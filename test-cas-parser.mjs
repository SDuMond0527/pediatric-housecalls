// Tests the CAS parser that will read Stedi's 835 ERA JSON and populate
// the per-category patient-responsibility columns (deductible /
// coinsurance / copay / non-covered) plus contractual adjustment.
//
// Stedi (Hadi Soueidan 2026-09-15) confirmed the 835 ERA JSON API
// exposes CAS adjustment detail at both claim-level and service-line
// level, including adjustmentGroupCode, adjustmentReasonCode, and
// adjustmentAmount. Once he gives us the endpoint path we plug that
// URL into the poller; the parser + DB write below are already ready.
//
// X12 835 CAS codes:
//   Group codes:
//     PR = Patient Responsibility
//     CO = Contractual Obligation (payer write-off)
//     OA = Other Adjustment
//     PI = Payer Initiated
//   PR reason codes:
//     1  = Deductible
//     2  = Coinsurance
//     3  = Copayment
//     96 = Non-covered charges
//
// Run with: node --env-file=.env.local test-cas-parser.mjs

import { neon } from '@neondatabase/serverless'

const sql = neon(process.env.DATABASE_URL)
const CLEANUP_TAG = `TEST_CAS_${Date.now()}`

// Bucket X12 835 CAS adjustments into our per-category columns.
//
// Stedi's actual 835 response uses two nested shapes for adjustments —
// per the get-healthcare-reports-835 docs (verified 2026-09-15):
//
// (1) Flat numbered pairs on each adjustment object — up to 6:
//       {
//         claimAdjustmentGroupCode: 'PR',
//         adjustmentReasonCode1: '1', adjustmentAmount1: '30.00',
//         adjustmentReasonCode2: '2', adjustmentAmount2: '20.00',
//         ...
//       }
//     `claimAdjustments` arrays live at claim-payment scope, and
//     `serviceAdjustments` arrays live at service-line scope.
//
// (2) Some SDKs / earlier Stedi docs use a nested variant:
//       {
//         adjustmentGroupCode: 'PR',
//         claimAdjustmentDetails: [
//           { adjustmentReasonCode: '1', adjustmentAmount: '30' }
//         ]
//       }
//     Kept as a fallback so we survive any endpoint that returns this
//     shape — the poll and webhook flows both call the same parser.
//
// Walk the response tree for either shape, sum into columns.
export function parseCasAdjustments(era835) {
  const totals = {
    patient_deductible:     0,
    patient_coinsurance:    0,
    patient_copay:          0,
    patient_non_covered:    0,
    contractual_adjustment: 0,
  }

  const bucketFor = (groupCode, reasonCode) => {
    if (groupCode === 'PR') {
      switch (String(reasonCode)) {
        case '1':  return 'patient_deductible'
        case '2':  return 'patient_coinsurance'
        case '3':  return 'patient_copay'
        case '96': return 'patient_non_covered'
        default:   return 'patient_non_covered'
      }
    }
    if (groupCode === 'CO' || groupCode === 'OA' || groupCode === 'PI') {
      return 'contractual_adjustment'
    }
    return null
  }

  const addAdj = (adj) => {
    if (!adj) return
    // Group code is `claimAdjustmentGroupCode` on Stedi 835 (both claim
    // and line level share the same field name per docs). Fall back to
    // `adjustmentGroupCode` for the legacy nested shape.
    const groupCode = adj.claimAdjustmentGroupCode ?? adj.adjustmentGroupCode ?? adj.groupCode

    // Shape (1): flat adjustmentReasonCodeN / adjustmentAmountN — up to 6.
    let sawFlatPair = false
    for (let i = 1; i <= 6; i++) {
      const reason = adj[`adjustmentReasonCode${i}`]
      const amount = adj[`adjustmentAmount${i}`]
      if (reason == null && amount == null) continue
      sawFlatPair = true
      const bucket = bucketFor(groupCode, reason)
      if (bucket) totals[bucket] += parseFloat(amount ?? '0') || 0
    }
    if (sawFlatPair) return

    // Shape (2): nested details array
    const details = adj.claimAdjustmentDetails ?? adj.adjustmentDetails ?? null
    if (details && Array.isArray(details)) {
      for (const d of details) {
        const bucket = bucketFor(groupCode, d.adjustmentReasonCode ?? d.reasonCode)
        if (bucket) totals[bucket] += parseFloat(d.adjustmentAmount ?? d.amount ?? '0') || 0
      }
      return
    }

    // Fallback: single reason/amount directly on the object.
    const bucket = bucketFor(groupCode, adj.adjustmentReasonCode ?? adj.reasonCode)
    if (bucket) totals[bucket] += parseFloat(adj.adjustmentAmount ?? adj.amount ?? '0') || 0
  }

  const ADJ_ARRAY_KEYS = new Set([
    'claimAdjustments',       // Stedi claim-level CAS
    'serviceAdjustments',     // Stedi service-line CAS
    'serviceLineAdjustments', // legacy alias
    'adjustments',            // generic
  ])

  const walk = (obj) => {
    if (!obj || typeof obj !== 'object') return
    if (Array.isArray(obj)) { for (const item of obj) walk(item); return }
    for (const key of Object.keys(obj)) {
      if (ADJ_ARRAY_KEYS.has(key)) {
        const arr = obj[key]
        if (Array.isArray(arr)) for (const adj of arr) addAdj(adj)
      } else {
        walk(obj[key])
      }
    }
  }

  walk(era835)
  for (const k of Object.keys(totals)) totals[k] = +totals[k].toFixed(2)
  return totals
}

