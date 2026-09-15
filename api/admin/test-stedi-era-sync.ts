import type { VercelRequest, VercelResponse } from '@vercel/node'
import { neon } from '@neondatabase/serverless'
import { createRemoteJWKSet, jwtVerify } from 'jose'

// Admin-triggered ERA sync — same pipeline as the scheduled cron but
// authed via admin provider token. Wired to a button on AdminClaims so
// Sara can verify end-to-end. Every helper is inlined — see comment in
// api/cron/stedi-era-poll.ts for the reason.

const STEDI_API_KEY = process.env.STEDI_API_KEY || ''

// Upgraded 2026-09-15 to Stedi's Claims Lifecycle API (announced
// 2026-09; replaces `claims-manager.us.stedi.com/2025-09-01/eras`).
// Response shape verified via @stedi/sdk TypeScript types
// (`ClaimPaymentInformationSummary` in @stedi/sdk/models_0.d.ts).
// Timeline events carry totalClaimChargeAmount, claimPaymentAmount,
// and patientResponsibilityAmount — enough to derive contractual
// adjustment. Per-CAS-code breakdown (deductible / coinsurance /
// copay / non-covered) is not exposed, biller enters manually.
const STEDI_CLAIMS_LIST_URL =
  'https://claims.us.stedi.com/2025-03-07/claims'
const STEDI_CLAIM_TIMELINE_URL = (id: string) =>
  `https://claims.us.stedi.com/2025-03-07/claims/${id}/timeline`

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

interface ParsedEraPayment {
  amount_billed:          number | null
  insurance_payment:      number | null
  contractual_adjustment: number | null
  patient_responsibility: number | null
  patient_deductible:     number | null
  patient_coinsurance:    number | null
  patient_copay:          number | null
  patient_non_covered:    number | null
}

