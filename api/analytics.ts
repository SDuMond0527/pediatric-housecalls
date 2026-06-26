import type { VercelRequest, VercelResponse } from '@vercel/node'
import sql from './_lib/db'
import { getProviderContext } from './_lib/auth'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  let practiceId: string
  try {
    const ctx = await getProviderContext(req.headers.authorization)
    practiceId = ctx.practiceId
  } catch {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  const [appointments, bookingRequests, waitlistEntries, familyProfiles, providers, broadcasts] = await Promise.all([
    sql`SELECT id, status, visit_type, scheduled_date, provider_id, notes, zone FROM appointments WHERE practice_id = ${practiceId}::uuid`,
    sql`SELECT id, status, visit_type, state, created_at, family_id FROM booking_requests WHERE practice_id = ${practiceId}::uuid`,
    sql`SELECT id, status, state, family_id, converted_provider_id FROM waitlist_entries WHERE practice_id = ${practiceId}::uuid`,
    sql`SELECT id FROM family_profiles WHERE practice_id = ${practiceId}::uuid`,
    sql`SELECT id, name, role FROM providers WHERE practice_id = ${practiceId}::uuid`,
    sql`SELECT id, status, created_at, is_urgent FROM broadcasts WHERE practice_id = ${practiceId}::uuid`,
  ])

  res.json({ appointments, bookingRequests, waitlistEntries, familyProfiles, providers, broadcasts })
}
