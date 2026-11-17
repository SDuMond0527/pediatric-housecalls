import type { VercelRequest, VercelResponse } from '@vercel/node'
import { neon, type NeonQueryFunction } from '@neondatabase/serverless'
import { createRemoteJWKSet, jwtVerify } from 'jose'

// X12 276 claim-status inquiry via Stedi. Called in two ways:
//   1. Per-claim trigger — POST /api/stedi/claim-status with { claim_id }.
//      Used by the "Check status" button on a submitted claim card.
//   2. Batched from the daily stale-claims cron — the cron imports
//      runClaimStatusCheck() for each aged claim.
//
// The response is bucketed into one of five outcomes (see classify277):
//   - pending            : payer has it, in process. No action.
//   - era_pending        : payer has finalized adjudication. ERA imminent.
//   - not_on_file        : payer says they never received it. Actionable
//                           — inserts a 'payer_never_received' review
//                           queue item so the biller can approve resubmit.
//   - rejected_intake    : payer rejected pre-adjudication. Writes the
//                           same claim_rejection_* fields a passive 277
//                           would, so it lands in Rework via existing
//                           isInRework logic.
//   - unknown            : we couldn't classify; biller sees raw message.
//
// Sara 2026-11-17. Pattern matches the eligibility caller (eligibility.ts).

const STEDI_API_KEY = process.env.STEDI_API_KEY || ''
const STEDI_CLAIM_STATUS_URL =
  'https://healthcare.us.stedi.com/2024-04-01/change/medicalnetwork/claimstatus/v2'

// CSCC (X12 claim status category) buckets. Reuses the rejection set
// from stedi-transaction.ts so the semantics of "intake rejection"
// stay in lock-step with the passive 277 webhook path.
const REJECTION_CATEGORIES_277 = new Set(['A3', 'A4', 'A5', 'A6', 'A7', 'A8', 'R4'])
const FINALIZED_CATEGORIES     = new Set(['F0', 'F1', 'F2', 'F3', 'F3F', 'F4', 'F5'])
// "Not on file" signals the payer actively told us they don't have the
// claim. These codes come from either the category (D0 = Data search)
// or the specific status codes 24 / 31 / 35 (entity / claim not found).
const NOT_ON_FILE_CATEGORIES = new Set(['D0'])
const NOT_ON_FILE_STATUS_CODES = new Set(['24', '31', '35'])

export type StatusBucket =
  | 'pending'
  | 'era_pending'
  | 'not_on_file'
  | 'rejected_intake'
  | 'unknown'

export type ClassifiedStatus = {
  bucket: StatusBucket
  category_code: string | null
  status_code: string | null
  message: string | null
}

type StatusEntry = {
  category: string | null
  code: string | null
  description: string | null
}

function fmtDate8(d: unknown): string {
  if (!d) return ''
  // Neon date columns come back as JS Date objects — String(dateObj) is
  // "Fri Oct 09 2026 00:00:00 GMT-0400", which slice(0,10) mangles into
  // "Fri Oct 09" and Stedi rejects with its YYYYMMDD regex. Always
  // route Date → toISOString first. See memory
  // feedback_neon_date_columns_toisostring.md.
  const s = d instanceof Date
    ? d.toISOString().slice(0, 10)
    : String(d).slice(0, 10)
  return s.replace(/-/g, '')
}

function digitsOnly(s: unknown): string {
  return String(s ?? '').replace(/\D/g, '')
}

