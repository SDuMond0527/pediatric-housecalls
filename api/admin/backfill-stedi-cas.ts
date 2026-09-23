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

// Polling endpoint lives on Stedi's "core" API host, not healthcare.
// See note in api/cron/stedi-era-poll.ts. Previous URL
// healthcare.us.stedi.com/2024-04-01/polling/transactions was 404.
const STEDI_POLL_TRANSACTIONS_URL =
  'https://core.us.stedi.com/2026-06-01/polling/transactions'
const STEDI_835_REPORT_URL = (transactionId: string) =>
  `https://healthcare.us.stedi.com/2024-04-01/change/medicalnetwork/reports/v2/${transactionId}/835`
// Same URL family, 277 suffix. If Stedi returns 404, the fetch failure
// gets recorded in stedi_transactions_processed with source
// '277-backfill-fetch-fail' so we can iterate on the URL without
// stalling the rest of the backfill.
const STEDI_277_REPORT_URL = (transactionId: string) =>
  `https://healthcare.us.stedi.com/2024-04-01/change/medicalnetwork/reports/v2/${transactionId}/277`

// 277 rejection status categories — must match the constants in the
// webhook and the manual attach endpoint.
const REJECTION_CATEGORIES_277 = new Set(['A3', 'A4', 'A6', 'A7', 'A8'])

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

