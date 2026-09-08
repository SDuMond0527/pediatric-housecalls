import { format } from 'date-fns'

/**
 * Timezone-safe formatter for date-only fields returned by the API.
 *
 * The API serializes Postgres DATE columns as ISO timestamps at midnight UTC
 * (e.g. "2026-09-02T00:00:00.000Z"). If passed to parseISO() and formatted in
 * a US local timezone, the display shifts to the previous day because midnight
 * UTC is 8pm ET the day before.
 *
 * This helper strips the time portion and constructs a Date from the local
 * components, so the display always matches the DB value.
 *
 * Use for ANY field the API returns as a date-only value: scheduled_date,
 * preferred_date, date, date_of_birth, etc. Do NOT use for genuine
 * timestamp fields like created_at.
 */
export function formatApiDate(dateStr: string | null | undefined, pattern: string = 'MMM d, yyyy'): string {
  if (!dateStr) return ''
  try {
    const s = String(dateStr).split('T')[0]
    const [y, m, day] = s.split('-').map(Number)
    if (!y || !m || !day) return String(dateStr)
    return format(new Date(y, m - 1, day), pattern)
  } catch {
    return String(dateStr)
  }
}

/**
 * Timezone-safe Date constructor for a date-only string. Returns a local Date
 * at noon so any downstream timezone math never crosses a day boundary.
 * Use when you need a Date object (e.g. for date-fns functions like isPast,
 * differenceInYears) — do NOT use parseISO on API date fields for the same
 * reason as above.
 */
export function parseApiDate(dateStr: string | null | undefined): Date | null {
  if (!dateStr) return null
  try {
    const s = String(dateStr).split('T')[0]
    const [y, m, day] = s.split('-').map(Number)
    if (!y || !m || !day) return null
    return new Date(y, m - 1, day, 12, 0, 0)
  } catch {
    return null
  }
}
