import type { VercelRequest, VercelResponse } from '@vercel/node'
import { verifyToken } from '../_lib/verifyToken'
import sql from '../_lib/db'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    await verifyToken(req.headers.authorization)
  } catch {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  if (req.method !== 'DELETE') return res.status(405).json({ error: 'Method not allowed' })
  const { id } = req.query as { id: string }
  await sql`DELETE FROM zone_restrictions WHERE id = ${id}::uuid`
  res.status(204).end()
}
