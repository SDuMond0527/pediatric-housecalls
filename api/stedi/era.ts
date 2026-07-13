import type { VercelRequest, VercelResponse } from '@vercel/node'
import { neon } from '@neondatabase/serverless'
import { createRemoteJWKSet, jwtVerify } from 'jose'

async function verifyToken(authHeader: string | undefined): Promise<string> {
  if (!authHeader?.startsWith('Bearer ')) throw new Error('Missing token')
  const token = authHeader.slice(7)
  const region     = process.env.VITE_AWS_REGION || 'us-east-2'
  const userPoolId = process.env.VITE_AWS_USER_POOL_ID || ''
  const JWKS = createRemoteJWKSet(new URL(`https://cognito-idp.${region}.amazonaws.com/${userPoolId}/.well-known/jwks.json`))
  const { payload } = await jwtVerify(token, JWKS, { issuer: `https://cognito-idp.${region}.amazonaws.com/${userPoolId}` })
  if (!payload.sub) throw new Error('No sub in token')
  return payload.sub
}

// Walk the 835 JSON and find the claim matching our patient control number.
// Stedi maps X12 segments to JSON — we handle the most common field name variants.
function findAndParseClaimPayment(eraBody: any, patientControlNumber: string) {
  const interchanges = eraBody?.interchanges ?? [eraBody]
  for (const interchange of interchanges) {
    const groups = interchange?.functionalGroups ?? interchange?.functionalGroup ?? [interchange]
    for (const group of groups) {
      const txSets =
        group?.transactionSets ??
        group?.transactionSet ??
        eraBody?.transactionSets ??
        []
      for (const txSet of txSets) {
        const claims =
          txSet?.claimPaymentInformation ??
          txSet?.claimPayments ??
          txSet?.detail?.claimPaymentInformation ??
          []
        for (const cp of claims) {
          const pcn = cp?.patientControlNumber ?? cp?.patientAccountNumber
          if (pcn !== patientControlNumber) continue

          const amountBilled     = parseFloat(cp?.totalClaimChargeAmount ?? 0) || null
          const insurancePayment = parseFloat(cp?.claimPaymentAmount ?? cp?.paymentAmount ?? 0) || null

          let contractualAdj = 0, deductible = 0, coinsurance = 0, copay = 0, nonCovered = 0

          for (const group of (cp?.claimAdjustmentInformation ?? cp?.adjustmentGroups ?? cp?.claimAdjustments ?? [])) {
            const gc      = group?.adjustmentGroupCode ?? group?.claimAdjustmentGroupCode ?? ''
            const details = group?.adjustmentDetails ?? group?.claimAdjustments ?? group?.adjustments ?? []
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

          return {
            amount_billed:          amountBilled,
            insurance_payment:      insurancePayment,
            contractual_adjustment: contractualAdj || null,
            patient_deductible:     deductible     || null,
            patient_coinsurance:    coinsurance    || null,
            patient_copay:          copay          || null,
            patient_non_covered:    nonCovered     || null,
          }
        }
      }
    }
  }
  return null
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  try {
    const sub = await verifyToken(req.headers.authorization)
    const sql = neon(process.env.DATABASE_URL!)

    const [provider] = await sql`SELECT practice_id FROM providers WHERE cognito_sub = ${sub} LIMIT 1`
    if (!provider) return res.status(403).json({ error: 'Provider not found' })

    const claimId = req.query.claim_id as string
    if (!claimId) return res.status(400).json({ error: 'claim_id required' })

    const [claim] = await sql`
      SELECT id, stedi_claim_id, payer_id,
             era_received_at,
             amount_billed_era, insurance_payment_era,
             contractual_adjustment_era, patient_deductible_era,
             patient_coinsurance_era, patient_copay_era, patient_non_covered_era,
             era_raw
      FROM claims
      WHERE id = ${claimId}::uuid AND practice_id = ${provider.practice_id}::uuid
      LIMIT 1
    `
    if (!claim) return res.status(404).json({ error: 'Claim not found' })

    // 1. Serve stored ERA data immediately — fastest path, set by the webhook
    if (claim.era_received_at) {
      return res.status(200).json({
        available: true,
        source: 'stored',
        era_received_at: claim.era_received_at,
        amount_billed:          claim.amount_billed_era,
        insurance_payment:      claim.insurance_payment_era,
        contractual_adjustment: claim.contractual_adjustment_era,
        patient_deductible:     claim.patient_deductible_era,
        patient_coinsurance:    claim.patient_coinsurance_era,
        patient_copay:          claim.patient_copay_era,
        patient_non_covered:    claim.patient_non_covered_era,
      })
    }

    const stediApiKey = process.env.STEDI_API_KEY
    if (!stediApiKey || !claim.stedi_claim_id) {
      return res.status(200).json({ available: false, message: 'ERA not yet received for this claim' })
    }

    // Patient control number = how we identified this claim in the 837 submission
    const patientControlNumber = claimId.replace(/-/g, '').slice(0, 20)

    // 2. Try to pull from Stedi's remittances (835 ERA) API
    // Stedi lists ERA files received for your account, filtered by payer
    // Verify endpoint and params at: https://www.stedi.com/docs/api/healthcare
    try {
      const params = new URLSearchParams()
      if (claim.payer_id) params.set('tradingPartnerId', claim.payer_id)
      params.set('limit', '50')

      const listRes = await fetch(
        `https://healthcare.us.stedi.com/2024-04-01/change/medicalnetwork/remittances/v3?${params}`,
        { headers: { Authorization: `Key ${stediApiKey}`, 'Content-Type': 'application/json' } }
      )

      if (listRes.ok) {
        const listData = await listRes.json()
        const remittances: any[] = listData?.remittances ?? listData?.items ?? []

        for (const rem of remittances) {
          const remId = rem?.id ?? rem?.remittanceId
          if (!remId) continue

          const detailRes = await fetch(
            `https://healthcare.us.stedi.com/2024-04-01/change/medicalnetwork/remittances/v3/${remId}`,
            { headers: { Authorization: `Key ${stediApiKey}` } }
          )
          if (!detailRes.ok) continue

          const detail = await detailRes.json()
          const parsed = findAndParseClaimPayment(detail, patientControlNumber)
          if (!parsed) continue

          // Cache the result back onto the claim so next call is instant
          await sql`
            UPDATE claims SET
              era_received_at          = NOW(),
              era_raw                  = ${JSON.stringify(detail)}::jsonb,
              amount_billed_era        = ${parsed.amount_billed},
              insurance_payment_era    = ${parsed.insurance_payment},
              contractual_adjustment_era = ${parsed.contractual_adjustment},
              patient_deductible_era   = ${parsed.patient_deductible},
              patient_coinsurance_era  = ${parsed.patient_coinsurance},
              patient_copay_era        = ${parsed.patient_copay},
              patient_non_covered_era  = ${parsed.patient_non_covered},
              updated_at               = NOW()
            WHERE id = ${claimId}::uuid
          `

          return res.status(200).json({ available: true, source: 'live', ...parsed })
        }
      }
    } catch (liveErr: any) {
      console.warn('[stedi/era] Live remittances pull failed:', liveErr?.message)
      // Fall through to "not yet available"
    }

    return res.status(200).json({ available: false, message: 'ERA not yet received for this claim' })

  } catch (e: any) {
    console.error('[stedi/era] error:', e)
    return res.status(200).json({ available: false, message: 'ERA not yet available' })
  }
}
