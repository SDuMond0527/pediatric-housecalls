import { useEffect, useMemo, useState } from 'react'
import { format, startOfMonth, endOfMonth, subDays } from 'date-fns'
import { formatApiDate } from '../../lib/dateUtils'
import { Trophy, ArrowLeft, Download } from 'lucide-react'
import { getReports } from '../../lib/api'
import { computeProviderPay } from '../../lib/payrollRules'

interface ApptRow {
  id: string
  provider_id: string
  visit_type: string
  scheduled_date: string
  status: string
  notes: string | null
}
interface ProviderRow { id: string; name: string; role: string }
interface EncounterCpt { code: string; description: string; category?: string; charge_amount: number; units?: number; modifier?: string }
interface EncounterNoteRow {
  encounter_note_id: string
  provider_id: string
  scheduled_date: string
  visit_type: string | null
  appointment_status: string | null
  claim_id: string | null
  claim_number: string | null
  claim_created_at: string | null
  payer_name: string | null
  payer_id: string | null
  chart_number: string | null
  patient_first_name: string | null
  patient_last_name: string | null
  cpt_codes: EncounterCpt[]
}

// One row per CPT line, per encounter note. Used by the Payroll report.
interface PayrollRow {
  key: string
  providerId: string
  providerName: string
  chartNumber: string
  patientName: string
  claimNumber: string
  payer: string
  code: string
  description: string
  category: string
  encounterDate: string
  visitType: string
  claimDate: string | null
  charge: number
  quantity: number
  rvu: number
  rvuRate: number
  rvuCount: number
  providerPay: number
  cvSplit: number
  appointmentStatus: string
}

function fmtPayer(name: string | null, id: string | null): string {
  if (!name && !id) return ''
  if (name && id)   return `${name} [${id}]`
  return name ?? id ?? ''
}

function fmtPatientName(first: string | null, last: string | null): string {
  const l = (last ?? '').trim()
  const f = (first ?? '').trim()
  if (l && f) return `${l}, ${f}`
  return l || f
}

