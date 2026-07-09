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
  try {
    const sub = await verifyToken(req.headers.authorization)
    const sql = neon(process.env.DATABASE_URL!)

    // Look up provider's practice_id from cognito sub
    const [provider] = await sql`SELECT practice_id FROM providers WHERE cognito_sub = ${sub} LIMIT 1`
    if (!provider) return res.status(403).json({ error: 'Provider not found' })
    const practiceId = provider.practice_id

    if (req.method === 'GET') {
      const claimId = req.query.claim_id as string
      if (!claimId) return res.status(400).json({ error: 'claim_id required' })

      const rows = await sql`
        SELECT ps.*,
          COALESCE(fp.email, '') as family_email,
          COALESCE(fp.phone, '') as family_phone
        FROM patient_statements ps
        LEFT JOIN claims c ON c.id = ps.claim_id
        LEFT JOIN children ch ON ch.id = c.child_id
        LEFT JOIN family_profiles fp ON fp.id = ch.family_id
        WHERE ps.claim_id = ${claimId} AND ps.practice_id = ${practiceId}::uuid
        LIMIT 1
      `
      return res.status(200).json(rows[0] ?? null)
    }

    if (req.method === 'POST') {
      const {
        claim_id,
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

      const [row] = await sql`
        INSERT INTO patient_statements (
          practice_id,
          claim_id,
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
          status,
          created_at,
          updated_at
        ) VALUES (
          ${practiceId}::uuid,
          ${claim_id},
          ${patient_first_name ?? null},
          ${patient_last_name ?? null},
          ${patient_dob ?? null},
          ${date_of_service ?? null},
          ${JSON.stringify(cpt_codes ?? [])}::jsonb,
          ${patient_email ?? null},
          ${patient_phone ?? null},
          ${amount_billed ?? null},
          ${insurance_payment ?? null},
          ${contractual_adjustment ?? null},
          ${patient_copay ?? null},
          ${patient_deductible ?? null},
          ${patient_coinsurance ?? null},
          ${patient_non_covered ?? null},
          ${remaining_balance ?? null},
          ${prior_balance ?? null},
          ${total_amount_due ?? null},
          ${JSON.stringify(explanations ?? [])}::jsonb,
          'draft',
          NOW(),
          NOW()
        )
        RETURNING *
      `
      return res.status(201).json(row)
    }

    return res.status(405).json({ error: 'Method not allowed' })
  } catch (e: any) {
    console.error('patient-statements index error:', e)
    return res.status(500).json({ error: e.message ?? 'Internal server error' })
  }
}
