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

  const { id } = req.query as { id: string }

  if (req.method === 'PATCH') {
    const { is_open } = req.body
    const [row] = await sql`UPDATE broadcasts SET is_open=${is_open} WHERE id=${id}::uuid AND practice_id = ${practiceId} RETURNING *`
    return res.json(row)
  }

  if (req.method === 'DELETE') {
    await sql`DELETE FROM broadcasts WHERE id = ${id}::uuid AND practice_id = ${practiceId}`
    return res.status(204).end()
  }

  res.status(405).json({ error: 'Method not allowed' })
}
