import type { VercelRequest, VercelResponse } from '@vercel/node'
import { neon } from '@neondatabase/serverless'

/**
 * GET /api/providers/[id]/cpr-availability?start=YYYY-MM-DD
 *
 * Returns a 14-day day-by-day availability view for a provider —
 * used by the CPR class booking flow to render a 2-week grid so
 * families can see at a glance which days Melissa is likely open
 * before submitting a request.
 *
 * Public (family-portal) endpoint — no auth. Scopes the query to
 * the practice via VITE_PRACTICE_ID so a stranger can't peek at a
 * random provider from another practice. That matches how
 * /api/providers?name= handles unauthenticated family lookups.
 *
 * Response:
 *   { days: [{ date, day_of_week, working, hasConflict }] }
 * where `working` reflects the weekly availability row (day-of-week
 * active with a set window) and `hasConflict` is true when the
 * provider already has any non-cancelled appointment on that date.
 * "Fuzzy" on purpose — Melissa still confirms manually on approval.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  const practiceId = process.env.VITE_PRACTICE_ID
  if (!practiceId) return res.status(500).json({ error: 'Practice not configured' })

  const providerId = req.query.id as string
  if (!providerId) return res.status(400).json({ error: 'id required' })

  const rawStart = (req.query.start as string) || ''
  const startDate = rawStart && /^\d{4}-\d{2}-\d{2}$/.test(rawStart)
    ? rawStart
    : new Date().toISOString().slice(0, 10)

  const sql = neon(process.env.DATABASE_URL!)

  // Verify this provider is in the caller's practice before leaking
  // any scheduling data.
  const [prov] = await sql`
    SELECT id FROM providers
    WHERE id = ${providerId}::uuid AND practice_id = ${practiceId}::uuid
    LIMIT 1
  `
  if (!prov) return res.status(404).json({ error: 'Provider not found' })

  // Pull all data for the window in one round-trip. 14 days rolling
  // window = start .. start+13.
  const [weekly, overrides, appts] = await Promise.all([
    sql`SELECT day_of_week, is_active, start_time, end_time FROM availability WHERE provider_id = ${providerId}::uuid`,
    sql`SELECT date::text AS date, is_available, start_time, end_time FROM availability_overrides
        WHERE provider_id = ${providerId}::uuid
          AND date >= ${startDate}::date
          AND date < ${startDate}::date + INTERVAL '14 days'`,
    sql`SELECT scheduled_date::text AS date, status
        FROM appointments
        WHERE provider_id = ${providerId}::uuid
          AND scheduled_date >= ${startDate}::date
          AND scheduled_date < ${startDate}::date + INTERVAL '14 days'
          AND status IS DISTINCT FROM 'cancelled'`,
  ])

  const weeklyByDow: Record<number, { is_active: boolean; start_time: string; end_time: string }> = {}
  for (const w of weekly as any[]) weeklyByDow[w.day_of_week] = w
  const overrideByDate: Record<string, { is_available: boolean }> = {}
  for (const o of overrides as any[]) overrideByDate[o.date] = o
  const busyDates = new Set<string>()
  for (const a of appts as any[]) busyDates.add(a.date)

  const days: {
    date: string
    day_of_week: number
    working: boolean
    hasConflict: boolean
    start_time: string | null
    end_time: string | null
  }[] = []
  const start = new Date(startDate + 'T12:00:00')
  for (let i = 0; i < 14; i++) {
    const d = new Date(start)
    d.setDate(start.getDate() + i)
    const iso = d.toISOString().slice(0, 10)
    const dow = d.getDay()
    const weeklyRow = weeklyByDow[dow]
    const override = overrideByDate[iso] as any

    // Overrides win: an explicit is_available=false on this date blocks
    // even a weekly-active day; an is_available=true opens even a day
    // she doesn't normally work. Times: prefer override's window (if
    // set), fall back to the weekly row's window.
    let working = !!(weeklyRow && weeklyRow.is_active)
    if (override) working = override.is_available
    const start_time = working ? (override?.start_time || weeklyRow?.start_time || null) : null
    const end_time   = working ? (override?.end_time   || weeklyRow?.end_time   || null) : null

    days.push({
      date: iso,
      day_of_week: dow,
      working,
      hasConflict: busyDates.has(iso),
      start_time,
      end_time,
    })
  }

  res.json({ days, start_date: startDate })
}
