import type { VercelRequest, VercelResponse } from '@vercel/node'
import { verifyToken } from '../_lib/verifyToken'
import sql from '../_lib/db'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    await verifyToken(req.headers.authorization)
  } catch {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { provider_id, label, days, time_range } = req.body
  const [row] = await sql`
    INSERT INTO time_blocks (provider_id, label, days, time_range)
    VALUES (${provider_id}::uuid, ${label}, ${days}, ${time_range})
    RETURNING *`
  res.json(row)
}
