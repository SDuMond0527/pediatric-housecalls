import { useEffect, useState } from 'react'
import { format, startOfMonth, endOfMonth, addMonths, subMonths } from 'date-fns'
import { ChevronLeft, ChevronRight, Trophy } from 'lucide-react'
import { getReports } from '../../lib/api'

interface ApptRow {
  id: string
  provider_id: string
  visit_type: string
  scheduled_date: string
  status: string
  notes: string | null
}
interface ProviderRow { id: string; name: string }
interface EncounterNoteRow { provider_id: string; cpt_codes: { code: string; description: string; charge_amount: number; modifier?: string }[] }

const VT_COLOR: Record<string, string> = {
  'In-home sick visit':  '#7F77DD',
  'Sports physical':     '#EF9F27',
  'CMA + telemedicine':  '#378ADD',
  'Video telemedicine':  '#1D9E75',
  'Text visit':          '#D4537E',
  'In-home IV fluids':   '#0F6E56',
}

const VISIT_TYPE_ORDER = [
  'In-home sick visit',
  'Video telemedicine',
  'CMA + telemedicine',
  'Sports physical',
  'Text visit',
  'In-home IV fluids',
]

function SummaryCard({ label, value, color, bg, sub }: { label: string; value: number; color: string; bg: string; sub?: string }) {
  return (
    <div className="bg-white border border-[#E8E8E4] rounded-xl p-5 shadow-sm">
      <div className="w-8 h-8 rounded-lg mb-3" style={{ background: bg }} />
      <div className="font-display text-3xl font-semibold mb-1" style={{ color }}>{value}</div>
      <div className="text-[13px] font-medium text-[#1A1A2E]">{label}</div>
      {sub && <div className="text-[11px] text-[#999] mt-0.5">{sub}</div>}
    </div>
  )
}

