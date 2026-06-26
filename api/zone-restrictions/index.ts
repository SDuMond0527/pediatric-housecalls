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

  const { provider_id, zone, start_time, end_time } = req.body
  const [row] = await sql`
    INSERT INTO zone_restrictions (provider_id, zone, start_time, end_time, practice_id)
    VALUES (${provider_id}::uuid, ${zone}, ${start_time}, ${end_time}, ${practiceId})
    RETURNING *`
  res.json(row)
}
