import type { VercelRequest, VercelResponse } from '@vercel/node'
import { neon } from '@neondatabase/serverless'
import { createRemoteJWKSet, jwtVerify } from 'jose'

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

/**
 * GET /api/patient-billing-log?child_id=xxx
 *
 * The "log book" of every bill transaction for a given patient. One row
 * per claim, each row carrying the encounter details, ERA breakdown
 * (if received), and any linked patient statement (with its own status
 * + paid info). Ordered by service_date DESC so the newest encounter
 * shows first.
 *
 * Used by the staff-side Billing tab on PatientChart. The family portal
 * does NOT hit this endpoint — parents see only sent/paid statements
 * via /api/family/patient-statements.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  try {
    const sub = await verifyToken(req.headers.authorization)
    const sql = neon(process.env.DATABASE_URL!)

    const [provider] = await sql`SELECT practice_id FROM providers WHERE cognito_sub = ${sub} LIMIT 1`
    if (!provider) return res.status(403).json({ error: 'Provider not found' })

    const { child_id } = req.query as { child_id?: string }
    if (!child_id) return res.status(400).json({ error: 'child_id required' })

    // Bootstrap payment_note in case a claim/statement update path is
    // hit against a database that has not yet run the mark-paid migration.
    try {
      await sql`ALTER TABLE patient_statements ADD COLUMN IF NOT EXISTS payment_note text`
    } catch {}

    const rows = await sql`
      SELECT
        cl.id                          AS claim_id,
        cl.status                      AS claim_status,
        cl.service_date::text          AS service_date,
        cl.payer_name,
        cl.payer_id,
        cl.cpt_codes,
        cl.total_charge,
        cl.amount_billed_era,
        cl.insurance_payment_era,
        cl.contractual_adjustment_era,
        cl.patient_copay_era,
        cl.patient_deductible_era,
        cl.patient_coinsurance_era,
        cl.patient_non_covered_era,
        cl.era_received_at,
        cl.submitted_at,
        cl.stedi_claim_id,
        cl.submission_error,
        cl.subscriber_name,
        cl.subscriber_dob::text        AS subscriber_dob,
        cl.member_id,
        cl.patient_first_name,
        cl.patient_last_name,
        cl.patient_dob::text           AS patient_dob,
        a.visit_type,
        p.name                         AS provider_name,
        ps.id                          AS statement_id,
        ps.status                      AS statement_status,
        ps.sent_at                     AS statement_sent_at,
        ps.paid_at                     AS statement_paid_at,
        ps.paid_amount_cents           AS statement_paid_amount_cents,
        ps.payment_note                AS statement_payment_note,
        COALESCE(NULLIF(ps.total_amount_due_text, ''), ps.total_amount_due::text) AS statement_total_amount_due,
        ps.amount_billed               AS statement_amount_billed,
        ps.insurance_payment           AS statement_insurance_payment,
        ps.contractual_adjustment      AS statement_contractual_adjustment,
        ps.patient_copay               AS statement_patient_copay,
        ps.patient_deductible          AS statement_patient_deductible,
        ps.patient_coinsurance         AS statement_patient_coinsurance,
        ps.patient_non_covered         AS statement_patient_non_covered,
        ps.remaining_balance           AS statement_remaining_balance,
        ps.prior_balance               AS statement_prior_balance,
        ps.square_payment_link_url     AS statement_square_payment_url,
        ps.created_at                  AS statement_created_at
      FROM claims cl
      LEFT JOIN appointments a ON a.id = cl.appointment_id
      LEFT JOIN providers    p ON p.id = cl.provider_id
      LEFT JOIN patient_statements ps ON ps.claim_id = cl.id
      WHERE cl.practice_id = ${provider.practice_id}::uuid
        AND COALESCE(
          cl.child_id,
          (SELECT child_id FROM appointments WHERE id = cl.appointment_id LIMIT 1)
        ) = ${child_id}::uuid
      ORDER BY cl.service_date DESC NULLS LAST, cl.created_at DESC
    `

    return res.status(200).json(rows)
  } catch (e: any) {
    console.error('patient-billing-log error:', e)
    return res.status(500).json({ error: e.message ?? 'Internal server error' })
  }
}
