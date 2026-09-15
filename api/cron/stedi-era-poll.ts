import type { VercelRequest, VercelResponse } from '@vercel/node'
import { neon } from '@neondatabase/serverless'

// Poll Stedi's remittances (835 ERAs) every 30 min as a catch-up in
// case the webhook (api/webhooks/stedi-era.ts) missed a notification.
// Every helper is INLINED — Vercel treats every .ts file inside api/
// as a serverless function, and files exporting only named helpers
// (no default handler) crash the deploy with FUNCTION_INVOCATION_FAILED.
// Keep this in sync with api/webhooks/stedi-era.ts and
// api/admin/test-stedi-era-sync.ts.
//
// Auth: CRON_SECRET env var (Bearer).

const STEDI_API_KEY = process.env.STEDI_API_KEY || ''
const CRON_SECRET   = process.env.CRON_SECRET   || ''

// Stedi Claims Lifecycle API (announced 2026-09, replaces the older
// `claims-manager.us.stedi.com/2025-09-01/eras` endpoints). Response
// shape verified via @stedi/sdk TypeScript types
// (`ClaimPaymentInformationSummary` in @stedi/sdk/models_0.d.ts).
//   ListClaims  — GET  /2025-03-07/claims?status=PROCESSED&status=DENIED
//   Claim      — GET  /2025-03-07/claims/{id}
//   Timeline   — GET  /2025-03-07/claims/{id}/timeline
// Timeline returns an array of events; ClaimPaymentInformation events
// carry totalClaimChargeAmount, claimPaymentAmount, and
// patientResponsibilityAmount. Contractual adjustment is the derived
// remainder (billed - paid - patient responsibility). Sara DuMond
// 2026-09-15 upgrade from the older summary-only URLs.
const STEDI_CLAIMS_LIST_URL =
  'https://claims.us.stedi.com/2025-03-07/claims'
const STEDI_CLAIM_TIMELINE_URL = (id: string) =>
  `https://claims.us.stedi.com/2025-03-07/claims/${id}/timeline`

// Second-pass URLs: Stedi confirmed (Hadi Soueidan 2026-09-15) that
// CAS breakdown (deductible / coinsurance / copay / non-covered) lives
// on the 835 ERA JSON API — a separate endpoint from Claims Lifecycle.
//   Poll Transactions   — GET /polling/transactions?startDateTime=...
//   835 ERA JSON        — GET /change/medicalnetwork/reports/v2/{transactionId}/835
// Docs: https://www.stedi.com/docs/healthcare/api-reference/get-healthcare-reports-835
const STEDI_POLL_TRANSACTIONS_URL =
  'https://healthcare.us.stedi.com/2024-04-01/polling/transactions'
const STEDI_835_REPORT_URL = (transactionId: string) =>
  `https://healthcare.us.stedi.com/2024-04-01/change/medicalnetwork/reports/v2/${transactionId}/835`

interface ParsedEraPayment {
  amount_billed:            number | null
  insurance_payment:        number | null
  contractual_adjustment:   number | null
  patient_responsibility:   number | null
  patient_deductible:       number | null
  patient_coinsurance:      number | null
  patient_copay:            number | null
  patient_non_covered:      number | null
}

// Parse a ClaimPaymentInformationSummary from a timeline event. Fields:
//   totalClaimChargeAmount   — billed
//   claimPaymentAmount       — insurance paid
//   patientResponsibilityAmount — subtotal patient owes (deductible +
//                               coinsurance + copay + non-covered).
//                               Stedi does NOT expose the per-category
//                               breakdown; biller enters it manually on
//                               the statement modal.
// Contractual adjustment is derived: billed - paid - patientResp.
function parseLifecyclePayment(cpi: any): ParsedEraPayment {
  const billed = parseFloat(cpi?.totalClaimChargeAmount ?? '0')
  const paid   = parseFloat(cpi?.claimPaymentAmount ?? '0')
  const patResp = cpi?.patientResponsibilityAmount != null
    ? parseFloat(cpi.patientResponsibilityAmount)
    : null
  const contractual = patResp != null && Number.isFinite(billed) && Number.isFinite(paid)
    ? +(billed - paid - patResp).toFixed(2)
    : null
  return {
    amount_billed:          Number.isFinite(billed) ? billed : null,
    insurance_payment:      Number.isFinite(paid) ? paid : null,
    contractual_adjustment: contractual,
    patient_responsibility: patResp,
    patient_deductible:     null,
    patient_coinsurance:    null,
    patient_copay:          null,
    patient_non_covered:    null,
  }
}

