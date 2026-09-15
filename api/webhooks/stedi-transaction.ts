import type { VercelRequest, VercelResponse } from '@vercel/node'
import { neon } from '@neondatabase/serverless'
import crypto from 'node:crypto'

// Stedi transaction.processed webhook receiver.
//
// Sara configures a Stedi Event Destination pointing at this URL:
//   POST https://phc-team.com/api/webhooks/stedi-transaction
// subscribed to the `transaction.processed` event. Stedi signs the
// payload with the Standard Webhooks convention (webhook-id +
// webhook-timestamp + webhook-signature headers, HMAC-SHA256 of
// `${id}.${timestamp}.${rawBody}` with a shared secret from the
// destination's `/secret` endpoint). We verify that signature here
// before doing anything else.
//
// After verification we:
//   1. Extract transactionId from the payload.
//   2. Guard on stedi_transactions_processed for idempotency.
//   3. Fetch the 835 JSON from
//        GET https://healthcare.us.stedi.com/2024-04-01/change/medicalnetwork/reports/v2/{transactionId}/835
//   4. For each claimPaymentInformation, match to a local claim by
//      patientControlNumber or payerClaimControlNumber and hydrate the
//      CAS-derived per-category patient responsibility columns.
//
// Additive to the existing Claims Lifecycle poll — the Lifecycle pass
// fills billed / paid / patient responsibility subtotal. This pass
// fills deductible / coinsurance / copay / non-covered. patient_statements
// writes are COALESCE'd so biller manual edits are preserved. Every
// helper is INLINED per the same reason spelled out in
// api/cron/stedi-era-poll.ts.

