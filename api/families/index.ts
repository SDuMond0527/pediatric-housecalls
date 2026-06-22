import type { VercelRequest, VercelResponse } from '@vercel/node'
import { verifyToken } from '../_lib/verifyFamilyToken'
import sql from '../_lib/db'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    await verifyFamilyToken(req.headers.authorization)
  } catch {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  const { ids } = req.query as Record<string, string>
  if (!ids) return res.json([])
  const idList = ids.split(',').filter(Boolean)
  const rows = await sql`SELECT * FROM family_profiles WHERE id = ANY(${idList}::uuid[])`
  res.json(rows)
}
