import type { VercelRequest, VercelResponse } from '@vercel/node'
import { neon } from '@neondatabase/serverless'
import { Webhook } from 'standardwebhooks'

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
// Same URL family; substituting the transaction type suffix. If Stedi
// returns 404, we log verbosely (the response body ends up in Vercel
// logs) so we can iterate on the URL if the guess is wrong. Whatever
// URL turns out to actually work, the pipeline below is agnostic to
// the response shape — it takes either parsed JSON or raw X12.
const STEDI_277_REPORT_URL = (transactionId: string) =>
  `https://healthcare.us.stedi.com/2024-04-01/change/medicalnetwork/reports/v2/${transactionId}/277`

// 277 status categories that count as REJECTIONS (as opposed to A1/A2
// acknowledgements). Must match the constant in
// api/admin/attach-277-x12.ts.
const REJECTION_CATEGORIES_277 = new Set(['A3', 'A4', 'A6', 'A7', 'A8'])

interface CasBreakdown {
  patient_deductible:     number
  patient_coinsurance:    number
  patient_copay:          number
  patient_non_covered:    number
  contractual_adjustment: number
}

// ── X12 835 parser (2026-09-16) ────────────────────────────────────────────
// Reads the raw X12 EDI text returned by /eras/{id}/x12 and pulls out
// every CLP (claim header) + subsequent CAS (adjustment) segments.
// This is the ONLY known Stedi endpoint that returns real CAS on Sara's
// subscription. Verified end-to-end 2026-09-16 — 28 of 315 remittances
// parsed successfully and populated real deductible / coinsurance /
// copay / non-covered / contractual amounts on matched claims.
// Duplicated in api/admin/refetch-known-eras.ts.
type ParsedX12Claim = {
  pcn: string
  payerClaimControlNumber: string
  totalCharge: number
  totalPaid: number
  patientResponsibility: number
  cas: Array<{ group: string; reason: string; amount: number }>
  remarks: string[]    // RARC codes from LQ / MOA / MIA segments (M127, N393, MA63, etc.)
}
function parseX12_835(text: string): ParsedX12Claim[] {
  const claims: ParsedX12Claim[] = []
  if (!text || typeof text !== 'string') return claims
  const segments = text.split('~').map(s => s.trim()).filter(Boolean)
  let current: ParsedX12Claim | null = null
  const looksLikeRarc = (s: string) => /^(?:M|MA|N)[A-Z]?\d+$/i.test(s)
  for (const seg of segments) {
    const fields = seg.split('*')
    const tag = fields[0]
    if (tag === 'CLP') {
      if (current) claims.push(current)
      current = {
        pcn:                    String(fields[1] ?? '').trim(),
        totalCharge:            parseFloat(String(fields[3] ?? '0')) || 0,
        totalPaid:              parseFloat(String(fields[4] ?? '0')) || 0,
        patientResponsibility:  parseFloat(String(fields[5] ?? '0')) || 0,
        payerClaimControlNumber: String(fields[7] ?? '').trim(),
        cas: [],
        remarks: [],
      }
    } else if (tag === 'CAS' && current) {
      const group = String(fields[1] ?? '').trim()
      for (let i = 2; i < fields.length; i += 3) {
        const reason = String(fields[i] ?? '').trim()
        const amount = parseFloat(String(fields[i + 1] ?? '0')) || 0
        if (reason && amount !== 0) {
          current.cas.push({ group, reason, amount })
        }
      }
    } else if (tag === 'LQ' && current) {
      // LQ*HE*<code> — remark code (RARC). Sometimes qualifier is omitted
      // and the code is in fields[1]. Accept both shapes.
      const codeType = String(fields[1] ?? '').trim()
      const code = String(fields[2] ?? '').trim() || codeType
      if (code && looksLikeRarc(code) && !current.remarks.includes(code)) {
        current.remarks.push(code)
      }
    } else if ((tag === 'MOA' || tag === 'MIA') && current) {
      // MOA and MIA can carry up to 5 remark codes in fields 3-7.
      for (let i = 3; i <= 7; i++) {
        const code = String(fields[i] ?? '').trim()
        if (code && looksLikeRarc(code) && !current.remarks.includes(code)) {
          current.remarks.push(code)
        }
      }
    }
  }
  if (current) claims.push(current)
  return claims
}

