import type { VercelRequest, VercelResponse } from '@vercel/node'
import { neon } from '@neondatabase/serverless'
import { createRemoteJWKSet, jwtVerify } from 'jose'

// Attach an unmatched Stedi ERA (sitting with matched_claim_count = 0
// in stedi_transactions_processed) to a specific claim in our DB.
// Covers the "Andrea resubmitted outside GoRoam → ERA came back to
// Stedi but has no local join key" gap. Sara 2026-11-09.
//
// Flow:
//   1. Verify super-admin.
//   2. Pull the 835 JSON report from Stedi for the transaction ID.
//   3. Walk the 835 to find the specific sub-claim the user wants to
//      attach (there can be multiple inside one 835).
//   4. Apply the payment to the local claim row, stamping era_seen_at
//      at the same time so the "NEW ERA" badge doesn't fire (Sara just
//      saw it + is attaching it deliberately).
//   5. Backfill stedi_claim_id + payer_control_number from the 835 so
//      any FUTURE ERAs for the same claim match natively.
//   6. Flip matched_claim_count to 1 on the transaction row so the
//      unmatched list doesn't show it again.
//   7. Log to claim_activity_log + fire the underpayment flagger.

async function verifyToken(authHeader: string | undefined): Promise<string> {
  if (!authHeader?.startsWith('Bearer ')) throw new Error('Missing token')
  const token = authHeader.slice(7)
  const region = process.env.VITE_AWS_REGION || 'us-east-2'
  const poolId = process.env.VITE_AWS_USER_POOL_ID || ''
  const JWKS = createRemoteJWKSet(new URL(`https://cognito-idp.${region}.amazonaws.com/${poolId}/.well-known/jwks.json`))
  const { payload } = await jwtVerify(token, JWKS, { issuer: `https://cognito-idp.${region}.amazonaws.com/${poolId}` })
  if (!payload.sub) throw new Error('No sub in token')
  return payload.sub as string
}

const STEDI_API_KEY = process.env.STEDI_API_KEY || ''
const STEDI_835_REPORT_URL = (transactionId: string) =>
  `https://healthcare.us.stedi.com/2024-04-01/change/medicalnetwork/reports/v2/${transactionId}/835`

type EraClaim = {
  patient_control_number: string | null
  payer_claim_control_number: string | null
  total_claim_charge: number | null
  insurance_payment: number | null
  patient_first: string | null
  patient_last: string | null
  service_dates: string[]
  // CAS-group adjustment amounts summed from the 835
  contractual_adjustment: number
  patient_copay: number
  patient_deductible: number
  patient_coinsurance: number
  patient_non_covered: number
  // Raw CAS codes so the underpayment flagger can translate them later
  cas_codes: Array<{ group_code: string; reason_code: string; amount: number }>
  remarks: string[]
}

