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

  if (req.method !== 'PATCH') return res.status(405).json({ error: 'Method not allowed' })

  const { id } = req.query as { id: string }
  const { status, after_visit_instructions, charm_appointment_id } = req.body

  let row: unknown
  if (after_visit_instructions !== undefined && charm_appointment_id !== undefined) {
    ;[row] = await sql`UPDATE booking_requests SET after_visit_instructions=${after_visit_instructions} WHERE charm_appointment_id=${charm_appointment_id} AND practice_id = ${practiceId} RETURNING *`
  } else if (after_visit_instructions !== undefined) {
    ;[row] = await sql`UPDATE booking_requests SET after_visit_instructions=${after_visit_instructions} WHERE id=${id}::uuid AND practice_id = ${practiceId} RETURNING *`
  } else if (status !== undefined) {
    ;[row] = await sql`UPDATE booking_requests SET status=${status} WHERE id=${id}::uuid AND practice_id = ${practiceId} RETURNING *`
  } else {
    return res.status(400).json({ error: 'No valid fields' })
  }
  res.json(row)
}
