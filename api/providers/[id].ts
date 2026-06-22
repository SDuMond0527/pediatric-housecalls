import type { VercelRequest, VercelResponse } from '@vercel/node'
import { verifyToken } from '../_lib/verifyToken'
import sql from '../_lib/db'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    await verifyToken(req.headers.authorization)
  } catch {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  if (req.method !== 'PATCH') return res.status(405).json({ error: 'Method not allowed' })

  const { id } = req.query as { id: string }
  const { phone, secure_text_number } = req.body

  let row: unknown
  if (phone !== undefined && secure_text_number !== undefined) {
    ;[row] = await sql`UPDATE providers SET phone=${phone}, secure_text_number=${secure_text_number} WHERE id=${id}::uuid RETURNING *`
  } else if (phone !== undefined) {
    ;[row] = await sql`UPDATE providers SET phone=${phone} WHERE id=${id}::uuid RETURNING *`
  } else if (secure_text_number !== undefined) {
    ;[row] = await sql`UPDATE providers SET secure_text_number=${secure_text_number} WHERE id=${id}::uuid RETURNING *`
  } else {
    return res.status(400).json({ error: 'No valid fields' })
  }
  res.json(row)
}
