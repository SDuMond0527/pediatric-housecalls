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

// Discovered via Sara's Stedi portal Network tab 2026-09-11 — see the
// same comment in api/admin/test-stedi-era-sync.ts for the story.
const STEDI_REMITTANCES_LIST_URL =
  'https://claims-manager.us.stedi.com/2025-09-01/eras'
const STEDI_REMITTANCE_DETAIL_URL = (id: string) =>
  `https://claims-manager.us.stedi.com/2025-09-01/eras/${id}`

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
  if (CRON_SECRET && req.headers.authorization !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' })
  }
  if (!STEDI_API_KEY) return res.status(500).json({ error: 'STEDI_API_KEY not configured' })

  const sql = neon(process.env.DATABASE_URL!)
  try { await sql`ALTER TABLE claims ADD COLUMN IF NOT EXISTS era_seen_at timestamptz` } catch {}

  const summary = { fetched: 0, matched: 0, statementsCreated: 0, statementsUpdated: 0, unmatched: 0, errors: [] as string[] }

  try {
    const params = new URLSearchParams({ limit: '50' })
    const listRes = await fetch(`${STEDI_REMITTANCES_LIST_URL}?${params}`, {
      headers: { Authorization: `Key ${STEDI_API_KEY}`, 'Content-Type': 'application/json' },
    })
    if (!listRes.ok) {
      const body = await listRes.text().catch(() => '')
      return res.status(200).json({ ...summary, errors: [`Stedi list failed: ${listRes.status} ${body.slice(0, 200)}`] })
    }
    const listData = await listRes.json()
    const remittances: any[] = listData?.remittances ?? listData?.items ?? []
    summary.fetched = remittances.length

    for (const rem of remittances) {
      const remId = rem?.id ?? rem?.remittanceId
      if (!remId) continue
      const detailRes = await fetch(STEDI_REMITTANCE_DETAIL_URL(remId), { headers: { Authorization: `Key ${STEDI_API_KEY}` } })
      if (!detailRes.ok) { summary.errors.push(`Detail fetch ${remId}: ${detailRes.status}`); continue }
      const detail = await detailRes.json()
      for (const { pcn, parsed } of walkClaimPayments(detail)) {
        const claim = await findClaimByPCN(sql, pcn)
        if (!claim) { summary.unmatched += 1; continue }
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
    return res.status(200).json(summary)
  } catch (e: any) {
    console.error('[stedi-era-poll] error:', e)
    return res.status(200).json({ ...summary, errors: [...summary.errors, e?.message ?? String(e)] })
  }
}
