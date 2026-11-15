import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { FlaskConical, FileText, Search, RefreshCw, CheckCircle2, Clock, Upload } from 'lucide-react'
import { format, formatDistanceToNowStrict } from 'date-fns'
import { getResults, signResult, acknowledgeResult, type ResultRow, type ResultType, type ResultStatus } from '../../lib/api'

// Pathology inbox + Labs inbox — same component, different type filter
// driven by the URL. Mounted at /admin/results/pathology and
// /admin/results/labs. Sara 2026-11-15 for Direct Dermatology.

type StatusFilter = 'all' | 'pending_review' | 'signed' | 'acknowledged'

const STATUS_LABEL: Record<ResultStatus, string> = {
  pending_review: 'Pending review',
  signed:         'Signed',
  acknowledged:   'Acknowledged',
}

const STATUS_TONE: Record<ResultStatus, string> = {
  pending_review: 'bg-[#FEF3C7] text-[#78350F] border-[#F5B041]',
  signed:         'bg-[#EEEDFE] text-[#3C3489] border-[#AFA9EC]',
  acknowledged:   'bg-[#D1FAE5] text-[#065F46] border-[#A7E3B8]',
}

export function AdminResultsInbox() {
  const { type: urlType } = useParams<{ type: string }>()
  const navigate = useNavigate()

  const type: ResultType = urlType === 'labs' ? 'lab' : 'pathology'
  const label = type === 'pathology' ? 'Pathology' : 'Labs'
  const Icon  = type === 'pathology' ? FlaskConical : FileText

  const [rows, setRows] = useState<ResultRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('pending_review')
  const [search, setSearch] = useState('')
  const [expanded, setExpanded] = useState<string | null>(null)
  const [actionBusy, setActionBusy] = useState<string | null>(null)

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const data = await getResults({ type, limit: 200 })
      setRows(Array.isArray(data) ? data : [])
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load results')
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { void load() }, [type])

  const filtered = useMemo(() => {
    const s = search.trim().toLowerCase()
    return rows.filter(r => {
      if (statusFilter !== 'all' && r.status !== statusFilter) return false
      if (!s) return true
      return [r.patient_name, r.specimen_type, r.specimen_site, r.source_lab, r.test_name]
        .filter(Boolean)
        .some(v => String(v).toLowerCase().includes(s))
    })
  }, [rows, statusFilter, search])

  const counts = useMemo(() => {
    const out: Record<StatusFilter, number> = { all: rows.length, pending_review: 0, signed: 0, acknowledged: 0 }
    for (const r of rows) out[r.status as StatusFilter] = (out[r.status as StatusFilter] ?? 0) + 1
    return out
  }, [rows])

  async function sign(id: string) {
    setActionBusy(id)
    try { await signResult(id) ; await load() }
    catch (e: any) { alert('Sign failed: ' + (e?.message ?? '')) }
    finally { setActionBusy(null) }
  }
  async function acknowledge(id: string, ack_channel?: string) {
    setActionBusy(id)
    try { await acknowledgeResult(id, { ack_channel }) ; await load() }
    catch (e: any) { alert('Acknowledge failed: ' + (e?.message ?? '')) }
    finally { setActionBusy(null) }
  }

  return (
    <div>
      <div className="bg-white border-b border-[#E8E8E4] px-6 py-4 flex items-center justify-between sticky top-0 z-10">
        <div className="flex items-center gap-2.5">
          <Icon size={18} className="text-[#7F77DD]" />
          <div>
            <div className="font-display text-[18px] font-medium text-[#1A1A2E]">{label} inbox</div>
            <div className="text-[12px] text-[#1A1A2E]/70">Review, sign, and acknowledge {type} results.</div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => navigate(`/admin/results/${urlType}/new`)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-[#7F77DD] text-white text-[12px] font-medium rounded-lg hover:bg-[#6B64C8]">
            <Upload size={12} /> Upload {type === 'pathology' ? 'report' : 'result'}
          </button>
          <button onClick={() => void load()}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 border border-[#E8E8E4] text-[12px] font-medium rounded-lg bg-white hover:bg-[#F1EFE8]">
            <RefreshCw size={12} className={loading ? 'animate-spin' : ''} /> Refresh
          </button>
        </div>
      </div>

      <div className="p-6 max-w-5xl space-y-4">
        {/* Status tab strip */}
        <div className="flex items-center gap-1 border-b border-[#E8E8E4]">
          {(['pending_review', 'signed', 'acknowledged', 'all'] as const).map(s => (
            <button key={s}
              onClick={() => setStatusFilter(s)}
              className={`px-3 py-2 text-[12px] font-medium border-b-2 transition-colors ${
                statusFilter === s
                  ? 'border-[#7F77DD] text-[#7F77DD]'
                  : 'border-transparent text-[#1A1A2E]/70 hover:text-[#1A1A2E]'
              }`}>
              {s === 'all' ? 'All' : STATUS_LABEL[s as ResultStatus]}
              <span className="ml-1.5 text-[11px] text-[#1A1A2E]/50">{counts[s] ?? 0}</span>
            </button>
          ))}
        </div>

        <div className="relative">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[#1A1A2E]/40" />
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder={`Search by patient, specimen, source lab${type === 'lab' ? ', test name' : ''}…`}
            className="w-full pl-7 pr-3 py-1.5 text-[12px] border border-[#E8E8E4] rounded-lg bg-white outline-none focus:border-[#7F77DD]"
          />
        </div>

        {error && (
          <div className="text-[12px] text-[#991B1B] bg-[#FCEBEB] border border-[#F5C6C6] px-3 py-2 rounded-lg">{error}</div>
        )}

        {loading && !rows.length && (
          <div className="text-[13px] text-[#1A1A2E]/60 py-12 text-center">Loading…</div>
        )}

        {!loading && filtered.length === 0 && (
          <div className="text-[13px] text-[#1A1A2E]/60 py-12 text-center bg-white rounded-xl border border-[#E8E8E4]">
            {rows.length === 0
              ? `No ${type} results yet. Click "Upload ${type === 'pathology' ? 'report' : 'result'}" to add the first one.`
              : 'No results match your filter.'}
          </div>
        )}

        <div className="space-y-2">
          {filtered.map(r => {
            const isOpen = expanded === r.id
            const received = r.received_at ? formatDistanceToNowStrict(new Date(r.received_at), { addSuffix: true }) : ''
            return (
              <div key={r.id} className="bg-white border border-[#E8E8E4] rounded-xl overflow-hidden">
                <button
                  onClick={() => setExpanded(isOpen ? null : r.id)}
                  className="w-full text-left px-4 py-3 flex items-start justify-between gap-3 hover:bg-[#FAFAF8]">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 mb-1">
                      <div className="text-[14px] font-medium text-[#1A1A2E] truncate">
                        {r.patient_name ?? 'Unknown patient'}
                      </div>
                      <span className={`inline-flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded-full border ${STATUS_TONE[r.status]}`}>
                        {r.status === 'pending_review' && <Clock size={9} />}
                        {r.status === 'signed' && <CheckCircle2 size={9} />}
                        {r.status === 'acknowledged' && <CheckCircle2 size={9} />}
                        {STATUS_LABEL[r.status]}
                      </span>
                    </div>
                    <div className="text-[12px] text-[#1A1A2E]/70 truncate">
                      {type === 'pathology' ? (
                        <>
                          {r.specimen_type ?? 'Specimen'}
                          {r.specimen_site ? ` · ${r.specimen_site}` : ''}
                          {r.source_lab ? ` · ${r.source_lab}` : ''}
                        </>
                      ) : (
                        <>
                          {r.test_name ?? 'Lab test'}
                          {r.result_value ? ` · ${r.result_value}${r.result_unit ? ' ' + r.result_unit : ''}` : ''}
                          {r.abnormal_flag ? ` · ${r.abnormal_flag}` : ''}
                          {r.source_lab ? ` · ${r.source_lab}` : ''}
                        </>
                      )}
                    </div>
                    <div className="text-[11px] text-[#1A1A2E]/50 mt-0.5">
                      Received {received}
                      {r.specimen_date && ` · specimen ${r.specimen_date}`}
                    </div>
                  </div>
                </button>

                {isOpen && (
                  <div className="px-4 py-3 border-t border-[#F1EFE8] bg-[#FAFAF8] space-y-3">
                    {r.report_pdf_url && (
                      <div>
                        <a href={r.report_pdf_url} target="_blank" rel="noopener noreferrer"
                          className="inline-flex items-center gap-1.5 text-[12px] text-[#7F77DD] hover:underline">
                          <FileText size={12} /> Open report PDF
                        </a>
                      </div>
                    )}
                    {r.report_text && (
                      <div className="text-[12px] text-[#1A1A2E] whitespace-pre-wrap bg-white rounded-lg border border-[#E8E8E4] p-3 max-h-64 overflow-y-auto">
                        {r.report_text}
                      </div>
                    )}

                    {/* Pathology-specific fields */}
                    {type === 'pathology' && (r.margins_status || r.breslow_depth_mm || r.clark_level) && (
                      <div className="flex flex-wrap gap-3 text-[12px]">
                        {r.margins_status && <div><span className="text-[#1A1A2E]/60">Margins:</span> <span className="font-medium">{r.margins_status}</span></div>}
                        {r.breslow_depth_mm != null && <div><span className="text-[#1A1A2E]/60">Breslow depth:</span> <span className="font-medium font-mono">{r.breslow_depth_mm} mm</span></div>}
                        {r.clark_level != null && <div><span className="text-[#1A1A2E]/60">Clark level:</span> <span className="font-medium">{r.clark_level}</span></div>}
                      </div>
                    )}

                    {/* Lab-specific fields */}
                    {type === 'lab' && (r.result_value || r.reference_range) && (
                      <div className="flex flex-wrap gap-3 text-[12px]">
                        {r.result_value && <div><span className="text-[#1A1A2E]/60">Value:</span> <span className="font-medium font-mono">{r.result_value}{r.result_unit ? ' ' + r.result_unit : ''}</span></div>}
                        {r.reference_range && <div><span className="text-[#1A1A2E]/60">Reference:</span> <span className="font-mono">{r.reference_range}</span></div>}
                        {r.abnormal_flag && <div><span className="text-[#1A1A2E]/60">Flag:</span> <span className="font-bold text-[#991B1B]">{r.abnormal_flag}</span></div>}
                      </div>
                    )}

                    {r.signed_at && (
                      <div className="text-[11px] text-[#1A1A2E]/60">
                        Signed {format(new Date(r.signed_at), 'MMM d, h:mm a')} by {r.signed_by_name ?? '?'}
                        {r.sign_note ? ` — ${r.sign_note}` : ''}
                      </div>
                    )}
                    {r.acknowledged_at && (
                      <div className="text-[11px] text-[#1A1A2E]/60">
                        Acknowledged to patient {format(new Date(r.acknowledged_at), 'MMM d, h:mm a')}
                        {r.ack_channel ? ` via ${r.ack_channel}` : ''}
                        {r.ack_note ? ` — ${r.ack_note}` : ''}
                      </div>
                    )}

                    <div className="flex items-center gap-2 pt-1">
                      {r.status === 'pending_review' && (
                        <button onClick={() => sign(r.id)} disabled={actionBusy === r.id}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-[#7F77DD] text-white text-[12px] font-medium rounded-lg hover:bg-[#6B64C8] disabled:opacity-50">
                          <CheckCircle2 size={12} /> Sign
                        </button>
                      )}
                      {r.status === 'signed' && (
                        <>
                          <button onClick={() => acknowledge(r.id, 'phone')} disabled={actionBusy === r.id}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 border border-[#E8E8E4] text-[12px] font-medium rounded-lg bg-white hover:bg-[#F1EFE8] disabled:opacity-50">
                            Acknowledged by phone
                          </button>
                          <button onClick={() => acknowledge(r.id, 'email')} disabled={actionBusy === r.id}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 border border-[#E8E8E4] text-[12px] font-medium rounded-lg bg-white hover:bg-[#F1EFE8] disabled:opacity-50">
                            Acknowledged by email
                          </button>
                          <button onClick={() => acknowledge(r.id, 'portal')} disabled={actionBusy === r.id}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 border border-[#E8E8E4] text-[12px] font-medium rounded-lg bg-white hover:bg-[#F1EFE8] disabled:opacity-50">
                            Via portal
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
