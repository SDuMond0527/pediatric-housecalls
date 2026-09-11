import type { VercelRequest, VercelResponse } from '@vercel/node'
import { neon } from '@neondatabase/serverless'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })
  const practiceId = process.env.VITE_PRACTICE_ID
  if (!practiceId) return res.status(500).json({ error: 'Practice not configured' })
  const sql = neon(process.env.DATABASE_URL!)

  // No visit-type renames on read — the descriptive names already in the
  // DB (`CMA + telemedicine`, `RN in-home IV fluids administration`,
  // `Video telemedicine screening for IV fluids`) are the source of truth.
  // An earlier version of this endpoint tried to rename them based on the
  // shorter badge_labels, but that matched nothing and confused everyone.

  const rows = await sql`
    SELECT * FROM practice_visit_types
    WHERE practice_id = ${practiceId}::uuid AND is_active = true
    ORDER BY sort_order, visit_type`
  res.json(rows)
}
