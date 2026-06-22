import type { VercelRequest, VercelResponse } from '@vercel/node'
import { verifyToken } from '../_lib/verifyToken'
import sql from '../_lib/db'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    await verifyToken(req.headers.authorization)
  } catch {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  if (req.method === 'GET') {
    const { status, family_id } = req.query as Record<string, string>
    let rows: unknown[]
    if (family_id) {
      rows = await sql`SELECT id FROM waitlist_entries WHERE family_id = ${family_id}::uuid AND status = 'waiting'`
    } else if (status) {
      rows = await sql`SELECT * FROM waitlist_entries WHERE status = ${status} ORDER BY created_at ASC`
    } else {
      rows = await sql`SELECT * FROM waitlist_entries ORDER BY created_at DESC`
    }
    return res.json(rows)
  }

  if (req.method === 'POST') {
    const b = req.body
    const childIds = b.child_ids ?? []
    const [row] = await sql`
      INSERT INTO waitlist_entries (family_id, child_ids, visit_type, zone, state, complaint, status, notes)
      VALUES (${b.family_id}::uuid, ${JSON.stringify(childIds)}::uuid[], ${b.visit_type}, ${b.zone ?? null}, ${b.state ?? null}, ${b.complaint ?? null}, 'waiting', ${b.notes ?? null})
      RETURNING *`
    return res.json(row)
  }

  res.status(405).json({ error: 'Method not allowed' })
}
