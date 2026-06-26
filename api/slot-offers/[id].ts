import type { VercelRequest, VercelResponse } from '@vercel/node'
import sql from '../_lib/db'
import { getAnyContext } from '../_lib/auth'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  let practiceId: string
  try {
    const ctx = await getAnyContext(req.headers.authorization)
    practiceId = ctx.practiceId
  } catch {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  if (req.method !== 'PATCH') return res.status(405).json({ error: 'Method not allowed' })

  const { id } = req.query as { id: string }
  const { status } = req.body
  const [row] = await sql`UPDATE slot_offers SET status=${status} WHERE id=${id}::uuid AND practice_id = ${practiceId} RETURNING *`
  res.json(row)
}
