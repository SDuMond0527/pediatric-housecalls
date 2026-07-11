import { useEffect, useState } from 'react'
import { apiFetch } from '../../lib/api'
import { format } from 'date-fns'
import { ShieldCheck, Search, RefreshCw } from 'lucide-react'

interface AuditRow {
  id: string
  action: string
  resource_type: string
  resource_id: string | null
  created_at: string
  provider_name: string
  provider_role: string
}

const ACTION_LABELS: Record<string, string> = {
  view_patient: 'Viewed patient chart',
  view_encounter_note: 'Opened encounter note',
}

const DAYS_OPTIONS = [
  { label: 'Last 7 days',  value: '7' },
  { label: 'Last 30 days', value: '30' },
  { label: 'Last 90 days', value: '90' },
]

export function AdminAuditLog() {
  const [rows, setRows] = useState<AuditRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [days, setDays] = useState('30')
  const [search, setSearch] = useState('')

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const data = await apiFetch<AuditRow[]>(`/api/audit-log?days=${days}&limit=500`)
      setRows(data)
    } catch (e: any) {
      setError(e.message || 'Failed to load audit log')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [days])

  const filtered = rows.filter(r => {
    if (!search) return true
    const q = search.toLowerCase()
    return (
      r.provider_name.toLowerCase().includes(q) ||
      r.action.toLowerCase().includes(q) ||
      r.resource_type.toLowerCase().includes(q) ||
      (r.resource_id ?? '').toLowerCase().includes(q)
    )
  })

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <div className="flex items-center gap-3 mb-6">
        <div className="w-9 h-9 rounded-xl bg-[#7F77DD]/10 flex items-center justify-center">
          <ShieldCheck size={18} className="text-[#7F77DD]" />
        </div>
        <div>
          <h1 className="font-display text-xl font-semibold text-[#1A1A2E]">PHI Audit Log</h1>
          <p className="text-[12px] text-[#999] mt-0.5">HIPAA access log — all patient data views recorded here</p>
        </div>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3 mb-5">
        <div className="flex rounded-lg border border-[#E8E8E4] overflow-hidden bg-white">
          {DAYS_OPTIONS.map(opt => (
            <button
              key={opt.value}
              onClick={() => setDays(opt.value)}
              className={`px-3 py-2 text-[12px] font-medium transition-all ${
                days === opt.value
                  ? 'bg-[#7F77DD] text-white'
                  : 'text-[#666] hover:bg-[#F1EFE8]'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>

        <div className="relative flex-1 max-w-xs">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[#999]" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Filter by provider or action…"
            className="w-full pl-8 pr-3 py-2 text-[13px] border border-[#E8E8E4] rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-[#7F77DD]/30"
          />
        </div>

        <button
          onClick={load}
          disabled={loading}
          className="flex items-center gap-1.5 px-3 py-2 text-[12px] font-medium text-[#666] border border-[#E8E8E4] rounded-lg bg-white hover:bg-[#F1EFE8] transition-all disabled:opacity-50"
        >
          <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
          Refresh
        </button>
      </div>

      {/* Summary bar */}
      {!loading && !error && (
        <div className="text-[12px] text-[#999] mb-3">
          {filtered.length} {filtered.length === 1 ? 'entry' : 'entries'}
          {search ? ` matching "${search}"` : ''} — {DAYS_OPTIONS.find(o => o.value === days)?.label.toLowerCase()}
        </div>
      )}

      {/* Table */}
      <div className="bg-white border border-[#E8E8E4] rounded-xl overflow-hidden shadow-sm">
        {loading ? (
          <div className="flex items-center justify-center h-48 text-[13px] text-[#999]">Loading…</div>
        ) : error ? (
          <div className="flex items-center justify-center h-48 text-[13px] text-red-500">{error}</div>
        ) : filtered.length === 0 ? (
          <div className="flex items-center justify-center h-48 text-[13px] text-[#999]">No audit entries found</div>
        ) : (
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-b border-[#E8E8E4] bg-[#FAFAF8]">
                <th className="text-left px-4 py-3 text-[11px] font-semibold text-[#999] uppercase tracking-wide">Timestamp</th>
                <th className="text-left px-4 py-3 text-[11px] font-semibold text-[#999] uppercase tracking-wide">Provider</th>
                <th className="text-left px-4 py-3 text-[11px] font-semibold text-[#999] uppercase tracking-wide">Action</th>
                <th className="text-left px-4 py-3 text-[11px] font-semibold text-[#999] uppercase tracking-wide">Resource</th>
                <th className="text-left px-4 py-3 text-[11px] font-semibold text-[#999] uppercase tracking-wide">ID</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#F1EFE8]">
              {filtered.map(row => (
                <tr key={row.id} className="hover:bg-[#FAFAF8] transition-colors">
                  <td className="px-4 py-3 text-[#999] tabular-nums whitespace-nowrap">
                    {format(new Date(row.created_at), 'MMM d, yyyy h:mm a')}
                  </td>
                  <td className="px-4 py-3">
                    <span className="font-medium text-[#1A1A2E]">{row.provider_name}</span>
                    <span className="ml-1.5 text-[11px] text-[#999]">{row.provider_role}</span>
                  </td>
                  <td className="px-4 py-3 text-[#444]">
                    {ACTION_LABELS[row.action] ?? row.action}
                  </td>
                  <td className="px-4 py-3">
                    <span className="px-2 py-0.5 rounded-full text-[11px] font-medium bg-[#F1EFE8] text-[#666]">
                      {row.resource_type}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-[#999] font-mono text-[11px] truncate max-w-[160px]">
                    {row.resource_id ?? '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
