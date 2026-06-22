import type { VercelRequest, VercelResponse } from '@vercel/node'
import { verifyToken } from '../_lib/verifyToken'
import sql from '../_lib/db'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    await verifyToken(req.headers.authorization)
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
    ORDER BY created_at DESC`
  res.json(rows)
}
