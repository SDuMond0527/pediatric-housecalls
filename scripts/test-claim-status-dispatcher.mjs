// Preview-env test of the full runClaimStatusCheck() dispatcher. Seeds
// a synthetic practice / child / claim into the Neon PREVIEW branch,
// then monkey-patches `fetch` so the Stedi POST returns a canned
// response. We check the side effects (DB columns, review_queue_items,
// claim_rejection_* fields) for each bucket. Nothing real is called.
//
//   node --env-file=.env.local scripts/test-claim-status-dispatcher.mjs
//
// Sara 2026-11-17.

import { neon } from '@neondatabase/serverless'

// Rewrite global fetch to return canned payloads keyed by test case.
let CANNED_RESPONSE = null
const origFetch = globalThis.fetch
globalThis.fetch = async (url, opts) => {
  if (typeof url === 'string' && url.includes('/claimstatus/')) {
    return {
      ok: true,
      status: 200,
      json: async () => CANNED_RESPONSE,
    }
  }
  return origFetch(url, opts)
}
// Also ensure STEDI_API_KEY is set to something; runClaimStatusCheck
// refuses to run without it.
process.env.STEDI_API_KEY = process.env.STEDI_API_KEY || 'test_key_not_used_due_to_fetch_mock'

const { runClaimStatusCheck, bootstrapPayerStatusColumns } = await import('../api/stedi/claim-status.ts')

const sql = neon(process.env.DATABASE_URL)
const PRACTICE_ID = '00000000-0000-0000-0000-000000000c57'    // fake (c57 → CST → claim-status-test)
const CHILD_ID    = '00000000-0000-0000-0000-000000000c58'
const CLAIM_ID    = '00000000-0000-0000-0000-000000000c59'

async function seed() {
  // Make sure we start from a clean slate so repeated runs are idempotent.
  await sql`DELETE FROM review_queue_items WHERE practice_id = ${PRACTICE_ID}::uuid`
  await sql`DELETE FROM claims WHERE id = ${CLAIM_ID}::uuid`
  await sql`DELETE FROM children WHERE id = ${CHILD_ID}::uuid`
  await sql`DELETE FROM practices WHERE id = ${PRACTICE_ID}::uuid`

  await sql`INSERT INTO practices (id, name, slug) VALUES (${PRACTICE_ID}::uuid, 'ClaimStatusTest Practice', 'claim-status-test')
            ON CONFLICT (id) DO NOTHING`
  await sql`INSERT INTO children (id, practice_id, first_name, last_name, date_of_birth,
                                  display_label,
                                  insurance_member_id, insurance_subscriber_name,
                                  insurance_subscriber_dob,
                                  insurance_dependent_code, insurance_no_dependent_code)
            VALUES (${CHILD_ID}::uuid, ${PRACTICE_ID}::uuid, 'Test', 'Child', '2015-01-01',
                    'Test Child',
                    'MEM12345', 'Parent Child', '1985-06-15', '00', false)
            ON CONFLICT (id) DO NOTHING`
  await bootstrapPayerStatusColumns(sql)
  await sql`INSERT INTO claims (id, practice_id, child_id, payer_id, payer_name,
                                patient_first_name, patient_last_name, patient_dob,
                                service_date, total_charge, status, submitted_at,
                                stedi_claim_id, payer_control_number)
            VALUES (${CLAIM_ID}::uuid, ${PRACTICE_ID}::uuid, ${CHILD_ID}::uuid,
                    '60054', 'Aetna', 'Test', 'Child', '2015-01-01',
                    '2026-10-01', 250.00, 'submitted', NOW() - INTERVAL '45 days',
                    'PEDS99999', 'PCN123XYZ')
            ON CONFLICT (id) DO NOTHING`
}

async function loadClaim() {
  const [c] = await sql`SELECT * FROM claims WHERE id = ${CLAIM_ID}::uuid LIMIT 1`
  return c
}

async function loadOpenQueueItems() {
  return await sql`SELECT item_type, summary FROM review_queue_items
                   WHERE practice_id = ${PRACTICE_ID}::uuid AND status = 'open'
                   ORDER BY created_at DESC`
}

async function resetBetweenCases() {
  await sql`UPDATE review_queue_items SET status = 'cleared_by_test', decided_at = NOW()
            WHERE practice_id = ${PRACTICE_ID}::uuid`
  await sql`UPDATE claims SET
              payer_status_bucket = NULL, payer_status_category = NULL,
              payer_status_code = NULL, payer_status_message = NULL,
              payer_status_checked_at = NULL, payer_status_raw = NULL,
              claim_rejection_at = NULL, claim_rejection_response = NULL,
              claim_rejection_reasons = NULL
            WHERE id = ${CLAIM_ID}::uuid`
}