// CARC group=CO codes that are TRULY contractual (a real fee-schedule
// write-down the practice agreed to). Every other CO code is a denial
// / rejection / documentation request — must NOT be silently absorbed
// into `contractual_adjustment`, which used to hide Aetna's CO-252
// "records required" $495 on Carson Yates's ERA. Sara caught it
// 2026-09-16.
const CONTRACTUAL_CO_CODES = new Set(['45', '97', '24', '131', '137'])

function bucketCasFromX12(cas: Array<{ group: string; reason: string; amount: number }>): CasBreakdown {
  const totals: CasBreakdown = {
    patient_deductible: 0, patient_coinsurance: 0, patient_copay: 0,
    patient_non_covered: 0, contractual_adjustment: 0,
  }
  for (const c of cas) {
    if (c.group === 'PR') {
      switch (c.reason) {
        case '1':  totals.patient_deductible  += c.amount; break
        case '2':  totals.patient_coinsurance += c.amount; break
        case '3':  totals.patient_copay       += c.amount; break
        case '96': totals.patient_non_covered += c.amount; break
        default:   totals.patient_non_covered += c.amount; break
      }
    } else if (c.group === 'CO' && CONTRACTUAL_CO_CODES.has(c.reason)) {
      totals.contractual_adjustment += c.amount
    }
    // All other CO codes (denials + documentation requests) and OA/PI
    // are left OUT of the bucketed totals — surfaced separately via
    // claims.denial_codes + claims.remark_codes so the biller sees the
    // rejection in the UI banner instead of it being buried.
  }
  for (const k of Object.keys(totals) as (keyof CasBreakdown)[]) totals[k] = +totals[k].toFixed(2)
  return totals
}

// ── Ensure a draft patient_statement exists for a claim (2026-09-17) ───────
// Every ERA (even one that resolves to $0 patient responsibility) creates
// a draft statement so the biller has to actively review + confirm.
// Prevents Stedi CAS misreads from silently closing out a claim that
// actually needs medical records or has denial reasons the payer hasn't
// finalized. Duplicated verbatim into api/admin/refetch-known-eras.ts
// and api/cron/stedi-era-poll.ts (Vercel forbids api/lib helpers).
async function ensureStatementForClaim(
  sql: any,
  claimId: string,
  cas: CasBreakdown,
  amountBilled: number | null,
  insurancePayment: number | null,
): Promise<{ created: boolean; statementId?: string }> {
  const [existing] = await sql`SELECT id FROM patient_statements WHERE claim_id = ${claimId}::uuid LIMIT 1`
  if (existing) return { created: false, statementId: existing.id as string }

  const [claim] = await sql`
    SELECT
      cl.id, cl.practice_id, cl.child_id, cl.appointment_id, cl.service_date,
      cl.cpt_codes, cl.patient_first_name, cl.patient_last_name, cl.patient_dob,
      ch.parent_email, ch.parent_phone,
      fp.email AS family_email, fp.phone AS family_phone
    FROM claims cl
    LEFT JOIN children ch ON ch.id = COALESCE(cl.child_id, (SELECT child_id FROM appointments WHERE id = cl.appointment_id LIMIT 1))
    LEFT JOIN family_profiles fp ON fp.id = ch.family_id
    WHERE cl.id = ${claimId}::uuid
    LIMIT 1
  `
  if (!claim) return { created: false }

  const patientResp = +(
    (cas.patient_copay ?? 0) +
    (cas.patient_deductible ?? 0) +
    (cas.patient_coinsurance ?? 0) +
    (cas.patient_non_covered ?? 0)
  ).toFixed(2)
  const remaining = +((amountBilled ?? 0) - (insurancePayment ?? 0) - (cas.contractual_adjustment ?? 0)).toFixed(2)
  const email = claim.parent_email ?? claim.family_email ?? null
  const phone = claim.parent_phone ?? claim.family_phone ?? null

  const [row] = await sql`
    INSERT INTO patient_statements (
      practice_id, claim_id,
      patient_first_name, patient_last_name, patient_dob,
      date_of_service, cpt_codes,
      patient_email, patient_phone,
      amount_billed, insurance_payment, contractual_adjustment,
      patient_copay, patient_deductible, patient_coinsurance, patient_non_covered,
      remaining_balance, prior_balance, total_amount_due, total_amount_due_text,
      status, created_at, updated_at
    ) VALUES (
      ${claim.practice_id}::uuid, ${claim.id},
      ${claim.patient_first_name}, ${claim.patient_last_name}, ${claim.patient_dob},
      ${claim.service_date}, ${JSON.stringify(claim.cpt_codes ?? [])}::jsonb,
      ${email}, ${phone},
      ${amountBilled}, ${insurancePayment}, ${cas.contractual_adjustment},
      ${cas.patient_copay}, ${cas.patient_deductible}, ${cas.patient_coinsurance}, ${cas.patient_non_covered},
      ${remaining}, 0, ${patientResp}, ${String(patientResp)},
      'draft', NOW(), NOW()
    )
    RETURNING id
  `
  return { created: true, statementId: row?.id as string }
}