// ── ADDITIVE denial-code extractor (2026-09-16) ────────────────────────────
// Duplicated verbatim from api/stedi/era.ts and
// api/cron/stedi-era-poll.ts. Runs alongside existing bucketing without
// modifying it. Callers wrap in try/catch — cannot break ERA backfill.
type DenialCodeEntry = { group_code: string; reason_code: string; amount: number }
function extractDenialCodes(era835: any): DenialCodeEntry[] {
  const entries: DenialCodeEntry[] = []
  try {
    const addAdj = (adj: any) => {
      if (!adj || typeof adj !== 'object') return
      const groupCode = String(adj.claimAdjustmentGroupCode ?? adj.adjustmentGroupCode ?? adj.groupCode ?? '')
      let sawFlat = false
      for (let i = 1; i <= 6; i++) {
        const reason = adj[`adjustmentReasonCode${i}`]
        const amount = adj[`adjustmentAmount${i}`]
        if (reason == null && amount == null) continue
        sawFlat = true
        entries.push({
          group_code: groupCode,
          reason_code: String(reason ?? ''),
          amount: parseFloat(String(amount ?? '0')) || 0,
        })
      }
      if (sawFlat) return
      const details = adj.claimAdjustmentDetails ?? adj.adjustmentDetails ?? null
      if (details && Array.isArray(details)) {
        for (const d of details) {
          entries.push({
            group_code: groupCode,
            reason_code: String(d.adjustmentReasonCode ?? d.reasonCode ?? ''),
            amount: parseFloat(String(d.adjustmentAmount ?? d.amount ?? '0')) || 0,
          })
        }
        return
      }
      entries.push({
        group_code: groupCode,
        reason_code: String(adj.adjustmentReasonCode ?? adj.reasonCode ?? ''),
        amount: parseFloat(String(adj.adjustmentAmount ?? adj.amount ?? '0')) || 0,
      })
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
  } catch (e) {
    // Defensive — return whatever we collected
  }
  return entries
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

// ── X12 277 Claim Acknowledgment parser (inlined — Vercel forbids api/lib) ──
// Duplicate of parseX12_277 in api/admin/attach-277-x12.ts and
// parseX12_277_full in api/webhooks/stedi-transaction.ts. If you change
// the shape, change all three.
type Parsed277Status = { category: string; code: string; entity: string; action: string; date: string; amount: number; message: string }
type Parsed277 = {
  patientControlNumber: string | null
  payerClaimControlNumber: string | null
  patientFirstName: string | null
  patientLastName: string | null
  serviceDateFrom: string | null
  serviceDateTo: string | null
  payerName: string | null
  transactionSetIdentifier: string | null
  statuses: Parsed277Status[]
  isRejection: boolean
}
function parseX12_277(text: string): Parsed277 {
  const out: Parsed277 = {
    patientControlNumber: null, payerClaimControlNumber: null,
    patientFirstName: null, patientLastName: null,
    serviceDateFrom: null, serviceDateTo: null,
    payerName: null, transactionSetIdentifier: null,
    statuses: [], isRejection: false,
  }
  if (!text || typeof text !== 'string') return out
  const segments = text.replace(/[\r\n]+/g, '').split('~').map(s => s.trim()).filter(Boolean)
  let currentHLLevel: string | null = null
  for (const seg of segments) {
    const fields = seg.split('*')
    const tag = fields[0]
    if (tag === 'ST') { out.transactionSetIdentifier = String(fields[1] ?? '').trim() || null; continue }
    if (tag === 'HL') { currentHLLevel = String(fields[3] ?? '').trim() || null; continue }
    if (tag === 'NM1') {
      const entity = String(fields[1] ?? '').trim()
      if (entity === 'QC') {
        out.patientLastName  = out.patientLastName  ?? (String(fields[3] ?? '').trim() || null)
        out.patientFirstName = out.patientFirstName ?? (String(fields[4] ?? '').trim() || null)
      }
      if (entity === 'PR') out.payerName = out.payerName ?? (String(fields[3] ?? '').trim() || null)
      continue
    }
    if (tag === 'TRN' && currentHLLevel === 'PT') {
      const v = String(fields[2] ?? '').trim()
      if (v && v !== '0' && !out.patientControlNumber) out.patientControlNumber = v
      continue
    }
    if (tag === 'REF' && String(fields[1] ?? '').trim() === '1K') {
      out.payerClaimControlNumber = String(fields[2] ?? '').trim() || null
      continue
    }
    if (tag === 'DTP' && String(fields[1] ?? '').trim() === '472') {
      const raw = String(fields[3] ?? '').trim()
      const parts = raw.split('-')
      const iso = (y: string) => y?.length === 8 ? `${y.slice(0,4)}-${y.slice(4,6)}-${y.slice(6,8)}` : null
      out.serviceDateFrom = iso(parts[0])
      out.serviceDateTo   = iso(parts[1] ?? parts[0])
      continue
    }
    if (tag === 'STC') {
      const composite = String(fields[1] ?? '')
      const parts = composite.split(/[`:]/)
      const category = String(parts[0] ?? '').trim()
      const code     = String(parts[1] ?? '').trim()
      const entity   = String(parts[2] ?? '').trim()
      const dateStr  = String(fields[2] ?? '').trim()
      const action   = String(fields[3] ?? '').trim()
      const amount   = parseFloat(String(fields[4] ?? '0')) || 0
      const messageParts: string[] = []
      for (let i = 12; i < fields.length; i++) { const p = String(fields[i] ?? '').trim(); if (p) messageParts.push(p) }
      const message = messageParts.join(' ').trim()
      out.statuses.push({ category, code, entity, action, date: dateStr, amount, message })
      if (REJECTION_CATEGORIES_277.has(category)) out.isRejection = true
      continue
    }
  }
  return out
}

// Attach a parsed 277 to whichever local claim its PCN matches. Uses
// the same findClaim helper as the 835 path so PCN matching behaves
// identically. Idempotent — COALESCE preserves the first-seen
// timestamp across repeated backfills.
async function attach277ToClaim(sql: any, parsed: Parsed277, rawX12: string, practiceId: string): Promise<{ matched: boolean; claimId?: string }> {
  try { await sql`ALTER TABLE claims ADD COLUMN IF NOT EXISTS claim_rejection_at timestamptz` } catch {}
  try { await sql`ALTER TABLE claims ADD COLUMN IF NOT EXISTS claim_rejection_response jsonb` } catch {}
  try { await sql`ALTER TABLE claims ADD COLUMN IF NOT EXISTS claim_rejection_reasons jsonb` } catch {}
  try { await sql`ALTER TABLE claims ADD COLUMN IF NOT EXISTS claim_rejection_seen_at timestamptz` } catch {}
  try { await sql`ALTER TABLE claims ADD COLUMN IF NOT EXISTS claim_rejection_handled_at timestamptz` } catch {}
  try { await sql`ALTER TABLE claims ADD COLUMN IF NOT EXISTS claim_rejection_handled_by_name text` } catch {}
  try { await sql`ALTER TABLE claims ADD COLUMN IF NOT EXISTS claim_rejection_handling_notes text` } catch {}

  const claim = await findClaim(sql, parsed.patientControlNumber, parsed.payerClaimControlNumber, practiceId)
  if (!claim) return { matched: false }

  const reasons = parsed.statuses
    .filter(s => REJECTION_CATEGORIES_277.has(s.category))
    .map(s => ({ category: s.category, code: s.code, entity: s.entity, action: s.action, amount: s.amount, message: s.message }))

  const responsePayload = { parsed, rawX12 }

  await sql`
    UPDATE claims SET
      claim_rejection_at       = COALESCE(claim_rejection_at, NOW()),
      claim_rejection_response = ${JSON.stringify(responsePayload)}::jsonb,
      claim_rejection_reasons  = ${JSON.stringify(reasons)}::jsonb,
      updated_at               = NOW()
    WHERE id = ${claim.id}::uuid`
  return { matched: true, claimId: claim.id }
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
    // 277 CA (Claim Acknowledgment / rejection) counters — separate
    // from 835 counters so the biller can tell at a glance how many
    // of each type landed in this backfill run.
    rejections277Seen: 0,
    rejections277Attached: 0,
    rejections277Unmatched: 0,
    rejections277SkippedAck: 0,
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
        const is277 = arts.some(a =>
          String(a?.artifactType ?? '').toLowerCase().includes('277') ||
          String(a?.model ?? '').toLowerCase().includes('claim status') ||
          String(a?.model ?? '').toLowerCase().includes('acknowledgment') ||
          String(a?.model ?? '').toLowerCase().includes('acknowledgement'))

        // ── 277 branch (Claim Acknowledgment / payer rejection at
        //    intake). Fetch the report, parse, match by PCN, attach
        //    as a claim rejection. Non-rejection acks (A1/A2) are
        //    recorded as processed so we don't re-fetch them next
        //    time but they don't touch any claim.
        const forceReprocess = req.query.force === '1'
        if (tx?.direction === 'INBOUND' && is277 && tx?.status === 'succeeded') {
          const [prior277] = await sql`SELECT 1 FROM stedi_transactions_processed WHERE transaction_id = ${transactionId} LIMIT 1`
          if (prior277 && !forceReprocess) { summary.skippedAlreadyProcessed += 1; continue }
          summary.rejections277Seen += 1
          try {
            const rr = await fetch(STEDI_277_REPORT_URL(transactionId), {
              headers: { Authorization: `Key ${STEDI_API_KEY}`, 'Content-Type': 'application/json' },
            })
            if (!rr.ok) {
              const b = await rr.text().catch(() => '')
              summary.errors.push(`277 ${transactionId}: ${rr.status} ${b.slice(0, 160)}`)
              await sql`
                INSERT INTO stedi_transactions_processed (transaction_id, matched_claim_count, source)
                VALUES (${transactionId}, 0, '277-backfill-fetch-fail')
                ON CONFLICT (transaction_id) DO UPDATE SET matched_claim_count = 0, processed_at = NOW()`
              continue
            }
            const body = await rr.json()
            const rawX12: string | null =
              (typeof body === 'object' && typeof body?.x12 === 'string') ? body.x12 :
              (typeof body === 'string') ? body : null
            if (!rawX12) {
              summary.errors.push(`277 ${transactionId}: no x12 field in report body; keys=${Object.keys(body ?? {}).join(',')}`)
              await sql`
                INSERT INTO stedi_transactions_processed (transaction_id, matched_claim_count, source)
                VALUES (${transactionId}, 0, '277-backfill-no-x12')
                ON CONFLICT (transaction_id) DO UPDATE SET matched_claim_count = 0, processed_at = NOW()`
              continue
            }
            const parsed = parseX12_277(rawX12)
            if (!parsed.isRejection) {
              // A1/A2 ack — not actionable, record as processed and move on.
              summary.rejections277SkippedAck += 1
              await sql`
                INSERT INTO stedi_transactions_processed (transaction_id, matched_claim_count, source)
                VALUES (${transactionId}, 0, '277-backfill-ack-only')
                ON CONFLICT (transaction_id) DO UPDATE SET matched_claim_count = 0, processed_at = NOW()`
              continue
            }
            const { matched, claimId } = await attach277ToClaim(sql, parsed, rawX12, provider.practice_id)
            if (matched) { summary.rejections277Attached += 1 } else { summary.rejections277Unmatched += 1 }
            await sql`
              INSERT INTO stedi_transactions_processed (transaction_id, matched_claim_count, source)
              VALUES (${transactionId}, ${matched ? 1 : 0}, '277-backfill')
              ON CONFLICT (transaction_id) DO UPDATE SET matched_claim_count = EXCLUDED.matched_claim_count, processed_at = NOW()`
            if (matched) console.log('[backfill-stedi-cas] 277 attached', transactionId, '→ claim', claimId)
          } catch (e277: any) {
            summary.errors.push(`277 ${transactionId} exception: ${e277?.message ?? String(e277)}`)
          }
          continue
        }

        if (tx?.direction !== 'INBOUND' || !is835 || tx?.status !== 'succeeded') {
          summary.skippedNotEra += 1
          continue
        }
        summary.transactionsSeen += 1

        // Force-reprocess mode: ?force=1 skips the idempotency guard so we
        // can re-fetch and re-parse transactions the webhook already
        // processed. Needed because the transaction webhook stores nothing
        // useful for downstream debug — it applies CAS then throws the
        // raw 835 away. Force lets us re-run against the actual payload.
        // (forceReprocess is declared once at the top of this loop for
        // the 277 branch; 835 branch reuses the same const.)
        const [prior] = await sql`SELECT 1 FROM stedi_transactions_processed WHERE transaction_id = ${transactionId} LIMIT 1`
        if (prior && !forceReprocess) { summary.skippedAlreadyProcessed += 1; continue }

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
            // ── ADDITIVE: preserve the raw 835 on the claim so parser bugs
            //             are debuggable without re-hitting Stedi. Only
            //             writes if not already set OR force=1. Never
            //             touches other era_* fields.
            try {
              await sql`ALTER TABLE claims ADD COLUMN IF NOT EXISTS era_raw_835 jsonb`
              if (forceReprocess) {
                await sql`UPDATE claims SET era_raw_835 = ${JSON.stringify(cp.scoped)}::jsonb WHERE id = ${claim.id}::uuid`
              } else {
                await sql`UPDATE claims SET era_raw_835 = COALESCE(era_raw_835, ${JSON.stringify(cp.scoped)}::jsonb) WHERE id = ${claim.id}::uuid`
              }
            } catch (rawErr: any) {
              console.error('[backfill-stedi-cas] era_raw_835 store failed (non-fatal):', rawErr?.message)
            }
            // ── ADDITIVE denial-code capture ─────────────────────────
            // Wrapped in try/catch; never blocks the backfill.
            try {
              await sql`ALTER TABLE claims ADD COLUMN IF NOT EXISTS denial_codes jsonb`
              const codes = extractDenialCodes(cp.scoped)
              if (codes.length > 0) {
                await sql`UPDATE claims SET denial_codes = ${JSON.stringify(codes)}::jsonb WHERE id = ${claim.id}::uuid`
              }
            } catch (denialErr: any) {
              console.error('[backfill-stedi-cas] denial-code capture failed (non-fatal):', denialErr?.message)
            }
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
