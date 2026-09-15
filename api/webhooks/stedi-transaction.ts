import type { VercelRequest, VercelResponse } from '@vercel/node'
import { neon } from '@neondatabase/serverless'

// Stedi transaction-processed webhook receiver.
//
// Sara configures a Stedi Event Destination pointing at this URL:
//   POST https://phc-team.com/api/webhooks/stedi-transaction
// with an Authorization: Bearer <STEDI_WEBHOOK_SECRET> header
// (secret set in Vercel env vars, matched here).
//
// When Stedi processes an inbound 835 ERA transaction, the event
// destination fires this webhook. We:
//   1. Verify the bearer secret.
//   2. Extract transactionId from the payload (defensive — multiple
//      shapes accepted).
//   3. Skip if we already processed this transactionId (idempotent).
//   4. Fetch the 835 JSON from
//        GET https://healthcare.us.stedi.com/2024-04-01/change/medicalnetwork/reports/v2/{transactionId}/835
//   5. For each claimPaymentInformation, match to a local claim by
//      patientControlNumber or payerClaimControlNumber and hydrate
//      the CAS-derived per-category patient responsibility columns.
//   6. Ack 200 quickly.
//
// Additive to the existing Claims Lifecycle poll (api/cron/stedi-era-poll.ts)
// — that pass fills the summary totals (billed / paid / patient
// responsibility subtotal). This pass fills the CAS-level breakdown
// (deductible / coinsurance / copay / non-covered) once we get the
// underlying 835 JSON. Both writes use COALESCE on patient_statements
// so biller manual edits are preserved. Every helper is INLINED per
// the same reason spelled out in api/cron/stedi-era-poll.ts.

const STEDI_API_KEY         = process.env.STEDI_API_KEY         || ''
const STEDI_WEBHOOK_SECRET  = process.env.STEDI_WEBHOOK_SECRET  || ''

const STEDI_835_REPORT_URL = (transactionId: string) =>
  `https://healthcare.us.stedi.com/2024-04-01/change/medicalnetwork/reports/v2/${transactionId}/835`

interface CasBreakdown {
  patient_deductible:     number
  patient_coinsurance:    number
  patient_copay:          number
  patient_non_covered:    number
  contractual_adjustment: number
}

