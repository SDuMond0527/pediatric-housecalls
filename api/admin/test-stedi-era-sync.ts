import type { VercelRequest, VercelResponse } from '@vercel/node'
import { neon } from '@neondatabase/serverless'
import { createRemoteJWKSet, jwtVerify } from 'jose'

// Admin-triggered ERA sync — same pipeline as the scheduled cron but
// authed via admin provider token. Wired to a button on AdminClaims so
// Sara can verify end-to-end. Every helper is inlined — see comment in
// api/cron/stedi-era-poll.ts for the reason.

const STEDI_API_KEY = process.env.STEDI_API_KEY || ''

// Discovered via Sara's Stedi portal Network tab 2026-09-11:
//   List:                 claims-manager.us.stedi.com/2025-09-01/eras
//   ERA metadata:         .../2025-09-01/eras/{id}                                    (public)
//   Claim payments:       .../2025-09-01/internal/eras/{id}/claim-payment-information (INTERNAL)
// The claim-payment-information URL has an `/internal/` prefix, which
// may only accept browser session auth. If it 401s with our API key,
// we need to ask Stedi support for the public equivalent (or accept
// that we'll only see ERA-level totals until they publish one).
const STEDI_REMITTANCES_LIST_URL =
  'https://claims-manager.us.stedi.com/2025-09-01/eras'
const STEDI_REMITTANCE_DETAIL_URL = (id: string) =>
  `https://claims-manager.us.stedi.com/2025-09-01/internal/eras/${id}/claim-payment-information?pageSize=100`

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
  patient_deductible:     number | null
  patient_coinsurance:    number | null
  patient_copay:          number | null
  patient_non_covered:    number | null
}

/**
 * Parse Stedi's /internal/eras/{id}/claim-payment-information response.
 * Response shape (confirmed via portal network trace 2026-09-11):
 *   { items: [{ patientControlNumber, claimId, totalClaimChargeAmount,
 *               paidAmount, patient: { first, last }, ... }] }
 *
 * NOTE: this endpoint only returns ERA-level totals per claim — NO
 * line-level adjustment breakdown (contractual adj, deductible, copay,
 * coinsurance, non-covered are all null). To get those we'd need a
 * different Stedi endpoint per claim payment. Missing detail is a known
 * limitation; biller can fill it in manually on the statement modal.
 */
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

