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
    const { status, family_id } = req.query as Record<string, string>
    let rows: unknown[]
    if (family_id) {
      rows = await sql`SELECT id FROM waitlist_entries WHERE family_id = ${family_id}::uuid AND status = 'waiting' AND practice_id = ${practiceId}::uuid`
    } else if (status) {
      rows = await sql`SELECT * FROM waitlist_entries WHERE status = ${status} AND practice_id = ${practiceId}::uuid ORDER BY created_at ASC`
    } else {
      rows = await sql`SELECT * FROM waitlist_entries WHERE practice_id = ${practiceId}::uuid ORDER BY created_at DESC`
    }
    return res.json(rows)
  }

  if (req.method === 'POST') {
    const b = req.body
    const childIds = b.child_ids ?? []
    const familyId = b.family_id
    const [row] = await sql`
      INSERT INTO waitlist_entries (family_id, child_ids, visit_type, zip, zone, state, complaint, status, notes, preferred_time_window, practice_id)
      VALUES (${familyId}::uuid, ${JSON.stringify(childIds)}::uuid[], ${b.visit_type}, ${b.zip ?? null}, ${b.zone ?? null}, ${b.state ?? null}, ${b.complaint ?? null}, 'waiting', ${b.notes ?? null}, ${b.preferred_time_window ?? null}, ${practiceId}::uuid)
      RETURNING *`
    return res.json(row)
  }

  res.status(405).json({ error: 'Method not allowed' })
}
