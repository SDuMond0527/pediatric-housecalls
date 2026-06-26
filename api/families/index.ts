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

  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  const { ids } = req.query as Record<string, string>
  if (!ids) return res.json([])
  const idList = ids.split(',').filter(Boolean)
  const rows = await sql`SELECT * FROM family_profiles WHERE id = ANY(${idList}::uuid[]) AND practice_id = ${practiceId}::uuid`
  res.json(rows)
}
