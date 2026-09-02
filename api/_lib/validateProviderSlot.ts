import { neon } from '@neondatabase/serverless'

// Converts "HH:MM", "HH:MM:SS", or "H:MM AM/PM" to minutes since midnight
function toMin(t: string): number {
  const s = t.trim()
  if (/[AaPp][Mm]$/.test(s)) {
    const [timePart, ampm] = s.split(' ')
    let [h, m] = timePart.split(':').map(Number)
    if (ampm.toUpperCase() === 'PM' && h !== 12) h += 12
    if (ampm.toUpperCase() === 'AM' && h === 12) h = 0
    return h * 60 + m
  }
  const [h, m] = s.split(':').map(Number)
  return h * 60 + m
}

/**
 * Validates that a requested time slot falls within a provider's configured
 * availability window (day-of-week schedule + visit-type restriction + overrides).
 * Returns null if valid, or an error string to send back to the client.
 */
export async function validateProviderSlot(
  sql: ReturnType<typeof neon>,
  providerId: string,
  visitType: string,
  date: string,       // "YYYY-MM-DD"
  time: string,       // "HH:MM" or "H:MM AM/PM"
): Promise<string | null> {
  const dayOfWeek = new Date(date + 'T12:00:00').getDay()

  const [availRows, overrideRows, vtRows] = await Promise.all([
    sql`SELECT is_active, start_time, end_time
        FROM availability
        WHERE provider_id = ${providerId}::uuid AND day_of_week = ${dayOfWeek}
        LIMIT 1`,
    sql`SELECT is_available, start_time, end_time
        FROM availability_overrides
        WHERE provider_id = ${providerId}::uuid AND date = ${date}::date
        LIMIT 1`,
    sql`SELECT is_active, start_time, end_time
        FROM visit_type_availability
        WHERE provider_id = ${providerId}::uuid AND visit_type = ${visitType}
        LIMIT 1`,
  ])

  const avail    = availRows[0]    as any
  const override = overrideRows[0] as any
  const vtAvail  = vtRows[0]       as any

  // Determine the base availability window for this date
  let winStart: number
  let winEnd: number

  if (override) {
    if (!override.is_available) return 'Provider is not available on this date'
    winStart = toMin(override.start_time)
    winEnd   = toMin(override.end_time)
  } else if (avail) {
    if (!avail.is_active) return 'Provider is not available on this day of the week'
    winStart = toMin(avail.start_time)
    winEnd   = toMin(avail.end_time)
  } else {
    // No availability record at all — provider is not configured for this day
    return 'Provider has no availability configured for this date'
  }

  // Intersect with visit-type window when configured
  if (vtAvail?.is_active && vtAvail.start_time && vtAvail.end_time) {
    winStart = Math.max(winStart, toMin(vtAvail.start_time))
    winEnd   = Math.min(winEnd,   toMin(vtAvail.end_time))
  }

  if (winEnd <= winStart) {
    return 'Provider has no availability for this visit type on this date'
  }

  const reqMin = toMin(time)
  if (reqMin < winStart || reqMin >= winEnd) {
    const fmt = (m: number) => `${Math.floor(m / 60).toString().padStart(2, '0')}:${(m % 60).toString().padStart(2, '0')}`
    return `Requested time ${time} is outside this provider's available hours (${fmt(winStart)}–${fmt(winEnd)})`
  }

  return null
}
