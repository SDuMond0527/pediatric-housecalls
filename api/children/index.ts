import type { VercelRequest, VercelResponse } from '@vercel/node'
import { verifyFamilyToken } from '../_lib/verifyFamilyToken'
import sql from '../_lib/db'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  let sub: string
  try {
    sub = await verifyFamilyToken(req.headers.authorization)
  } catch {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  if (req.method === 'GET') {
    const { family_ids, ids } = req.query as Record<string, string>
    if (ids) {
      const idList = ids.split(',').filter(Boolean)
      if (!idList.length) return res.json([])
      const rows = await sql`SELECT * FROM children WHERE id = ANY(${idList}::uuid[])`
      return res.json(rows)
    }
    if (!family_ids) return res.json([])
    const famIds = family_ids.split(',').filter(Boolean)
    const rows = await sql`SELECT * FROM children WHERE family_id = ANY(${famIds}::uuid[])`
    return res.json(rows)
  }

  if (req.method === 'POST') {
    const { display_label } = req.body
    const [profile] = await sql`SELECT id FROM family_profiles WHERE cognito_sub = ${sub} LIMIT 1`
    if (!profile) return res.status(404).json({ error: 'Family profile not found' })
    const [row] = await sql`
      INSERT INTO children (display_label, family_id)
      VALUES (${display_label}, ${profile.id}::uuid)
      RETURNING *`
    return res.json(row)
  }

  res.status(405).json({ error: 'Method not allowed' })
}
