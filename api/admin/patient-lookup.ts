import type { VercelRequest, VercelResponse } from '@vercel/node'
import { neon } from '@neondatabase/serverless'

/**
 * GET /api/admin/patient-lookup?q=<name>
 *
 * Service-token-gated diagnostic. Takes a free-text name query, returns
 * matching children + their family_profiles signup status. Lets the
 * platform operator confirm whether a given family has an account
 * before troubleshooting a login complaint — without exposing PHI to
 * a public surface.
 *
 * Not Cognito-authed; strictly requires INTERNAL_SERVICE_TOKEN.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  const expected = process.env.INTERNAL_SERVICE_TOKEN || ''
  const provided = String(req.headers['x-internal-service-token'] ?? '')
  if (!expected || provided !== expected) return res.status(401).json({ error: 'Unauthorized' })

  const q = String(req.query.q ?? '').trim().toLowerCase()
  if (q.length < 2) return res.status(400).json({ error: 'q (name query) required, 2+ chars' })

  const sql = neon(process.env.DATABASE_URL!)
  const pattern = `%${q}%`

  const children = await sql`
    SELECT
      ch.id, ch.first_name, ch.last_name, ch.date_of_birth, ch.family_id,
      ch.parent_email AS child_parent_email, ch.parent_phone AS child_parent_phone,
      fp.id              AS fp_id,
      fp.cognito_sub     AS fp_cognito_sub,
      fp.email           AS fp_email,
      fp.display_name    AS fp_display_name,
      fp.phone           AS fp_phone,
      fp.created_at      AS fp_created_at,
      fp.agreements_accepted_at,
      fp.payment_policy_accepted_at
    FROM children ch
    LEFT JOIN family_profiles fp ON fp.id = ch.family_id
    WHERE LOWER(ch.first_name) LIKE ${pattern}
       OR LOWER(ch.last_name)  LIKE ${pattern}
       OR LOWER(CONCAT(ch.first_name, ' ', ch.last_name)) LIKE ${pattern}
    ORDER BY ch.last_name, ch.first_name
    LIMIT 30`

  return res.json({ q, count: children.length, children })
}
