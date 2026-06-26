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
  const b = req.body

  const updates: string[] = []
  if (b.phone !== undefined)               updates.push('phone')
  if (b.secure_text_number !== undefined)  updates.push('secure_text_number')
  if (b.home_address !== undefined)        updates.push('home_address')
  if (b.email !== undefined)               updates.push('email')

  if (!updates.length) return res.status(400).json({ error: 'No valid fields' })

  const [row] = await sql`
    UPDATE providers SET
      phone              = CASE WHEN ${b.phone !== undefined} THEN ${b.phone ?? null}              ELSE phone              END,
      secure_text_number = CASE WHEN ${b.secure_text_number !== undefined} THEN ${b.secure_text_number ?? null} ELSE secure_text_number END,
      home_address       = CASE WHEN ${b.home_address !== undefined} THEN ${b.home_address ?? null} ELSE home_address       END,
      email              = CASE WHEN ${b.email !== undefined} THEN ${b.email ?? null}              ELSE email              END
    WHERE id = ${id}::uuid AND practice_id = ${practiceId}
    RETURNING *`
  res.json(row)
}
