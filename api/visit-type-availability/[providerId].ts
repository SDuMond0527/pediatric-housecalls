import type { VercelRequest, VercelResponse } from '@vercel/node'
import { verifyToken } from '../_lib/verifyToken'
import sql from '../_lib/db'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    await verifyToken(req.headers.authorization)
  } catch {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  if (req.method !== 'PUT') return res.status(405).json({ error: 'Method not allowed' })

  const { providerId } = req.query as { providerId: string }
  const rows = req.body as Array<{ visit_type: string; is_active: boolean; start_time: string; end_time: string }>

  const results = await Promise.all(rows.map(async (r) => {
    const [row] = await sql`
      INSERT INTO visit_type_availability (provider_id, visit_type, is_active, start_time, end_time)
      VALUES (${providerId}::uuid, ${r.visit_type}, ${r.is_active}, ${r.start_time}, ${r.end_time})
      ON CONFLICT (provider_id, visit_type) DO UPDATE
      SET is_active=EXCLUDED.is_active, start_time=EXCLUDED.start_time, end_time=EXCLUDED.end_time
      RETURNING *`
    return row
  }))
  res.json(results)
}
