import type { VercelRequest, VercelResponse } from '@vercel/node'
import { neon } from '@neondatabase/serverless'
import { createHmac } from 'crypto'

// Stedi signs webhooks with HMAC-SHA256 — verify the header matches
// Header name: confirm in Stedi dashboard → Webhooks → your endpoint → Signing secret
function verifyStediSignature(req: VercelRequest, body: string): boolean {
  const secret = process.env.STEDI_WEBHOOK_SECRET
  if (!secret) return true // skip in dev if not configured

  const sig = (req.headers['x-stedi-signature'] ?? req.headers['x-webhook-signature']) as string
  if (!sig) return false

  const expected = 'sha256=' + createHmac('sha256', secret).update(body).digest('hex')
  return expected === sig
}

// Walk the 835 JSON and find the claim payment record matching our patient control number.
// Stedi maps X12 835 segments to JSON — we handle the two most common field name variants.
function findClaimPayment(eraBody: any, patientControlNumber: string): any | null {
  const interchanges = eraBody?.interchanges ?? [eraBody]
  for (const interchange of interchanges) {
    const groups = interchange?.functionalGroups ?? interchange?.functionalGroup ?? [interchange]
    for (const group of groups) {
      const txSets = group?.transactionSets ?? group?.transactionSet ?? eraBody?.transactionSets ?? []
      for (const txSet of txSets) {
        const claims =
          txSet?.claimPaymentInformation ??
          txSet?.claimPayments ??
          txSet?.detail?.claimPaymentInformation ??
          []
        for (const cp of claims) {
          const pcn = cp?.patientControlNumber ?? cp?.patientAccountNumber
          if (pcn === patientControlNumber) return cp
        }
      }
    }
  }
  return null
}

function parseEraAmounts(claimPayment: any) {
  const amountBilled    = parseFloat(claimPayment?.totalClaimChargeAmount ?? 0) || null
  const insurancePayment = parseFloat(claimPayment?.claimPaymentAmount ?? claimPayment?.paymentAmount ?? 0) || null

  let contractualAdj = 0
  let deductible     = 0
  let coinsurance    = 0
  let copay          = 0
  let nonCovered     = 0

  const adjGroups =
    claimPayment?.claimAdjustmentInformation ??
    claimPayment?.adjustmentGroups ??
    claimPayment?.claimAdjustments ??
    []

  for (const group of adjGroups) {
    const groupCode = group?.adjustmentGroupCode ?? group?.claimAdjustmentGroupCode ?? ''
    const details   = group?.adjustmentDetails ?? group?.claimAdjustments ?? group?.adjustments ?? []

    for (const d of details) {
      const code   = d?.adjustmentReasonCode ?? d?.claimAdjustmentReasonCode ?? ''
      const amount = parseFloat(d?.adjustmentAmount ?? 0)
      if (groupCode === 'CO' && code === '45') contractualAdj += amount
      if (groupCode === 'PR' && code === '1')  deductible     += amount
      if (groupCode === 'PR' && code === '2')  coinsurance    += amount
      if (groupCode === 'PR' && code === '3')  copay          += amount
      if (groupCode === 'PR' && code === '96') nonCovered     += amount
    }
  }

  return {
    amount_billed_era:           amountBilled,
    insurance_payment_era:       insurancePayment,
    contractual_adjustment_era:  contractualAdj || null,
    patient_deductible_era:      deductible     || null,
    patient_coinsurance_era:     coinsurance    || null,
    patient_copay_era:           copay          || null,
    patient_non_covered_era:     nonCovered     || null,
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).end()

  const rawBody = typeof req.body === 'string' ? req.body : JSON.stringify(req.body)

  if (!verifyStediSignature(req, rawBody)) {
    console.warn('[webhooks/stedi-era] Invalid signature')
    return res.status(401).json({ error: 'Invalid signature' })
  }

  const event = typeof req.body === 'string' ? JSON.parse(req.body) : req.body
  const sql   = neon(process.env.DATABASE_URL!)

  // An 835 can contain payments for many claims — process all of them
  const interchanges = event?.interchanges ?? [event]
  let processed = 0
  let skipped   = 0

  for (const interchange of interchanges) {
    const groups = interchange?.functionalGroups ?? interchange?.functionalGroup ?? [interchange]
    for (const group of groups) {
      const txSets =
        group?.transactionSets ??
        group?.transactionSet ??
        event?.transactionSets ??
        []

      for (const txSet of txSets) {
        const claims835 =
          txSet?.claimPaymentInformation ??
          txSet?.claimPayments ??
          txSet?.detail?.claimPaymentInformation ??
          []

        for (const claimPayment of claims835) {
          const pcn = claimPayment?.patientControlNumber ?? claimPayment?.patientAccountNumber
          if (!pcn) { skipped++; continue }

          // Patient control number = LEFT(REPLACE(claim_id, '-', ''), 20)
          const [claim] = await sql`
            SELECT id FROM claims
            WHERE LEFT(REPLACE(id::text, '-', ''), 20) = ${pcn}
            LIMIT 1
          `
          if (!claim) { skipped++; continue }

          const amounts = parseEraAmounts(claimPayment)

          await sql`
            UPDATE claims SET
              era_received_at          = NOW(),
              era_raw                  = ${JSON.stringify(event)}::jsonb,
              amount_billed_era        = ${amounts.amount_billed_era},
              insurance_payment_era    = ${amounts.insurance_payment_era},
              contractual_adjustment_era = ${amounts.contractual_adjustment_era},
              patient_deductible_era   = ${amounts.patient_deductible_era},
              patient_coinsurance_era  = ${amounts.patient_coinsurance_era},
              patient_copay_era        = ${amounts.patient_copay_era},
              patient_non_covered_era  = ${amounts.patient_non_covered_era},
              updated_at               = NOW()
            WHERE id = ${claim.id}::uuid
          `

          console.log(`[webhooks/stedi-era] ERA stored for claim ${claim.id} (PCN: ${pcn})`)
          processed++
        }
      }
    }
  }

  console.log(`[webhooks/stedi-era] Done — ${processed} stored, ${skipped} skipped`)
  return res.status(200).json({ received: true, processed, skipped })
}