// Legacy parser retained for the webhook, which still receives the
// older payload shape until Stedi publishes their webhook-side upgrade.
// Poll and admin test button both use parseLifecyclePayment above.
function walkClaimPayments(body: any): Array<{ pcn: string; stediClaimId: string | null; parsed: ParsedEraPayment }> {
  const items: any[] = Array.isArray(body?.items)
    ? body.items
    : Array.isArray(body) ? body
    : []
  const out: Array<{ pcn: string; stediClaimId: string | null; parsed: ParsedEraPayment }> = []
  for (const item of items) {
    const pcn = String(item?.patientControlNumber ?? '').trim()
    if (!pcn) continue
    const billed = parseFloat(item?.totalClaimChargeAmount ?? '0')
    const paid   = parseFloat(item?.paidAmount ?? '0')
    out.push({
      pcn,
      stediClaimId: item?.claimId ? String(item.claimId) : null,
      parsed: {
        amount_billed:          Number.isFinite(billed) ? billed : null,
        insurance_payment:      Number.isFinite(paid) ? paid : null,
        patient_responsibility: null,
        contractual_adjustment: null,
        patient_deductible:     null,
        patient_coinsurance:    null,
        patient_copay:          null,
        patient_non_covered:    null,
      },
    })
  }
  return out
}

async function findClaimByStediIdOrPCN(sql: any, stediClaimId: string | null, pcn: string): Promise<any | null> {
  if (stediClaimId) {
    const rows = await sql`
      SELECT id, practice_id, encounter_note_id, appointment_id, child_id,
             payer_name, payer_id, service_date, cpt_codes,
             patient_first_name, patient_last_name, patient_dob, patient_gender,
             era_received_at, era_seen_at, stedi_claim_id
      FROM claims
      WHERE stedi_claim_id = ${stediClaimId}
      LIMIT 1`
    if (rows[0]) return rows[0]
  }
  const rows = await sql`
    SELECT id, practice_id, encounter_note_id, appointment_id, child_id,
           payer_name, payer_id, service_date, cpt_codes,
           patient_first_name, patient_last_name, patient_dob, patient_gender,
           era_received_at, era_seen_at, stedi_claim_id
    FROM claims
    WHERE REPLACE(id::text, '-', '') ILIKE ${pcn + '%'}
    LIMIT 1`
  return rows[0] ?? null
}

