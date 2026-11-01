import type { VercelRequest, VercelResponse } from '@vercel/node'
import { neon } from '@neondatabase/serverless'

/**
 * GET /api/admin/bcbs-cleanup-list — service-token-gated.
 * Returns BCBS kids missing a dep code, grouped by shared member_id so
 * Andrea can work one family at a time.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })
  const expected = process.env.INTERNAL_SERVICE_TOKEN || ''
  const provided = String(req.headers['x-internal-service-token'] ?? '')
  if (!expected || provided !== expected) return res.status(401).json({ error: 'Unauthorized' })

  const sql = neon(process.env.DATABASE_URL!)

  const rows = await sql`
    SELECT first_name, last_name, date_of_birth,
           insurance_provider, insurance_member_id, insurance_dependent_code,
           insurance_subscriber_name, insurance_subscriber_dob,
           LENGTH(insurance_member_id) AS mid_len
    FROM children
    WHERE (insurance_provider ILIKE '%blue%' OR insurance_provider ILIKE '%bcbs%' OR insurance_provider ILIKE '%anthem%')
      AND (insurance_dependent_code IS NULL OR TRIM(insurance_dependent_code) = '')
    ORDER BY insurance_member_id, date_of_birth`

  const groups: Record<string, any> = {}
  for (const r of rows as any[]) {
    const key = (r.insurance_member_id ?? '(no id)').trim()
    if (!groups[key]) groups[key] = {
      member_id: key,
      mid_len: r.mid_len,
      insurance_provider: r.insurance_provider,
      subscriber_name: r.insurance_subscriber_name,
      subscriber_dob: r.insurance_subscriber_dob,
      kids: [] as any[],
    }
    groups[key].kids.push({
      first_name: r.first_name,
      last_name: r.last_name,
      date_of_birth: r.date_of_birth,
    })
  }

  const list = Object.values(groups)
  return res.json({ family_count: list.length, kid_count: rows.length, families: list })
}