/**
 * Prefer matching by Stedi's own `claimId` (stored in
 * claims.stedi_claim_id at submission time) — it's a stable string
 * they mint and echo back on the ERA. Falls back to reverse-lookup on
 * patientControlNumber = first 20 chars of the local claim UUID.
 */
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
      patient_deductible_era     = ${parsed.patient_deductible},
      patient_coinsurance_era    = ${parsed.patient_coinsurance},
      patient_copay_era          = ${parsed.patient_copay},
      patient_non_covered_era    = ${parsed.patient_non_covered},
      updated_at                 = NOW()
    WHERE id = ${claim.id}`

  const patientResp = (parsed.patient_copay ?? 0) + (parsed.patient_deductible ?? 0) + (parsed.patient_coinsurance ?? 0) + (parsed.patient_non_covered ?? 0)
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
      errors: [], sampleUnmatchedPCNs: [], remittanceIds: [],
    })
  }

  try { await sql`ALTER TABLE claims ADD COLUMN IF NOT EXISTS era_seen_at timestamptz` } catch {}

  const summary = {
    ok: true as boolean,
    diagnosis: '' as string,
    fetched: 0,
    matched: 0,
    statementsCreated: 0,
    statementsUpdated: 0,
    unmatched: 0,
    errors: [] as string[],
    sampleUnmatchedPCNs: [] as string[],
    remittanceIds: [] as string[],
    // Raw sample of the first claim-payment-information response — lets
    // us adjust the parser without another round-trip if the response
    // shape doesn't match what walkClaimPayments expects. Truncated.
    sampleClaimPaymentResponse: '' as string,
    detailStatusCodes: [] as string[],
  }

  try {
    const params = new URLSearchParams({ limit: '50' })
    const listRes = await fetch(`${STEDI_REMITTANCES_LIST_URL}?${params}`, {
      headers: { Authorization: `Key ${STEDI_API_KEY}`, 'Content-Type': 'application/json' },
    })
    if (!listRes.ok) {
      const body = await listRes.text().catch(() => '')
      summary.ok = false
      summary.diagnosis = `Stedi rejected the list request (HTTP ${listRes.status}). This usually means the API key is wrong, expired, or doesn't have remittance access. Response: ${body.slice(0, 300)}`
      return res.status(200).json(summary)
    }

    const listData = await listRes.json()
    const remittances: any[] = listData?.remittances ?? listData?.items ?? []
    summary.fetched = remittances.length
    summary.remittanceIds = remittances.slice(0, 10).map((r: any) => String(r?.id ?? r?.remittanceId ?? '')).filter(Boolean)

    if (remittances.length === 0) {
      summary.diagnosis = 'Stedi returned zero remittances. Either no ERAs have been received on this Stedi account, or the API key belongs to a different tenant. Verify by logging into Stedi and confirming remittances exist for this account.'
      return res.status(200).json(summary)
    }

    for (const rem of remittances) {
      const remId = rem?.id ?? rem?.remittanceId
      if (!remId) continue

      const detailRes = await fetch(STEDI_REMITTANCE_DETAIL_URL(remId), {
        headers: { Authorization: `Key ${STEDI_API_KEY}` },
      })
      summary.detailStatusCodes.push(String(detailRes.status))
      if (!detailRes.ok) {
        const errBody = await detailRes.text().catch(() => '')
        summary.errors.push(`Detail fetch ${remId}: HTTP ${detailRes.status} ${errBody.slice(0, 150)}`)
        continue
      }
      const detail = await detailRes.json()
      // Save first response as a sample so we can see the actual shape.
      if (!summary.sampleClaimPaymentResponse) {
        summary.sampleClaimPaymentResponse = JSON.stringify(detail).slice(0, 1500)
      }

      for (const { pcn, stediClaimId, parsed } of walkClaimPayments(detail)) {
        const claim = await findClaimByStediIdOrPCN(sql, stediClaimId, pcn)
        if (!claim) {
          summary.unmatched += 1
          if (summary.sampleUnmatchedPCNs.length < 5) summary.sampleUnmatchedPCNs.push(pcn)
          continue
        }
        if (claim.practice_id !== provider.practice_id) continue
        try {
          const { statementCreated } = await applyEraPaymentToClaim(sql, claim, parsed, detail)
          summary.matched += 1
          if (statementCreated) summary.statementsCreated += 1
          else summary.statementsUpdated += 1
        } catch (perClaimErr: any) {
          summary.errors.push(`Claim ${claim.id}: ${perClaimErr?.message ?? String(perClaimErr)}`)
        }
      }
    }

    if (summary.matched === 0 && summary.unmatched === 0) {
      summary.diagnosis = `Fetched ${summary.fetched} remittance(s) from Stedi, but none contained a claim payment we could parse. The JSON structure may have changed — check Stedi's API docs or share a raw remittance for me to look at.`
    } else if (summary.matched === 0 && summary.unmatched > 0) {
      summary.diagnosis = `Stedi returned ${summary.unmatched} claim payment(s), but NONE matched a local claim by patient control number. This means the PCN scheme used at claim submission doesn't match the reverse-lookup. Sample unmatched PCNs: ${summary.sampleUnmatchedPCNs.join(', ')}. Compare to first 20 chars of your local claim UUIDs (with dashes stripped).`
    } else {
      summary.diagnosis = `Success — applied ${summary.matched} ERA payment(s) to claims. ${summary.statementsCreated} new patient statements created, ${summary.statementsUpdated} updated. Any unmatched (${summary.unmatched}) are payments for claims not in this database.`
    }

    return res.status(200).json(summary)
  } catch (e: any) {
    console.error('[admin/test-stedi-era-sync] error:', e)
    summary.ok = false
    summary.diagnosis = `Unexpected error: ${e?.message ?? String(e)}`
    return res.status(200).json(summary)
  }
}
