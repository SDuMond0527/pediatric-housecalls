import type { VercelRequest, VercelResponse } from '@vercel/node'
import { neon } from '@neondatabase/serverless'
import { createRemoteJWKSet, jwtVerify } from 'jose'

// Admin-triggered CAS backfill.
//
// Runs the same 835-fetch + CAS-parse + apply pipeline as
// api/cron/stedi-era-poll.ts's second pass, but with a configurable
// lookback window (default 60 days). Use case: a practice enables the
// CAS pipeline and needs its already-received ERAs to hydrate their
// deductible / coinsurance / copay / non-covered columns retroactively.
//
// Every helper is INLINED to mirror the cron/webhook pattern (see
// api/cron/stedi-era-poll.ts header). Idempotent via
// stedi_transactions_processed — running twice does nothing extra.
// patient_statements writes preserve biller manual edits.
//
// Auth: admin provider JWT (same as api/admin/test-stedi-era-sync.ts).
// Trigger: AdminClaims "Backfill Stedi CAS" button.

const STEDI_API_KEY = process.env.STEDI_API_KEY || ''

const STEDI_POLL_TRANSACTIONS_URL =
  'https://healthcare.us.stedi.com/2024-04-01/polling/transactions'
const STEDI_835_REPORT_URL = (transactionId: string) =>
  `https://healthcare.us.stedi.com/2024-04-01/change/medicalnetwork/reports/v2/${transactionId}/835`

async function verifyProviderToken(authHeader: string | undefined): Promise<string> {
  if (!authHeader?.startsWith('Bearer ')) throw new Error('Missing token')
  const token = authHeader.slice(7)
  const region     = process.env.VITE_AWS_REGION || 'us-east-2'
  const userPoolId = process.env.VITE_AWS_USER_POOL_ID || ''
  const JWKS = createRemoteJWKSet(new URL(`https://cognito-idp.${region}.amazonaws.com/${userPoolId}/.well-known/jwks.json`))
  const { payload } = await jwtVerify(token, JWKS, { issuer: `https://cognito-idp.${region}.amazonaws.com/${userPoolId}` })
  if (!payload.sub) throw new Error('No sub in token')
  return payload.sub as string
}

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

