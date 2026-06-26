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

  if (req.method !== 'PATCH') return res.status(405).json({ error: 'Method not allowed' })

  const { id } = req.query as { id: string }
  const { status, converted_provider_id } = req.body

  let row: unknown
  if (converted_provider_id) {
    ;[row] = await sql`UPDATE waitlist_entries SET status=${status}, converted_provider_id=${converted_provider_id}::uuid WHERE id=${id}::uuid AND practice_id = ${practiceId} RETURNING *`
  } else {
    ;[row] = await sql`UPDATE waitlist_entries SET status=${status} WHERE id=${id}::uuid AND practice_id = ${practiceId} RETURNING *`
  }
  res.json(row)
}