async function applyEraPaymentToClaim(sql: any, claim: any, parsed: ParsedEraPayment, eraRaw: any): Promise<{ statementCreated: boolean }> {
  await sql`
    UPDATE claims SET
      era_received_at            = COALESCE(era_received_at, NOW()),
      era_raw                    = ${JSON.stringify(eraRaw)}::jsonb,
      amount_billed_era          = ${parsed.amount_billed},
      insurance_payment_era      = ${parsed.insurance_payment},
      contractual_adjustment_era = ${parsed.contractual_adjustment},
      patient_responsibility_era = ${parsed.patient_responsibility},
      patient_deductible_era     = ${parsed.patient_deductible},
      patient_coinsurance_era    = ${parsed.patient_coinsurance},
      patient_copay_era          = ${parsed.patient_copay},
      patient_non_covered_era    = ${parsed.patient_non_covered},
      updated_at                 = NOW()
    WHERE id = ${claim.id}`

  // Prefer the Stedi-provided subtotal (patient_responsibility) if
  // present. Fall back to the sum of individual categories when the
  // biller has manually categorized them.
  const patientResp = parsed.patient_responsibility != null
    ? parsed.patient_responsibility
    : (parsed.patient_copay ?? 0) + (parsed.patient_deductible ?? 0) + (parsed.patient_coinsurance ?? 0) + (parsed.patient_non_covered ?? 0)
  const remaining = (parsed.amount_billed ?? 0) - (parsed.insurance_payment ?? 0) - (parsed.contractual_adjustment ?? 0)

  const [existing] = await sql`SELECT id FROM patient_statements WHERE claim_id = ${claim.id} LIMIT 1`
  if (existing) {
    await sql`
      UPDATE patient_statements SET
        amount_billed          = COALESCE(${parsed.amount_billed}, amount_billed),
        insurance_payment      = COALESCE(${parsed.insurance_payment}, insurance_payment),
        contractual_adjustment = COALESCE(${parsed.contractual_adjustment}, contractual_adjustment),
        patient_copay          = COALESCE(${parsed.patient_copay}, patient_copay),
        patient_deductible     = COALESCE(${parsed.patient_deductible}, patient_deductible),
        patient_coinsurance    = COALESCE(${parsed.patient_coinsurance}, patient_coinsurance),
        patient_non_covered    = COALESCE(${parsed.patient_non_covered}, patient_non_covered),
        remaining_balance      = COALESCE(${remaining}, remaining_balance),
        total_amount_due       = COALESCE(${patientResp}, total_amount_due),
        updated_at             = NOW()
      WHERE id = ${existing.id}`
    return { statementCreated: false }
  }

  let email: string | null = null
  let phone: string | null = null
  if (claim.child_id) {
    const [ch] = await sql`
      SELECT ch.parent_email, ch.parent_phone,
             fp.email AS family_email, fp.phone AS family_phone
      FROM children ch LEFT JOIN family_profiles fp ON fp.id = ch.family_id
      WHERE ch.id = ${claim.child_id}::uuid
      LIMIT 1`
    if (ch) {
      email = ch.parent_email || ch.family_email || null
      phone = ch.parent_phone || ch.family_phone || null
    }
  }

  await sql`
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
      ${parsed.amount_billed}, ${parsed.insurance_payment}, ${parsed.contractual_adjustment},
      ${parsed.patient_copay}, ${parsed.patient_deductible}, ${parsed.patient_coinsurance}, ${parsed.patient_non_covered},
      ${remaining}, 0, ${patientResp}, ${String(patientResp)},
      'draft', NOW(), NOW()
    )`
  return { statementCreated: true }
}

// ────────────────────────────────────────────────────────────────────
// CAS-breakdown pass — walks a Stedi 835 ERA JSON payload and buckets
// the adjustment amounts by our per-category columns:
//   PR/1  → patient_deductible
//   PR/2  → patient_coinsurance
//   PR/3  → patient_copay
//   PR/96 → patient_non_covered
//   PR/*  → patient_non_covered (default for unknown PR reasons)
//   CO/OA/PI/* → contractual_adjustment
// Stedi's 835 CAS shape uses flat `adjustmentReasonCode1..6` +
// `adjustmentAmount1..6` numbered pairs on each adjustment object;
// legacy nested `claimAdjustmentDetails` shape kept as a fallback.
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

