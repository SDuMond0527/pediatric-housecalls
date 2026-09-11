import type { VercelRequest, VercelResponse } from '@vercel/node'
import { neon } from '@neondatabase/serverless'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })
  const practiceId = process.env.VITE_PRACTICE_ID
  if (!practiceId) return res.status(500).json({ error: 'Practice not configured' })
  const sql = neon(process.env.DATABASE_URL!)

  // One-time visit-type renames + archive. Idempotent — no-op once done,
  // no-op if the target already exists. Runs on next fetch after deploy so
  // no manual migration step is needed.
  try {
    await sql`
      UPDATE practice_visit_types
      SET visit_type = 'RN IV fluid visit — paired with MD/NP screening'
      WHERE visit_type = 'RN IV fluids'
        AND NOT EXISTS (SELECT 1 FROM practice_visit_types p2 WHERE p2.visit_type = 'RN IV fluid visit — paired with MD/NP screening' AND p2.practice_id = practice_visit_types.practice_id)
    `
    await sql`
      UPDATE practice_visit_types
      SET visit_type = 'CMA visit — paired with MD/NP telemedicine screening'
      WHERE visit_type = 'CMA + tele'
        AND NOT EXISTS (SELECT 1 FROM practice_visit_types p2 WHERE p2.visit_type = 'CMA visit — paired with MD/NP telemedicine screening' AND p2.practice_id = practice_visit_types.practice_id)
    `
    // Archive the standalone IV tele screening visit type (0 appointments
    // ever used it, confirmed by Sara on 2026-09-11). Reversible in one line.
    await sql`
      UPDATE practice_visit_types
      SET is_active = false
      WHERE visit_type = 'IV tele screening' AND is_active = true
    `
  } catch (e) {
    console.error('[practice-visit-types] rename err:', e)
  }

  const rows = await sql`
    SELECT * FROM practice_visit_types
    WHERE practice_id = ${practiceId}::uuid AND is_active = true
    ORDER BY sort_order, visit_type`
  res.json(rows)
}
