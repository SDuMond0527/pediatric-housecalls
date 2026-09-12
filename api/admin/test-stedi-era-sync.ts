import type { VercelRequest, VercelResponse } from '@vercel/node'
import { neon } from '@neondatabase/serverless'
import { createRemoteJWKSet, jwtVerify } from 'jose'

// Admin-triggered ERA sync — same pipeline as the scheduled cron but
// authed via admin provider token. Wired to a button on AdminClaims so
// Sara can verify end-to-end. Every helper is inlined — see comment in
// api/cron/stedi-era-poll.ts for the reason.

const STEDI_API_KEY = process.env.STEDI_API_KEY || ''

const STEDI_REMITTANCES_LIST_URL =
  'https://healthcare.us.stedi.com/2024-04-01/change/medicalnetwork/remittances/v3'
const STEDI_REMITTANCE_DETAIL_URL = (id: string) =>
  `https://healthcare.us.stedi.com/2024-04-01/change/medicalnetwork/remittances/v3/${id}`

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

function walkClaimPayments(eraBody: any): Array<{ pcn: string; parsed: ParsedEraPayment }> {
  const out: Array<{ pcn: string; parsed: ParsedEraPayment }> = []
  const interchanges = eraBody?.interchanges ?? [eraBody]
  for (const interchange of interchanges) {
    const groups = interchange?.functionalGroups ?? interchange?.functionalGroup ?? [interchange]
    for (const group of groups) {
      const txSets = group?.transactionSets ?? group?.transactionSet ?? eraBody?.transactionSets ?? []
      for (const txSet of txSets) {
        const claims = txSet?.claimPaymentInformation ?? txSet?.claimPayments ?? txSet?.detail?.claimPaymentInformation ?? []
        for (const cp of claims) {
          const pcn = String(cp?.patientControlNumber ?? cp?.patientAccountNumber ?? '').trim()
          if (!pcn) continue
          const amountBilled     = parseFloat(cp?.totalClaimChargeAmount ?? 0) || null
          const insurancePayment = parseFloat(cp?.claimPaymentAmount ?? cp?.paymentAmount ?? 0) || null
          let contractualAdj = 0, deductible = 0, coinsurance = 0, copay = 0, nonCovered = 0
          for (const grp of (cp?.claimAdjustmentInformation ?? cp?.adjustmentGroups ?? cp?.claimAdjustments ?? [])) {
            const gc = grp?.adjustmentGroupCode ?? grp?.claimAdjustmentGroupCode ?? ''
            const details = grp?.adjustmentDetails ?? grp?.claimAdjustments ?? grp?.adjustments ?? []
            for (const d of details) {
              const code   = d?.adjustmentReasonCode ?? d?.claimAdjustmentReasonCode ?? ''
              const amount = parseFloat(d?.adjustmentAmount ?? 0)
              if (gc === 'CO' && code === '45') contractualAdj += amount
              if (gc === 'PR' && code === '1')  deductible     += amount
              if (gc === 'PR' && code === '2')  coinsurance    += amount
              if (gc === 'PR' && code === '3')  copay          += amount
              if (gc === 'PR' && code === '96') nonCovered     += amount
            }
          }
          out.push({
            pcn,
            parsed: {
              amount_billed:          amountBilled,
              insurance_payment:      insurancePayment,
              contractual_adjustment: contractualAdj || null,
              patient_deductible:     deductible     || null,
              patient_coinsurance:    coinsurance    || null,
              patient_copay:          copay          || null,
              patient_non_covered:    nonCovered     || null,
            },
          })
        }
      }
    }
  }
  return out
}

async function findClaimByPCN(sql: any, pcn: string): Promise<any | null> {
  const rows = await sql`
    SELECT id, practice_id, encounter_note_id, appointment_id, child_id,
           payer_name, payer_id, service_date, cpt_codes,
           patient_first_name, patient_last_name, patient_dob, patient_gender,
           era_received_at, era_seen_at
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
      if (!detailRes.ok) {
        summary.errors.push(`Detail fetch ${remId}: HTTP ${detailRes.status}`)
        continue
      }
      const detail = await detailRes.json()

      for (const { pcn, parsed } of walkClaimPayments(detail)) {
        const claim = await findClaimByPCN(sql, pcn)
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
