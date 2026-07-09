// TODO: Confirm exact Stedi ERA endpoint with Stedi support once ERA enrollment is complete
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { neon } from '@neondatabase/serverless'
import { createRemoteJWKSet, jwtVerify } from 'jose'

async function verifyToken(authHeader: string | undefined): Promise<string> {
  if (!authHeader?.startsWith('Bearer ')) throw new Error('Missing token')
  const token = authHeader.slice(7)
  const region = process.env.VITE_AWS_REGION || 'us-east-2'
  const userPoolId = process.env.VITE_AWS_USER_POOL_ID || ''
  const JWKS = createRemoteJWKSet(new URL(`https://cognito-idp.${region}.amazonaws.com/${userPoolId}/.well-known/jwks.json`))
  const { payload } = await jwtVerify(token, JWKS, { issuer: `https://cognito-idp.${region}.amazonaws.com/${userPoolId}` })
  if (!payload.sub) throw new Error('No sub in token')
  return payload.sub
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  try {
    const sub = await verifyToken(req.headers.authorization)
    const sql = neon(process.env.DATABASE_URL!)

    // Look up provider's practice_id
    const [provider] = await sql`SELECT practice_id FROM providers WHERE cognito_sub = ${sub} LIMIT 1`
    if (!provider) return res.status(403).json({ error: 'Provider not found' })
    const practiceId = provider.practice_id

    const claimId = req.query.claim_id as string
    if (!claimId) return res.status(400).json({ error: 'claim_id required' })

    // 1. Look up claim to get stedi_claim_id
    const [claim] = await sql`
      SELECT id, stedi_claim_id FROM claims
      WHERE id = ${claimId} AND practice_id = ${practiceId}::uuid
      LIMIT 1
    `
    if (!claim) return res.status(404).json({ error: 'Claim not found' })

    const stediClaimId = claim.stedi_claim_id
    if (!stediClaimId) {
      return res.status(200).json({ available: false, message: 'No Stedi claim ID on record for this claim' })
    }

    const stediApiKey = process.env.STEDI_API_KEY
    if (!stediApiKey) {
      return res.status(200).json({ available: false, message: 'Stedi API key not configured' })
    }

    // 2. Call Stedi ERA / claim status API
    let stediRes: Response
    try {
      stediRes = await fetch(
        `https://healthcare.us.stedi.com/2024-04-01/change/medicalnetwork/claimstatus/v3?claimId=${encodeURIComponent(stediClaimId)}`,
        {
          method: 'GET',
          headers: {
            Authorization: `Key ${stediApiKey}`,
            'Content-Type': 'application/json',
          },
        }
      )
    } catch (fetchErr: any) {
      console.error('Stedi ERA fetch error:', fetchErr)
      return res.status(200).json({ available: false, message: 'ERA not yet available for this claim' })
    }

    if (!stediRes.ok) {
      const errText = await stediRes.text()
      console.warn('Stedi ERA non-OK response:', stediRes.status, errText)
      return res.status(200).json({ available: false, message: 'ERA not yet available for this claim' })
    }

    const data = await stediRes.json()

    // 3. Check if useful data came back
    const transactionSets = data?.transactionSets ?? data?.claimStatusTransactionSets ?? []
    if (!transactionSets.length) {
      return res.status(200).json({ available: false, message: 'ERA not yet available for this claim' })
    }

    // 4. Parse and return structured ERA data
    const firstSet = transactionSets[0]
    const claimInfo = firstSet?.claimStatusInformation?.[0] ?? firstSet?.claimInformation?.[0] ?? {}

    // Extract financial fields matching statement structure
    const era = {
      available: true,
      stedi_claim_id: stediClaimId,
      raw: data,
      // Structured fields for pre-filling statement
      amount_billed: claimInfo.chargeAmount ?? claimInfo.totalClaimChargeAmount ?? null,
      insurance_payment: claimInfo.paymentAmount ?? claimInfo.totalClaimPaymentAmount ?? null,
      contractual_adjustment: claimInfo.adjustments?.find((a: any) => a.groupCode === 'CO' && a.reasonCode === '45')?.amount ?? null,
      patient_copay: claimInfo.adjustments?.find((a: any) => a.groupCode === 'PR' && a.reasonCode === '3')?.amount ?? null,
      patient_deductible: claimInfo.adjustments?.find((a: any) => a.groupCode === 'PR' && a.reasonCode === '1')?.amount ?? null,
      patient_coinsurance: claimInfo.adjustments?.find((a: any) => a.groupCode === 'PR' && a.reasonCode === '2')?.amount ?? null,
      patient_non_covered: claimInfo.adjustments?.find((a: any) => a.groupCode === 'PR' && a.reasonCode === '96')?.amount ?? null,
      claim_status: claimInfo.claimStatus ?? null,
      claim_status_details: claimInfo.claimStatusDetails ?? [],
    }

    return res.status(200).json(era)
  } catch (e: any) {
    console.error('stedi/era error:', e)
    return res.status(200).json({ available: false, message: 'ERA not yet available for this claim' })
  }
}