async function pickPracticeAndProvider() {
  const [row] = await sql`
    SELECT p.id AS provider_id, p.practice_id
    FROM providers p WHERE p.is_active = true LIMIT 1`
  if (!row) throw new Error('No active provider in preview DB')
  return row
}

async function cleanup(practiceId) {
  await sql`DELETE FROM patient_statements WHERE practice_id = ${practiceId}::uuid AND patient_first_name = ${'TEST_' + CLEANUP_TAG}`
  await sql`DELETE FROM claims WHERE practice_id = ${practiceId}::uuid AND patient_first_name = ${'TEST_' + CLEANUP_TAG}`
}

async function insertTestClaim(practiceId, providerId) {
  const [row] = await sql`
    INSERT INTO claims (
      practice_id, provider_id,
      patient_first_name, patient_last_name,
      status, service_date, cpt_codes
    ) VALUES (
      ${practiceId}::uuid, ${providerId}::uuid,
      ${'TEST_' + CLEANUP_TAG}, ${'PATIENT'},
      'submitted', ${new Date().toISOString().slice(0, 10)}::date,
      ${'[]'}::jsonb
    ) RETURNING id`
  return row.id
}

function assertEq(label, actual, expected) {
  if (Math.abs(actual - expected) > 0.01) throw new Error(`${label}: expected ${expected}, got ${actual}`)
}

