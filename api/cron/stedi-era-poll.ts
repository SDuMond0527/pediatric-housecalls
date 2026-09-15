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

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (CRON_SECRET && req.headers.authorization !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' })
  }
  if (!STEDI_API_KEY) return res.status(500).json({ error: 'STEDI_API_KEY not configured' })

  const sql = neon(process.env.DATABASE_URL!)
  try { await sql`ALTER TABLE claims ADD COLUMN IF NOT EXISTS era_seen_at timestamptz` } catch {}
  try { await sql`ALTER TABLE claims ADD COLUMN IF NOT EXISTS patient_responsibility_era numeric(10,2)` } catch {}

  const summary = { fetched: 0, matched: 0, statementsCreated: 0, statementsUpdated: 0, unmatched: 0, errors: [] as string[] }

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
    return res.status(200).json(summary)
  } catch (e: any) {
    console.error('[stedi-era-poll] error:', e)
    return res.status(200).json({ ...summary, errors: [...summary.errors, e?.message ?? String(e)] })
  }
}
