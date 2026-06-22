import type { VercelRequest, VercelResponse } from '@vercel/node'
import { verifyToken } from '../../_lib/verifyToken'
import sql from '../../_lib/db'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    await verifyToken(req.headers.authorization)
  } catch {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { providerId } = req.query as { providerId: string }
  const { date, is_available, start_time, end_time, note } = req.body
  const [row] = await sql`
    INSERT INTO availability_overrides (provider_id, date, is_available, start_time, end_time, note)
    VALUES (${providerId}::uuid, ${date}::date, ${is_available}, ${start_time ?? null}, ${end_time ?? null}, ${note ?? null})
    ON CONFLICT (provider_id, date) DO UPDATE
    SET is_available=EXCLUDED.is_available, start_time=EXCLUDED.start_time, end_time=EXCLUDED.end_time, note=EXCLUDED.note
    RETURNING *`
  res.json(row)
}
