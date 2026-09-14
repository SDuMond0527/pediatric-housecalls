/**
 * Overlap detection for provider schedules.
 *
 * Providers and admins are allowed to deliberately double-book or overlap
 * visits (parents are not — the family booking flow enforces strict,
 * exclusive visit-type time blocks). Because overlaps are legitimate on the
 * staff side, the schedule has to *show* them: this flags which appointments
 * share time with another visit on the same provider's day so the UI can mark
 * them instead of silently stacking two visits at the same hour.
 */

export interface OverlapCandidate {
  id: string
  provider_id?: string | null
  scheduled_date?: string | null
  scheduled_time?: string | null
  duration_minutes?: number | null
  visit_type?: string | null
  status?: string | null
}

function toMinutes(time: string | null | undefined): number | null {
  if (!time) return null
  const [h, m] = String(time).split(':').map(Number)
  if (Number.isNaN(h) || Number.isNaN(m)) return null
  return h * 60 + m
}

/**
 * IDs of appointments whose time block collides with another appointment on
 * the same provider and date. Cancelled visits are ignored.
 *
 * `durationFor` supplies the practice-configured length for a visit type when
 * the row has no explicit duration_minutes (falls back to 60).
 */
export function findDoubleBookedIds(
  appts: OverlapCandidate[],
  durationFor?: (visitType: string | null | undefined) => number | null | undefined,
): Set<string> {
  const flagged = new Set<string>()
  const byProviderDay = new Map<string, { id: string; start: number; end: number }[]>()

  for (const a of appts) {
    if (a.status === 'cancelled') continue
    const start = toMinutes(a.scheduled_time)
    if (start === null) continue
    const duration = a.duration_minutes ?? durationFor?.(a.visit_type) ?? 60
    const key = `${a.provider_id ?? ''}|${a.scheduled_date ?? ''}`
    const list = byProviderDay.get(key) ?? []
    list.push({ id: a.id, start, end: start + duration })
    byProviderDay.set(key, list)
  }

  for (const list of byProviderDay.values()) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        if (list[i].start < list[j].end && list[i].end > list[j].start) {
          flagged.add(list[i].id)
          flagged.add(list[j].id)
        }
      }
    }
  }
  return flagged
}