// Extract every (category, code, description) tuple from a parsed
// Stedi 277 response. Stedi returns the shape documented at
// stedi.com/docs/healthcare/api-reference under claim-status. We walk
// defensively because Stedi occasionally shifts nesting between
// versions (same lesson as the 277 webhook parser).
function extractStatuses(resp: any): StatusEntry[] {
  const out: StatusEntry[] = []
  const push = (category: any, code: any, description: any) => {
    out.push({
      category: category ? String(category) : null,
      code:     code ? String(code) : null,
      description: description ? String(description) : null,
    })
  }
  // Top-level claim info (most common place for a single-claim query)
  const ci = resp?.claimInformation ?? resp?.claimStatusResponse?.claimInformation ?? null
  if (ci) {
    const infos = Array.isArray(ci.statusInformation) ? ci.statusInformation
                : Array.isArray(ci.claimStatusInformation) ? ci.claimStatusInformation
                : []
    for (const si of infos) push(si?.categoryCode, si?.statusCode, si?.statusCodeDescription ?? si?.description)
  }
  // Nested payer -> claimStatusTransactions -> claimStatusDetails -> claims
  const payers = Array.isArray(resp?.payers) ? resp.payers : []
  for (const p of payers) {
    const txs = Array.isArray(p?.claimStatusTransactions) ? p.claimStatusTransactions : []
    for (const tx of txs) {
      const batches = Array.isArray(tx?.claimStatusDetails) ? tx.claimStatusDetails : []
      for (const b of batches) {
        const claims = Array.isArray(b?.claims) ? b.claims : []
        for (const c of claims) {
          const cs = c?.claimStatus
          if (cs) push(cs?.categoryCode, cs?.statusCode, cs?.statusCodeDescription ?? cs?.description)
          const infos = Array.isArray(c?.statusInformation) ? c.statusInformation : []
          for (const si of infos) push(si?.categoryCode, si?.statusCode, si?.statusCodeDescription ?? si?.description)
        }
      }
    }
  }
  // Fallback — top-level errors array (used when Stedi itself can't
  // reach the payer; treated as 'unknown' downstream).
  if (Array.isArray(resp?.errors) && out.length === 0) {
    for (const e of resp.errors) push(null, e?.code, e?.description ?? e?.message)
  }
  return out
}

// Rank statuses by severity for picking the one we store. Order:
// rejected_intake > not_on_file > era_pending > pending > unknown.
export function classify277(resp: any): ClassifiedStatus {
  const statuses = extractStatuses(resp)
  const compact = statuses.filter(s => s.category || s.code)
  if (compact.length === 0) {
    return { bucket: 'unknown', category_code: null, status_code: null, message: 'No status in payer response' }
  }
  // Scan in priority order so a "rejected" + "pending" response still
  // classifies as rejected.
  const pick = (test: (s: StatusEntry) => boolean): StatusEntry | null => compact.find(test) ?? null
  const rejected = pick(s => s.category != null && REJECTION_CATEGORIES_277.has(s.category))
  if (rejected) return { bucket: 'rejected_intake', category_code: rejected.category, status_code: rejected.code, message: rejected.description }

  const notOnFile = pick(s =>
    (s.category != null && NOT_ON_FILE_CATEGORIES.has(s.category)) ||
    (s.code != null && NOT_ON_FILE_STATUS_CODES.has(s.code))
  )
  if (notOnFile) return { bucket: 'not_on_file', category_code: notOnFile.category, status_code: notOnFile.code, message: notOnFile.description }

  const finalized = pick(s => s.category != null && FINALIZED_CATEGORIES.has(s.category))
  if (finalized) return { bucket: 'era_pending', category_code: finalized.category, status_code: finalized.code, message: finalized.description }

  // Everything that's acknowledged / in-process falls through to pending.
  const first = compact[0]
  return { bucket: 'pending', category_code: first.category, status_code: first.code, message: first.description }
}

export type ClaimForStatus = {
  id: string
  practice_id: string
  stedi_claim_id: string | null
  payer_control_number: string | null
  payer_id: string | null
  payer_name: string | null
  service_date: string | null
  total_charge: number | string | null
  patient_first_name: string | null
  patient_last_name: string | null
  patient_dob: string | null
  child_id: string | null
}

type SubscriberRow = {
  insurance_member_id: string | null
  insurance_subscriber_name: string | null
  insurance_subscriber_dob: string | null
  insurance_dependent_code: string | null
  insurance_no_dependent_code: boolean | null
  subscriber_first: string
  subscriber_last: string
}

// Same suffix-stripping logic as eligibility.ts so Stedi's subscriber
// lookup matches. "Edward J Wood IV" → first: "Edward J", last: "Wood".
const SUBSCRIBER_SUFFIXES = new Set(['JR', 'JR.', 'SR', 'SR.', 'II', 'III', 'IV', 'V', 'VI'])
function parseSubName(name: string): { first: string; last: string } {
  if (!name?.trim()) return { first: '', last: '' }
  if (name.includes(', ')) {
    const [last, first] = name.split(', ')
    return { first: first ?? '', last: last ?? '' }
  }
  let parts = name.trim().split(/\s+/)
  if (parts.length > 1 && SUBSCRIBER_SUFFIXES.has(parts[parts.length - 1].toUpperCase())) {
    parts = parts.slice(0, -1)
  }
  if (parts.length === 1) return { first: '', last: parts[0] }
  return { first: parts.slice(0, -1).join(' '), last: parts[parts.length - 1] }
}

