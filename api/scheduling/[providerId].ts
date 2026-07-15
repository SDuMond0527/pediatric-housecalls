import type { VercelRequest, VercelResponse } from '@vercel/node'
import { neon } from '@neondatabase/serverless'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  const sql = neon(process.env.DATABASE_URL!)
  const { providerId } = req.query as { providerId: string }
  const { date, visit_type } = req.query as Record<string, string>

  if (!date) return res.status(400).json({ error: 'date is required' })

  const providerRows = await sql`SELECT practice_id FROM providers WHERE id = ${providerId}::uuid LIMIT 1`
  if (!providerRows.length) return res.status(404).json({ error: 'Provider not found' })
  const practiceId = providerRows[0].practice_id as string

  const dayOfWeek = new Date(date + 'T12:00:00').getDay()

  const [availRows, overrideRows, visitTypeRows, bookedRows] = await Promise.all([
    sql`SELECT is_active, start_time, end_time FROM availability WHERE provider_id = ${providerId}::uuid AND day_of_week = ${dayOfWeek} LIMIT 1`,
    sql`SELECT is_available, start_time, end_time FROM availability_overrides WHERE provider_id = ${providerId}::uuid AND date = ${date}::date LIMIT 1`,
    visit_type
      ? sql`SELECT is_active, start_time, end_time FROM visit_type_availability WHERE provider_id = ${providerId}::uuid AND visit_type = ${visit_type} LIMIT 1`
      : Promise.resolve([]),
    sql`SELECT scheduled_time, COALESCE(duration_minutes, 60) AS duration_minutes FROM appointments WHERE provider_id = ${providerId}::uuid AND practice_id = ${practiceId}::uuid AND scheduled_date = ${date}::date AND status != 'cancelled'`,
  ])

  res.json({
    availability: availRows[0] ?? null,
    override: overrideRows[0] ?? null,
    visitTypeAvail: visitTypeRows[0] ?? null,
    bookedSlots: (bookedRows as Array<{ scheduled_time: string; duration_minutes: number }>).map(r => ({ time: r.scheduled_time, duration: r.duration_minutes })),
  })
}