function parseCasAdjustments(era835: any): CasBreakdown {
  const totals: CasBreakdown = {
    patient_deductible:     0,
    patient_coinsurance:    0,
    patient_copay:          0,
    patient_non_covered:    0,
    contractual_adjustment: 0,
  }

  const bucketFor = (groupCode: string | undefined, reasonCode: any): keyof CasBreakdown | null => {
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

  const addAdj = (adj: any) => {
    if (!adj) return
    const groupCode = adj.claimAdjustmentGroupCode ?? adj.adjustmentGroupCode ?? adj.groupCode
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
    const details = adj.claimAdjustmentDetails ?? adj.adjustmentDetails ?? null
    if (details && Array.isArray(details)) {
      for (const d of details) {
        const bucket = bucketFor(groupCode, d.adjustmentReasonCode ?? d.reasonCode)
        if (bucket) totals[bucket] += parseFloat(d.adjustmentAmount ?? d.amount ?? '0') || 0
      }
      return
    }
    const bucket = bucketFor(groupCode, adj.adjustmentReasonCode ?? adj.reasonCode)
    if (bucket) totals[bucket] += parseFloat(adj.adjustmentAmount ?? adj.amount ?? '0') || 0
  }

  const ADJ_ARRAY_KEYS = new Set(['claimAdjustments', 'serviceAdjustments', 'serviceLineAdjustments', 'adjustments'])
  const walk = (obj: any) => {
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
  for (const k of Object.keys(totals) as (keyof CasBreakdown)[]) totals[k] = +totals[k].toFixed(2)
  return totals
}

// Find every claimPaymentInformation node in the 835 tree. Each carries
// a patientControlNumber that we assigned at 837 submission (first 20
// chars of the local claim UUID, dashes stripped) — that's our join
// key back to the local claim.
function extractClaimPayments(era835: any): Array<{ pcn: string | null; payerClaimControlNumber: string | null; scoped: any }> {
  const results: Array<{ pcn: string | null; payerClaimControlNumber: string | null; scoped: any }> = []
  const walk = (obj: any) => {
    if (!obj || typeof obj !== 'object') return
    if (Array.isArray(obj)) { for (const item of obj) walk(item); return }
    if (obj.patientControlNumber || obj.payerClaimControlNumber || obj.claimAdjustments || obj.serviceLines) {
      // Node looks like a claim-payment record if it carries any of
      // these fields. Capture it so we can re-parse its adjustment
      // subtree in isolation for accurate per-claim bucketing.
      if (obj.patientControlNumber || obj.payerClaimControlNumber) {
        results.push({
          pcn: obj.patientControlNumber ? String(obj.patientControlNumber).trim() : null,
          payerClaimControlNumber: obj.payerClaimControlNumber ? String(obj.payerClaimControlNumber).trim() : null,
          scoped: obj,
        })
      }
    }
    for (const key of Object.keys(obj)) walk(obj[key])
  }
  walk(era835)
  return results
}

async function findClaim(sql: any, pcn: string | null, payerClaimControlNumber: string | null): Promise<any | null> {
  if (payerClaimControlNumber) {
    // Prefer stedi_payer_claim_control_number if we've saved it before.
    const rows = await sql`
      SELECT id, patient_deductible_era, patient_coinsurance_era,
             patient_copay_era, patient_non_covered_era, contractual_adjustment_era
      FROM claims
      WHERE stedi_payer_claim_control_number = ${payerClaimControlNumber}
      LIMIT 1`
    if (rows[0]) return rows[0]
  }
  if (pcn) {
    // PCN = first 20 chars of local UUID with dashes stripped.
    const rows = await sql`
      SELECT id, patient_deductible_era, patient_coinsurance_era,
             patient_copay_era, patient_non_covered_era, contractual_adjustment_era
      FROM claims
      WHERE REPLACE(id::text, '-', '') ILIKE ${pcn + '%'}
      LIMIT 1`
    if (rows[0]) return rows[0]
  }
  return null
}

async function applyCasToClaim(sql: any, claimId: string, cas: CasBreakdown) {
  // Overwrite the ERA columns on claims (authoritative — 835 is source
  // of truth). COALESCE the patient_statements columns so biller
  // manual edits win over subsequent recomputes.
  await sql`
    UPDATE claims SET
      patient_deductible_era     = ${cas.patient_deductible},
      patient_coinsurance_era    = ${cas.patient_coinsurance},
      patient_copay_era          = ${cas.patient_copay},
      patient_non_covered_era    = ${cas.patient_non_covered},
      contractual_adjustment_era = ${cas.contractual_adjustment},
      updated_at                 = NOW()
    WHERE id = ${claimId}::uuid`

  const [stmt] = await sql`SELECT id FROM patient_statements WHERE claim_id = ${claimId}::uuid LIMIT 1`
  if (stmt) {
    await sql`
      UPDATE patient_statements SET
        patient_deductible     = COALESCE(patient_deductible,     ${cas.patient_deductible}),
        patient_coinsurance    = COALESCE(patient_coinsurance,    ${cas.patient_coinsurance}),
        patient_copay          = COALESCE(patient_copay,          ${cas.patient_copay}),
        patient_non_covered    = COALESCE(patient_non_covered,    ${cas.patient_non_covered}),
        contractual_adjustment = COALESCE(contractual_adjustment, ${cas.contractual_adjustment}),
        updated_at             = NOW()
      WHERE id = ${stmt.id}`
  }
}

async function fetch835(transactionId: string): Promise<{ ok: boolean; body?: any; status: number; error?: string }> {
  const res = await fetch(STEDI_835_REPORT_URL(transactionId), {
    headers: { Authorization: `Key ${STEDI_API_KEY}`, 'Content-Type': 'application/json' },
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    return { ok: false, status: res.status, error: text.slice(0, 300) }
  }
  const body = await res.json()
  return { ok: true, status: res.status, body }
}

// Extract transactionId from any of the shapes Stedi's Event Destination
// might send. Documented shape has it at top level; nested variants
// covered as belt-and-suspenders.
function extractTransactionId(body: any): string | null {
  if (!body) return null
  return (
    body.transactionId
    ?? body.transaction_id
    ?? body.data?.transactionId
    ?? body.data?.transaction?.id
    ?? body.detail?.transactionId
    ?? body.payload?.transactionId
    ?? null
  )
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  // Bearer-token gate. If STEDI_WEBHOOK_SECRET isn't configured we
  // reject — better to be loud than silently trust every stranger
  // POSTing to this URL.
  if (!STEDI_WEBHOOK_SECRET) {
    return res.status(500).json({ error: 'STEDI_WEBHOOK_SECRET not configured' })
  }
  const authz = req.headers.authorization || ''
  if (authz !== `Bearer ${STEDI_WEBHOOK_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' })
  }
  if (!STEDI_API_KEY) return res.status(500).json({ error: 'STEDI_API_KEY not configured' })

  const transactionId = extractTransactionId(req.body)
  if (!transactionId) {
    return res.status(400).json({ error: 'Could not find transactionId on webhook payload' })
  }

  const sql = neon(process.env.DATABASE_URL!)

  try {
    await sql`
      CREATE TABLE IF NOT EXISTS stedi_transactions_processed (
        transaction_id text PRIMARY KEY,
        processed_at timestamptz NOT NULL DEFAULT NOW(),
        matched_claim_count integer NOT NULL DEFAULT 0,
        source text
      )`
  } catch {}
  try { await sql`ALTER TABLE claims ADD COLUMN IF NOT EXISTS stedi_payer_claim_control_number text` } catch {}

  // Idempotency guard — same 835 might fire the webhook twice (Stedi
  // retries on non-2xx). Once we've applied it, ack fast.
  const [prior] = await sql`
    SELECT transaction_id FROM stedi_transactions_processed
    WHERE transaction_id = ${transactionId} LIMIT 1`
  if (prior) {
    return res.status(200).json({ ok: true, transactionId, skipped: 'already_processed' })
  }

  const fetched = await fetch835(transactionId)
  if (!fetched.ok) {
    // 404 on this endpoint usually means Stedi has the transactionId
    // but the 835 report isn't materialized yet, or the transaction
    // isn't an 835. Don't mark it processed so a retry can pick it up.
    return res.status(200).json({ ok: false, transactionId, stediStatus: fetched.status, error: fetched.error })
  }

  const claimPayments = extractClaimPayments(fetched.body)
  let matched = 0
  const errors: string[] = []
  for (const cp of claimPayments) {
    try {
      const claim = await findClaim(sql, cp.pcn, cp.payerClaimControlNumber)
      if (!claim) continue
      const cas = parseCasAdjustments(cp.scoped)
      await applyCasToClaim(sql, claim.id, cas)
      // Save payerClaimControlNumber for future ERAs on the same claim.
      if (cp.payerClaimControlNumber) {
        await sql`UPDATE claims SET stedi_payer_claim_control_number = ${cp.payerClaimControlNumber} WHERE id = ${claim.id}::uuid AND stedi_payer_claim_control_number IS NULL`
      }
      matched += 1
    } catch (perClaimErr: any) {
      errors.push(String(perClaimErr?.message ?? perClaimErr).slice(0, 200))
    }
  }

  await sql`
    INSERT INTO stedi_transactions_processed (transaction_id, matched_claim_count, source)
    VALUES (${transactionId}, ${matched}, 'webhook')
    ON CONFLICT (transaction_id) DO UPDATE SET
      matched_claim_count = EXCLUDED.matched_claim_count,
      processed_at = NOW()`

  return res.status(200).json({
    ok: true,
    transactionId,
    claimPaymentsSeen: claimPayments.length,
    matched,
    errors,
  })
}
