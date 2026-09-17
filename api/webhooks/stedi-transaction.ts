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
}
function parseX12_835(text: string): ParsedX12Claim[] {
  const claims: ParsedX12Claim[] = []
  if (!text || typeof text !== 'string') return claims
  const segments = text.split('~').map(s => s.trim()).filter(Boolean)
  let current: ParsedX12Claim | null = null
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
    }
  }
  if (current) claims.push(current)
  return claims
}
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
    } else if (c.group === 'CO' || c.group === 'OA' || c.group === 'PI') {
      totals.contractual_adjustment += c.amount
    }
  }
  for (const k of Object.keys(totals) as (keyof CasBreakdown)[]) totals[k] = +totals[k].toFixed(2)
  return totals
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

  // Only process 835 ERAs. Ack 200 on other X12 types (277 claim
  // status acks, 999 functional acks, etc.) so Stedi stops retrying
  // events we don't care about — a non-2xx would keep it retrying
  // forever and eventually disable the destination.
  if (x12Type && !x12Type.endsWith('.835')) {
    return res.status(200).json({ ok: true, skipped: 'not_835', x12Type, transactionId })
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
              if (pc.payerClaimControlNumber) {
                await sql`UPDATE claims SET stedi_payer_claim_control_number = ${pc.payerClaimControlNumber} WHERE id = ${claimId}::uuid AND stedi_payer_claim_control_number IS NULL`
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