async function teardown() {
  await sql`DELETE FROM review_queue_items WHERE practice_id = ${PRACTICE_ID}::uuid`
  await sql`DELETE FROM claims WHERE id = ${CLAIM_ID}::uuid`
  await sql`DELETE FROM children WHERE id = ${CHILD_ID}::uuid`
  await sql`DELETE FROM practices WHERE id = ${PRACTICE_ID}::uuid`
}

const CASES = [
  {
    name: 'not_on_file → inserts payer_never_received queue row',
    canned: { claimInformation: { statusInformation: [{ categoryCode: 'D0', statusCode: '35', statusCodeDescription: 'Claim/encounter not found' }] } },
    expectBucket: 'not_on_file',
    expectSideEffect: 'queued_payer_never_received',
    check: async () => {
      const items = await loadOpenQueueItems()
      if (items.length !== 1 || items[0].item_type !== 'payer_never_received') {
        throw new Error(`expected 1 payer_never_received item, got ${JSON.stringify(items)}`)
      }
    },
  },
  {
    name: 'rejected_intake → sets claim_rejection_at + routes to Rework',
    canned: { claimInformation: { statusInformation: [{ categoryCode: 'A3', statusCode: '21', statusCodeDescription: 'Missing or invalid information' }] } },
    expectBucket: 'rejected_intake',
    expectSideEffect: 'moved_to_rework',
    check: async () => {
      const claim = await loadClaim()
      if (!claim.claim_rejection_at) throw new Error('expected claim_rejection_at set')
      const reasons = claim.claim_rejection_reasons
      if (!Array.isArray(reasons) || reasons[0]?.source !== '276-inquiry') {
        throw new Error(`expected rejection reasons sourced from 276-inquiry, got ${JSON.stringify(reasons)}`)
      }
    },
  },
  {
    name: 'pending → updates pill only, no side effects',
    canned: { claimInformation: { statusInformation: [{ categoryCode: 'P1', statusCode: '20', statusCodeDescription: 'Accepted for processing.' }] } },
    expectBucket: 'pending',
    expectSideEffect: 'none',
    check: async () => {
      const items = await loadOpenQueueItems()
      if (items.length !== 0) throw new Error(`pending should not queue anything, got ${JSON.stringify(items)}`)
      const claim = await loadClaim()
      if (claim.claim_rejection_at) throw new Error('pending should not set rejection')
      if (claim.payer_status_bucket !== 'pending') throw new Error(`expected bucket=pending, got ${claim.payer_status_bucket}`)
    },
  },
  {
    name: 'era_pending → updates pill only',
    canned: { claimInformation: { statusInformation: [{ categoryCode: 'F1', statusCode: '65', statusCodeDescription: 'Claim/line has been paid.' }] } },
    expectBucket: 'era_pending',
    expectSideEffect: 'none',
    check: async () => {
      const claim = await loadClaim()
      if (claim.payer_status_bucket !== 'era_pending') throw new Error(`expected bucket=era_pending, got ${claim.payer_status_bucket}`)
    },
  },
]

let pass = 0, fail = 0
try {
  await seed()
  for (const c of CASES) {
    await resetBetweenCases()
    CANNED_RESPONSE = c.canned
    try {
      const claim = await loadClaim()
      const result = await runClaimStatusCheck(sql, {
        id: claim.id, practice_id: claim.practice_id,
        stedi_claim_id: claim.stedi_claim_id, payer_control_number: claim.payer_control_number,
        payer_id: claim.payer_id, payer_name: claim.payer_name,
        service_date: claim.service_date, total_charge: claim.total_charge,
        patient_first_name: claim.patient_first_name, patient_last_name: claim.patient_last_name,
        patient_dob: claim.patient_dob, child_id: claim.child_id,
      }, { triggeredBy: 'test' })
      if (result.bucket !== c.expectBucket) throw new Error(`expected bucket=${c.expectBucket}, got ${result.bucket}`)
      if (result.side_effect !== c.expectSideEffect) throw new Error(`expected side_effect=${c.expectSideEffect}, got ${result.side_effect}`)
      await c.check()
      console.log(`✓ ${c.name}`)
      pass++
    } catch (e) {
      console.log(`✗ ${c.name}: ${e.message}`)
      fail++
    }
  }
} finally {
  await teardown()
  globalThis.fetch = origFetch
}
console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
