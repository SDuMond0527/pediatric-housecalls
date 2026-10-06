import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { format } from 'date-fns'
import {
  Search, RefreshCw, FileText, Send, Receipt, DollarSign, CheckCircle2,
  AlertCircle, Zap, Ban, ChevronDown, ChevronUp,
} from 'lucide-react'
import { getClaimAudit, type ClaimAuditRow, type ClaimAuditEventType } from '../../lib/api'
import { ChartNumberPill } from '../../components/ChartNumberPill'

/**
 * Claim audit log — one card per claim, each with a chronological
 * event timeline covering every lifecycle step the system tracks
 * (created, submitted, rejection, ERA, resubmit, patient statement
 * generated/sent/paid/written-off).
 *
 * Replaces the previous PHI-access audit log at /admin/audit-log per
 * Sara 2026-10-06. The underlying phi_audit_log table is still
 * populated for compliance; just not surfaced in the admin UI anymore.
 */

function fmtDate(v: string | null | undefined): string {
  if (!v) return '—'
  try {
    const [y, m, d] = String(v).split('T')[0].split('-').map(Number)
    return format(new Date(y, m - 1, d), 'MMM d, yyyy')
  } catch { return String(v) }
}
function fmtDateTime(v: string | null | undefined): string {
  if (!v) return '—'
  try { return format(new Date(v), 'MMM d, yyyy h:mm a') } catch { return String(v) }
}
function fmtMoney(v: number | string | null | undefined): string {
  if (v == null || v === '') return '—'
  const n = typeof v === 'number' ? v : parseFloat(v)
  if (!isFinite(n)) return '—'
  return '$' + n.toFixed(2)
}

const EVENT_META: Record<ClaimAuditEventType, { icon: typeof FileText; color: string; bg: string }> = {
  created:               { icon: FileText,    color: '#4C1D95', bg: '#EEEDFE' },
  submitted:             { icon: Send,        color: '#2D7BA6', bg: '#EEF6FB' },
  rejection:             { icon: AlertCircle, color: '#991B1B', bg: '#FEE2E2' },
  era_received:          { icon: Zap,         color: '#085041', bg: '#E1F5EE' },
  resubmit:              { icon: RefreshCw,   color: '#B45309', bg: '#FEF3C7' },
  reopened:              { icon: RefreshCw,   color: '#4C1D95', bg: '#EEEDFE' },
  rework_resolved:       { icon: CheckCircle2,color: '#085041', bg: '#E1F5EE' },
  written_off:           { icon: Ban,         color: '#555',    bg: '#F1EFE8' },
  statement_created:     { icon: Receipt,     color: '#7F77DD', bg: '#F5F4FE' },
  statement_sent:        { icon: Send,        color: '#2D7BA6', bg: '#EEF6FB' },
  statement_paid:        { icon: DollarSign,  color: '#085041', bg: '#E1F5EE' },
  statement_written_off: { icon: Ban,         color: '#555',    bg: '#F1EFE8' },
  activity:              { icon: FileText,    color: '#555',    bg: '#FAFAF8' },
}

