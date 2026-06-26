import type { VercelRequest, VercelResponse } from '@vercel/node'
import { neon } from '@neondatabase/serverless'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })
  const practiceId = process.env.VITE_PRACTICE_ID
  if (!practiceId) return res.status(500).json({ error: 'Practice not configured' })
  const sql = neon(process.env.DATABASE_URL!)
  const rows = await sql`
    SELECT * FROM practice_visit_types
    WHERE practice_id = ${practiceId}::uuid AND is_active = true
    ORDER BY sort_order, visit_type`
  res.json(rows)
}