// ── ADDITIVE denial-code extractor (2026-09-16) ────────────────────────────
// Duplicated verbatim from api/stedi/era.ts, api/cron/stedi-era-poll.ts,
// api/admin/backfill-stedi-cas.ts, api/admin/backfill-denial-codes.ts.
// Runs alongside existing CAS bucket logic without modifying it. Callers
// wrap the invocation in try/catch — cannot break this webhook.
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
    // Defensive
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

async function findClaim(sql: any, pcn: string | null, payerClaimControlNumber: string | null): Promise<any | null> {
  if (payerClaimControlNumber) {
    const rows = await sql`SELECT id FROM claims WHERE stedi_payer_claim_control_number = ${payerClaimControlNumber} LIMIT 1`
    if (rows[0]) return rows[0]
  }
  if (pcn) {
    // Prefer exact-match on the new short PCN (PEDS####) — every claim
    // submitted after 2026-09-23 uses this format.
    const shortRows = await sql`SELECT id FROM claims WHERE payer_control_number = ${pcn} LIMIT 1`
    if (shortRows[0]) return shortRows[0]
    // Fall back to the UUID-prefix match for legacy claims submitted
    // before the short-PCN format shipped.
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

// ── X12 277 Claim Acknowledgment parser ──────────────────────────────
// Full duplicate of api/admin/attach-277-x12.ts::parseX12_277 because
// Vercel forbids api/lib helpers (all logic must live within the api/
// endpoint file that uses it). If the shape needs to change, update
// both.
type Parsed277Status = { category: string; code: string; entity: string; action: string; date: string; amount: number; message: string }
type Parsed277Full = {
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
function parseX12_277_full(text: string): Parsed277Full {
  const out: Parsed277Full = {
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

// Attach a parsed 277 to whichever local claim the PCN matches. Same
// findClaim + column bootstraps as the manual attach endpoint. Idempotent
// (COALESCE on claim_rejection_at so the first-seen timestamp is
// preserved across repeated processing).
async function attach277ToClaim(sql: any, parsed: Parsed277Full, rawX12: string | null): Promise<{ matched: boolean; claimId?: string }> {
  try { await sql`ALTER TABLE claims ADD COLUMN IF NOT EXISTS claim_rejection_at timestamptz` } catch {}
  try { await sql`ALTER TABLE claims ADD COLUMN IF NOT EXISTS claim_rejection_response jsonb` } catch {}
  try { await sql`ALTER TABLE claims ADD COLUMN IF NOT EXISTS claim_rejection_reasons jsonb` } catch {}
  try { await sql`ALTER TABLE claims ADD COLUMN IF NOT EXISTS claim_rejection_seen_at timestamptz` } catch {}
  try { await sql`ALTER TABLE claims ADD COLUMN IF NOT EXISTS claim_rejection_handled_at timestamptz` } catch {}
  try { await sql`ALTER TABLE claims ADD COLUMN IF NOT EXISTS claim_rejection_handled_by_name text` } catch {}
  try { await sql`ALTER TABLE claims ADD COLUMN IF NOT EXISTS claim_rejection_handling_notes text` } catch {}

  const claim = await findClaim(sql, parsed.patientControlNumber, parsed.payerClaimControlNumber)
  if (!claim) return { matched: false }

  const reasons = parsed.statuses
    .filter(s => REJECTION_CATEGORIES_277.has(s.category))
    .map(s => ({ category: s.category, code: s.code, entity: s.entity, action: s.action, amount: s.amount, message: s.message }))

  // Stash the raw X12 alongside the parsed shape so parser bugs are
  // debuggable without re-fetching from Stedi.
  const responsePayload = rawX12
    ? { parsed, rawX12 }
    : { parsed }

  await sql`
    UPDATE claims SET
      claim_rejection_at       = COALESCE(claim_rejection_at, NOW()),
      claim_rejection_response = ${JSON.stringify(responsePayload)}::jsonb,
      claim_rejection_reasons  = ${JSON.stringify(reasons)}::jsonb,
      updated_at               = NOW()
    WHERE id = ${claim.id}::uuid`
  return { matched: true, claimId: claim.id }
}

async function readRawBody(req: VercelRequest): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req as unknown as AsyncIterable<Buffer>) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
  }
  return Buffer.concat(chunks).toString('utf-8')
}

// Delegates verification to the audited `standardwebhooks` library —
// the exact same code Stedi's own docs (event-destinations-message-handling)
// point at as the reference implementation. Handles secret normalization
// (`whsec_` prefix / base64 decoding), signed-payload construction
// (`${id}.${timestamp}.${rawBody}`), and the space-separated
// `v1,BASE64SIG` header format. Throws on mismatch; returns void on ok.
function verifyStediSignature(headers: Record<string, string | string[] | undefined>, rawBody: string, secret: string): { ok: true } | { ok: false; reason: string } {
  try {
    const flatHeaders: Record<string, string> = {}
    for (const [k, v] of Object.entries(headers)) {
      if (v == null) continue
      flatHeaders[k.toLowerCase()] = Array.isArray(v) ? v[0] : v
    }
    const wh = new Webhook(secret)
    wh.verify(rawBody, flatHeaders)
    return { ok: true }
  } catch (e: any) {
    return { ok: false, reason: e?.message ?? String(e) }
  }
}

// Stedi's transaction.processed webhook wraps the payload in `v1Event`.
// The transaction UUID lives at v1Event.resource.id when resource.type
// is "transaction". Related X12 type (835, 277, 999, ...) is on
// v1Event.relatedResources[].type as e.g. "transaction.x12.835".
function extractTransactionInfo(body: any): { transactionId: string | null; x12Type: string | null; eventType: string | null } {
  if (!body) return { transactionId: null, x12Type: null, eventType: null }
  const v1 = body.v1Event ?? body
  const transactionId = v1?.resource?.id
    ?? v1?.transactionId
    ?? body.transactionId
    ?? body.data?.transactionId
    ?? null
  const relatedTypes = Array.isArray(v1?.relatedResources)
    ? v1.relatedResources.map((r: any) => String(r?.type ?? ''))
    : []
  const x12Type = relatedTypes.find(t => t.startsWith('transaction.x12.')) ?? null
  const eventType = v1?.type ?? body?.type ?? null
  return { transactionId, x12Type, eventType }
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
    const s = STEDI_WEBHOOK_SECRET
    const trimmed = s.trim()
    const afterPrefix = trimmed.startsWith('whsec_') ? trimmed.slice(6) : trimmed
    // Safe metadata — never emits the actual secret, only shape info that
    // lets us diagnose which of the common copy-paste failure modes is
    // in play. Written into the response body so it appears in Stedi's
    // failed-delivery dashboard (Sara doesn't have to open Vercel logs).
    const diagnostic = {
      secret_configured: !!s,
      secret_char_length: s.length,
      secret_trimmed_length: trimmed.length,
      secret_had_leading_or_trailing_whitespace: s.length !== trimmed.length,
      secret_starts_with_whsec: trimmed.startsWith('whsec_'),
      secret_contains_only_base64_chars_after_prefix: /^[A-Za-z0-9+/=_-]+$/.test(afterPrefix),
      after_prefix_length: afterPrefix.length,
      after_prefix_first_2: afterPrefix.slice(0, 2),
      after_prefix_last_2: afterPrefix.slice(-2),
      body_bytes: rawBody.length,
      webhook_id_present: 'webhook-id' in req.headers,
      webhook_ts_present: 'webhook-timestamp' in req.headers,
      webhook_sig_present: 'webhook-signature' in req.headers,
    }
    console.error('[stedi-transaction] signature FAILED:', verified.reason, JSON.stringify(diagnostic))
    return res.status(401).json({ error: 'Signature verification failed', reason: verified.reason, diagnostic })
  }

  let payload: any
  try {
    payload = rawBody ? JSON.parse(rawBody) : {}
  } catch {
    return res.status(400).json({ error: 'Body was not valid JSON' })
  }

  const { transactionId, x12Type, eventType } = extractTransactionInfo(payload)
  if (!transactionId) {
    return res.status(400).json({ error: 'Could not find transactionId on webhook payload', eventType, x12Type })
  }

  const sql = neon(process.env.DATABASE_URL!)

  // Branch on X12 type:
  //   .835 → existing ERA/CAS processing (below)
  //   .277 → NEW: fetch the 277 report, parse, attach to matched
  //          claim as a rejection if it's A3/A4/A6/A7/A8. Skip
  //          A1/A2 (those are just acks, not actionable).
  //   .999 or anything else → silent ack (200) so Stedi doesn't retry
  //          forever; we don't care about those transaction types.
  // Match any 277 X12 type string — .277, .277CA, .277P, whatever
  // shape Stedi uses. Broader than endsWith so we don't miss variants.
  if (x12Type && String(x12Type).toLowerCase().includes('277')) {
    // Log the full payload the first time we see a 277 so we can see
    // exactly what Stedi delivers — the X12 may be inline, may be
    // linked, may need a separate fetch. Server-side only; no Sara
    // action needed. Log lives in Vercel function logs.
    console.log('[stedi-transaction] 277 event received. transactionId:',
      transactionId, 'x12Type:', x12Type,
      'payload (first 6000 chars):', JSON.stringify(payload).slice(0, 6000))

    try {
      await sql`
        CREATE TABLE IF NOT EXISTS stedi_transactions_processed (
          transaction_id text PRIMARY KEY,
          processed_at timestamptz NOT NULL DEFAULT NOW(),
          matched_claim_count integer NOT NULL DEFAULT 0,
          source text
        )`
    } catch {}
    const [prior] = await sql`SELECT transaction_id FROM stedi_transactions_processed WHERE transaction_id = ${transactionId} LIMIT 1`
    if (prior) return res.status(200).json({ ok: true, transactionId, x12Type, skipped: 'already_processed_277' })

    // Try multiple X12 extraction paths so a wrong-URL guess doesn't
    // block ingestion. First one that yields a valid ISA-headed X12
    // string wins. Records which source worked in Vercel logs.
    let rawX12: string | null = null
    let x12Source = ''

    // Attempt 1 — X12 embedded directly in the webhook payload. Stedi
    // often includes the artifact body inline on transaction.processed
    // events. Check several common paths.
    const inlineCandidates: any[] = [
      payload?.v1Event?.resource?.body,
      payload?.v1Event?.resource?.x12,
      payload?.v1Event?.data?.x12,
      payload?.v1Event?.artifact?.body,
      payload?.v1Event?.artifact?.content,
      payload?.data?.x12,
      payload?.body,
      payload?.x12,
    ]
    for (const cand of inlineCandidates) {
      if (typeof cand === 'string' && cand.trim().startsWith('ISA')) {
        rawX12 = cand; x12Source = 'webhook-payload-inline'; break
      }
    }

    // Attempt 2 — related resources with a URL to the artifact.
    if (!rawX12) {
      const related: any[] = Array.isArray(payload?.v1Event?.relatedResources) ? payload.v1Event.relatedResources : []
      for (const rr of related) {
        if (!rr) continue
        const typeStr = String(rr.type ?? '').toLowerCase()
        const isCandidate = typeStr.includes('277') || typeStr.includes('artifact')
        const url: string | null = typeof rr.url === 'string' ? rr.url : typeof rr.href === 'string' ? rr.href : null
        if (!isCandidate || !url) continue
        try {
          const rrRes = await fetch(url, { headers: { Authorization: `Key ${STEDI_API_KEY}` } })
          if (!rrRes.ok) {
            console.error('[stedi-transaction] related-resource fetch failed', rrRes.status, 'url:', url)
            continue
          }
          const rrText = (await rrRes.text()).trim()
          if (rrText.startsWith('ISA')) { rawX12 = rrText; x12Source = `related-resource:${url}`; break }
          // Might be JSON wrapping the X12
          try {
            const rrJson = JSON.parse(rrText)
            const embedded = rrJson?.x12 ?? rrJson?.body ?? rrJson?.content
            if (typeof embedded === 'string' && embedded.trim().startsWith('ISA')) {
              rawX12 = embedded; x12Source = `related-resource-json:${url}`; break
            }
          } catch {}
        } catch (rrErr: any) {
          console.error('[stedi-transaction] related-resource fetch threw', rrErr?.message, 'url:', url)
        }
      }
    }

    // Attempt 3 — assumed report URL pattern (parallel to 835).
    if (!rawX12) {
      try {
        const reportRes = await fetch(STEDI_277_REPORT_URL(transactionId), {
          headers: { Authorization: `Key ${STEDI_API_KEY}`, 'Content-Type': 'application/json' },
        })
        if (reportRes.ok) {
          const rawText = (await reportRes.text()).trim()
          if (rawText.startsWith('ISA')) {
            rawX12 = rawText; x12Source = 'report-endpoint-x12'
          } else {
            try {
              const body = JSON.parse(rawText)
              const embedded = body?.x12 ?? body?.body ?? body?.content
              if (typeof embedded === 'string' && embedded.trim().startsWith('ISA')) {
                rawX12 = embedded; x12Source = 'report-endpoint-json'
              } else {
                console.error('[stedi-transaction] report endpoint JSON had no x12. keys:', Object.keys(body ?? {}))
              }
            } catch {
              console.error('[stedi-transaction] report endpoint returned non-JSON non-X12. head:', rawText.slice(0, 300))
            }
          }
        } else {
          console.error('[stedi-transaction] report endpoint failed:', reportRes.status, (await reportRes.text().catch(() => '')).slice(0, 500))
        }
      } catch (rptErr: any) {
        console.error('[stedi-transaction] report endpoint threw:', rptErr?.message)
      }
    }

    if (!rawX12) {
      console.error('[stedi-transaction] 277 X12 extraction FAILED after all attempts. transactionId:', transactionId,
        'payload (first 3000 chars):', JSON.stringify(payload).slice(0, 3000))
      await sql`
        INSERT INTO stedi_transactions_processed (transaction_id, matched_claim_count, source)
        VALUES (${transactionId}, 0, '277-webhook-no-x12')
        ON CONFLICT (transaction_id) DO NOTHING`
      return res.status(200).json({ ok: false, transactionId, x12Type, error: 'could not extract X12 from webhook payload, related resources, or report endpoint. See Vercel logs.' })
    }
    console.log('[stedi-transaction] 277 X12 obtained via:', x12Source, 'transactionId:', transactionId, 'len:', rawX12.length)

    const parsed = parseX12_277_full(rawX12)
    if (!parsed.isRejection) {
      // A1/A2 or similar — ack, not rejection. Skip attaching.
      await sql`
        INSERT INTO stedi_transactions_processed (transaction_id, matched_claim_count, source)
        VALUES (${transactionId}, 0, '277-webhook-ack-only')
        ON CONFLICT (transaction_id) DO NOTHING`
      return res.status(200).json({ ok: true, transactionId, x12Type, skipped: 'ack_not_rejection', statuses: parsed.statuses.map(s => `${s.category}/${s.code}`) })
    }

    const { matched, claimId } = await attach277ToClaim(sql, parsed, rawX12)
    await sql`
      INSERT INTO stedi_transactions_processed (transaction_id, matched_claim_count, source)
      VALUES (${transactionId}, ${matched ? 1 : 0}, '277-webhook')
      ON CONFLICT (transaction_id) DO UPDATE SET matched_claim_count = EXCLUDED.matched_claim_count, processed_at = NOW()`
    return res.status(200).json({ ok: true, transactionId, x12Type, matched, claimId })
  }

  // Non-835, non-277 transactions (999 functional acks etc.) — silent
  // ack so Stedi stops retrying.
  if (x12Type && !x12Type.endsWith('.835')) {
    return res.status(200).json({ ok: true, skipped: 'not_835_or_277', x12Type, transactionId })
  }

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
      // ── ADDITIVE: preserve the raw 835 payload so parser bugs
      //             are debuggable without re-fetching from Stedi.
      try {
        await sql`ALTER TABLE claims ADD COLUMN IF NOT EXISTS era_raw_835 jsonb`
        await sql`UPDATE claims SET era_raw_835 = COALESCE(era_raw_835, ${JSON.stringify(cp.scoped)}::jsonb) WHERE id = ${claim.id}::uuid`
      } catch (rawErr: any) {
        console.error('[webhooks/stedi-transaction] era_raw_835 store failed (non-fatal):', rawErr?.message)
      }
      // ── ADDITIVE denial-code capture ─────────────────────────────
      // Fully wrapped — never blocks the webhook. Worst case
      // denial_codes stays null on this claim.
      try {
        await sql`ALTER TABLE claims ADD COLUMN IF NOT EXISTS denial_codes jsonb`
        const codes = extractDenialCodes(cp.scoped)
        if (codes.length > 0) {
          await sql`UPDATE claims SET denial_codes = ${JSON.stringify(codes)}::jsonb WHERE id = ${claim.id}::uuid`
        }
      } catch (denialErr: any) {
        console.error('[webhooks/stedi-transaction] denial-code capture failed (non-fatal):', denialErr?.message)
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

  // ── ENRICHMENT: fetch /eras/{id}/x12 for recent remittances and
  //   parse real CAS from the X12 EDI. The /reports/v2/{txId}/835
  //   endpoint above returns only a summary (no CAS), so this step
  //   is what actually populates deductible / coinsurance / copay /
  //   contractual on matched claims. Fully wrapped in try/catch —
  //   never blocks the webhook. Idempotent — re-parsing the same
  //   remittance just re-writes the same values.
  let x12Enriched = 0
  const x12Errors: string[] = []
  try {
    // Pull all claims' payer_ids so we can scope the /eras list. Small
    // practice — cheap query.
    const allClaims: any = await sql`SELECT id, payer_id FROM claims WHERE payer_id IS NOT NULL`
    const pcnToClaim = new Map<string, string>()
    const payerIds = new Set<string>()
    for (const c of allClaims) {
      const pcn = String(c.id).replace(/-/g, '').slice(0, 20).toUpperCase()
      pcnToClaim.set(pcn, c.id as string)
      payerIds.add(c.payer_id as string)
    }

    for (const payerId of payerIds) {
      try {
        const params = new URLSearchParams()
        params.set('tradingPartnerId', payerId)
        params.set('limit', '25')
        const listRes = await fetch(`https://claims-manager.us.stedi.com/2025-09-01/eras?${params}`, {
          headers: { Authorization: `Key ${STEDI_API_KEY}`, 'Content-Type': 'application/json' },
        })
        if (!listRes.ok) { x12Errors.push(`list ${payerId} HTTP ${listRes.status}`); continue }
        const listBody = await listRes.json() as any
        const rems: any[] = listBody?.remittances ?? listBody?.items ?? []

        for (const rem of rems) {
          const remId = rem?.id ?? rem?.remittanceId
          if (!remId) continue
          try {
            const x12Res = await fetch(`https://claims-manager.us.stedi.com/2025-09-01/eras/${remId}/x12`, {
              headers: { Authorization: `Key ${STEDI_API_KEY}`, Accept: 'application/edi-x12, text/plain' },
            })
            if (!x12Res.ok) { x12Errors.push(`x12 ${remId} HTTP ${x12Res.status}`); continue }
            const x12Text = await x12Res.text()
            const parsedClaims = parseX12_835(x12Text)

            for (const pc of parsedClaims) {
              const pcn = String(pc.pcn ?? '').toUpperCase()
              const claimId = pcnToClaim.get(pcn)
              if (!claimId) continue
              const cas = bucketCasFromX12(pc.cas)
              await sql`
                UPDATE claims SET
                  era_received_at            = COALESCE(era_received_at, NOW()),
                  era_raw_835                = ${JSON.stringify({
                                                  pcn: pc.pcn,
                                                  payerClaimControlNumber: pc.payerClaimControlNumber,
                                                  totalCharge: pc.totalCharge,
                                                  totalPaid: pc.totalPaid,
                                                  patientResponsibility: pc.patientResponsibility,
                                                  cas: pc.cas,
                                                  remarks: pc.remarks,
                                                })}::jsonb,
                  amount_billed_era          = ${pc.totalCharge},
                  insurance_payment_era      = ${pc.totalPaid},
                  contractual_adjustment_era = ${cas.contractual_adjustment},
                  patient_deductible_era     = ${cas.patient_deductible},
                  patient_coinsurance_era    = ${cas.patient_coinsurance},
                  patient_copay_era          = ${cas.patient_copay},
                  patient_non_covered_era    = ${cas.patient_non_covered},
                  updated_at                 = NOW()
                WHERE id = ${claimId}::uuid
              `
              const denialCodes = pc.cas.map(c => ({ group_code: c.group, reason_code: c.reason, amount: c.amount }))
              if (denialCodes.length > 0) {
                await sql`UPDATE claims SET denial_codes = ${JSON.stringify(denialCodes)}::jsonb WHERE id = ${claimId}::uuid`
              }
              // Persist remark (RARC) codes so the UI can tell the biller
              // exactly what documentation Aetna / BCBS want back. Column
              // may not exist yet — bootstrap idempotently.
              try { await sql`ALTER TABLE claims ADD COLUMN IF NOT EXISTS remark_codes jsonb` } catch {}
              if (pc.remarks && pc.remarks.length > 0) {
                await sql`UPDATE claims SET remark_codes = ${JSON.stringify(pc.remarks)}::jsonb WHERE id = ${claimId}::uuid`
              }
              // Save Stedi's remittance transaction ID so /api/claims/[id]/era-pdf
              // can call /electronic-remittance-advice/{id}/pdf without a second lookup.
              try { await sql`ALTER TABLE claims ADD COLUMN IF NOT EXISTS stedi_era_transaction_id text` } catch {}
              await sql`UPDATE claims SET stedi_era_transaction_id = ${String(remId)} WHERE id = ${claimId}::uuid`
              if (pc.payerClaimControlNumber) {
                await sql`UPDATE claims SET stedi_payer_claim_control_number = ${pc.payerClaimControlNumber} WHERE id = ${claimId}::uuid AND stedi_payer_claim_control_number IS NULL`
              }
              // Auto-create a draft statement so the biller MUST review
              // every ERA outcome — even $0 patient responsibility. Prevents
              // Stedi CAS misreads (denial coded as contractual) from
              // silently closing out a claim.
              try {
                await ensureStatementForClaim(sql, claimId, cas, pc.totalCharge, pc.totalPaid)
              } catch (stmtErr: any) {
                x12Errors.push(`stmt ${claimId}: ${String(stmtErr?.message ?? stmtErr).slice(0, 200)}`)
              }
              x12Enriched += 1
            }
          } catch (perRemErr: any) {
            x12Errors.push(`rem ${remId}: ${String(perRemErr?.message ?? perRemErr).slice(0, 200)}`)
          }
        }
      } catch (perPayerErr: any) {
        x12Errors.push(`payer ${payerId}: ${String(perPayerErr?.message ?? perPayerErr).slice(0, 200)}`)
      }
    }
  } catch (enrichErr: any) {
    console.error('[webhooks/stedi-transaction] X12 enrichment failed (non-fatal):', enrichErr?.message)
    x12Errors.push(String(enrichErr?.message ?? enrichErr).slice(0, 200))
  }

  return res.status(200).json({
    ok: true,
    transactionId,
    claimPaymentsSeen: claimPayments.length,
    matched,
    errors,
    x12Enriched,
    x12Errors: x12Errors.slice(0, 5),
  })
}
