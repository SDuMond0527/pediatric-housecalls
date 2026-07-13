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

    const [provider] = await sql`SELECT id, is_admin, practice_id FROM providers WHERE cognito_sub = ${sub} LIMIT 1`
    if (!provider) return res.status(403).json({ error: 'Provider not found' })
    if (!provider.is_admin) return res.status(403).json({ error: 'Admin access required' })

    const { status } = req.query as { status?: string }

    const rows = await sql`
      SELECT
        ps.id,
        ps.status,
        ps.patient_name,
        ps.family_email,
        ps.family_phone,
        ps.date_of_service,
        ps.visit_type,
        ps.provider_name,
        ps.total_amount_due_text  AS total_amount_due,
        ps.amount_billed,
        ps.insurance_payment,
        ps.square_payment_link_url AS square_payment_url,
        ps.sent_at,
        ps.paid_at,
        ps.paid_amount_cents,
        ps.created_at,
        ps.claim_id,
        c.stedi_claim_id,
        c.payer_name
      FROM patient_statements ps
      LEFT JOIN claims c ON c.id = ps.claim_id
      WHERE ps.practice_id = ${provider.practice_id}::uuid
        AND (${status ?? null}::text IS NULL OR ps.status = ${status ?? null})
      ORDER BY ps.created_at DESC
      LIMIT 500
    `

    return res.status(200).json(rows)
  } catch (e: any) {
    console.error('patient-statements/all error:', e)
    return res.status(500).json({ error: e.message ?? 'Internal server error' })
  }
}
