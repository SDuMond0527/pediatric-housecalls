import { useEffect, useState } from 'react'
import { format, subWeeks, startOfWeek } from 'date-fns'
import { supabase } from '../../lib/supabase'

interface ApptRow { id: string; status: string; visit_type: string; scheduled_date: string; provider_id: string; notes: string | null }
interface BookingRow { id: string; status: string; visit_type: string; state: string | null; created_at: string }
interface WaitlistRow { id: string; status: string; state: string | null; family_id: string; converted_provider_id: string | null }
interface ProviderRow { id: string; name: string; role: string }

const VT_COLOR: Record<string, string> = {
  'In-home sick visit':  '#7F77DD',
  'Sports physical':     '#EF9F27',
  'CMA + telemedicine':  '#378ADD',
  'Video telemedicine':  '#1D9E75',
  'Text visit':          '#D4537E',
  'In-home IV fluids':   '#0F6E56',
}

const STATE_LABEL: Record<string, string> = { NC: 'North Carolina', SC: 'South Carolina', VA: 'Virginia' }

function StatCard({ label, value, sub, color, bg }: { label: string; value: number | string; sub: string; color: string; bg: string }) {
  return (
    <div className="bg-white border border-[#E8E8E4] rounded-xl p-5 shadow-sm">
      <div className="w-8 h-8 rounded-lg mb-3 flex-shrink-0" style={{ background: bg }} />
      <div className="font-display text-3xl font-semibold mb-1" style={{ color }}>{value}</div>
      <div className="text-[13px] font-medium text-[#1A1A2E]">{label}</div>
      <div className="text-[11px] text-[#999] mt-0.5">{sub}</div>
    </div>
  )
}

function HBar({ label, count, max, color }: { label: string; count: number; max: number; color: string }) {
  return (
    <div>
      <div className="flex items-center justify-between text-[13px] mb-1.5">
        <span className="text-[#1A1A2E]">{label}</span>
        <span className="text-[#999] font-medium tabular-nums">{count}</span>
      </div>
      <div className="h-2 bg-[#F1EFE8] rounded-full overflow-hidden">
        <div className="h-full rounded-full transition-all duration-500"
          style={{ width: `${max > 0 ? (count / max) * 100 : 0}%`, background: color }} />
      </div>
    </div>
  )
}