async function run() {
  const { provider_id, practice_id } = await pickPracticeAndProvider()
  await cleanup(practice_id)
  // Mirror the bootstrap the cron endpoint runs on every request.
  try { await sql`ALTER TABLE claims ADD COLUMN IF NOT EXISTS stedi_payer_claim_control_number text` } catch {}
  try { await sql`ALTER TABLE claims ADD COLUMN IF NOT EXISTS patient_responsibility_era numeric(10,2)` } catch {}
  try {
    await sql`CREATE TABLE IF NOT EXISTS stedi_transactions_processed (
      transaction_id text PRIMARY KEY, processed_at timestamptz NOT NULL DEFAULT NOW(),
      matched_claim_count integer NOT NULL DEFAULT 0, source text)`
  } catch {}

  // ── Case 1: classic breakdown — deductible + coinsurance + contractual
  console.log('[test] Case 1: PR/1 deductible + PR/2 coinsurance + CO/45 contractual')
  const era1 = {
    claimPaymentInformation: [{
      totalClaimChargeAmount: '495.00',
      claimPaymentAmount: '250.00',
      claimAdjustments: [
        { adjustmentGroupCode: 'PR', claimAdjustmentDetails: [
          { adjustmentReasonCode: '1', adjustmentAmount: '30.00' },
          { adjustmentReasonCode: '2', adjustmentAmount: '20.00' },
        ]},
        { adjustmentGroupCode: 'CO', claimAdjustmentDetails: [
          { adjustmentReasonCode: '45', adjustmentAmount: '195.00' },
        ]},
      ],
    }],
  }
  const parsed1 = parseCasAdjustments(era1)
  assertEq('deductible', parsed1.patient_deductible, 30)
  assertEq('coinsurance', parsed1.patient_coinsurance, 20)
  assertEq('copay', parsed1.patient_copay, 0)
  assertEq('non_covered', parsed1.patient_non_covered, 0)
  assertEq('contractual', parsed1.contractual_adjustment, 195)
  console.log('[test]   ✓ deductible=30, coinsurance=20, contractual=195')

  // ── Case 2: pure deductible ERA (this is the biller's $0-paid case)
  console.log('[test] Case 2: full 495 to deductible, insurance paid 0')
  const era2 = {
    claimPaymentInformation: [{
      totalClaimChargeAmount: '495.00',
      claimPaymentAmount: '0.00',
      claimAdjustments: [
        { adjustmentGroupCode: 'PR', claimAdjustmentDetails: [
          { adjustmentReasonCode: '1', adjustmentAmount: '495.00' },
        ]},
      ],
    }],
  }
  const parsed2 = parseCasAdjustments(era2)
  assertEq('deductible', parsed2.patient_deductible, 495)
  assertEq('total contractual', parsed2.contractual_adjustment, 0)
  console.log('[test]   ✓ deductible=495 (biller no longer has to categorize by hand)')

  // ── Case 3: copay-only visit
  console.log('[test] Case 3: copay-only (PR/3 = 25)')
  const era3 = {
    claimPaymentInformation: [{
      claimAdjustments: [
        { adjustmentGroupCode: 'PR', claimAdjustmentDetails: [
          { adjustmentReasonCode: '3', adjustmentAmount: '25.00' },
        ]},
      ],
    }],
  }
  const parsed3 = parseCasAdjustments(era3)
  assertEq('copay', parsed3.patient_copay, 25)
  assertEq('deductible', parsed3.patient_deductible, 0)
  console.log('[test]   ✓ copay=25, everything else 0')

  // ── Case 4: service-line-level adjustments (not just claim-level)
  console.log('[test] Case 4: adjustments only on service lines, not claim')
  const era4 = {
    claimPaymentInformation: [{
      serviceLines: [
        {
          serviceLineAdjustments: [
            { adjustmentGroupCode: 'PR', claimAdjustmentDetails: [
              { adjustmentReasonCode: '1', adjustmentAmount: '15.00' },
            ]},
          ],
        },
        {
          serviceLineAdjustments: [
            { adjustmentGroupCode: 'PR', claimAdjustmentDetails: [
              { adjustmentReasonCode: '2', adjustmentAmount: '35.00' },
            ]},
            { adjustmentGroupCode: 'CO', claimAdjustmentDetails: [
              { adjustmentReasonCode: '45', adjustmentAmount: '80.00' },
            ]},
          ],
        },
      ],
    }],
  }
  const parsed4 = parseCasAdjustments(era4)
  assertEq('line-level deductible', parsed4.patient_deductible, 15)
  assertEq('line-level coinsurance', parsed4.patient_coinsurance, 35)
  assertEq('line-level contractual', parsed4.contractual_adjustment, 80)
  console.log('[test]   ✓ line-level adjustments sum correctly')

  // ── Case 5: non-covered (PR/96) + unmapped PR reason
  console.log('[test] Case 5: PR/96 non-covered + PR/24 unmapped both go to non_covered')
  const era5 = {
    claimPaymentInformation: [{
      claimAdjustments: [
        { adjustmentGroupCode: 'PR', claimAdjustmentDetails: [
          { adjustmentReasonCode: '96', adjustmentAmount: '40.00' },
          { adjustmentReasonCode: '24', adjustmentAmount: '10.00' },
        ]},
      ],
    }],
  }
  const parsed5 = parseCasAdjustments(era5)
  assertEq('non_covered', parsed5.patient_non_covered, 50)
  console.log('[test]   ✓ non_covered=50 (both PR/96 and unmapped PR reasons)')

  // ── Case 6: REAL Stedi 835 shape — flat adjustmentReasonCodeN / adjustmentAmountN
  console.log('[test] Case 6: REAL Stedi flat shape (adjustmentAmount1..6 pairs)')
  const era6 = {
    transactions: [{
      claimPaymentInformation: [{
        totalClaimChargeAmount: '495.00',
        claimPaymentAmount: '250.00',
        claimAdjustments: [
          {
            claimAdjustmentGroupCode: 'PR',
            adjustmentReasonCode1: '1', adjustmentAmount1: '30.00',
            adjustmentReasonCode2: '2', adjustmentAmount2: '20.00',
          },
          {
            claimAdjustmentGroupCode: 'CO',
            adjustmentReasonCode1: '45', adjustmentAmount1: '195.00',
          },
        ],
        serviceLines: [
          {
            serviceAdjustments: [
              {
                claimAdjustmentGroupCode: 'PR',
                adjustmentReasonCode1: '3', adjustmentAmount1: '10.00',
              },
            ],
          },
        ],
      }],
    }],
  }
  const parsed6 = parseCasAdjustments(era6)
  assertEq('flat deductible', parsed6.patient_deductible, 30)
  assertEq('flat coinsurance', parsed6.patient_coinsurance, 20)
  assertEq('flat copay (line-level)', parsed6.patient_copay, 10)
  assertEq('flat contractual', parsed6.contractual_adjustment, 195)
  console.log('[test]   ✓ flat shape parsed: ded=30, coins=20, copay=10 (line), contract=195')

  // ── Case 7: flat shape at claim level uses adjustmentAmount1..6 fully
  console.log('[test] Case 7: 6 adjustments packed into one PR group node')
  const era7 = {
    claimAdjustments: [
      {
        claimAdjustmentGroupCode: 'PR',
        adjustmentReasonCode1: '1', adjustmentAmount1: '10.00',
        adjustmentReasonCode2: '2', adjustmentAmount2: '15.00',
        adjustmentReasonCode3: '3', adjustmentAmount3: '20.00',
        adjustmentReasonCode4: '96', adjustmentAmount4: '5.00',
        adjustmentReasonCode5: '1', adjustmentAmount5: '25.00',  // more deductible
        adjustmentReasonCode6: '2', adjustmentAmount6: '30.00',  // more coinsurance
      },
    ],
  }
  const parsed7 = parseCasAdjustments(era7)
  assertEq('packed deductible', parsed7.patient_deductible, 35)   // 10 + 25
  assertEq('packed coinsurance', parsed7.patient_coinsurance, 45) // 15 + 30
  assertEq('packed copay', parsed7.patient_copay, 20)
  assertEq('packed non_covered', parsed7.patient_non_covered, 5)
  console.log('[test]   ✓ 6-slot packed group: ded=35, coins=45, copay=20, non=5')

  // ── Case 8: DB round-trip — write the parsed values, read them back
  console.log('[test] Case 8: DB write + read against Neon preview')
  const claimId = await insertTestClaim(practice_id, provider_id)
  await sql`
    UPDATE claims SET
      patient_deductible_era     = ${parsed1.patient_deductible},
      patient_coinsurance_era    = ${parsed1.patient_coinsurance},
      patient_copay_era          = ${parsed1.patient_copay},
      patient_non_covered_era    = ${parsed1.patient_non_covered},
      contractual_adjustment_era = ${parsed1.contractual_adjustment}
    WHERE id = ${claimId}::uuid`
  const [row] = await sql`
    SELECT patient_deductible_era, patient_coinsurance_era, patient_copay_era,
           patient_non_covered_era, contractual_adjustment_era
    FROM claims WHERE id = ${claimId}::uuid`
  assertEq('db deductible', parseFloat(row.patient_deductible_era), 30)
  assertEq('db coinsurance', parseFloat(row.patient_coinsurance_era), 20)
  assertEq('db contractual', parseFloat(row.contractual_adjustment_era), 195)
  console.log('[test]   ✓ DB round-trip')

  // ── Case 9: full pipeline — extract claim payments from a nested 835,
  // then apply the CAS breakdown to real DB rows via the same shape
  // the production webhook uses. Verifies the end-to-end write path.
  console.log('[test] Case 9: full pipeline — nested 835 → extract → parse → apply')

  function extractClaimPayments(era835) {
    const out = []
    const walk = (obj) => {
      if (!obj || typeof obj !== 'object') return
      if (Array.isArray(obj)) { for (const item of obj) walk(item); return }
      if (obj.patientControlNumber || obj.payerClaimControlNumber) {
        out.push({
          pcn: obj.patientControlNumber ?? null,
          payerClaimControlNumber: obj.payerClaimControlNumber ?? null,
          scoped: obj,
        })
      }
      for (const key of Object.keys(obj)) walk(obj[key])
    }
    walk(era835)
    return out
  }

  // Insert two claims — the 835 has two claim-payment records inside it
  const claim9aId = await insertTestClaim(practice_id, provider_id)
  const claim9bId = await insertTestClaim(practice_id, provider_id)
  const pcn9a = claim9aId.replace(/-/g, '').slice(0, 20).toUpperCase()
  const pcn9b = claim9bId.replace(/-/g, '').slice(0, 20).toUpperCase()

  const era9 = {
    transactions: [{
      claimPaymentInformation: [
        {
          patientControlNumber: pcn9a,
          payerClaimControlNumber: 'FY0286445TEST9A',
          totalClaimChargeAmount: '495.00',
          claimPaymentAmount: '250.00',
          claimAdjustments: [
            { claimAdjustmentGroupCode: 'PR', adjustmentReasonCode1: '1', adjustmentAmount1: '30.00', adjustmentReasonCode2: '2', adjustmentAmount2: '20.00' },
            { claimAdjustmentGroupCode: 'CO', adjustmentReasonCode1: '45', adjustmentAmount1: '195.00' },
          ],
        },
        {
          patientControlNumber: pcn9b,
          payerClaimControlNumber: 'FY0286445TEST9B',
          totalClaimChargeAmount: '150.00',
          claimPaymentAmount: '0.00',
          claimAdjustments: [
            { claimAdjustmentGroupCode: 'PR', adjustmentReasonCode1: '1', adjustmentAmount1: '150.00' },
          ],
        },
      ],
    }],
  }

  const payments = extractClaimPayments(era9)
  if (payments.length !== 2) throw new Error(`Expected 2 extracted payments, got ${payments.length}`)

  for (const cp of payments) {
    const [claim] = await sql`SELECT id FROM claims WHERE REPLACE(id::text, '-', '') ILIKE ${cp.pcn + '%'} LIMIT 1`
    if (!claim) throw new Error(`No claim matched for PCN ${cp.pcn}`)
    const cas = parseLifecycleCas(cp.scoped)
    await sql`
      UPDATE claims SET
        patient_deductible_era     = ${cas.patient_deductible},
        patient_coinsurance_era    = ${cas.patient_coinsurance},
        patient_copay_era          = ${cas.patient_copay},
        patient_non_covered_era    = ${cas.patient_non_covered},
        contractual_adjustment_era = ${cas.contractual_adjustment},
        stedi_payer_claim_control_number = ${cp.payerClaimControlNumber}
      WHERE id = ${claim.id}::uuid`
  }

  const [aRow] = await sql`SELECT * FROM claims WHERE id = ${claim9aId}::uuid`
  const [bRow] = await sql`SELECT * FROM claims WHERE id = ${claim9bId}::uuid`
  assertEq('9a deductible', parseFloat(aRow.patient_deductible_era), 30)
  assertEq('9a coinsurance', parseFloat(aRow.patient_coinsurance_era), 20)
  assertEq('9a contractual', parseFloat(aRow.contractual_adjustment_era), 195)
  if (aRow.stedi_payer_claim_control_number !== 'FY0286445TEST9A') throw new Error(`9a payerCCN wrong: ${aRow.stedi_payer_claim_control_number}`)
  assertEq('9b deductible (full amount)', parseFloat(bRow.patient_deductible_era), 150)
  assertEq('9b contractual', parseFloat(bRow.contractual_adjustment_era), 0)
  console.log('[test]   ✓ two-claim 835 fully processed, payer CCN cached')

  await cleanup(practice_id)
  console.log('\n[test] PASS — all 9 CAS-parser assertions succeeded')
  console.log('       Ready to plug into 835 fetch flow.')
}

// Re-export via alias so the Case 9 code above can also call the parser.
const parseLifecycleCas = parseCasAdjustments

run().catch(e => { console.error('[test] FAIL:', e.message); process.exit(1) })