export function AdminAuditLog() {
  const [rows, setRows] = useState<ClaimAuditRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  async function load() {
    setLoading(true); setError(null)
    try {
      const data = await getClaimAudit({ search: search.trim() || undefined, limit: 200 })
      setRows(data ?? [])
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load claim audit')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() /* eslint-disable-next-line */ }, [])

  // Debounce search so typing doesn't fire a fetch on every keystroke.
  useEffect(() => {
    const t = setTimeout(() => { load() }, 300)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search])

  const stats = useMemo(() => {
    const total = rows.length
    const paid = rows.filter(r => r.events.some(e => e.type === 'statement_paid')).length
    const rejected = rows.filter(r => r.events.some(e => e.type === 'rejection')).length
    const inFlight = rows.filter(r => r.events.some(e => e.type === 'submitted') && !r.events.some(e => e.type === 'era_received' || e.type === 'rejection')).length
    return { total, paid, rejected, inFlight }
  }, [rows])

  function toggleCard(id: string) {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  return (
    <div>
      <div className="bg-white border-b border-[#E8E8E4] px-6 py-4 sticky top-0 z-10">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div>
            <div className="font-display text-[18px] font-medium text-[#1A1A2E]">Claim audit log</div>
            <div className="text-[12px] text-[#1A1A2E] mt-0.5">
              Every lifecycle event for every claim — created, submitted, rejected, ERA'd, resubmitted, statement sent/paid. Click a card to see the full timeline.
            </div>
          </div>
          <div className="flex items-center gap-4 text-[12px]">
            <span className="text-[#555]">{stats.total} claim{stats.total === 1 ? '' : 's'}</span>
            <span className="text-[#2D7BA6]">{stats.inFlight} in flight</span>
            <span className="text-[#085041]">{stats.paid} paid</span>
            {stats.rejected > 0 && <span className="text-[#991B1B]">{stats.rejected} rejected</span>}
            <button onClick={load} className="flex items-center gap-1 text-[#1A1A2E] hover:text-[#7F77DD]">
              <RefreshCw size={12} /> Refresh
            </button>
          </div>
        </div>
      </div>

      <div className="p-6 max-w-6xl space-y-3">
        <div className="relative">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#999]" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search by patient name, chart number, or PCN…"
            className="w-full pl-9 pr-3 py-2 text-[13px] border border-[#E8E8E4] rounded-lg focus:outline-none focus:ring-2 focus:ring-[#7F77DD]/30"
          />
        </div>

        {error && (
          <div className="text-[13px] text-red-500 bg-red-50 border border-red-200 rounded-xl px-4 py-3">{error}</div>
        )}

        {loading && rows.length === 0 ? (
          <div className="text-center py-12 text-[13px] text-[#1A1A2E]">Loading…</div>
        ) : rows.length === 0 ? (
          <div className="bg-white border border-[#E8E8E4] rounded-xl p-10 text-center text-[13px] text-[#1A1A2E]">
            {search ? 'No claims match your search.' : 'No claims yet.'}
          </div>
        ) : (
          <div className="space-y-2">
            {rows.map(r => {
              const isOpen = expanded.has(r.claim_id)
              const latestEvent = r.events[r.events.length - 1]
              return (
                <div key={r.claim_id} className="bg-white border border-[#E8E8E4] rounded-xl overflow-hidden">
                  <button
                    className="w-full p-4 text-left hover:bg-[#FAFAF8] transition-colors"
                    onClick={() => toggleCard(r.claim_id)}
                  >
                    <div className="flex items-start justify-between gap-4">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <Link
                            to={`/admin/claims#claim-card-${r.claim_id}`}
                            onClick={e => e.stopPropagation()}
                            className="text-[14px] font-medium text-[#1A1A2E] hover:underline"
                          >
                            {r.patient_name}
                          </Link>
                          <ChartNumberPill value={r.chart_number} />
                          <span className="text-[12px] text-[#555]">PCN {r.pcn ?? '—'}</span>
                          <span className="text-[12px] text-[#555]">· DOS {fmtDate(r.service_date)}</span>
                        </div>
                        <div className="text-[12px] text-[#555] mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
                          <span>{r.payer_name ?? '—'}</span>
                          <span>· {fmtMoney(r.total_charge)}</span>
                          {latestEvent && (
                            <span>· Last activity: {latestEvent.label} ({fmtDateTime(latestEvent.at)})</span>
                          )}
                          <span>· {r.events.length} event{r.events.length === 1 ? '' : 's'}</span>
                        </div>
                      </div>
                      <div className="flex-shrink-0 text-[#555]">
                        {isOpen ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                      </div>
                    </div>
                  </button>

                  {isOpen && (
                    <div className="border-t border-[#E8E8E4] bg-[#FAFAF8] p-4">
                      {r.events.length === 0 ? (
                        <div className="text-[12px] text-[#555]">No tracked events on this claim.</div>
                      ) : (
                        <ol className="space-y-2">
                          {r.events.map((e, i) => {
                            const meta = EVENT_META[e.type] ?? EVENT_META.activity
                            const Icon = meta.icon
                            return (
                              <li key={i} className="flex items-start gap-3">
                                <span
                                  className="flex-shrink-0 inline-flex items-center justify-center rounded-full"
                                  style={{ width: 24, height: 24, backgroundColor: meta.bg, color: meta.color }}
                                >
                                  <Icon size={12} />
                                </span>
                                <div className="min-w-0 flex-1 pt-0.5">
                                  <div className="text-[13px] font-medium text-[#1A1A2E]">
                                    {e.label}
                                    <span className="ml-2 text-[11px] font-normal text-[#555]">{fmtDateTime(e.at)}</span>
                                    {e.by && <span className="ml-2 text-[11px] font-normal text-[#777]">· {e.by}</span>}
                                  </div>
                                  {e.detail && (
                                    <div className="text-[12px] text-[#555] mt-0.5 whitespace-pre-wrap break-words">
                                      {e.detail}
                                    </div>
                                  )}
                                </div>
                              </li>
                            )
                          })}
                        </ol>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
