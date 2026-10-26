import type { VercelRequest, VercelResponse } from '@vercel/node'
import { neon } from '@neondatabase/serverless'

/**
 * GET /api/admin/referral-diag — service-token-gated diagnostic.
 * Dumps practices + the last 5 referrals + Sara's provider row so we can
 * see whether a submitted referral landed under the practice Sara's
 * admin login belongs to.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })
  const expected = process.env.INTERNAL_SERVICE_TOKEN || ''
  const provided = String(req.headers['x-internal-service-token'] ?? '')
  if (!expected || provided !== expected) return res.status(401).json({ error: 'Unauthorized' })

  const sql = neon(process.env.DATABASE_URL!)
  const practices = await sql`SELECT id, name, created_at FROM practices ORDER BY created_at`
  const referrals = await sql`
    SELECT id, practice_id, referring_uc_name, patient_first_name, patient_last_name, created_at, status
    FROM referrals_in ORDER BY created_at DESC LIMIT 5`
  const sara = await sql`
    SELECT id, name, practice_id, is_admin, receives_referral_alerts, email, phone
    FROM providers
    WHERE LOWER(name) LIKE '%sara%' AND is_admin = true`
  return res.json({ practices, referrals, sara })
}