// Parse a ClaimPaymentInformationSummary event. Fields on the summary:
//   totalClaimChargeAmount        — billed
//   claimPaymentAmount            — insurance paid
//   patientResponsibilityAmount   — subtotal patient owes
// Contractual adjustment is derived: billed - paid - patient resp.
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

  const patientResp = parsed.patient_responsibility != null
    ? parsed.patient_responsibility
    : (parsed.patient_copay ?? 0) + (parsed.patient_deductible ?? 0) + (parsed.patient_coinsurance ?? 0) + (parsed.patient_non_covered ?? 0)
  const remaining = (parsed.amount_billed ?? 0) - (parsed.insurance_payment ?? 0) - (parsed.contractual_adjustment ?? 0)
  const paidInFull = patientResp === 0

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
        status                 = CASE WHEN status = 'draft' AND ${paidInFull} THEN 'paid' ELSE status END,
        paid_at                = CASE WHEN status = 'draft' AND ${paidInFull} THEN NOW() ELSE paid_at END,
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

  const newStatus = paidInFull ? 'paid' : 'draft'
  await sql`
    INSERT INTO patient_statements (
      practice_id, claim_id,
      patient_first_name, patient_last_name, patient_dob,
      date_of_service, cpt_codes,
      patient_email, patient_phone,
      amount_billed, insurance_payment, contractual_adjustment,
      patient_copay, patient_deductible, patient_coinsurance, patient_non_covered,
      remaining_balance, prior_balance, total_amount_due, total_amount_due_text,
      status, paid_at, created_at, updated_at
    ) VALUES (
      ${claim.practice_id}::uuid, ${claim.id},
      ${claim.patient_first_name}, ${claim.patient_last_name}, ${claim.patient_dob},
      ${claim.service_date}, ${JSON.stringify(claim.cpt_codes ?? [])}::jsonb,
      ${email}, ${phone},
      ${parsed.amount_billed}, ${parsed.insurance_payment}, ${parsed.contractual_adjustment},
      ${parsed.patient_copay}, ${parsed.patient_deductible}, ${parsed.patient_coinsurance}, ${parsed.patient_non_covered},
      ${remaining}, 0, ${patientResp}, ${String(patientResp)},
      ${newStatus}, ${paidInFull ? new Date().toISOString() : null}, NOW(), NOW()
    )`
  return { statementCreated: true }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  let sub: string
  try {
    sub = await verifyProviderToken(req.headers.authorization)
  } catch {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const sql = neon(process.env.DATABASE_URL!)
  const [provider] = await sql`SELECT id, is_admin, practice_id FROM providers WHERE cognito_sub = ${sub} LIMIT 1`
  if (!provider) return res.status(403).json({ error: 'Provider not found' })
  if (!provider.is_admin) return res.status(403).json({ error: 'Admin only' })

  if (!STEDI_API_KEY) {
    return res.status(200).json({
      ok: false,
      diagnosis: 'STEDI_API_KEY is not set in Vercel environment variables. Add it and redeploy.',
      fetched: 0, matched: 0, statementsCreated: 0, statementsUpdated: 0, unmatched: 0,
      errors: [], sampleUnmatchedStediIds: [],
    })
  }

  try { await sql`ALTER TABLE claims ADD COLUMN IF NOT EXISTS era_seen_at timestamptz` } catch {}
  try { await sql`ALTER TABLE claims ADD COLUMN IF NOT EXISTS patient_responsibility_era numeric(10,2)` } catch {}

  const summary = {
    ok: true as boolean,
    diagnosis: '' as string,
    fetched: 0,
    matched: 0,
    statementsCreated: 0,
    statementsUpdated: 0,
    unmatched: 0,
    errors: [] as string[],
    sampleUnmatchedStediIds: [] as string[],
    // Raw sample of the first timeline response — lets us adjust the
    // parser without another round-trip if the shape doesn't match.
    sampleTimelineResponse: '' as string,
    timelineStatusCodes: [] as string[],
  }

  try {
    // Poll Stedi's Claims Lifecycle API for every submitted claim we
    // haven't yet posted a payment for. Iterate local claims that we
    // submitted to Stedi and ask each one for its timeline.
    const localClaims: any[] = await sql`
      SELECT id, practice_id, encounter_note_id, appointment_id, child_id,
             payer_name, payer_id, service_date, cpt_codes,
             patient_first_name, patient_last_name, patient_dob, patient_gender,
             era_received_at, era_seen_at, stedi_claim_id
      FROM claims
      WHERE stedi_claim_id IS NOT NULL
        AND practice_id = ${provider.practice_id}::uuid
        AND status IN ('submitted', 'accepted', 'in_process', 'paid')
        AND era_received_at IS NULL
      ORDER BY submitted_at DESC NULLS LAST
      LIMIT 50`
    summary.fetched = localClaims.length

    if (localClaims.length === 0) {
      summary.diagnosis = 'No local claims are awaiting ERA (either none submitted to Stedi yet, or all already have a payment posted). Nothing to poll.'
      return res.status(200).json(summary)
    }

    for (const localClaim of localClaims) {
      const stediId = localClaim.stedi_claim_id
      if (!stediId) continue
      const timelineRes = await fetch(STEDI_CLAIM_TIMELINE_URL(stediId), {
        headers: { Authorization: `Key ${STEDI_API_KEY}`, 'Content-Type': 'application/json' },
      })
      summary.timelineStatusCodes.push(String(timelineRes.status))
      if (!timelineRes.ok) {
        const errBody = await timelineRes.text().catch(() => '')
        summary.errors.push(`Timeline ${stediId}: HTTP ${timelineRes.status} ${errBody.slice(0, 150)}`)
        if (summary.sampleUnmatchedStediIds.length < 5) summary.sampleUnmatchedStediIds.push(stediId)
        continue
      }
      const timeline = await timelineRes.json()
      if (!summary.sampleTimelineResponse) {
        summary.sampleTimelineResponse = JSON.stringify(timeline).slice(0, 1500)
      }
      const events: any[] = timeline?.events ?? timeline?.items ?? []
      const payments = events.filter(e => e?.type === 'CLAIM_PAYMENT_INFORMATION' || e?.eventType === 'CLAIM_PAYMENT_INFORMATION' || e?.claimPaymentInformation != null)
      if (payments.length === 0) {
        summary.unmatched += 1
        continue
      }
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
    }

    if (summary.matched === 0 && summary.unmatched === summary.fetched) {
      summary.diagnosis = `Polled ${summary.fetched} claim(s) at Stedi — none have a payment event yet. Payer hasn't processed these claims, or Stedi's Claims Lifecycle API hasn't received the ERA. Check back later.`
    } else if (summary.matched === 0 && summary.errors.length > 0) {
      summary.diagnosis = `Stedi returned errors on every timeline fetch. First error: ${summary.errors[0]}. If the status is 404, the stedi_claim_id we saved at submit time isn't recognized (Stedi may use a different identifier on this API).`
    } else {
      summary.diagnosis = `Success — applied ${summary.matched} ERA payment(s). ${summary.statementsCreated} new patient statements created, ${summary.statementsUpdated} updated. ${summary.unmatched} claim(s) polled but no payment event on timeline yet.`
    }

    return res.status(200).json(summary)
  } catch (e: any) {
    console.error('[admin/test-stedi-era-sync] error:', e)
    summary.ok = false
    summary.diagnosis = `Unexpected error: ${e?.message ?? String(e)}`
    return res.status(200).json(summary)
  }
}