export function AdminReports() {
  const [month, setMonth] = useState(new Date())
  const [appts, setAppts] = useState<ApptRow[]>([])
  const [providers, setProviders] = useState<ProviderRow[]>([])
  const [encounterNotes, setEncounterNotes] = useState<EncounterNoteRow[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function load() {
      setLoading(true)
      const start = format(startOfMonth(month), 'yyyy-MM-dd')
      const end   = format(endOfMonth(month),   'yyyy-MM-dd')

      const result = await getReports({ start, end }).catch(() => null)
      setAppts(result?.appointments ?? [])
      setProviders(result?.providers ?? [])
      setEncounterNotes(result?.encounterNotes ?? [])
      setLoading(false)
    }
    load()
  }, [month])

  if (loading) return <div className="p-8 text-[#999] text-[13px]">Loading reports…</div>

  const monthLabel = format(month, 'MMMM yyyy')

  // Summary totals
  const total     = appts.length
  const completed = appts.filter(a => a.status === 'done').length
  const upcoming  = appts.filter(a => a.status === 'upcoming' || a.status === 'in-progress').length
  const broadcastTotal = appts.filter(a => a.notes?.startsWith('Broadcast:')).length
  const waitlistTotal  = appts.filter(a => a.notes?.startsWith('From waitlist')).length
  const totalPickups   = broadcastTotal + waitlistTotal

  // Per-provider stats
  const providerStats = providers
    .map(p => {
      const pa = appts.filter(a => a.provider_id === p.id)
      const byType: Record<string, number> = {}
      pa.forEach(a => { byType[a.visit_type] = (byType[a.visit_type] ?? 0) + 1 })
      const broadcasts = pa.filter(a => a.notes?.startsWith('Broadcast:')).length
      const waitlist   = pa.filter(a => a.notes?.startsWith('From waitlist')).length
      return {
        ...p,
        total:     pa.length,
        completed: pa.filter(a => a.status === 'done').length,
        upcoming:  pa.filter(a => a.status === 'upcoming' || a.status === 'in-progress').length,
        cancelled: pa.filter(a => a.status === 'cancelled').length,
        byType,
        broadcasts,
        waitlist,
        pickups: broadcasts + waitlist,
      }
    })
    .filter(p => p.total > 0)
    .sort((a, b) => b.total - a.total)

  // Visit types that appear this month, in preferred order
  const activeTypes = VISIT_TYPE_ORDER.filter(vt => appts.some(a => a.visit_type === vt))
  // Add any unexpected types not in the order list
  appts.forEach(a => { if (!activeTypes.includes(a.visit_type)) activeTypes.push(a.visit_type) })

  // Procedure codes by provider
  type CptSummary = { code: string; description: string; count: number; total: number }
  const providerCptMap: Record<string, CptSummary[]> = {}
  encounterNotes.forEach(en => {
    if (!Array.isArray(en.cpt_codes)) return
    const provider = providers.find(p => p.id === en.provider_id)
    if (!provider) return
    if (!providerCptMap[provider.name]) providerCptMap[provider.name] = []
    en.cpt_codes.forEach(c => {
      const existing = providerCptMap[provider.name].find(x => x.code === c.code)
      if (existing) { existing.count++; existing.total += c.charge_amount ?? 0 }
      else providerCptMap[provider.name].push({ code: c.code, description: c.description, count: 1, total: c.charge_amount ?? 0 })
    })
  })
  const providerCptRows = Object.entries(providerCptMap)
    .map(([name, codes]) => ({ name, codes: [...codes].sort((a, b) => b.count - a.count) }))
    .sort((a, b) => a.name.localeCompare(b.name))

  // Bonus leader (highest pickups; if tied, both get badge)
  const maxPickups = Math.max(...providerStats.map(p => p.pickups), 0)
  const pickupLeaders = providerStats.filter(p => p.pickups === maxPickups && maxPickups > 0)
  const pickupLeaderIds = new Set(pickupLeaders.map(p => p.id))
  const pickupsSorted = [...providerStats].sort((a, b) => b.pickups - a.pickups)

  return (
    <div>
      {/* Header */}
      <div className="bg-white border-b border-[#E8E8E4] px-6 py-4 sticky top-0 z-10 flex items-center justify-between">
        <div>
          <div className="font-display text-[18px] font-medium text-[#1A1A2E]">Reports</div>
          <div className="text-[12px] text-[#999] mt-0.5">Monthly visit and provider activity</div>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => setMonth(m => subMonths(m, 1))}
            className="p-1.5 rounded-lg hover:bg-[#F1EFE8] transition-colors text-[#555] hover:text-[#1A1A2E]">
            <ChevronLeft size={16} />
          </button>
          <span className="font-medium text-[14px] text-[#1A1A2E] w-36 text-center">{monthLabel}</span>
          <button onClick={() => setMonth(m => addMonths(m, 1))}
            className="p-1.5 rounded-lg hover:bg-[#F1EFE8] transition-colors text-[#555] hover:text-[#1A1A2E]">
            <ChevronRight size={16} />
          </button>
        </div>
      </div>

      <div className="p-6 max-w-6xl space-y-6">

        {/* Summary cards */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <SummaryCard label="Total visits"       value={total}        color="#1A1A2E" bg="#F1EFE8" />
          <SummaryCard label="Completed"          value={completed}    color="#1D9E75" bg="#E1F5EE" />
          <SummaryCard label="Upcoming / active"  value={upcoming}     color="#7F77DD" bg="#EEEDFE" />
          <SummaryCard label="Waitlist & broadcast pickups" value={totalPickups} color="#EF9F27" bg="#FAEEDA"
            sub={totalPickups > 0 ? `${broadcastTotal} broadcast · ${waitlistTotal} waitlist` : undefined} />
        </div>

        {/* Visits by provider */}
        <div className="bg-white border border-[#E8E8E4] rounded-xl p-5 shadow-sm">
          <h3 className="font-display text-[15px] font-medium text-[#1A1A2E] mb-1">Visits by provider</h3>
          <p className="text-[12px] text-[#999] mb-4">{monthLabel}</p>
          {providerStats.length === 0 ? (
            <p className="text-[13px] text-[#999]">No appointments this month.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="border-b border-[#E8E8E4]">
                    {['Provider', 'Total', 'Completed', 'Upcoming', 'Cancelled'].map(h => (
                      <th key={h} className="text-left text-[11px] font-medium text-[#999] uppercase tracking-wider pb-2.5 pr-6 whitespace-nowrap">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#F1EFE8]">
                  {providerStats.map(p => (
                    <tr key={p.id}>
                      <td className="py-3 pr-6 font-medium text-[#1A1A2E] whitespace-nowrap">{p.name}</td>
                      <td className="py-3 pr-6 font-semibold text-[#1A1A2E] tabular-nums">{p.total}</td>
                      <td className="py-3 pr-6 tabular-nums font-medium" style={{ color: '#1D9E75' }}>{p.completed}</td>
                      <td className="py-3 pr-6 tabular-nums" style={{ color: '#7F77DD' }}>{p.upcoming}</td>
                      <td className="py-3 tabular-nums" style={{ color: '#C0392B' }}>{p.cancelled}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Visit type breakdown by provider */}
        {activeTypes.length > 0 && providerStats.length > 0 && (
          <div className="bg-white border border-[#E8E8E4] rounded-xl p-5 shadow-sm">
            <h3 className="font-display text-[15px] font-medium text-[#1A1A2E] mb-1">Visit type breakdown by provider</h3>
            <p className="text-[12px] text-[#999] mb-4">{monthLabel} — all statuses</p>
            <div className="overflow-x-auto">
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="border-b border-[#E8E8E4]">
                    <th className="text-left text-[11px] font-medium text-[#999] uppercase tracking-wider pb-2.5 pr-6 whitespace-nowrap">Provider</th>
                    {activeTypes.map(vt => (
                      <th key={vt} className="text-left text-[11px] font-medium uppercase tracking-wider pb-2.5 pr-5 whitespace-nowrap"
                        style={{ color: VT_COLOR[vt] ?? '#999' }}>
                        {vt}
                      </th>
                    ))}
                    <th className="text-left text-[11px] font-medium text-[#999] uppercase tracking-wider pb-2.5 whitespace-nowrap">Total</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#F1EFE8]">
                  {providerStats.map(p => (
                    <tr key={p.id}>
                      <td className="py-3 pr-6 font-medium text-[#1A1A2E] whitespace-nowrap">{p.name}</td>
                      {activeTypes.map(vt => (
                        <td key={vt} className="py-3 pr-5 tabular-nums text-[#555]">
                          {p.byType[vt] ? (
                            <span className="font-medium" style={{ color: VT_COLOR[vt] ?? '#555' }}>{p.byType[vt]}</span>
                          ) : (
                            <span className="text-[#D8D5CE]">—</span>
                          )}
                        </td>
                      ))}
                      <td className="py-3 font-semibold text-[#1A1A2E] tabular-nums">{p.total}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Procedure codes by provider */}
        <div className="bg-white border border-[#E8E8E4] rounded-xl p-5 shadow-sm">
          <h3 className="font-display text-[15px] font-medium text-[#1A1A2E] mb-1">Procedure codes by provider</h3>
          <p className="text-[12px] text-[#999] mb-4">{monthLabel} — from completed encounter notes</p>
          {providerCptRows.length === 0 ? (
            <p className="text-[13px] text-[#999]">No procedure codes recorded this month.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="border-b border-[#E8E8E4]">
                    {['Provider', 'Code', 'Description', 'Count', 'Total Charges'].map(h => (
                      <th key={h} className="text-left text-[11px] font-medium text-[#999] uppercase tracking-wider pb-2.5 pr-6 whitespace-nowrap">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#F1EFE8]">
                  {providerCptRows.map(({ name, codes }) =>
                    codes.map((c, i) => (
                      <tr key={`${name}-${c.code}`}>
                        <td className="py-2.5 pr-6 font-medium text-[#1A1A2E] whitespace-nowrap">
                          {i === 0 ? name : ''}
                        </td>
                        <td className="py-2.5 pr-6">
                          <span className="font-mono text-[12px] font-semibold bg-[#EEEDFE] text-[#3C3489] px-1.5 py-0.5 rounded">{c.code}</span>
                        </td>
                        <td className="py-2.5 pr-6 text-[#555] max-w-xs">{c.description}</td>
                        <td className="py-2.5 pr-6 tabular-nums font-semibold text-[#1A1A2E]">{c.count}</td>
                        <td className="py-2.5 tabular-nums text-[#1D9E75] font-medium">${c.total.toFixed(2)}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Monthly bonus leaderboard */}
        <div className="bg-white border border-[#E8E8E4] rounded-xl p-5 shadow-sm">
          <div className="flex items-center gap-2 mb-1">
            <Trophy size={15} color="#EF9F27" />
            <h3 className="font-display text-[15px] font-medium text-[#1A1A2E]">Monthly bonus leaderboard</h3>
          </div>
          <p className="text-[12px] text-[#999] mb-4">Waitlist & broadcast pickups — {monthLabel}</p>

          {pickupLeaders.length > 0 && (
            <div className="mb-4 p-4 rounded-xl border border-[#EF9F27]/30 bg-[#FFFBF5] flex items-center gap-3">
              <span className="text-2xl">🏆</span>
              <div>
                <div className="font-semibold text-[#1A1A2E] text-[14px]">
                  {pickupLeaders.map(p => p.name).join(' & ')}
                </div>
                <div className="text-[12px] text-[#555] mt-0.5">
                  {maxPickups} pickup{maxPickups !== 1 ? 's' : ''} this month · {monthLabel} bonus {pickupLeaders.length > 1 ? 'co-leaders' : 'leader'}
                </div>
              </div>
            </div>
          )}

          {pickupsSorted.length === 0 ? (
            <p className="text-[13px] text-[#999]">No pickups recorded this month.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="border-b border-[#E8E8E4]">
                    {['Provider', 'Broadcast pickups', 'Waitlist pickups', 'Total pickups', ''].map(h => (
                      <th key={h} className="text-left text-[11px] font-medium text-[#999] uppercase tracking-wider pb-2.5 pr-6 whitespace-nowrap">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#F1EFE8]">
                  {pickupsSorted.map(p => (
                    <tr key={p.id}>
                      <td className="py-3 pr-6 font-medium text-[#1A1A2E] whitespace-nowrap">{p.name}</td>
                      <td className="py-3 pr-6 tabular-nums font-medium" style={{ color: '#378ADD' }}>{p.broadcasts}</td>
                      <td className="py-3 pr-6 tabular-nums font-medium" style={{ color: '#7F77DD' }}>{p.waitlist}</td>
                      <td className="py-3 pr-6 font-semibold text-[#1A1A2E] tabular-nums">{p.pickups}</td>
                      <td className="py-3">
                        {pickupLeaderIds.has(p.id) && maxPickups > 0 && (
                          <span className="inline-flex items-center gap-1 text-[11px] font-medium px-2.5 py-1 rounded-full bg-[#FAEEDA] text-[#633806]">
                            🏆 Leader
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

      </div>
    </div>
  )
}
