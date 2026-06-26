import type { VercelRequest, VercelResponse } from '@vercel/node'
import sql from '../_lib/db'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  const { providerId } = req.query as { providerId: string }
  const { date, visit_type, practice_slug } = req.query as Record<string, string>

  if (!date) return res.status(400).json({ error: 'date is required' })

  // Resolve practiceId from slug if provided, used for scoping availability queries
  let practiceId: string | null = null
  if (practice_slug) {
    const [practice] = await sql`SELECT id FROM practices WHERE slug = ${practice_slug} LIMIT 1`
    if (practice) practiceId = practice.id
  }

  const dayOfWeek = new Date(date + 'T12:00:00').getDay()

  const [availRows, overrideRows, visitTypeRows, bookedRows] = await Promise.all([
    practiceId
      ? sql`SELECT is_active, start_time, end_time FROM availability WHERE provider_id = ${providerId}::uuid AND day_of_week = ${dayOfWeek} AND practice_id = ${practiceId}::uuid LIMIT 1`
      : sql`SELECT is_active, start_time, end_time FROM availability WHERE provider_id = ${providerId}::uuid AND day_of_week = ${dayOfWeek} LIMIT 1`,
    practiceId
      ? sql`SELECT is_available, start_time, end_time FROM availability_overrides WHERE provider_id = ${providerId}::uuid AND date = ${date}::date AND practice_id = ${practiceId}::uuid LIMIT 1`
      : sql`SELECT is_available, start_time, end_time FROM availability_overrides WHERE provider_id = ${providerId}::uuid AND date = ${date}::date LIMIT 1`,
    visit_type
      ? (practiceId
          ? sql`SELECT is_active, start_time, end_time FROM visit_type_availability WHERE provider_id = ${providerId}::uuid AND visit_type = ${visit_type} AND practice_id = ${practiceId}::uuid LIMIT 1`
          : sql`SELECT is_active, start_time, end_time FROM visit_type_availability WHERE provider_id = ${providerId}::uuid AND visit_type = ${visit_type} LIMIT 1`)
      : Promise.resolve([]),
    practiceId
      ? sql`SELECT scheduled_time, COALESCE(duration_minutes, 60) AS duration_minutes FROM appointments WHERE provider_id = ${providerId}::uuid AND scheduled_date = ${date}::date AND status != 'cancelled' AND practice_id = ${practiceId}::uuid`
      : sql`SELECT scheduled_time, COALESCE(duration_minutes, 60) AS duration_minutes FROM appointments WHERE provider_id = ${providerId}::uuid AND scheduled_date = ${date}::date AND status != 'cancelled'`,
  ])

  res.json({
    availability: availRows[0] ?? null,
    override: overrideRows[0] ?? null,
    visitTypeAvail: visitTypeRows[0] ?? null,
    bookedSlots: (bookedRows as Array<{ scheduled_time: string; duration_minutes: number }>).map(r => ({ time: r.scheduled_time, duration: r.duration_minutes })),
  })
}
