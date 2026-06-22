import type { VercelRequest, VercelResponse } from '@vercel/node'
import { verifyToken } from '../_lib/verifyToken'
import sql from '../_lib/db'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    await verifyToken(req.headers.authorization)
  } catch {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const { id } = req.query as { id: string }

  if (req.method === 'PATCH') {
    const { is_open } = req.body
    const [row] = await sql`UPDATE broadcasts SET is_open=${is_open} WHERE id=${id}::uuid RETURNING *`
    return res.json(row)
  }

  if (req.method === 'DELETE') {
    await sql`DELETE FROM broadcasts WHERE id = ${id}::uuid`
    return res.status(204).end()
  }

  res.status(405).json({ error: 'Method not allowed' })
}
