import type { VercelRequest, VercelResponse } from '@vercel/node'
import { verifyToken } from '../_lib/verifyToken'
import sql from '../_lib/db'

// Returns all data needed to calculate available slots for a provider on a date:
// availability (day-of-week record), override (date-specific), visitTypeAvail, bookedTimes
export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    await verifyToken(req.headers.authorization)
  } catch {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  const { providerId } = req.query as { providerId: string }
  const { date, visit_type } = req.query as Record<string, string>

  if (!date) return res.status(400).json({ error: 'date is required' })

  const dayOfWeek = new Date(date + 'T12:00:00').getDay()

  const [availRows, overrideRows, visitTypeRows, bookedRows] = await Promise.all([
    sql`SELECT is_active, start_time, end_time FROM availability WHERE provider_id = ${providerId}::uuid AND day_of_week = ${dayOfWeek} LIMIT 1`,
    sql`SELECT is_available, start_time, end_time FROM availability_overrides WHERE provider_id = ${providerId}::uuid AND date = ${date}::date LIMIT 1`,
    visit_type
      ? sql`SELECT is_active, start_time, end_time FROM visit_type_availability WHERE provider_id = ${providerId}::uuid AND visit_type = ${visit_type} LIMIT 1`
      : Promise.resolve([]),
    sql`SELECT scheduled_time FROM appointments WHERE provider_id = ${providerId}::uuid AND scheduled_date = ${date}::date AND status != 'cancelled'`,
  ])

  res.json({
    availability: availRows[0] ?? null,
    override: overrideRows[0] ?? null,
    visitTypeAvail: visitTypeRows[0] ?? null,
    bookedTimes: (bookedRows as Array<{ scheduled_time: string }>).map(r => r.scheduled_time),
  })
}
