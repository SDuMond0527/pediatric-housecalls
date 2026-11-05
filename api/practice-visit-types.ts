import type { VercelRequest, VercelResponse } from '@vercel/node'
import { neon } from '@neondatabase/serverless'
import { getPracticeSettings } from './_lib/practiceSettings'
import { isVisitTypeAllowed } from '../src/lib/visitTypeFlags'

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

  // Filter by the practice's feature flags (Phase 2). PHC has every flag
  // ON so this is a no-op for PHC; lighter practices (e.g., Sarah Cash's
  // cash-pay office setup) will see a trimmed list.
  const settings = await getPracticeSettings(practiceId)
  const filtered = (rows as Array<{ visit_type: string }>).filter(r =>
    isVisitTypeAllowed(r.visit_type, settings),
  )

  res.json(filtered)
}
