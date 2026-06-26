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

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { provider_id, label, days, time_range } = req.body
  const [row] = await sql`
    INSERT INTO time_blocks (provider_id, label, days, time_range, practice_id)
    VALUES (${provider_id}::uuid, ${label}, ${days}, ${time_range}, ${practiceId}::uuid)
    RETURNING *`
  res.json(row)
}