async function loadSubscriber(sql: NeonQueryFunction<false, false>, childId: string | null): Promise<SubscriberRow | null> {
  if (!childId) return null
  const [row] = await sql`
    SELECT insurance_member_id, insurance_subscriber_name,
           insurance_subscriber_dob::text AS insurance_subscriber_dob,
           insurance_dependent_code, insurance_no_dependent_code
    FROM children WHERE id = ${childId}::uuid LIMIT 1`
  if (!row) return null
  const { first, last } = parseSubName(String((row as any).insurance_subscriber_name ?? ''))
  return { ...(row as any), subscriber_first: first, subscriber_last: last } as SubscriberRow
}

function buildMemberId(sub: SubscriberRow | null): string {
  if (!sub) return ''
  const raw = String(sub.insurance_member_id ?? '').trim()
  if (!raw) return ''
  if (sub.insurance_no_dependent_code) return raw
  const dep = String(sub.insurance_dependent_code ?? '').trim()
  return dep ? raw + dep : raw
}

export async function bootstrapPayerStatusColumns(sql: NeonQueryFunction<false, false>) {
  try { await sql`ALTER TABLE claims ADD COLUMN IF NOT EXISTS payer_status_bucket     text` } catch {}
  try { await sql`ALTER TABLE claims ADD COLUMN IF NOT EXISTS payer_status_code       text` } catch {}
  try { await sql`ALTER TABLE claims ADD COLUMN IF NOT EXISTS payer_status_category   text` } catch {}
  try { await sql`ALTER TABLE claims ADD COLUMN IF NOT EXISTS payer_status_message    text` } catch {}
  try { await sql`ALTER TABLE claims ADD COLUMN IF NOT EXISTS payer_status_checked_at timestamptz` } catch {}
  try { await sql`ALTER TABLE claims ADD COLUMN IF NOT EXISTS payer_status_raw        jsonb` } catch {}
}