// Vercel: disable automatic JSON body parsing so we can HMAC-verify
// the RAW request bytes exactly as Stedi signed them.
export const config = { api: { bodyParser: false } }

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
    patient_deductible: 0, patient_coinsurance: 0, patient_copay: 0,
    patient_non_covered: 0, contractual_adjustment: 0,
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
    if (groupCode === 'CO' || groupCode === 'OA' || groupCode === 'PI') return 'contractual_adjustment'
    return null
  }
  const addAdj = (adj: any) => {
    if (!adj) return
    const groupCode = adj.claimAdjustmentGroupCode ?? adj.adjustmentGroupCode ?? adj.groupCode
    let sawFlat = false
    for (let i = 1; i <= 6; i++) {
      const reason = adj[`adjustmentReasonCode${i}`]
      const amount = adj[`adjustmentAmount${i}`]
      if (reason == null && amount == null) continue
      sawFlat = true
      const bucket = bucketFor(groupCode, reason)
      if (bucket) totals[bucket] += parseFloat(amount ?? '0') || 0
    }
    if (sawFlat) return
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
  const ADJ_KEYS = new Set(['claimAdjustments', 'serviceAdjustments', 'serviceLineAdjustments', 'adjustments'])
  const walk = (obj: any) => {
    if (!obj || typeof obj !== 'object') return
    if (Array.isArray(obj)) { for (const item of obj) walk(item); return }
    for (const key of Object.keys(obj)) {
      if (ADJ_KEYS.has(key)) {
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

function extractClaimPayments(era835: any): Array<{ pcn: string | null; payerClaimControlNumber: string | null; scoped: any }> {
  const out: Array<{ pcn: string | null; payerClaimControlNumber: string | null; scoped: any }> = []
  const walk = (obj: any) => {
    if (!obj || typeof obj !== 'object') return
    if (Array.isArray(obj)) { for (const item of obj) walk(item); return }
    if (obj.patientControlNumber || obj.payerClaimControlNumber) {
      out.push({
        pcn: obj.patientControlNumber ? String(obj.patientControlNumber).trim() : null,
        payerClaimControlNumber: obj.payerClaimControlNumber ? String(obj.payerClaimControlNumber).trim() : null,
        scoped: obj,
      })
    }
    for (const key of Object.keys(obj)) walk(obj[key])
  }
  walk(era835)
  return out
}

async function findClaim(sql: any, pcn: string | null, payerClaimControlNumber: string | null): Promise<any | null> {
  if (payerClaimControlNumber) {
    const rows = await sql`SELECT id FROM claims WHERE stedi_payer_claim_control_number = ${payerClaimControlNumber} LIMIT 1`
    if (rows[0]) return rows[0]
  }
  if (pcn) {
    const rows = await sql`SELECT id FROM claims WHERE REPLACE(id::text, '-', '') ILIKE ${pcn + '%'} LIMIT 1`
    if (rows[0]) return rows[0]
  }
  return null
}

async function applyCasToClaim(sql: any, claimId: string, cas: CasBreakdown, payerClaimControlNumber: string | null) {
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
  if (payerClaimControlNumber) {
    await sql`UPDATE claims SET stedi_payer_claim_control_number = ${payerClaimControlNumber} WHERE id = ${claimId}::uuid AND stedi_payer_claim_control_number IS NULL`
  }
}

async function readRawBody(req: VercelRequest): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req as unknown as AsyncIterable<Buffer>) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
  }
  return Buffer.concat(chunks).toString('utf-8')
}

// Standard Webhooks verification (spec: https://www.standardwebhooks.com/).
// Stedi's Event Destinations follow this convention per docs:
//   webhook-id, webhook-timestamp, webhook-signature headers
//   secret is base64 in `whsec_` prefix form
//   signed_payload = `${id}.${timestamp}.${rawBody}`
//   signature = base64(HMAC-SHA256(signed_payload, secretBytes))
//   header may contain multiple sigs separated by space: "v1,sig1 v1,sig2"
// Reject if timestamp is off by more than 5 minutes (replay guard).
function verifyStediSignature(headers: Record<string, string | string[] | undefined>, rawBody: string, secret: string): { ok: true } | { ok: false; reason: string } {
  const id = String(headers['webhook-id'] ?? '')
  const ts = String(headers['webhook-timestamp'] ?? '')
  const sig = String(headers['webhook-signature'] ?? '')
  if (!id || !ts || !sig) return { ok: false, reason: 'Missing webhook-id / webhook-timestamp / webhook-signature header' }

  const tsNum = Number(ts)
  if (!Number.isFinite(tsNum)) return { ok: false, reason: 'Invalid webhook-timestamp' }
  const now = Math.floor(Date.now() / 1000)
  if (Math.abs(now - tsNum) > 300) return { ok: false, reason: 'webhook-timestamp outside 5-minute tolerance' }

  const secretBase64 = secret.startsWith('whsec_') ? secret.slice(6) : secret
  let secretBytes: Buffer
  try {
    secretBytes = Buffer.from(secretBase64, 'base64')
  } catch {
    return { ok: false, reason: 'Invalid secret encoding' }
  }

  const signedPayload = `${id}.${ts}.${rawBody}`
  const expected = crypto.createHmac('sha256', secretBytes).update(signedPayload).digest('base64')

  // Header format: "v1,BASE64SIG v1,BASE64SIG2 ..."
  const providedSigs = sig.split(' ')
    .map(s => s.trim())
    .filter(Boolean)
    .map(s => s.includes(',') ? s.split(',')[1] : s)

  for (const provided of providedSigs) {
    try {
      const a = Buffer.from(provided, 'base64')
      const b = Buffer.from(expected, 'base64')
      if (a.length === b.length && crypto.timingSafeEqual(a, b)) return { ok: true }
    } catch { /* try next candidate */ }
  }
  return { ok: false, reason: 'No signature matched' }
}

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

  if (!STEDI_WEBHOOK_SECRET) {
    return res.status(500).json({ error: 'STEDI_WEBHOOK_SECRET not configured' })
  }
  if (!STEDI_API_KEY) return res.status(500).json({ error: 'STEDI_API_KEY not configured' })

  // Read raw body first so we can HMAC-verify Stedi's signature over
  // the exact bytes they sent, before parsing.
  let rawBody: string
  try {
    rawBody = await readRawBody(req)
  } catch (e: any) {
    return res.status(400).json({ error: 'Failed to read body', message: e?.message })
  }

  const verified = verifyStediSignature(req.headers as any, rawBody, STEDI_WEBHOOK_SECRET)
  if (!verified.ok) {
    return res.status(401).json({ error: 'Signature verification failed', reason: verified.reason })
  }

  let payload: any
  try {
    payload = rawBody ? JSON.parse(rawBody) : {}
  } catch {
    return res.status(400).json({ error: 'Body was not valid JSON' })
  }

  const transactionId = extractTransactionId(payload)
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

  const [prior] = await sql`SELECT transaction_id FROM stedi_transactions_processed WHERE transaction_id = ${transactionId} LIMIT 1`
  if (prior) {
    return res.status(200).json({ ok: true, transactionId, skipped: 'already_processed' })
  }

  const reportRes = await fetch(STEDI_835_REPORT_URL(transactionId), {
    headers: { Authorization: `Key ${STEDI_API_KEY}`, 'Content-Type': 'application/json' },
  })
  if (!reportRes.ok) {
    const err = await reportRes.text().catch(() => '')
    return res.status(200).json({ ok: false, transactionId, stediStatus: reportRes.status, error: err.slice(0, 300) })
  }
  const era835 = await reportRes.json()

  const claimPayments = extractClaimPayments(era835)
  let matched = 0
  const errors: string[] = []
  for (const cp of claimPayments) {
    try {
      const claim = await findClaim(sql, cp.pcn, cp.payerClaimControlNumber)
      if (!claim) continue
      const cas = parseCasAdjustments(cp.scoped)
      await applyCasToClaim(sql, claim.id, cas, cp.payerClaimControlNumber)
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
