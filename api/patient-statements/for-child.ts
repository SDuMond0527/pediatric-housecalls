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

    const [provider] = await sql`SELECT id, practice_id FROM providers WHERE cognito_sub = ${sub} LIMIT 1`
    if (!provider) return res.status(403).json({ error: 'Provider not found' })

    const { child_id } = req.query as { child_id?: string }
    if (!child_id) return res.status(400).json({ error: 'child_id required' })

    // sent/paid only — drafts and voids are hidden from the patient chart's
    // Billing tab per product spec. Full statement lifecycle is still
    // visible on AdminStatements for the biller.
    const rows = await sql`
      SELECT
        ps.id,
        ps.status,
        ps.cpt_codes,
        ps.visit_type,
        ps.provider_name,
        COALESCE(NULLIF(ps.total_amount_due_text, ''), ps.total_amount_due::text) AS total_amount_due,
        ps.amount_billed,
        ps.insurance_payment,
        ps.contractual_adjustment,
        ps.patient_copay,
        ps.patient_deductible,
        ps.patient_coinsurance,
        ps.patient_non_covered,
        ps.remaining_balance,
        ps.prior_balance,
        ps.square_payment_link_url AS square_payment_url,
        ps.sent_at,
        ps.paid_at,
        ps.paid_amount_cents,
        ps.created_at,
        ps.claim_id,
        c.payer_name,
        COALESCE(ps.patient_first_name, c.patient_first_name) AS patient_first_name,
        COALESCE(ps.patient_last_name,  c.patient_last_name)  AS patient_last_name,
        COALESCE(ps.patient_dob::text,  c.patient_dob::text)  AS patient_dob,
        COALESCE(ps.date_of_service::text, c.service_date::text) AS service_date
      FROM patient_statements ps
      LEFT JOIN claims c ON c.id = ps.claim_id
      WHERE ps.practice_id = ${provider.practice_id}::uuid
        AND ps.status IN ('sent', 'paid')
        AND COALESCE(
          c.child_id,
          (SELECT child_id FROM appointments WHERE id = c.appointment_id LIMIT 1)
        ) = ${child_id}::uuid
      ORDER BY ps.created_at DESC
    `

    return res.status(200).json(rows)
  } catch (e: any) {
    console.error('patient-statements/for-child error:', e)
    return res.status(500).json({ error: e.message ?? 'Internal server error' })
  }
}