function toCsv(rows: PayrollRow[]): string {
  const headers = [
    '#', 'Chart #', 'Patient Name', 'Claim #', 'Payer',
    'Procedure Code', 'Description', 'Category',
    'Encounter Date', 'Visit Type', 'Claim Date',
    'Provider', 'Amount Billed',
    'wRVU', '$/RVU', 'RVU Count', 'Provider $ Paid', 'CV Split',
  ]
  const esc = (v: any) => {
    const s = v == null ? '' : String(v)
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const body = rows.map((r, i) => [
    i + 1, r.chartNumber, r.patientName, r.claimNumber, r.payer,
    r.code, r.description, r.category,
    formatApiDate(r.encounterDate), r.visitType,
    r.claimDate ? formatApiDate(r.claimDate) : '',
    r.providerName, r.charge.toFixed(2),
    r.rvu.toFixed(2), r.rvuRate.toFixed(2), r.rvuCount.toFixed(2),
    r.providerPay.toFixed(2), r.cvSplit.toFixed(2),
  ].map(esc).join(','))

  const totalEncounters = new Set(rows.map(r => r.claimNumber || r.encounterDate + '|' + r.patientName)).size
  const totalRvuCount = rows.reduce((s, r) => s + r.rvuCount, 0)
  const totalRvuPay   = rows.reduce((s, r) => s + r.providerPay, 0)
  const totalCv       = rows.reduce((s, r) => s + r.cvSplit, 0)
  const grandTotal    = totalRvuPay + totalCv
  const totalsRow = [
    '', '', '', '', '', '', '', 'REPORT TOTALS',
    `Encounters: ${totalEncounters}`, '', '', '', '',
    '', '', totalRvuCount.toFixed(2), totalRvuPay.toFixed(2), totalCv.toFixed(2),
  ].map(esc).join(',')
  const grandTotalRow = [
    '', '', '', '', '', '', '', 'TOTAL PAY',
    '', '', '', '', '',
    '', '', '', grandTotal.toFixed(2), '',
  ].map(esc).join(',')

  return [headers.join(','), ...body, totalsRow, grandTotalRow].join('\n')
}

function downloadCsv(filename: string, csv: string) {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

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

const today = new Date()
const DEFAULT_START = format(startOfMonth(today), 'yyyy-MM-dd')
const DEFAULT_END   = format(endOfMonth(today),   'yyyy-MM-dd')

export function AdminReports() {
  const [startDate, setStartDate] = useState(DEFAULT_START)
  const [endDate,   setEndDate]   = useState(DEFAULT_END)
  const [appts, setAppts] = useState<ApptRow[]>([])
  const [providers, setProviders] = useState<ProviderRow[]>([])
  const [encounterNotes, setEncounterNotes] = useState<EncounterNoteRow[]>([])
  const [loading, setLoading] = useState(true)

  // Payroll report state
  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(null)
  const [excludeCancelled, setExcludeCancelled] = useState(true)
  const [filterCategory, setFilterCategory] = useState<'all' | 'Procedure' | 'Non-Covered Services'>('all')
  const [filterVisitTypes, setFilterVisitTypes] = useState<string[]>([])
  const [filterEncounterStart, setFilterEncounterStart] = useState('')
  const [filterEncounterEnd, setFilterEncounterEnd] = useState('')
  const [excludedCodes, setExcludedCodes] = useState<string[]>([])

  useEffect(() => {
    async function load() {
      if (!startDate || !endDate || startDate > endDate) return
      setLoading(true)
      const result = await getReports({ start: startDate, end: endDate }).catch(() => null)
      setAppts(result?.appointments ?? [])
      setProviders(result?.providers ?? [])
      setEncounterNotes(result?.encounterNotes ?? [])
      setLoading(false)
    }
    load()
  }, [startDate, endDate])

  const rangeLabel = startDate === endDate
    ? formatApiDate(startDate)
    : `${formatApiDate(startDate, 'MMM d')} – ${formatApiDate(endDate)}`

  // Payroll rows must be a useMemo (not a bare computation) and must live above
  // the `if (loading)` early return so hook order stays stable across renders.
  const payrollRows: PayrollRow[] = useMemo(() => {
    const out: PayrollRow[] = []
    encounterNotes.forEach(en => {
      if (!Array.isArray(en.cpt_codes)) return
      const provider = providers.find(p => p.id === en.provider_id)
      if (!provider) return
      en.cpt_codes.forEach((c, idx) => {
        const charge = Number(c.charge_amount) || 0
        const quantity = Number(c.units) || 1
        const pay = computeProviderPay({
          code: c.code,
          quantity,
          visitType: en.visit_type ?? '',
          providerName: provider.name,
          providerRole: provider.role ?? '',
        })
        out.push({
          key: `${en.encounter_note_id}-${idx}`,
          providerId: provider.id,
          providerName: provider.name,
          chartNumber: en.chart_number ?? '',
          patientName: fmtPatientName(en.patient_first_name, en.patient_last_name),
          claimNumber: en.claim_number ?? '',
          payer: fmtPayer(en.payer_name, en.payer_id),
          code: c.code,
          description: c.description ?? '',
          category: c.category ?? 'Procedure',
          encounterDate: en.scheduled_date,
          visitType: en.visit_type ?? '',
          claimDate: en.claim_created_at,
          charge,
          quantity,
          rvu: pay.rvu,
          rvuRate: pay.rvuRate,
          rvuCount: pay.rvuCount,
          providerPay: pay.pay,
          cvSplit: pay.cvSplit,
          appointmentStatus: en.appointment_status ?? '',
        })
      })
    })
    return out
  }, [encounterNotes, providers])

  const payrollVisitTypes = useMemo(() => {
    const s = new Set<string>()
    payrollRows.forEach(r => { if (r.visitType) s.add(r.visitType) })
    return Array.from(s).sort()
  }, [payrollRows])

  // All unfiltered rows for the selected provider — used both by the filter chip
  // options and to distinguish "no data" from "filters exclude everything".
  const selectedProviderAllRows = useMemo(() => {
    if (!selectedProviderId) return []
    return payrollRows.filter(r => r.providerId === selectedProviderId)
  }, [payrollRows, selectedProviderId])

  const filteredProviderRows = useMemo(() => {
    if (!selectedProviderId) return []
    return selectedProviderAllRows.filter(r => {
      if (excludeCancelled && r.appointmentStatus === 'cancelled') return false
      if (filterCategory !== 'all' && r.category !== filterCategory) return false
      if (filterVisitTypes.length > 0 && !filterVisitTypes.includes(r.visitType)) return false
      if (excludedCodes.includes(r.code)) return false
      if (filterEncounterStart && (!r.encounterDate || r.encounterDate.slice(0, 10) < filterEncounterStart)) return false
      if (filterEncounterEnd   && (!r.encounterDate || r.encounterDate.slice(0, 10) > filterEncounterEnd))   return false
      return true
    }).sort((a, b) => a.encounterDate.localeCompare(b.encounterDate) || a.code.localeCompare(b.code))
  }, [selectedProviderAllRows, selectedProviderId, excludeCancelled, filterCategory, filterVisitTypes,
      excludedCodes, filterEncounterStart, filterEncounterEnd])

  const payrollProviderTotals = useMemo(() => {
    type Acc = { id: string; name: string; encounters: Set<string>; totalRvuCount: number; totalRvuPay: number; totalCvSplit: number }
    const byProvider = new Map<string, Acc>()
    payrollRows.forEach(r => {
      if (excludeCancelled && r.appointmentStatus === 'cancelled') return
      const existing = byProvider.get(r.providerId) ?? { id: r.providerId, name: r.providerName, encounters: new Set<string>(), totalRvuCount: 0, totalRvuPay: 0, totalCvSplit: 0 }
      existing.encounters.add(r.claimNumber || r.encounterDate + '|' + r.patientName)
      existing.totalRvuCount += r.rvuCount
      existing.totalRvuPay   += r.providerPay
      existing.totalCvSplit  += r.cvSplit
      byProvider.set(r.providerId, existing)
    })
    return Array.from(byProvider.values())
      .map(p => ({ id: p.id, name: p.name, encounters: p.encounters.size, totalRvuCount: p.totalRvuCount, totalRvuPay: p.totalRvuPay, totalCvSplit: p.totalCvSplit, totalPay: p.totalRvuPay + p.totalCvSplit }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [payrollRows, excludeCancelled])

  if (loading) return <div className="p-8 text-[#999] text-[13px]">Loading reports…</div>

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

  // Visit types that appear this period, in preferred order
  const activeTypes = VISIT_TYPE_ORDER.filter(vt => appts.some(a => a.visit_type === vt))
  appts.forEach(a => { if (!activeTypes.includes(a.visit_type)) activeTypes.push(a.visit_type) })

  // payrollRows / filteredProviderRows / payrollProviderTotals / payrollVisitTypes
  // are memoized above the loading return so hook order stays stable.

  const payrollGrandTotalEncounters  = payrollProviderTotals.reduce((s, p) => s + p.encounters, 0)
  const payrollGrandTotalRvuCount    = payrollProviderTotals.reduce((s, p) => s + p.totalRvuCount, 0)
  const payrollGrandTotalRvuPay      = payrollProviderTotals.reduce((s, p) => s + p.totalRvuPay, 0)
  const payrollGrandTotalCvSplit     = payrollProviderTotals.reduce((s, p) => s + p.totalCvSplit, 0)
  const payrollGrandTotalPay         = payrollProviderTotals.reduce((s, p) => s + p.totalPay, 0)
  const selectedProvider = payrollProviderTotals.find(p => p.id === selectedProviderId)

  function toggleVisitTypeFilter(vt: string) {
    setFilterVisitTypes(prev => prev.includes(vt) ? prev.filter(x => x !== vt) : [...prev, vt])
  }

  function resetPayrollFilters() {
    setExcludeCancelled(true)
    setFilterCategory('all')
    setFilterVisitTypes([])
    setFilterEncounterStart('')
    setFilterEncounterEnd('')
    setExcludedCodes([])
  }

  function toggleExcludedCode(code: string) {
    setExcludedCodes(prev => prev.includes(code) ? prev.filter(c => c !== code) : [...prev, code])
  }

  // Bonus leader
  const maxPickups = Math.max(...providerStats.map(p => p.pickups), 0)
  const pickupLeaders = providerStats.filter(p => p.pickups === maxPickups && maxPickups > 0)
  const pickupLeaderIds = new Set(pickupLeaders.map(p => p.id))
  const pickupsSorted = [...providerStats].sort((a, b) => b.pickups - a.pickups)

  return (
    <div>
      {/* Header */}
      <div className="bg-white border-b border-[#E8E8E4] px-6 py-4 sticky top-0 z-10 flex items-center justify-between flex-wrap gap-3">
        <div>
          <div className="font-display text-[18px] font-medium text-[#1A1A2E]">Reports</div>
          <div className="text-[12px] text-[#999] mt-0.5">Visit and provider activity</div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <input
            type="date"
            value={startDate}
            onChange={e => setStartDate(e.target.value)}
            className="border border-[#E8E8E4] rounded-lg px-3 py-1.5 text-[13px] text-[#1A1A2E] bg-white focus:outline-none focus:border-[#7F77DD]"
          />
          <span className="text-[#999] text-[13px]">to</span>
          <input
            type="date"
            value={endDate}
            onChange={e => setEndDate(e.target.value)}
            className="border border-[#E8E8E4] rounded-lg px-3 py-1.5 text-[13px] text-[#1A1A2E] bg-white focus:outline-none focus:border-[#7F77DD]"
          />
          <button
            onClick={() => { setStartDate(format(startOfMonth(today), 'yyyy-MM-dd')); setEndDate(format(endOfMonth(today), 'yyyy-MM-dd')) }}
            className="px-3 py-1.5 text-[12px] font-medium text-[#555] hover:text-[#1A1A2E] border border-[#E8E8E4] rounded-lg hover:bg-[#F1EFE8] transition-colors whitespace-nowrap"
          >
            This month
          </button>
          <button
            onClick={() => { const d = today; setStartDate(format(subDays(d, 13), 'yyyy-MM-dd')); setEndDate(format(d, 'yyyy-MM-dd')) }}
            className="px-3 py-1.5 text-[12px] font-medium text-[#555] hover:text-[#1A1A2E] border border-[#E8E8E4] rounded-lg hover:bg-[#F1EFE8] transition-colors whitespace-nowrap"
          >
            Last 14 days
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
          <p className="text-[12px] text-[#999] mb-4">{rangeLabel}</p>
          {providerStats.length === 0 ? (
            <p className="text-[13px] text-[#999]">No appointments in this period.</p>
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
            <p className="text-[12px] text-[#999] mb-4">{rangeLabel} — all statuses</p>
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

        {/* Payroll report */}
        <div className="bg-white border border-[#E8E8E4] rounded-xl p-5 shadow-sm">
          {selectedProviderId && selectedProvider ? (
            // ────────── Provider detail view ──────────
            <>
              <div className="flex items-center justify-between flex-wrap gap-3 mb-1">
                <div className="flex items-center gap-3">
                  <button
                    onClick={() => { setSelectedProviderId(null); resetPayrollFilters() }}
                    className="p-1.5 rounded-md hover:bg-[#F1EFE8] text-[#555]"
                    aria-label="Back to provider list"
                  >
                    <ArrowLeft size={16} />
                  </button>
                  <h3 className="font-display text-[15px] font-medium text-[#1A1A2E]">
                    Payroll Report : {selectedProvider.name}
                  </h3>
                </div>
                <button
                  onClick={() => downloadCsv(
                    `payroll-${selectedProvider.name.replace(/\s+/g, '_')}-${startDate}_to_${endDate}.csv`,
                    toCsv(filteredProviderRows),
                  )}
                  disabled={filteredProviderRows.length === 0}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-medium text-white bg-[#1D9E75] rounded-lg hover:bg-[#178862] disabled:bg-[#D8D5CE] disabled:cursor-not-allowed"
                >
                  <Download size={13} /> Export as CSV
                </button>
              </div>
              <p className="text-[12px] text-[#999] mb-4">Encounter Date {rangeLabel}</p>

              {/* Filters */}
              <div className="bg-[#FAF9F4] border border-[#E8E8E4] rounded-lg p-3 mb-4 space-y-2">
                <div className="flex items-center gap-2 flex-wrap text-[12px]">
                  <label className="inline-flex items-center gap-1.5 text-[#555]">
                    <input type="checkbox" checked={excludeCancelled} onChange={e => setExcludeCancelled(e.target.checked)} />
                    Exclude cancelled appointments
                  </label>
                  <span className="text-[#D8D5CE]">|</span>
                  <label className="text-[#555]">Category:</label>
                  <select
                    value={filterCategory}
                    onChange={e => setFilterCategory(e.target.value as any)}
                    className="border border-[#E8E8E4] rounded px-2 py-1 text-[12px] bg-white"
                  >
                    <option value="all">All</option>
                    <option value="Procedure">Procedure</option>
                    <option value="Non-Covered Services">Non-Covered Services</option>
                  </select>
                </div>

                {payrollVisitTypes.length > 0 && (
                  <div className="flex items-center gap-2 flex-wrap text-[12px]">
                    <span className="text-[#555]">Visit type:</span>
                    {payrollVisitTypes.map(vt => {
                      const active = filterVisitTypes.includes(vt)
                      return (
                        <button
                          key={vt}
                          onClick={() => toggleVisitTypeFilter(vt)}
                          className={`px-2 py-0.5 rounded-full border transition-colors ${active ? 'bg-[#7F77DD] border-[#7F77DD] text-white' : 'border-[#E8E8E4] text-[#555] hover:bg-white'}`}
                        >
                          {vt}
                        </button>
                      )
                    })}
                    {filterVisitTypes.length > 0 && (
                      <button onClick={() => setFilterVisitTypes([])} className="text-[11px] text-[#999] hover:text-[#555] underline">clear</button>
                    )}
                  </div>
                )}

                <div className="grid grid-cols-2 gap-2 text-[12px]">
                  <div>
                    <div className="text-[#999] mb-0.5">Encounter date from</div>
                    <input type="date" value={filterEncounterStart} onChange={e => setFilterEncounterStart(e.target.value)} className="w-full border border-[#E8E8E4] rounded px-2 py-1 bg-white" />
                  </div>
                  <div>
                    <div className="text-[#999] mb-0.5">Encounter date to</div>
                    <input type="date" value={filterEncounterEnd} onChange={e => setFilterEncounterEnd(e.target.value)} className="w-full border border-[#E8E8E4] rounded px-2 py-1 bg-white" />
                  </div>
                </div>

                {/* Procedure code filter — one chip per unique code present in this
                    provider's data. Click to exclude (e.g. codes without an RVU). */}
                {(() => {
                  const uniqueCodes = Array.from(new Set(selectedProviderAllRows.map(r => r.code))).sort()
                  if (uniqueCodes.length === 0) return null
                  return (
                    <div className="text-[12px]">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-[#555]">Procedure codes:</span>
                        <span className="text-[11px] text-[#999]">every code this provider used in the date range — click any to exclude from the report</span>
                        {excludedCodes.length > 0 && (
                          <button onClick={() => setExcludedCodes([])} className="ml-auto text-[11px] text-[#999] hover:text-[#555] underline">include all</button>
                        )}
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {uniqueCodes.map(code => {
                          const excluded = excludedCodes.includes(code)
                          return (
                            <button
                              key={code}
                              onClick={() => toggleExcludedCode(code)}
                              className={`font-mono px-2 py-0.5 rounded border transition-colors ${excluded ? 'border-[#E8E8E4] text-[#B0AFA8] line-through bg-white' : 'border-[#E8E8E4] text-[#555] bg-white hover:bg-[#F1EFE8]'}`}
                              title={excluded ? 'Excluded — click to include' : 'Included — click to exclude'}
                            >
                              {code}
                            </button>
                          )
                        })}
                      </div>
                    </div>
                  )
                })()}

                <div className="flex justify-end">
                  <button onClick={resetPayrollFilters} className="text-[11px] text-[#999] hover:text-[#555] underline">Reset filters</button>
                </div>
              </div>

              {selectedProviderAllRows.length === 0 ? (
                <p className="text-[13px] text-[#999]">
                  No signed encounter notes with procedure codes for {selectedProvider.name} in {rangeLabel}.
                  {' '}Notes must be signed and have CPT codes attached to appear on payroll.
                </p>
              ) : filteredProviderRows.length === 0 ? (
                <p className="text-[13px] text-[#999]">
                  {selectedProviderAllRows.length} record{selectedProviderAllRows.length === 1 ? '' : 's'} exist for this provider,
                  but the current filters exclude all of them. Try clicking <strong>Reset filters</strong> above.
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-[12px]">
                    <thead>
                      <tr className="border-b border-[#E8E8E4]">
                        {['#', 'Chart #', 'Patient', 'Claim #', 'Payer', 'Code', 'Description', 'Encounter', 'Visit Type', 'Claim Date', 'Billed', 'wRVU', '$/RVU', 'RVU Ct', 'Provider $', 'CV Split'].map(h => (
                          <th key={h} className="text-left text-[10px] font-medium text-[#999] uppercase tracking-wider pb-2 pr-3 whitespace-nowrap">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[#F1EFE8]">
                      {filteredProviderRows.map((r, i) => (
                        <tr key={r.key}>
                          <td className="py-2 pr-3 text-[#999] tabular-nums">{i + 1}</td>
                          <td className="py-2 pr-3 font-mono text-[10px] text-[#555] whitespace-nowrap">{r.chartNumber || '—'}</td>
                          <td className="py-2 pr-3 text-[#1A1A2E] whitespace-nowrap">{r.patientName || '—'}</td>
                          <td className="py-2 pr-3 font-mono text-[10px] text-[#555] whitespace-nowrap">{r.claimNumber || '—'}</td>
                          <td className="py-2 pr-3 text-[#555] whitespace-nowrap max-w-[160px] truncate" title={r.payer}>{r.payer || '—'}</td>
                          <td className="py-2 pr-3">
                            <span className="font-mono text-[11px] font-semibold bg-[#EEEDFE] text-[#3C3489] px-1.5 py-0.5 rounded">{r.code}</span>
                          </td>
                          <td className="py-2 pr-3 text-[#555] max-w-[180px] truncate" title={r.description}>{r.description}</td>
                          <td className="py-2 pr-3 tabular-nums text-[#555] whitespace-nowrap">{formatApiDate(r.encounterDate)}</td>
                          <td className="py-2 pr-3 text-[#555] whitespace-nowrap">{r.visitType || '—'}</td>
                          <td className="py-2 pr-3 tabular-nums text-[#555] whitespace-nowrap">{r.claimDate ? formatApiDate(r.claimDate) : '—'}</td>
                          <td className="py-2 pr-3 tabular-nums text-[#1A1A2E]">${r.charge.toFixed(2)}</td>
                          <td className="py-2 pr-3 tabular-nums text-[#555]">{r.rvu > 0 ? r.rvu.toFixed(2) : '—'}</td>
                          <td className="py-2 pr-3 tabular-nums text-[#555]">{r.rvuRate > 0 ? `$${r.rvuRate}` : '—'}</td>
                          <td className="py-2 pr-3 tabular-nums text-[#555]">{r.rvuCount > 0 ? r.rvuCount.toFixed(2) : '—'}</td>
                          <td className="py-2 pr-3 tabular-nums font-medium text-[#1D9E75]">{r.providerPay > 0 ? `$${r.providerPay.toFixed(2)}` : '—'}</td>
                          <td className="py-2 pr-3 tabular-nums font-medium text-[#EF9F27]">{r.cvSplit > 0 ? `$${r.cvSplit.toFixed(2)}` : '—'}</td>
                        </tr>
                      ))}
                      <tr className="bg-[#FAF9F4]">
                        <td colSpan={13} className="py-2 pr-3 text-right text-[11px] font-medium text-[#555] uppercase tracking-wider">Report Totals</td>
                        <td className="py-2 pr-3 tabular-nums font-semibold text-[#1A1A2E]">{filteredProviderRows.reduce((s, r) => s + r.rvuCount, 0).toFixed(2)}</td>
                        <td className="py-2 pr-3 tabular-nums font-semibold text-[#1D9E75]">${filteredProviderRows.reduce((s, r) => s + r.providerPay, 0).toFixed(2)}</td>
                        <td className="py-2 pr-3 tabular-nums font-semibold text-[#EF9F27]">${filteredProviderRows.reduce((s, r) => s + r.cvSplit, 0).toFixed(2)}</td>
                      </tr>
                      <tr className="bg-[#FAF9F4] border-t border-[#E8E8E4]">
                        <td colSpan={14} className="py-2 pr-3 text-right text-[11px] font-medium text-[#555] uppercase tracking-wider">Total Pay for {selectedProvider.name}</td>
                        <td colSpan={2} className="py-2 pr-3 tabular-nums font-semibold text-[15px] text-[#1D9E75]">
                          ${filteredProviderRows.reduce((s, r) => s + r.providerPay + r.cvSplit, 0).toFixed(2)}
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              )}
            </>
          ) : (
            // ────────── Landing view: provider totals ──────────
            <>
              <div className="flex items-center justify-between flex-wrap gap-3 mb-1">
                <h3 className="font-display text-[15px] font-medium text-[#1A1A2E]">Payroll Report</h3>
                <label className="inline-flex items-center gap-1.5 text-[12px] text-[#555]">
                  <input type="checkbox" checked={excludeCancelled} onChange={e => setExcludeCancelled(e.target.checked)} />
                  Exclude cancelled appointments
                </label>
              </div>
              <p className="text-[12px] text-[#999] mb-4">Encounter Date {rangeLabel} — click a provider to see procedure detail and export CSV</p>

              {payrollProviderTotals.length === 0 ? (
                <p className="text-[13px] text-[#999]">No procedure codes recorded in this period.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-[13px]">
                    <thead>
                      <tr className="border-b border-[#E8E8E4]">
                        {['Provider Name', 'Encounters', 'RVU Count', '$ RVU Pay', '$ CV Share', 'Total Pay'].map(h => (
                          <th key={h} className="text-left text-[11px] font-medium text-[#999] uppercase tracking-wider pb-2.5 pr-6 whitespace-nowrap">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[#F1EFE8]">
                      {payrollProviderTotals.map(p => (
                        <tr key={p.id} className="hover:bg-[#FAF9F4] cursor-pointer" onClick={() => setSelectedProviderId(p.id)}>
                          <td className="py-3 pr-6 font-medium text-[#7F77DD] underline whitespace-nowrap">{p.name}</td>
                          <td className="py-3 pr-6 tabular-nums text-[#1A1A2E] text-right">{p.encounters}</td>
                          <td className="py-3 pr-6 tabular-nums text-[#1A1A2E] text-right">{p.totalRvuCount.toFixed(2)}</td>
                          <td className="py-3 pr-6 tabular-nums text-[#1D9E75] text-right">${p.totalRvuPay.toFixed(2)}</td>
                          <td className="py-3 pr-6 tabular-nums text-[#EF9F27] text-right">${p.totalCvSplit.toFixed(2)}</td>
                          <td className="py-3 pr-6 tabular-nums font-semibold text-[#1D9E75] text-right">${p.totalPay.toFixed(2)}</td>
                        </tr>
                      ))}
                      <tr className="bg-[#FAF9F4]">
                        <td className="py-3 pr-6 font-semibold text-[#1A1A2E]">Report Total</td>
                        <td className="py-3 pr-6 tabular-nums font-semibold text-[#1A1A2E] text-right">{payrollGrandTotalEncounters}</td>
                        <td className="py-3 pr-6 tabular-nums font-semibold text-[#1A1A2E] text-right">{payrollGrandTotalRvuCount.toFixed(2)}</td>
                        <td className="py-3 pr-6 tabular-nums font-semibold text-[#1D9E75] text-right">${payrollGrandTotalRvuPay.toFixed(2)}</td>
                        <td className="py-3 pr-6 tabular-nums font-semibold text-[#EF9F27] text-right">${payrollGrandTotalCvSplit.toFixed(2)}</td>
                        <td className="py-3 pr-6 tabular-nums font-semibold text-[#1D9E75] text-right">${payrollGrandTotalPay.toFixed(2)}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </div>

        {/* Monthly bonus leaderboard */}
        <div className="bg-white border border-[#E8E8E4] rounded-xl p-5 shadow-sm">
          <div className="flex items-center gap-2 mb-1">
            <Trophy size={15} color="#EF9F27" />
            <h3 className="font-display text-[15px] font-medium text-[#1A1A2E]">Bonus leaderboard</h3>
          </div>
          <p className="text-[12px] text-[#999] mb-4">Waitlist & broadcast pickups — {rangeLabel}</p>

          {pickupLeaders.length > 0 && (
            <div className="mb-4 p-4 rounded-xl border border-[#EF9F27]/30 bg-[#FFFBF5] flex items-center gap-3">
              <span className="text-2xl">🏆</span>
              <div>
                <div className="font-semibold text-[#1A1A2E] text-[14px]">
                  {pickupLeaders.map(p => p.name).join(' & ')}
                </div>
                <div className="text-[12px] text-[#555] mt-0.5">
                  {maxPickups} pickup{maxPickups !== 1 ? 's' : ''} · {rangeLabel} bonus {pickupLeaders.length > 1 ? 'co-leaders' : 'leader'}
                </div>
              </div>
            </div>
          )}

          {pickupsSorted.length === 0 ? (
            <p className="text-[13px] text-[#999]">No pickups recorded in this period.</p>
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
