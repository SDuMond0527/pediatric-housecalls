import type { VercelRequest, VercelResponse } from '@vercel/node'
import { neon } from '@neondatabase/serverless'
import { createRemoteJWKSet, jwtVerify } from 'jose'

async function verifyFamilyToken(authHeader: string | undefined): Promise<string> {
  if (!authHeader?.startsWith('Bearer ')) throw new Error('Missing token')
  const token = authHeader.slice(7)
  const region = process.env.VITE_AWS_REGION || 'us-east-2'
  const poolId = process.env.VITE_FAMILY_USER_POOL_ID || ''
  const JWKS = createRemoteJWKSet(new URL(`https://cognito-idp.${region}.amazonaws.com/${poolId}/.well-known/jwks.json`))
  const { payload } = await jwtVerify(token, JWKS, { issuer: `https://cognito-idp.${region}.amazonaws.com/${poolId}` })
  if (!payload.sub) throw new Error('No sub')
  return payload.sub as string
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  let sub: string
  try {
    sub = await verifyFamilyToken(req.headers.authorization)
  } catch {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  try {
    const sql = neon(process.env.DATABASE_URL!)

    const [fam] = await sql`
      SELECT id, practice_id FROM family_profiles WHERE cognito_sub = ${sub} LIMIT 1
    `
    if (!fam) return res.json([])

    // Parents only see sent + paid statements. Drafts and voids are
    // internal-only. Filter is applied here at the API boundary so the
    // family dashboard can't accidentally leak in-progress billing.
    const rows = await sql`
      SELECT
        ps.id,
        ps.status,
        ps.visit_type,
        ps.provider_name,
        ps.cpt_codes,
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
        c.payer_name,
        COALESCE(ps.patient_first_name, c.patient_first_name, ch.first_name) AS patient_first_name,
        COALESCE(ps.patient_last_name,  c.patient_last_name,  ch.last_name)  AS patient_last_name,
        ch.chart_number                                                       AS chart_number,
        COALESCE(ps.patient_dob::text,  c.patient_dob::text,  ch.date_of_birth::text) AS patient_dob,
        COALESCE(ps.date_of_service::text, c.service_date::text)             AS service_date
      FROM patient_statements ps
      LEFT JOIN claims c ON c.id = ps.claim_id
      JOIN children ch ON ch.id = COALESCE(
        c.child_id,
        (SELECT child_id FROM appointments WHERE id = c.appointment_id LIMIT 1)
      )
      WHERE ps.practice_id = ${fam.practice_id}::uuid
        AND ch.family_id  = ${fam.id}::uuid
        AND ps.status IN ('sent', 'paid')
      ORDER BY ps.created_at DESC
    `

    return res.status(200).json(rows)
  } catch (e: any) {
    console.error('family/patient-statements error:', e)
    return res.status(500).json({ error: e.message ?? 'Internal server error' })
  }
}
