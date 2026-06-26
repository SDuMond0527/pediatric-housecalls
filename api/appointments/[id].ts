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
  const { status, after_visit_instructions } = req.body

  let row: unknown
  if (status !== undefined && after_visit_instructions !== undefined) {
    ;[row] = await sql`UPDATE appointments SET status=${status}, after_visit_instructions=${after_visit_instructions} WHERE id=${id}::uuid AND practice_id = ${practiceId}::uuid RETURNING *`
  } else if (status !== undefined) {
    ;[row] = await sql`UPDATE appointments SET status=${status} WHERE id=${id}::uuid AND practice_id = ${practiceId}::uuid RETURNING *`
  } else if (after_visit_instructions !== undefined) {
    ;[row] = await sql`UPDATE appointments SET after_visit_instructions=${after_visit_instructions} WHERE id=${id}::uuid AND practice_id = ${practiceId}::uuid RETURNING *`
  } else {
    return res.status(400).json({ error: 'No valid fields' })
  }
  res.json(row)
}
