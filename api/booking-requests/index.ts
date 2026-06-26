import type { VercelRequest, VercelResponse } from '@vercel/node'
import sql from '../_lib/db'
import { getProviderContext } from '../_lib/auth'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  let ctx: { sub: string; practiceId: string; providerId: string }
  try {
    ctx = await getProviderContext(req.headers.authorization)
  } catch {
    return res.status(401).json({ error: 'Unauthorized' })
  }
  const { practiceId } = ctx

  if (req.method === 'GET') {
    const { status, family_id, reference_code } = req.query as Record<string, string>
    let rows: unknown[]
    if (reference_code) {
      rows = await sql`SELECT * FROM booking_requests WHERE reference_code = ${reference_code} AND practice_id = ${practiceId} LIMIT 1`
    } else if (family_id) {
      rows = await sql`SELECT * FROM booking_requests WHERE family_id = ${family_id}::uuid AND practice_id = ${practiceId} ORDER BY preferred_date DESC LIMIT 20`
    } else if (status) {
      rows = await sql`SELECT * FROM booking_requests WHERE status = ${status} AND practice_id = ${practiceId} ORDER BY created_at DESC`
    } else {
      rows = await sql`SELECT * FROM booking_requests WHERE practice_id = ${practiceId} ORDER BY created_at DESC`
    }
    return res.json(rows)
  }

  if (req.method === 'POST') {
    const b = req.body
    const childIds = b.child_ids ?? []
    const familyId = b.family_id
    const [row] = await sql`
      INSERT INTO booking_requests (family_id, child_ids, visit_type, preferred_provider, zone, state, preferred_date, preferred_time, status, confirmed_provider_id, reference_code, convenience_fee, notes, practice_id)
      VALUES (${familyId}::uuid, ${childIds}::uuid[], ${b.visit_type}, ${b.preferred_provider ?? null}, ${b.zone ?? null}, ${b.state ?? null}, ${b.preferred_date}::date, ${b.preferred_time}, ${b.status ?? 'pending'}, ${b.confirmed_provider_id ?? null}, ${b.reference_code}, ${b.convenience_fee ?? null}, ${b.notes ?? null}, ${practiceId})
      RETURNING *`
    return res.json(row)
  }

  res.status(405).json({ error: 'Method not allowed' })
}
