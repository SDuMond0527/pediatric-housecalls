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
    const { family_ids, ids, search } = req.query as Record<string, string>

    if (search?.trim()) {
      const q = `%${search.trim()}%`
      const rows = await sql`
        SELECT c.*,
               fp.display_name AS family_display_name,
               fp.email        AS family_email,
               fp.phone        AS family_phone,
               fp.address      AS family_address,
               fp.zip          AS family_zip,
               fp.state        AS family_state
        FROM children c
        LEFT JOIN family_profiles fp ON fp.id = c.family_id
        WHERE c.practice_id = ${practiceId}::uuid
          AND (
            c.first_name ILIKE ${q}
            OR c.last_name  ILIKE ${q}
            OR (c.first_name || ' ' || c.last_name) ILIKE ${q}
            OR c.display_label ILIKE ${q}
          )
        ORDER BY c.first_name, c.last_name
        LIMIT 20`
      return res.json(rows)
    }

    if (ids) {
      const idList = ids.split(',').filter(Boolean)
      if (!idList.length) return res.json([])
      const rows = await sql`SELECT * FROM children WHERE id = ANY(${idList}::uuid[]) AND practice_id = ${practiceId}::uuid`
      return res.json(rows)
    }
    if (!family_ids) return res.json([])
    const famIds = family_ids.split(',').filter(Boolean)
    const rows = await sql`SELECT * FROM children WHERE family_id = ANY(${famIds}::uuid[]) AND practice_id = ${practiceId}::uuid`
    return res.json(rows)
  }

  if (req.method === 'POST') {
    try {
      const { display_label, family_id } = req.body
      const [row] = await sql`
        INSERT INTO children (display_label, family_id, practice_id)
        VALUES (${display_label}, ${family_id}::uuid, ${practiceId}::uuid)
        RETURNING *`
      return res.json(row)
    } catch (e: any) {
      return res.status(500).json({ error: e.message ?? String(e) })
    }
  }

  res.status(405).json({ error: 'Method not allowed' })
}
