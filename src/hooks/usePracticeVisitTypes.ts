import { useState, useEffect, useCallback } from 'react'
import { apiFetch } from '../lib/api'

export interface PracticeVisitType {
  id: string
  visit_type: string
  base_price: number | null
  badge_label: string | null
  badge_color: string
  badge_text_color: string
  duration_minutes: number
  lead_minutes: number
  has_convenience_fee: boolean
  per_child_extra_minutes: number
  is_in_home: boolean
  is_cpr: boolean
  sort_order: number
  allowed_roles: string[] | null
}

interface VisitTypeData {
  visitTypes: PracticeVisitType[]
  byType: Record<string, PracticeVisitType>
}

// Module-level cache removed 2026-11-15. It was global (not per-user),
// so it both served stale data across tenant switches AND silently
// hid the "no auth header" bug introduced when I auth-gated
// /api/practice-visit-types (every empty-cache load would just
// swallow the 401 and cache an empty array). Pay the per-mount
// fetch cost — small payload, infrequent calls.

function build(rows: PracticeVisitType[]): VisitTypeData {
  const byType: Record<string, PracticeVisitType> = {}
  for (const vt of rows) byType[vt.visit_type] = vt
  return { visitTypes: rows, byType }
}

export function usePracticeVisitTypes() {
  const [data, setData] = useState<VisitTypeData>(() => build([]))
  const [loading, setLoading] = useState(true)
  const load = useCallback(async () => {
    try {
      const rows = await apiFetch<PracticeVisitType[]>('/api/practice-visit-types')
      setData(build(Array.isArray(rows) ? rows : []))
    } catch {
      setData(build([]))
    } finally {
      setLoading(false)
    }
  }, [])
  useEffect(() => { void load() }, [load])
  return { ...data, loading, refresh: load }
}
