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

  if (req.method === 'GET') {
    const { provider_id, date } = req.query as Record<string, string>
    const rows = await sql`
      SELECT * FROM schedule_blocks
      WHERE provider_id = ${provider_id}::uuid
        AND start_date <= ${date}::date
        AND end_date >= ${date}::date
        AND practice_id = ${practiceId}::uuid
      ORDER BY start_time`
    return res.json(rows)
  }

  if (req.method === 'POST') {
    const { provider_id, start_date, end_date, all_day, start_time, end_time, reason } = req.body
    const [row] = await sql`
      INSERT INTO schedule_blocks (provider_id, start_date, end_date, all_day, start_time, end_time, reason, practice_id)
      VALUES (${provider_id}::uuid, ${start_date}::date, ${end_date}::date, ${all_day ?? false}, ${start_time ?? null}, ${end_time ?? null}, ${reason ?? null}, ${practiceId}::uuid)
      RETURNING *`
    return res.json(row)
  }

  res.status(405).json({ error: 'Method not allowed' })
}