async function findClaim(sql: any, pcn: string | null, payerClaimControlNumber: string | null, practiceId: string): Promise<any | null> {
  if (payerClaimControlNumber) {
    const rows = await sql`
      SELECT id FROM claims
      WHERE stedi_payer_claim_control_number = ${payerClaimControlNumber}
        AND practice_id = ${practiceId}::uuid
      LIMIT 1`
    if (rows[0]) return rows[0]
  }
  if (pcn) {
    const rows = await sql`
      SELECT id FROM claims
      WHERE REPLACE(id::text, '-', '') ILIKE ${pcn + '%'}
        AND practice_id = ${practiceId}::uuid
      LIMIT 1`
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
  const patientRespSubtotal = +(cas.patient_deductible + cas.patient_coinsurance + cas.patient_copay + cas.patient_non_covered).toFixed(2)
  const paidInFull = patientRespSubtotal === 0
  const [stmt] = await sql`SELECT id FROM patient_statements WHERE claim_id = ${claimId}::uuid LIMIT 1`
  if (stmt) {
    await sql`
      UPDATE patient_statements SET
        patient_deductible     = COALESCE(patient_deductible,     ${cas.patient_deductible}),
        patient_coinsurance    = COALESCE(patient_coinsurance,    ${cas.patient_coinsurance}),
        patient_copay          = COALESCE(patient_copay,          ${cas.patient_copay}),
        patient_non_covered    = COALESCE(patient_non_covered,    ${cas.patient_non_covered}),
        contractual_adjustment = COALESCE(contractual_adjustment, ${cas.contractual_adjustment}),
        total_amount_due       = CASE WHEN COALESCE(total_amount_due, 0) = 0 THEN ${patientRespSubtotal} ELSE total_amount_due END,
        total_amount_due_text  = CASE WHEN COALESCE(total_amount_due, 0) = 0 THEN ${String(patientRespSubtotal)} ELSE total_amount_due_text END,
        remaining_balance      = CASE WHEN COALESCE(remaining_balance, 0) = 0 THEN COALESCE(amount_billed, 0) - COALESCE(insurance_payment, 0) - COALESCE(contractual_adjustment, ${cas.contractual_adjustment}, 0) ELSE remaining_balance END,
        status                 = CASE WHEN status = 'draft' AND ${paidInFull} THEN 'paid' ELSE status END,
        paid_at                = CASE WHEN status = 'draft' AND ${paidInFull} THEN NOW() ELSE paid_at END,
        updated_at             = NOW()
      WHERE id = ${stmt.id}`
  }
  if (payerClaimControlNumber) {
    await sql`UPDATE claims SET stedi_payer_claim_control_number = ${payerClaimControlNumber} WHERE id = ${claimId}::uuid AND stedi_payer_claim_control_number IS NULL`
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  let sub: string
  try {
    sub = await verifyProviderToken(req.headers.authorization)
  } catch {
    return res.status(401).json({ error: 'Unauthorized' })
  }
  if (!STEDI_API_KEY) return res.status(500).json({ error: 'STEDI_API_KEY not configured' })

  const sql = neon(process.env.DATABASE_URL!)
  const [provider] = await sql`SELECT id, is_admin, practice_id FROM providers WHERE cognito_sub = ${sub} LIMIT 1`
  if (!provider) return res.status(403).json({ error: 'Provider not found' })
  if (!provider.is_admin) return res.status(403).json({ error: 'Admin only' })

  const days = Math.max(1, Math.min(365, Number(req.query.days ?? '60') || 60))
  const startDateTime = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()

  try { await sql`ALTER TABLE claims ADD COLUMN IF NOT EXISTS stedi_payer_claim_control_number text` } catch {}
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS stedi_transactions_processed (
        transaction_id text PRIMARY KEY,
        processed_at timestamptz NOT NULL DEFAULT NOW(),
        matched_claim_count integer NOT NULL DEFAULT 0,
        source text
      )`
  } catch {}

  const summary = {
    days,
    startDateTime,
    transactionsSeen: 0,
    transactionsProcessed: 0,
    skippedNotEra: 0,
    skippedAlreadyProcessed: 0,
    claimsUpdated: 0,
    pagesFetched: 0,
    errors: [] as string[],
    sampleTimeline: '' as string,
  }

  try {
    let pageToken: string | undefined = undefined
    const seenIds = new Set<string>()
    // Cap total pages to prevent runaway calls — 25 × 500 = 12.5k
    // transactions per backfill is plenty for a small pediatric practice.
    for (let page = 0; page < 25; page++) {
      const params = new URLSearchParams()
      params.set('pageSize', '500')
      if (pageToken) params.set('pageToken', pageToken)
      else params.set('startDateTime', startDateTime)

      const listRes = await fetch(`${STEDI_POLL_TRANSACTIONS_URL}?${params}`, {
        headers: { Authorization: `Key ${STEDI_API_KEY}`, 'Content-Type': 'application/json' },
      })
      summary.pagesFetched += 1
      if (!listRes.ok) {
        const body = await listRes.text().catch(() => '')
        summary.errors.push(`poll-transactions p${page}: ${listRes.status} ${body.slice(0, 200)}`)
        break
      }
      const list = await listRes.json()
      const items: any[] = list?.items ?? []
      pageToken = list?.nextPageToken

      for (const tx of items) {
        const transactionId: string | undefined = tx?.transactionId
        if (!transactionId || seenIds.has(transactionId)) continue
        seenIds.add(transactionId)

        const arts: any[] = Array.isArray(tx?.artifacts) ? tx.artifacts : []
        const is835 = arts.some(a =>
          String(a?.artifactType ?? '').toLowerCase().includes('835') ||
          String(a?.model ?? '').toLowerCase().includes('remittance'))
        if (tx?.direction !== 'INBOUND' || !is835 || tx?.status !== 'succeeded') {
          summary.skippedNotEra += 1
          continue
        }
        summary.transactionsSeen += 1

        const [prior] = await sql`SELECT 1 FROM stedi_transactions_processed WHERE transaction_id = ${transactionId} LIMIT 1`
        if (prior) { summary.skippedAlreadyProcessed += 1; continue }

        const reportRes = await fetch(STEDI_835_REPORT_URL(transactionId), {
          headers: { Authorization: `Key ${STEDI_API_KEY}`, 'Content-Type': 'application/json' },
        })
        if (!reportRes.ok) {
          summary.errors.push(`835 ${transactionId}: ${reportRes.status}`)
          continue
        }
        const era835 = await reportRes.json()
        if (!summary.sampleTimeline) summary.sampleTimeline = JSON.stringify(era835).slice(0, 1200)

        let matchedThis = 0
        for (const cp of extractClaimPayments(era835)) {
          try {
            const claim = await findClaim(sql, cp.pcn, cp.payerClaimControlNumber, provider.practice_id)
            if (!claim) continue
            const cas = parseCasAdjustments(cp.scoped)
            await applyCasToClaim(sql, claim.id, cas, cp.payerClaimControlNumber)
            matchedThis += 1
          } catch (perErr: any) {
            summary.errors.push(`apply ${transactionId}: ${perErr?.message ?? String(perErr)}`)
          }
        }
        summary.transactionsProcessed += 1
        summary.claimsUpdated += matchedThis
        await sql`
          INSERT INTO stedi_transactions_processed (transaction_id, matched_claim_count, source)
          VALUES (${transactionId}, ${matchedThis}, 'backfill')
          ON CONFLICT (transaction_id) DO UPDATE SET
            matched_claim_count = EXCLUDED.matched_claim_count,
            processed_at = NOW()`
      }
      if (!pageToken) break
    }
    return res.status(200).json({ ok: true, ...summary })
  } catch (e: any) {
    console.error('[backfill-stedi-cas] error:', e)
    return res.status(200).json({ ok: false, ...summary, errors: [...summary.errors, e?.message ?? String(e)] })
  }
}
