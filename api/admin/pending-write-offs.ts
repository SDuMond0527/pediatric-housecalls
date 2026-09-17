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
 * GET /api/admin/pending-write-offs
 * GET /api/admin/pending-write-offs?count=1
 *
 * Returns write-off requests submitted by admin billers awaiting owner
 * (super_admin) review. count=1 → lightweight { count } for the sidebar
 * badge; no query param → full list for the review page.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  try {
    const sub = await verifyToken(req.headers.authorization)
    const sql = neon(process.env.DATABASE_URL!)

    const [provider] = await sql`SELECT id, is_admin, practice_id FROM providers WHERE cognito_sub = ${sub} LIMIT 1`
    if (!provider) return res.status(403).json({ error: 'Provider not found' })
    if (!provider.is_admin) return res.status(403).json({ error: 'Admin access required' })

    // Idempotent — surfaces the columns before the first request lands.
    try { await sql`ALTER TABLE patient_statements ADD COLUMN IF NOT EXISTS write_off_pending boolean` } catch {}
    try { await sql`ALTER TABLE claims ADD COLUMN IF NOT EXISTS write_off_pending boolean` } catch {}
    try { await sql`ALTER TABLE patient_statements ADD COLUMN IF NOT EXISTS write_off_requested_by uuid` } catch {}
    try { await sql`ALTER TABLE patient_statements ADD COLUMN IF NOT EXISTS write_off_requested_at timestamptz` } catch {}
    try { await sql`ALTER TABLE claims ADD COLUMN IF NOT EXISTS write_off_requested_by uuid` } catch {}
    try { await sql`ALTER TABLE claims ADD COLUMN IF NOT EXISTS write_off_requested_at timestamptz` } catch {}

    const { count } = req.query as { count?: string }

    if (count === '1') {
      const [row] = await sql`
        SELECT (
          (SELECT COUNT(*) FROM patient_statements WHERE practice_id = ${provider.practice_id}::uuid AND write_off_pending = TRUE)
        + (SELECT COUNT(*) FROM claims WHERE practice_id = ${provider.practice_id}::uuid AND write_off_pending = TRUE)
        )::int AS count
      `
      return res.status(200).json({ count: row?.count ?? 0 })
    }

    const statements = await sql`
      SELECT
        'statement'::text                                  AS side,
        ps.id                                              AS id,
        ps.void_reason                                     AS reason,
        ps.void_note                                       AS note,
        ps.write_off_requested_at                          AS requested_at,
        rp.name                                            AS requested_by_name,
        COALESCE(ps.total_amount_due, 0)::numeric(12,2)    AS amount,
        c.payer_name                                       AS payer_name,
        COALESCE(ps.patient_first_name, c.patient_first_name, ch.first_name) AS patient_first_name,
        COALESCE(ps.patient_last_name,  c.patient_last_name,  ch.last_name)  AS patient_last_name,
        ch.chart_number                                    AS chart_number,
        COALESCE(ps.date_of_service::text, c.service_date::text) AS service_date
      FROM patient_statements ps
      LEFT JOIN claims c    ON c.id  = ps.claim_id
      LEFT JOIN children ch ON ch.id = COALESCE(c.child_id, (SELECT child_id FROM appointments WHERE id = c.appointment_id LIMIT 1))
      LEFT JOIN providers rp ON rp.id = ps.write_off_requested_by
      WHERE ps.practice_id = ${provider.practice_id}::uuid
        AND ps.write_off_pending = TRUE
      ORDER BY ps.write_off_requested_at ASC
    `

    const claims = await sql`
      SELECT
        'claim'::text                                       AS side,
        cl.id                                               AS id,
        cl.write_off_reason                                 AS reason,
        cl.write_off_note                                   AS note,
        cl.write_off_requested_at                           AS requested_at,
        rp.name                                             AS requested_by_name,
        COALESCE(cl.total_charge, 0)::numeric(12,2)         AS amount,
        cl.payer_name                                       AS payer_name,
        COALESCE(cl.patient_first_name, ch.first_name)      AS patient_first_name,
        COALESCE(cl.patient_last_name,  ch.last_name)       AS patient_last_name,
        ch.chart_number                                     AS chart_number,
        cl.service_date::text                               AS service_date
      FROM claims cl
      LEFT JOIN children ch  ON ch.id = COALESCE(cl.child_id, (SELECT child_id FROM appointments WHERE id = cl.appointment_id LIMIT 1))
      LEFT JOIN providers rp ON rp.id = cl.write_off_requested_by
      WHERE cl.practice_id = ${provider.practice_id}::uuid
        AND cl.write_off_pending = TRUE
      ORDER BY cl.write_off_requested_at ASC
    `

    return res.status(200).json({
      statements,
      claims,
      total: statements.length + claims.length,
    })
  } catch (e: any) {
    console.error('admin/pending-write-offs error:', e)
    return res.status(500).json({ error: e.message ?? 'Internal server error' })
  }
}
