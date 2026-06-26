import type { VercelRequest, VercelResponse } from '@vercel/node'
import sql from '../../_lib/db'
import { getProviderContext } from '../../_lib/auth'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  let practiceId: string
  try {
    const ctx = await getProviderContext(req.headers.authorization)
    practiceId = ctx.practiceId
  } catch {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { provider_id, date, is_available, start_time, end_time, note } = req.body
  const [row] = await sql`
    INSERT INTO availability_overrides (provider_id, date, is_available, start_time, end_time, note, practice_id)
    VALUES (${provider_id}::uuid, ${date}::date, ${is_available}, ${start_time ?? null}, ${end_time ?? null}, ${note ?? null}, ${practiceId})
    ON CONFLICT (provider_id, date) DO UPDATE
    SET is_available=EXCLUDED.is_available, start_time=EXCLUDED.start_time, end_time=EXCLUDED.end_time, note=EXCLUDED.note
    RETURNING *`
  res.json(row)
}
