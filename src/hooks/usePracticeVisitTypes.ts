import { useState, useEffect } from 'react'

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

let cache: VisitTypeData | null = null
let pending: Promise<VisitTypeData> | null = null

function build(rows: PracticeVisitType[]): VisitTypeData {
  const byType: Record<string, PracticeVisitType> = {}
  for (const vt of rows) byType[vt.visit_type] = vt
  return { visitTypes: rows, byType }
}

function load(): Promise<VisitTypeData> {
  if (cache) return Promise.resolve(cache)
  if (pending) return pending
  pending = fetch('/api/practice-visit-types')
    .then(r => { if (!r.ok) throw new Error('visit types fetch failed'); return r.json() })
    .then(rows => { cache = build(Array.isArray(rows) ? rows : []); pending = null; return cache! })
    .catch(() => { pending = null; return build([]) })
  return pending
}

export function usePracticeVisitTypes() {
  const [data, setData] = useState<VisitTypeData>(() => cache ?? build([]))
  const [loading, setLoading] = useState(!cache)
  useEffect(() => {
    if (cache) return
    load().then(d => { setData(d); setLoading(false) })
  }, [])
  return { ...data, loading }
}