async function findClaimByPcnOrPayerControlNumber(sql: any, pcn: string | null, payerClaimControlNumber: string | null): Promise<any | null> {
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
  const [stmt] = await sql`SELECT id FROM patient_statements WHERE claim_id = ${claimId}::uuid LIMIT 1`
  if (stmt) {
    // COALESCE preserves biller category edits. total_amount_due /
    // remaining_balance get repaired only when they were stuck at 0
    // from the old code path (before CAS support) — biller-set
    // non-zero values win.
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
        updated_at             = NOW()
      WHERE id = ${stmt.id}`
  }
  if (payerClaimControlNumber) {
    await sql`UPDATE claims SET stedi_payer_claim_control_number = ${payerClaimControlNumber} WHERE id = ${claimId}::uuid AND stedi_payer_claim_control_number IS NULL`
  }
}

// Look-back window for the poll pass. 24h with 15-min back-off from
// "now" (Stedi's `startDateTime` filter requires ≥1 minute in past).
function pollLookBackIso(): string {
  return new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (CRON_SECRET && req.headers.authorization !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' })
  }
  if (!STEDI_API_KEY) return res.status(500).json({ error: 'STEDI_API_KEY not configured' })

  const sql = neon(process.env.DATABASE_URL!)
  try { await sql`ALTER TABLE claims ADD COLUMN IF NOT EXISTS era_seen_at timestamptz` } catch {}
  try { await sql`ALTER TABLE claims ADD COLUMN IF NOT EXISTS patient_responsibility_era numeric(10,2)` } catch {}
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
    fetched: 0, matched: 0, statementsCreated: 0, statementsUpdated: 0, unmatched: 0,
    errors: [] as string[],
    cas: { transactionsSeen: 0, transactionsProcessed: 0, claimsUpdated: 0, skipped: 0 },
  }

  try {
    // Poll Stedi's Claims Lifecycle API for every submitted claim we
    // haven't yet posted a payment for. We walk the timeline events on
    // each claim and pick out ClaimPaymentInformationSummary entries —
    // those carry the billed / paid / patient-responsibility figures.
    const localClaims: any[] = await sql`
      SELECT id, practice_id, encounter_note_id, appointment_id, child_id,
             payer_name, payer_id, service_date, cpt_codes,
             patient_first_name, patient_last_name, patient_dob, patient_gender,
             era_received_at, era_seen_at, stedi_claim_id
      FROM claims
      WHERE stedi_claim_id IS NOT NULL
        AND status IN ('submitted', 'accepted', 'in_process', 'paid')
        AND era_received_at IS NULL
      ORDER BY submitted_at DESC NULLS LAST
      LIMIT 100`
    summary.fetched = localClaims.length

    for (const localClaim of localClaims) {
      const stediId = localClaim.stedi_claim_id
      if (!stediId) continue
      const timelineRes = await fetch(STEDI_CLAIM_TIMELINE_URL(stediId), {
        headers: { Authorization: `Key ${STEDI_API_KEY}`, 'Content-Type': 'application/json' },
      })
      if (!timelineRes.ok) {
        summary.errors.push(`Timeline ${stediId}: ${timelineRes.status}`)
        continue
      }
      const timeline = await timelineRes.json()
      const events: any[] = timeline?.events ?? timeline?.items ?? []
      const payments = events.filter(e => e?.type === 'CLAIM_PAYMENT_INFORMATION' || e?.eventType === 'CLAIM_PAYMENT_INFORMATION' || e?.claimPaymentInformation != null)
      for (const evt of payments) {
        const cpi = evt.claimPaymentInformation ?? evt
        const parsed = parseLifecyclePayment(cpi)
        try {
          const { statementCreated } = await applyEraPaymentToClaim(sql, localClaim, parsed, evt)
          summary.matched += 1
          if (statementCreated) summary.statementsCreated += 1
          else summary.statementsUpdated += 1
        } catch (perClaimErr: any) {
          summary.errors.push(`Claim ${localClaim.id}: ${perClaimErr?.message ?? String(perClaimErr)}`)
        }
      }
      if (payments.length === 0) summary.unmatched += 1
    }
  } catch (e: any) {
    console.error('[stedi-era-poll] lifecycle pass error:', e)
    summary.errors.push(`lifecycle: ${e?.message ?? String(e)}`)
  }

  // ────────────────────────────────────────────────────────────────
  // Pass 2 — CAS-breakdown hydration via 835 ERA JSON.
  //
  // Enumerate recently-processed INBOUND transactions from Stedi's
  // Poll Transactions API, filter to 835 report artifacts, skip any
  // transactionId we've already digested, then fetch the 835 report
  // and apply CAS-derived amounts to matching claims.
  //
  // Wrapped in its own try/catch — a bug here must NEVER blow up the
  // Lifecycle pass above.
  try {
    let pageToken: string | undefined = undefined
    const startDateTime = pollLookBackIso()
    const seen = new Set<string>()

    for (let page = 0; page < 5; page++) {
      const params = new URLSearchParams()
      params.set('pageSize', '100')
      if (pageToken) params.set('pageToken', pageToken)
      else params.set('startDateTime', startDateTime)

      const listRes = await fetch(`${STEDI_POLL_TRANSACTIONS_URL}?${params}`, {
        headers: { Authorization: `Key ${STEDI_API_KEY}`, 'Content-Type': 'application/json' },
      })
      if (!listRes.ok) {
        const body = await listRes.text().catch(() => '')
        summary.errors.push(`poll-transactions: ${listRes.status} ${body.slice(0, 200)}`)
        break
      }
      const list = await listRes.json()
      const items: any[] = list?.items ?? []
      pageToken = list?.nextPageToken

      for (const tx of items) {
        const transactionId: string | undefined = tx?.transactionId
        if (!transactionId || seen.has(transactionId)) continue
        seen.add(transactionId)

        // Filter to 835 report artifacts. Stedi reports the file type
        // via `artifacts[].artifactType` — we accept both '835' and
        // upstream variants seen in test.
        const arts: any[] = Array.isArray(tx?.artifacts) ? tx.artifacts : []
        const is835 = arts.some(a =>
          String(a?.artifactType ?? '').toLowerCase().includes('835') ||
          String(a?.model ?? '').toLowerCase().includes('remittance'))
        if (tx?.direction !== 'INBOUND' || !is835 || tx?.status !== 'succeeded') { summary.cas.skipped += 1; continue }
        summary.cas.transactionsSeen += 1

        // Idempotency guard.
        const [prior] = await sql`SELECT 1 FROM stedi_transactions_processed WHERE transaction_id = ${transactionId} LIMIT 1`
        if (prior) { summary.cas.skipped += 1; continue }

        // Fetch the 835.
        const reportRes = await fetch(STEDI_835_REPORT_URL(transactionId), {
          headers: { Authorization: `Key ${STEDI_API_KEY}`, 'Content-Type': 'application/json' },
        })
        if (!reportRes.ok) {
          // 404 = report not materialized yet, don't mark processed;
          // any other failure logs but doesn't block the loop.
          summary.errors.push(`835 fetch ${transactionId}: ${reportRes.status}`)
          continue
        }
        const era835 = await reportRes.json()

        let matchedThis = 0
        for (const cp of extractClaimPayments(era835)) {
          try {
            const claim = await findClaimByPcnOrPayerControlNumber(sql, cp.pcn, cp.payerClaimControlNumber)
            if (!claim) continue
            const cas = parseCasAdjustments(cp.scoped)
            await applyCasToClaim(sql, claim.id, cas, cp.payerClaimControlNumber)
            matchedThis += 1
          } catch (perErr: any) {
            summary.errors.push(`CAS apply ${transactionId}: ${perErr?.message ?? String(perErr)}`)
          }
        }
        summary.cas.transactionsProcessed += 1
        summary.cas.claimsUpdated += matchedThis
        await sql`
          INSERT INTO stedi_transactions_processed (transaction_id, matched_claim_count, source)
          VALUES (${transactionId}, ${matchedThis}, 'cron')
          ON CONFLICT (transaction_id) DO UPDATE SET
            matched_claim_count = EXCLUDED.matched_claim_count,
            processed_at = NOW()`
      }
      if (!pageToken) break
    }
  } catch (e: any) {
    console.error('[stedi-era-poll] cas pass error:', e)
    summary.errors.push(`cas: ${e?.message ?? String(e)}`)
  }

  return res.status(200).json(summary)
}
