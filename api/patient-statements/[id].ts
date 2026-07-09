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
  if (req.method !== 'PATCH') return res.status(405).json({ error: 'Method not allowed' })

  try {
    const sub = await verifyToken(req.headers.authorization)
    const sql = neon(process.env.DATABASE_URL!)

    // Look up provider's practice_id
    const [provider] = await sql`SELECT practice_id FROM providers WHERE cognito_sub = ${sub} LIMIT 1`
    if (!provider) return res.status(403).json({ error: 'Provider not found' })
    const practiceId = provider.practice_id

    const statementId = req.query.id as string
    if (!statementId) return res.status(400).json({ error: 'id required' })

    // Verify the statement belongs to this provider's practice
    const [existing] = await sql`
      SELECT id FROM patient_statements WHERE id = ${statementId} AND practice_id = ${practiceId}::uuid LIMIT 1
    `
    if (!existing) return res.status(404).json({ error: 'Statement not found' })

    const {
      patient_first_name,
      patient_last_name,
      patient_dob,
      date_of_service,
      cpt_codes,
      patient_email,
      patient_phone,
      amount_billed,
      insurance_payment,
      contractual_adjustment,
      patient_copay,
      patient_deductible,
      patient_coinsurance,
      patient_non_covered,
      remaining_balance,
      prior_balance,
      total_amount_due,
      explanations,
    } = req.body

    const [updated] = await sql`
      UPDATE patient_statements SET
        patient_first_name   = COALESCE(${patient_first_name ?? null}, patient_first_name),
        patient_last_name    = COALESCE(${patient_last_name ?? null}, patient_last_name),
        patient_dob          = COALESCE(${patient_dob ?? null}, patient_dob),
        date_of_service      = COALESCE(${date_of_service ?? null}, date_of_service),
        cpt_codes            = COALESCE(${cpt_codes != null ? JSON.stringify(cpt_codes) : null}::jsonb, cpt_codes),
        patient_email        = COALESCE(${patient_email ?? null}, patient_email),
        patient_phone        = COALESCE(${patient_phone ?? null}, patient_phone),
        amount_billed        = COALESCE(${amount_billed ?? null}, amount_billed),
        insurance_payment    = COALESCE(${insurance_payment ?? null}, insurance_payment),
        contractual_adjustment = COALESCE(${contractual_adjustment ?? null}, contractual_adjustment),
        patient_copay        = COALESCE(${patient_copay ?? null}, patient_copay),
        patient_deductible   = COALESCE(${patient_deductible ?? null}, patient_deductible),
        patient_coinsurance  = COALESCE(${patient_coinsurance ?? null}, patient_coinsurance),
        patient_non_covered  = COALESCE(${patient_non_covered ?? null}, patient_non_covered),
        remaining_balance    = COALESCE(${remaining_balance ?? null}, remaining_balance),
        prior_balance        = COALESCE(${prior_balance ?? null}, prior_balance),
        total_amount_due     = COALESCE(${total_amount_due ?? null}, total_amount_due),
        explanations         = COALESCE(${explanations != null ? JSON.stringify(explanations) : null}::jsonb, explanations),
        updated_at           = NOW()
      WHERE id = ${statementId} AND practice_id = ${practiceId}::uuid
      RETURNING *
    `
    return res.status(200).json(updated)
  } catch (e: any) {
    console.error('patient-statements [id] error:', e)
    return res.status(500).json({ error: e.message ?? 'Internal server error' })
  }
}