// Builds the 276 payload and POSTs it. Returns the parsed response or
// throws on transport / API error.
async function post276(claim: ClaimForStatus, sub: SubscriberRow | null): Promise<any> {
  const memberId = buildMemberId(sub)
  const subscriberFirst = sub?.subscriber_first || claim.patient_first_name || ''
  const subscriberLast  = sub?.subscriber_last  || claim.patient_last_name  || ''
  const subscriberDob   = sub?.insurance_subscriber_dob ?? claim.patient_dob ?? null

  const payload: any = {
    controlNumber: Date.now().toString().slice(-9),
    tradingPartnerServiceId: claim.payer_id,
    // X12 276 wants a providers ARRAY (unlike 270 eligibility which uses
    // a singular `provider` object). Stedi validation rejects the
    // singular form with `missing field `providers` at line 1 column N`.
    // Sara 2026-11-17 caught via live Check-status click.
    providers: [{
      organizationName: process.env.PRACTICE_NAME || 'Pediatric House Calls PLLC',
      npi: process.env.PRACTICE_NPI || '1093250904',
      providerType: 'BillingProvider',
    }],
    subscriber: {
      ...(memberId ? { memberId } : {}),
      ...(subscriberFirst ? { firstName: subscriberFirst } : {}),
      lastName: subscriberLast || subscriberFirst || 'Unknown',
      ...(subscriberDob ? { dateOfBirth: fmtDate8(subscriberDob) } : {}),
    },
    claimInformation: {
      ...(claim.stedi_claim_id ? { patientControlNumber: claim.stedi_claim_id } : {}),
      ...(claim.payer_control_number ? { payerControlNumber: claim.payer_control_number } : {}),
      ...(claim.total_charge != null ? { totalClaimChargeAmount: String(claim.total_charge) } : {}),
      ...(claim.service_date
        ? {
            serviceDate: fmtDate8(claim.service_date),
            fromServiceDate: fmtDate8(claim.service_date),
            toServiceDate: fmtDate8(claim.service_date),
          }
        : {}),
    },
  }
  // If subscriber ≠ patient (e.g. parent is policyholder, child is patient),
  // Stedi wants a dependents block. We only add it when names actually
  // differ so single-member policies don't get a spurious dependent.
  const patientFirst = claim.patient_first_name ?? ''
  const patientLast  = claim.patient_last_name  ?? ''
  const namesDiffer =
    patientFirst.trim().toLowerCase() !== subscriberFirst.trim().toLowerCase() ||
    patientLast.trim().toLowerCase()  !== subscriberLast.trim().toLowerCase()
  if (namesDiffer && patientFirst && patientLast) {
    payload.dependents = [{
      firstName:   patientFirst,
      lastName:    patientLast,
      ...(claim.patient_dob ? { dateOfBirth: fmtDate8(claim.patient_dob) } : {}),
    }]
  }

  const resp = await fetch(STEDI_CLAIM_STATUS_URL, {
    method: 'POST',
    headers: {
      Authorization: `Key ${STEDI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  })
  const data = await resp.json().catch(() => ({ parse_error: true }))
  if (!resp.ok) {
    const err = new Error(
      `Stedi 276 returned ${resp.status}: ${data?.message ?? data?.error ?? JSON.stringify(data).slice(0, 300)}`
    )
    ;(err as any).raw = data
    throw err
  }
  return data
}

export type RunStatusCheckResult = {
  bucket: StatusBucket
  category_code: string | null
  status_code: string | null
  message: string | null
  raw: any
  side_effect: 'none' | 'queued_payer_never_received' | 'moved_to_rework'
}

// End-to-end check for one claim: run 276, classify, persist, side-effect.
// Used by both the per-claim trigger endpoint and the daily cron.
export async function runClaimStatusCheck(
  sql: NeonQueryFunction<false, false>,
  claim: ClaimForStatus,
  opts?: { triggeredBy?: string }
): Promise<RunStatusCheckResult> {
  if (!STEDI_API_KEY) throw new Error('STEDI_API_KEY not configured')
  if (!claim.payer_id) throw new Error('Claim has no payer_id — cannot run status inquiry')

  await bootstrapPayerStatusColumns(sql)
  const sub = await loadSubscriber(sql, claim.child_id)
  const raw = await post276(claim, sub)
  const result = classify277(raw)

  // Persist on the claim regardless of bucket.
  await sql`
    UPDATE claims SET
      payer_status_bucket     = ${result.bucket},
      payer_status_category   = ${result.category_code},
      payer_status_code       = ${result.status_code},
      payer_status_message    = ${result.message},
      payer_status_checked_at = NOW(),
      payer_status_raw        = ${JSON.stringify(raw)}::jsonb,
      updated_at              = NOW()
    WHERE id = ${claim.id}::uuid`

  let sideEffect: RunStatusCheckResult['side_effect'] = 'none'

  // Bucket-specific side effects.
  if (result.bucket === 'rejected_intake') {
    // Mirror the passive 277 webhook path so the claim lands in Rework
    // via existing isInRework logic. Only overwrite claim_rejection_at
    // if the claim isn't already in that state (preserves original
    // rejection timestamp if we're re-confirming).
    await sql`
      UPDATE claims SET
        claim_rejection_at = COALESCE(claim_rejection_at, NOW()),
        claim_rejection_response = ${JSON.stringify(raw)}::jsonb,
        claim_rejection_reasons = ${JSON.stringify([{
          category_code: result.category_code,
          status_code: result.status_code,
          description: result.message,
          source: '276-inquiry',
        }])}::jsonb,
        updated_at = NOW()
      WHERE id = ${claim.id}::uuid
        AND claim_rejection_at IS NULL`
    sideEffect = 'moved_to_rework'
  } else if (result.bucket === 'not_on_file') {
    // Insert a payer_never_received review-queue item. Idempotent
    // against the same open item per claim via the partial unique
    // index established by the stale-claims cron.
    const patientName = [claim.patient_first_name, claim.patient_last_name].filter(Boolean).join(' ') || 'Unknown patient'
    const summary = `Payer "${claim.payer_name ?? claim.payer_id}" reports no record of this claim (Not on file / Never received). Approve resubmit to re-queue for the biller.`
    const reasoning = {
      source: '276-inquiry',
      triggered_by: opts?.triggeredBy ?? null,
      bucket: result.bucket,
      category_code: result.category_code,
      status_code: result.status_code,
      status_message: result.message,
      checked_at: new Date().toISOString(),
    }
    try {
      await sql`
        INSERT INTO review_queue_items
          (practice_id, item_type, work_category, claim_id, patient_name,
           payer_name, service_date, priority, summary, agent_reasoning)
        VALUES
          (${claim.practice_id}::uuid, 'payer_never_received', 'claim_submission', ${claim.id}::uuid,
           ${patientName}, ${claim.payer_name ?? null}, ${claim.service_date ?? null}::date,
           40, ${summary}, ${JSON.stringify(reasoning)}::jsonb)
        ON CONFLICT (practice_id, claim_id, item_type) WHERE status = 'open' DO UPDATE SET
          summary         = EXCLUDED.summary,
          agent_reasoning = EXCLUDED.agent_reasoning`
    } catch (e: any) {
      // Fallback for schemas without the partial unique index — same
      // check-then-insert pattern as stale-claims.ts.
      const [existing] = await sql`
        SELECT id FROM review_queue_items
        WHERE practice_id = ${claim.practice_id}::uuid
          AND claim_id    = ${claim.id}::uuid
          AND item_type   = 'payer_never_received'
          AND status      = 'open'
        LIMIT 1`
      if (existing) {
        await sql`
          UPDATE review_queue_items
          SET summary = ${summary}, agent_reasoning = ${JSON.stringify(reasoning)}::jsonb
          WHERE id = ${existing.id}::uuid`
      } else {
        await sql`
          INSERT INTO review_queue_items
            (practice_id, item_type, work_category, claim_id, patient_name,
             payer_name, service_date, priority, summary, agent_reasoning)
          VALUES
            (${claim.practice_id}::uuid, 'payer_never_received', 'claim_submission', ${claim.id}::uuid,
             ${patientName}, ${claim.payer_name ?? null}, ${claim.service_date ?? null}::date,
             40, ${summary}, ${JSON.stringify(reasoning)}::jsonb)`
      }
    }
    sideEffect = 'queued_payer_never_received'
  }

  return { ...result, raw, side_effect: sideEffect }
}

// Super-admin-only token verification — matches the pattern used by the
// rest of /api/claims and /api/review-queue so there's one source of
// truth for admin-only auth.
async function verifyProviderToken(authHeader: string | undefined): Promise<string> {
  if (!authHeader?.startsWith('Bearer ')) throw new Error('Missing token')
  const token = authHeader.slice(7)
  const region = process.env.VITE_AWS_REGION || 'us-east-2'
  const poolId = process.env.VITE_AWS_USER_POOL_ID || ''
  const JWKS = createRemoteJWKSet(new URL(`https://cognito-idp.${region}.amazonaws.com/${poolId}/.well-known/jwks.json`))
  const { payload } = await jwtVerify(token, JWKS, { issuer: `https://cognito-idp.${region}.amazonaws.com/${poolId}` })
  if (!payload.sub) throw new Error('No sub in token')
  return payload.sub as string
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  let sub: string
  try { sub = await verifyProviderToken(req.headers.authorization) }
  catch { return res.status(401).json({ error: 'Unauthorized' }) }

  if (!STEDI_API_KEY) return res.status(500).json({ error: 'STEDI_API_KEY not configured' })

  const sql = neon(process.env.DATABASE_URL!)
  const [provider] = await sql`SELECT id, practice_id, is_admin, is_super_admin FROM providers WHERE cognito_sub = ${sub} LIMIT 1`
  if (!provider) return res.status(403).json({ error: 'Provider not found' })
  if (!provider.is_admin && !provider.is_super_admin) return res.status(403).json({ error: 'Admin only' })

  const body = req.body as { claim_id?: string }
  const claimId = String(body?.claim_id ?? '').trim()
  if (!claimId) return res.status(400).json({ error: 'claim_id required' })

  const [claim] = await sql`
    SELECT id, practice_id, stedi_claim_id, payer_control_number, payer_id, payer_name,
           service_date::text AS service_date, total_charge,
           patient_first_name, patient_last_name, patient_dob::text AS patient_dob,
           child_id
    FROM claims
    WHERE id = ${claimId}::uuid AND practice_id = ${provider.practice_id}::uuid
    LIMIT 1`
  if (!claim) return res.status(404).json({ error: 'Claim not found' })

  try {
    const result = await runClaimStatusCheck(sql, claim as ClaimForStatus, { triggeredBy: 'manual-check-status' })
    return res.status(200).json({ ok: true, ...result })
  } catch (e: any) {
    console.error('[claim-status] inquiry failed:', e?.message, e?.raw)
    return res.status(502).json({ error: e?.message ?? 'Claim status inquiry failed', details: e?.raw ?? null })
  }
}

// Only — digits-only helper kept for callers that need a bare NPI.
export { digitsOnly }
