import type { VercelRequest, VercelResponse } from '@vercel/node'
import sql from '../_lib/db'
import { getAnyContext } from '../_lib/auth'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  let practiceId: string
  try {
    const ctx = await getAnyContext(req.headers.authorization)
    practiceId = ctx.practiceId
  } catch {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  const { waitlist_entry_ids } = req.query as Record<string, string>
  if (!waitlist_entry_ids) return res.json([])

  const ids = waitlist_entry_ids.split(',')
  const now = new Date().toISOString()
  const rows = await sql`
    SELECT * FROM slot_offers
    WHERE waitlist_entry_id = ANY(${ids}::uuid[])
      AND status = 'pending'
      AND expires_at > ${now}::timestamptz
      AND practice_id = ${practiceId}
    ORDER BY created_at DESC`
  res.json(rows)
}
