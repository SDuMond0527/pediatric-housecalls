import { useState, useEffect } from 'react'

export interface PracticeZone {
  id: string
  zone_name: string
  state: string | null
  zips: string[]
  is_waitlist_only: boolean
  sort_order: number
}

interface ZoneData {
  zones: PracticeZone[]
  zipToZone: Record<string, string>
  zipToState: Record<string, string>
  waitlistZones: string[]
}

let cache: ZoneData | null = null
let pending: Promise<ZoneData> | null = null

function build(zones: PracticeZone[]): ZoneData {
  const zipToZone: Record<string, string> = {}
  const zipToState: Record<string, string> = {}
  const waitlistZones: string[] = []
  for (const z of zones) {
    for (const zip of z.zips) {
      zipToZone[zip] = z.zone_name
      if (z.state) zipToState[zip] = z.state
    }
    if (z.is_waitlist_only) waitlistZones.push(z.zone_name)
  }
  return { zones, zipToZone, zipToState, waitlistZones }
}

function load(): Promise<ZoneData> {
  if (cache) return Promise.resolve(cache)
  if (pending) return pending
  pending = fetch('/api/practice-zones')
    .then(r => r.json())
    .then(zones => { cache = build(zones); pending = null; return cache! })
    .catch(() => { pending = null; return build([]) })
  return pending
}

export function usePracticeZones() {
  const [data, setData] = useState<ZoneData>(() => cache ?? build([]))
  const [loading, setLoading] = useState(!cache)
  useEffect(() => {
    if (cache) return
    load().then(d => { setData(d); setLoading(false) })
  }, [])
  return { ...data, loading }
}
