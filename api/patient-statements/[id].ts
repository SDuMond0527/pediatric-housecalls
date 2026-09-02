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

    const num = (v: any) => (v === '' || v == null ? null : Number(v))

    const [updated] = await sql`
      UPDATE patient_statements SET
        patient_first_name   = COALESCE(${patient_first_name || null}, patient_first_name),
        patient_last_name    = COALESCE(${patient_last_name || null}, patient_last_name),
        patient_dob          = COALESCE(${patient_dob || null}, patient_dob),
        date_of_service      = COALESCE(${date_of_service || null}, date_of_service),
        cpt_codes            = COALESCE(${cpt_codes != null ? JSON.stringify(cpt_codes) : null}::jsonb, cpt_codes),
        patient_email        = COALESCE(${patient_email || null}, patient_email),
        patient_phone        = COALESCE(${patient_phone || null}, patient_phone),
        amount_billed        = COALESCE(${num(amount_billed)}, amount_billed),
        insurance_payment    = COALESCE(${num(insurance_payment)}, insurance_payment),
        contractual_adjustment = COALESCE(${num(contractual_adjustment)}, contractual_adjustment),
        patient_copay        = COALESCE(${num(patient_copay)}, patient_copay),
        patient_deductible   = COALESCE(${num(patient_deductible)}, patient_deductible),
        patient_coinsurance  = COALESCE(${num(patient_coinsurance)}, patient_coinsurance),
        patient_non_covered  = COALESCE(${num(patient_non_covered)}, patient_non_covered),
        remaining_balance    = COALESCE(${num(remaining_balance)}, remaining_balance),
        prior_balance        = COALESCE(${num(prior_balance)}, prior_balance),
        total_amount_due      = COALESCE(${num(total_amount_due)}, total_amount_due),
        total_amount_due_text = COALESCE(${num(total_amount_due) != null ? String(num(total_amount_due)) : null}, total_amount_due_text),
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