export function AdminAnalytics() {
  const [appts, setAppts]       = useState<ApptRow[]>([])
  const [bookings, setBookings] = useState<BookingRow[]>([])
  const [waitlist, setWaitlist] = useState<WaitlistRow[]>([])
  const [providers, setProviders] = useState<ProviderRow[]>([])
  const [familyCount, setFamilyCount] = useState(0)
  const [loading, setLoading]   = useState(true)

  useEffect(() => {
    async function load() {
      const [
        { data: a },
        { data: b },
        { data: w },
        { data: f },
        { data: p },
      ] = await Promise.all([
        supabase.from('appointments').select('id, status, visit_type, scheduled_date, provider_id, notes'),
        supabase.from('booking_requests').select('id, status, visit_type, state, created_at'),
        supabase.from('waitlist_entries').select('id, status, state, family_id, converted_provider_id'),
        supabase.from('family_profiles').select('id'),
        supabase.from('providers').select('id, name, role'),
      ])
      setAppts(a ?? [])
      setBookings(b ?? [])
      setWaitlist(w ?? [])
      setFamilyCount(f?.length ?? 0)
      setProviders(p ?? [])


      setLoading(false)
    }
    load()
  }, [])

  if (loading) return (
    <div className="p-8 text-[#999] text-[13px]">Loading analytics…</div>
  )

  // ── Derived values ──────────────────────────────────────────────────────────

  const thisMonthPrefix = format(new Date(), 'yyyy-MM')
  const totalDone     = appts.filter(a => a.status === 'done').length
  const thisMonth     = appts.filter(a => a.scheduled_date.startsWith(thisMonthPrefix)).length
  const openWaitlist  = waitlist.filter(w => w.status === 'waiting').length
  const converted     = waitlist.filter(w => w.status === 'converted').length
  const conversionPct = waitlist.length > 0 ? Math.round((converted / waitlist.length) * 100) : 0

  // Status breakdown
  const statusMap: Record<string, number> = { done: 0, upcoming: 0, 'in-progress': 0, cancelled: 0 }
  appts.forEach(a => { statusMap[a.status] = (statusMap[a.status] ?? 0) + 1 })
  const totalAppts = appts.length
  const nonUpcoming = totalAppts - statusMap.upcoming
  const completionRate = nonUpcoming > 0 ? Math.round((statusMap.done / nonUpcoming) * 100) : 0

  // Visit type breakdown
  const vtMap: Record<string, number> = {}
  appts.forEach(a => { vtMap[a.visit_type] = (vtMap[a.visit_type] ?? 0) + 1 })
  const vtSorted = Object.entries(vtMap).sort((a, b) => b[1] - a[1])
  const maxVt = vtSorted[0]?.[1] ?? 1

  // Provider breakdown
  type PStats = { done: number; upcoming: number; cancelled: number }
  const pMap: Record<string, PStats> = {}
  appts.forEach(a => {
    if (!pMap[a.provider_id]) pMap[a.provider_id] = { done: 0, upcoming: 0, cancelled: 0 }
    if (a.status === 'done') pMap[a.provider_id].done++
    else if (a.status === 'upcoming' || a.status === 'in-progress') pMap[a.provider_id].upcoming++
    else if (a.status === 'cancelled') pMap[a.provider_id].cancelled++
  })
  const providerRows = providers
    .filter(p => p.role !== 'admin')
    .map(p => {
      const s = pMap[p.id] ?? { done: 0, upcoming: 0, cancelled: 0 }
      const total = s.done + s.upcoming + s.cancelled
      const rate  = (s.done + s.upcoming) > 0 ? Math.round((s.done / (s.done + s.upcoming)) * 100) : 0
      return { ...p, ...s, total, rate }
    })
    .filter(p => p.total > 0)
    .sort((a, b) => b.total - a.total)

  // Waitlist pickups by provider — appointments where the provider clicked Accept
  // (acceptEntry() always writes "From waitlist" into the notes field)
  const waitlistPickupsByProvider: Record<string, number> = {}
  appts.filter(a => a.notes?.includes('From waitlist')).forEach(a => {
    const provider = providers.find(p => p.id === a.provider_id)
    const key = provider?.name ?? null
    if (key) waitlistPickupsByProvider[key] = (waitlistPickupsByProvider[key] ?? 0) + 1
  })
  const pickupsSorted = Object.entries(waitlistPickupsByProvider).sort((a, b) => b[1] - a[1])
  const maxPickups = pickupsSorted[0]?.[1] ?? 1

  // Waitlist by state
  const wByState: Record<string, { waiting: number; converted: number }> = {}
  waitlist.forEach(w => {
    const s = w.state ?? 'Other'
    if (!wByState[s]) wByState[s] = { waiting: 0, converted: 0 }
    if (w.status === 'waiting')   wByState[s].waiting++
    if (w.status === 'converted') wByState[s].converted++
  })

  // Weekly bookings trend (last 8 weeks)
  const weeks = Array.from({ length: 8 }, (_, i) => {
    const start = startOfWeek(subWeeks(new Date(), 7 - i), { weekStartsOn: 1 })
    const end   = new Date(start.getTime() + 6 * 24 * 60 * 60 * 1000)
    return { label: format(start, 'MMM d'), start, end }
  })
  const weekCounts = weeks.map(w => ({
    label: w.label,
    count: bookings.filter(b => {
      const d = new Date(b.created_at)
      return d >= w.start && d <= w.end
    }).length,
  }))
  const maxWeek = Math.max(...weekCounts.map(w => w.count), 1)

  // Booking type mix (from booking_requests)
  const bVtMap: Record<string, number> = {}
  bookings.forEach(b => { bVtMap[b.visit_type] = (bVtMap[b.visit_type] ?? 0) + 1 })
  const bVtSorted = Object.entries(bVtMap).sort((a, b) => b[1] - a[1])

  return (
    <div>
      {/* Header */}
      <div className="bg-white border-b border-[#E8E8E4] px-6 py-4 sticky top-0 z-10 flex items-center justify-between">
        <div>
          <div className="font-display text-[18px] font-medium text-[#1A1A2E]">Analytics</div>
          <div className="text-[12px] text-[#999] mt-0.5">Practice-wide · All time</div>
        </div>
        <div className="text-[12px] text-[#999]">Updated {format(new Date(), 'MMM d, h:mm a')}</div>
      </div>

      <div className="p-6 max-w-5xl space-y-6">

        {/* KPI row */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <StatCard label="Completed visits"  value={totalDone}    sub="All time"                          color="#1D9E75" bg="#E1F5EE" />
          <StatCard label="This month"        value={thisMonth}    sub={format(new Date(), 'MMMM yyyy')}   color="#7F77DD" bg="#EEEDFE" />
          <StatCard label="Families on file"  value={familyCount}  sub="Registered accounts"               color="#378ADD" bg="#E6F1FB" />
          <StatCard label="Waitlist open"     value={openWaitlist} sub={`${conversionPct}% conversion rate`} color="#EF9F27" bg="#FAEEDA" />
        </div>

        {/* Visit type + Status */}
        <div className="grid lg:grid-cols-2 gap-5">

          {/* By visit type */}
          <div className="bg-white border border-[#E8E8E4] rounded-xl p-5 shadow-sm">
            <h3 className="font-display text-[15px] font-medium text-[#1A1A2E] mb-4">Visits by type</h3>
            {vtSorted.length > 0 ? (
              <div className="space-y-3">
                {vtSorted.map(([type, count]) => (
                  <HBar key={type} label={type} count={count} max={maxVt} color={VT_COLOR[type] ?? '#AFA9EC'} />
                ))}
              </div>
            ) : <p className="text-[13px] text-[#999]">No appointments recorded yet.</p>}
          </div>

          {/* Status distribution */}
          <div className="bg-white border border-[#E8E8E4] rounded-xl p-5 shadow-sm">
            <h3 className="font-display text-[15px] font-medium text-[#1A1A2E] mb-4">Appointment status</h3>
            {totalAppts > 0 ? (
              <>
                <div className="space-y-3">
                  {([
                    { key: 'done',        label: 'Completed',   color: '#1D9E75' },
                    { key: 'upcoming',    label: 'Upcoming',    color: '#7F77DD' },
                    { key: 'in-progress', label: 'In progress', color: '#378ADD' },
                    { key: 'cancelled',   label: 'Cancelled',   color: '#C0392B' },
                  ] as const).map(s => {
                    const count = statusMap[s.key] ?? 0
                    const pct   = Math.round((count / totalAppts) * 100)
                    return (
                      <div key={s.key} className="flex items-center gap-3">
                        <span className="text-[12px] text-[#555] w-24 flex-shrink-0">{s.label}</span>
                        <div className="flex-1 h-2 bg-[#F1EFE8] rounded-full overflow-hidden">
                          <div className="h-full rounded-full" style={{ width: `${pct}%`, background: s.color }} />
                        </div>
                        <span className="text-[12px] text-[#999] w-16 text-right flex-shrink-0 tabular-nums">{count} · {pct}%</span>
                      </div>
                    )
                  })}
                </div>
                <div className="mt-4 pt-4 border-t border-[#E8E8E4] flex justify-between text-[13px]">
                  <span className="text-[#555]">Completion rate (of closed visits)</span>
                  <span className="font-semibold text-[#1D9E75]">{completionRate}%</span>
                </div>
              </>
            ) : <p className="text-[13px] text-[#999]">No appointments recorded yet.</p>}
          </div>
        </div>

        {/* Bookings trend */}
        <div className="bg-white border border-[#E8E8E4] rounded-xl p-5 shadow-sm">
          <h3 className="font-display text-[15px] font-medium text-[#1A1A2E] mb-1">Booking trend</h3>
          <p className="text-[12px] text-[#999] mb-5">New family booking requests — last 8 weeks</p>
          <div className="flex items-end gap-2 h-36">
            {weekCounts.map(w => (
              <div key={w.label} className="flex-1 flex flex-col items-center gap-1.5 min-w-0">
                {w.count > 0 && <div className="text-[11px] text-[#7F77DD] font-semibold">{w.count}</div>}
                <div className="w-full rounded-t-md transition-all duration-500"
                  style={{
                    height: `${Math.max((w.count / maxWeek) * 96, w.count > 0 ? 6 : 2)}px`,
                    background: w.count > 0 ? '#7F77DD' : '#E8E8E4',
                  }} />
                <div className="text-[10px] text-[#999] text-center leading-tight">{w.label}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Provider table */}
        <div className="bg-white border border-[#E8E8E4] rounded-xl p-5 shadow-sm">
          <h3 className="font-display text-[15px] font-medium text-[#1A1A2E] mb-4">Provider breakdown</h3>
          {providerRows.length === 0 ? (
            <p className="text-[13px] text-[#999]">No provider activity recorded yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="border-b border-[#E8E8E4]">
                    {['Provider', 'Completed', 'Upcoming', 'Cancelled', 'Total', 'Completion rate'].map(h => (
                      <th key={h} className="text-left text-[11px] font-medium text-[#999] uppercase tracking-wider pb-2.5 pr-5 whitespace-nowrap">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#F1EFE8]">
                  {providerRows.map(p => (
                    <tr key={p.id}>
                      <td className="py-2.5 pr-5 font-medium text-[#1A1A2E] whitespace-nowrap">{p.name}</td>
                      <td className="py-2.5 pr-5 font-medium tabular-nums" style={{ color: '#1D9E75' }}>{p.done}</td>
                      <td className="py-2.5 pr-5 tabular-nums" style={{ color: '#7F77DD' }}>{p.upcoming}</td>
                      <td className="py-2.5 pr-5 tabular-nums" style={{ color: '#C0392B' }}>{p.cancelled}</td>
                      <td className="py-2.5 pr-5 font-medium text-[#1A1A2E] tabular-nums">{p.total}</td>
                      <td className="py-2.5">
                        <div className="flex items-center gap-2">
                          <div className="w-20 h-1.5 bg-[#F1EFE8] rounded-full overflow-hidden flex-shrink-0">
                            <div className="h-full bg-[#1D9E75] rounded-full" style={{ width: `${p.rate}%` }} />
                          </div>
                          <span className="text-[#555] tabular-nums">{p.rate}%</span>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Waitlist */}
        <div className="grid lg:grid-cols-2 gap-5">

          <div className="bg-white border border-[#E8E8E4] rounded-xl p-5 shadow-sm">
            <h3 className="font-display text-[15px] font-medium text-[#1A1A2E] mb-4">Waitlist overview</h3>
            <div className="grid grid-cols-3 gap-3 mb-4">
              {[
                { label: 'Total entries', value: waitlist.length, color: '#1A1A2E' },
                { label: 'Still waiting', value: openWaitlist,   color: '#EF9F27' },
                { label: 'Converted',     value: converted,      color: '#1D9E75' },
              ].map(s => (
                <div key={s.label} className="text-center p-3 bg-[#FAFAF8] rounded-lg border border-[#E8E8E4]">
                  <div className="font-display text-2xl font-semibold mb-0.5" style={{ color: s.color }}>{s.value}</div>
                  <div className="text-[11px] text-[#999] leading-tight">{s.label}</div>
                </div>
              ))}
            </div>
            {waitlist.length > 0 && (
              <>
                <div className="h-2 bg-[#F1EFE8] rounded-full overflow-hidden mb-2">
                  <div className="h-full bg-[#1D9E75] rounded-full" style={{ width: `${conversionPct}%` }} />
                </div>
                <div className="flex justify-between text-[12px]">
                  <span className="text-[#555]">Conversion rate</span>
                  <span className="font-semibold text-[#1D9E75]">{conversionPct}%</span>
                </div>
              </>
            )}
            <div className="mt-4 pt-4 border-t border-[#E8E8E4]">
              <div className="text-[11px] font-semibold text-[#999] uppercase tracking-wider mb-3">Waitlist pickups by provider</div>
              {pickupsSorted.length === 0 ? (
                <p className="text-[13px] text-[#999]">No waitlist pickups recorded yet.</p>
              ) : (
                <div className="space-y-2.5">
                  {pickupsSorted.map(([name, count]) => (
                    <div key={name}>
                      <div className="flex items-center justify-between text-[13px] mb-1">
                        <span className="text-[#1A1A2E]">{name}</span>
                        <span className="font-semibold text-[#7F77DD] tabular-nums">{count}</span>
                      </div>
                      <div className="h-2 bg-[#F1EFE8] rounded-full overflow-hidden">
                        <div className="h-full rounded-full bg-[#7F77DD] transition-all duration-500"
                          style={{ width: `${(count / maxPickups) * 100}%` }} />
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="bg-white border border-[#E8E8E4] rounded-xl p-5 shadow-sm">
            <h3 className="font-display text-[15px] font-medium text-[#1A1A2E] mb-4">Waitlist by state</h3>
            {Object.keys(wByState).length === 0 ? (
              <p className="text-[13px] text-[#999]">No waitlist entries yet.</p>
            ) : (
              <div className="space-y-3">
                {Object.entries(wByState)
                  .sort((a, b) => (b[1].waiting + b[1].converted) - (a[1].waiting + a[1].converted))
                  .map(([state, counts]) => (
                    <div key={state}>
                      <div className="flex items-center justify-between text-[13px] mb-1">
                        <span className="font-medium text-[#1A1A2E]">{STATE_LABEL[state] ?? state}</span>
                        <div className="flex items-center gap-3 text-[12px]">
                          <span style={{ color: '#EF9F27' }}>{counts.waiting} waiting</span>
                          <span style={{ color: '#1D9E75' }}>{counts.converted} converted</span>
                        </div>
                      </div>
                      <div className="h-1.5 bg-[#F1EFE8] rounded-full overflow-hidden flex">
                        {(() => {
                          const total = counts.waiting + counts.converted
                          return (
                            <>
                              <div style={{ width: `${(counts.converted / total) * 100}%`, background: '#1D9E75' }} className="h-full" />
                              <div style={{ width: `${(counts.waiting / total) * 100}%`, background: '#EF9F27' }} className="h-full" />
                            </>
                          )
                        })()}
                      </div>
                    </div>
                  ))}
              </div>
            )}
          </div>
        </div>

        {/* Booking mix (from requests) */}
        {bVtSorted.length > 0 && (
          <div className="bg-white border border-[#E8E8E4] rounded-xl p-5 shadow-sm">
            <h3 className="font-display text-[15px] font-medium text-[#1A1A2E] mb-1">Booking request mix</h3>
            <p className="text-[12px] text-[#999] mb-4">What families are requesting — all booking requests</p>
            <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
              {bVtSorted.map(([type, count]) => {
                const pct = Math.round((count / bookings.length) * 100)
                return (
                  <div key={type} className="p-3 rounded-lg border border-[#E8E8E4] bg-[#FAFAF8]">
                    <div className="flex items-center gap-2 mb-1.5">
                      <div className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ background: VT_COLOR[type] ?? '#AFA9EC' }} />
                      <span className="text-[12px] font-medium text-[#1A1A2E] leading-tight">{type}</span>
                    </div>
                    <div className="font-display text-xl font-semibold text-[#1A1A2E]">{count}</div>
                    <div className="text-[11px] text-[#999]">{pct}% of requests</div>
                  </div>
                )
              })}
            </div>
          </div>
        )}

      </div>
    </div>
  )
}
