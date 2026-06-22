import type { VercelRequest, VercelResponse } from '@vercel/node'
import { verifyToken } from './_lib/verifyToken'
import sql from './_lib/db'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    await verifyToken(req.headers.authorization)
  } catch {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  const [appointments, bookingRequests, waitlistEntries, familyProfiles, providers] = await Promise.all([
    sql`SELECT id, status, visit_type, scheduled_date, provider_id, notes FROM appointments`,
    sql`SELECT id, status, visit_type, state, created_at FROM booking_requests`,
    sql`SELECT id, status, state, family_id, converted_provider_id FROM waitlist_entries`,
    sql`SELECT id FROM family_profiles`,
    sql`SELECT id, name, role FROM providers`,
  ])

  res.json({ appointments, bookingRequests, waitlistEntries, familyProfiles, providers })
}
