import type { VercelRequest, VercelResponse } from '@vercel/node'
import sql from '../_lib/db'
import { getProviderContext } from '../_lib/auth'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  let practiceId: string
  try {
    const ctx = await getProviderContext(req.headers.authorization)
    practiceId = ctx.practiceId
  } catch {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  if (req.method !== 'PUT') return res.status(405).json({ error: 'Method not allowed' })

  const { providerId } = req.query as { providerId: string }
  const rows = req.body as Array<{ visit_type: string; is_active: boolean; start_time: string; end_time: string }>

  const results = await Promise.all(rows.map(async (r) => {
    const [row] = await sql`
      INSERT INTO visit_type_availability (provider_id, visit_type, is_active, start_time, end_time, practice_id)
      VALUES (${providerId}::uuid, ${r.visit_type}, ${r.is_active}, ${r.start_time}, ${r.end_time}, ${practiceId})
      ON CONFLICT (provider_id, visit_type) DO UPDATE
      SET is_active=EXCLUDED.is_active, start_time=EXCLUDED.start_time, end_time=EXCLUDED.end_time
      RETURNING *`
    return row
  }))
  res.json(results)
}