function parseEraClaims(era835: any): EraClaim[] {
  const out: EraClaim[] = []
  const walk = (obj: any) => {
    if (!obj || typeof obj !== 'object') return
    if (Array.isArray(obj)) { for (const item of obj) walk(item); return }
    if (obj.patientControlNumber || obj.payerClaimControlNumber) {
      const claim: EraClaim = {
        patient_control_number:     obj.patientControlNumber ?? null,
        payer_claim_control_number: obj.payerClaimControlNumber ?? null,
        total_claim_charge:         Number(obj.totalClaimChargeAmount ?? 0) || null,
        insurance_payment:          Number(obj.claimPaymentAmount ?? 0) || null,
        patient_first:              obj.patientName?.firstName ?? obj.patient?.firstName ?? null,
        patient_last:               obj.patientName?.lastName  ?? obj.patient?.lastName  ?? null,
        service_dates: obj.serviceLines
          ? [...new Set((obj.serviceLines ?? [])
              .map((l: any) => l.serviceDate ?? l.serviceDates?.serviceDate ?? l.serviceDates?.startDate)
              .filter(Boolean))] as string[]
          : [],
        contractual_adjustment: 0,
        patient_copay:          0,
        patient_deductible:     0,
        patient_coinsurance:    0,
        patient_non_covered:    0,
        cas_codes:              [],
        remarks:                [],
      }
      // Walk both claim-level adjustments AND per-line adjustments.
      const rollUpAdjustments = (adjArr: any[] | undefined) => {
        if (!Array.isArray(adjArr)) return
        for (const a of adjArr) {
          const grp = String(a?.claimAdjustmentGroupCode ?? a?.groupCode ?? '').toUpperCase()
          const adjs = Array.isArray(a?.adjustmentDetails) ? a.adjustmentDetails
                    : Array.isArray(a?.adjustments) ? a.adjustments : []
          for (const d of adjs) {
            const rsn = String(d?.adjustmentReasonCode ?? d?.reasonCode ?? '')
            const amt = Number(d?.adjustmentAmount ?? d?.amount ?? 0) || 0
            if (!grp || !rsn) continue
            claim.cas_codes.push({ group_code: grp, reason_code: rsn, amount: amt })
            if (grp === 'CO') claim.contractual_adjustment += amt
            if (grp === 'PR') {
              if (rsn === '3') claim.patient_copay += amt
              else if (rsn === '1') claim.patient_deductible += amt
              else if (rsn === '2') claim.patient_coinsurance += amt
              else claim.patient_non_covered += amt
            }
          }
        }
      }
      rollUpAdjustments(obj.claimAdjustments)
      if (Array.isArray(obj.serviceLines)) {
        for (const line of obj.serviceLines) {
          rollUpAdjustments(line.serviceAdjustments)
          if (Array.isArray(line.remarks)) {
            for (const rk of line.remarks) {
              const code = String(rk?.code ?? rk?.remarkCode ?? '').trim()
              if (code) claim.remarks.push(code)
            }
          }
        }
      }
      out.push(claim)
    }
    for (const key of Object.keys(obj)) walk(obj[key])
  }
  walk(era835)
  return out
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
  if (!STEDI_API_KEY) return res.status(500).json({ error: 'STEDI_API_KEY not configured' })

  let sub: string
  try { sub = await verifyToken(req.headers.authorization) }
  catch { return res.status(401).json({ error: 'Unauthorized' }) }

  const sql = neon(process.env.DATABASE_URL!)
  const [actor] = await sql`SELECT id, name, practice_id, is_super_admin FROM providers WHERE cognito_sub = ${sub} LIMIT 1`
  if (!actor?.is_super_admin) return res.status(403).json({ error: 'Not available' })

  const { transaction_id, claim_id, claim_index } = (req.body ?? {}) as {
    transaction_id?: string
    claim_id?: string
    claim_index?: number
  }
  if (!transaction_id) return res.status(400).json({ error: 'transaction_id required' })
  if (!claim_id)       return res.status(400).json({ error: 'claim_id required' })

  // Confirm the target claim exists and belongs to this practice.
  const [claim] = await sql`
    SELECT id, practice_id, status, era_received_at, payer_name, payer_id,
           patient_first_name, patient_last_name
    FROM claims WHERE id = ${claim_id}::uuid AND practice_id = ${actor.practice_id}::uuid LIMIT 1`
  if (!claim) return res.status(404).json({ error: 'Claim not found' })
  if (claim.era_received_at) {
    return res.status(409).json({
      error: `This claim already has an ERA (received ${new Date(claim.era_received_at).toLocaleDateString()}). Overwriting would corrupt audit history — if this is wrong, reach out and we'll correct manually.`,
    })
  }

  // Pull the 835 JSON report from Stedi.
  const reportRes = await fetch(STEDI_835_REPORT_URL(transaction_id), {
    headers: { Authorization: `Key ${STEDI_API_KEY}`, 'Content-Type': 'application/json' },
  })
  if (!reportRes.ok) {
    const body = await reportRes.text().catch(() => '')
    return res.status(502).json({ error: `Stedi fetch failed: ${reportRes.status} ${body.slice(0, 200)}` })
  }
  const era835 = await reportRes.json()
  const eraClaims = parseEraClaims(era835)
  if (eraClaims.length === 0) {
    return res.status(400).json({ error: 'No claim data found in the 835 report' })
  }

  // Pick which sub-claim from the 835 to attach. Default to the first;
  // caller can override with claim_index if there are multiple.
  const idx = typeof claim_index === 'number' && claim_index >= 0 && claim_index < eraClaims.length ? claim_index : 0
  const ec = eraClaims[idx]

  const billed    = Number(ec.total_claim_charge ?? 0) || 0
  const paid      = Number(ec.insurance_payment  ?? 0) || 0

  // Write the payment to the claim row.
  await sql`
    UPDATE claims SET
      era_received_at            = COALESCE(era_received_at, NOW()),
      era_seen_at                = NOW(),
      era_raw                    = ${JSON.stringify(era835)}::jsonb,
      amount_billed_era          = ${billed},
      insurance_payment_era      = ${paid},
      contractual_adjustment_era = ${ec.contractual_adjustment},
      patient_copay_era          = ${ec.patient_copay},
      patient_deductible_era     = ${ec.patient_deductible},
      patient_coinsurance_era    = ${ec.patient_coinsurance},
      patient_non_covered_era    = ${ec.patient_non_covered},
      denial_codes               = ${JSON.stringify(ec.cas_codes)}::jsonb,
      remark_codes               = ${JSON.stringify(ec.remarks)}::jsonb,
      stedi_claim_id             = COALESCE(stedi_claim_id, ${transaction_id}),
      stedi_era_transaction_id   = ${transaction_id},
      payer_control_number       = COALESCE(payer_control_number, ${ec.patient_control_number}),
      stedi_payer_claim_control_number = COALESCE(stedi_payer_claim_control_number, ${ec.payer_claim_control_number}),
      updated_at                 = NOW()
    WHERE id = ${claim_id}::uuid AND practice_id = ${actor.practice_id}::uuid`

  // Mark the transaction as matched so it falls off the unmatched list.
  try {
    await sql`
      UPDATE stedi_transactions_processed
      SET matched_claim_count = 1
      WHERE transaction_id = ${transaction_id}`
  } catch (e: any) {
    console.error('[attach-era] matched_claim_count update failed (non-fatal):', e?.message)
  }

  // Activity log entry so the attach is traceable forever.
  try {
    await sql`
      INSERT INTO claim_activity_log (claim_id, created_by, created_by_name, kind, body)
      VALUES (${claim_id}::uuid, ${actor.id}::uuid, ${actor.name ?? 'Admin'}, 'era_manually_attached',
              ${`Manually attached unmatched Stedi ERA ${transaction_id} to this claim. Billed $${billed.toFixed(2)}, insurance paid $${paid.toFixed(2)}.`})`
  } catch (e: any) {
    console.error('[attach-era] activity log failed (non-fatal):', e?.message)
  }

  return res.status(200).json({
    ok: true,
    transaction_id,
    claim_id,
    era: {
      amount_billed: billed,
      insurance_payment: paid,
      patient_responsibility: +(ec.patient_copay + ec.patient_deductible + ec.patient_coinsurance + ec.patient_non_covered).toFixed(2),
      cas_codes: ec.cas_codes,
    },
  })
}
