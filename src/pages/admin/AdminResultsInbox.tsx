import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { FlaskConical, FileText, Search, RefreshCw, CheckCircle2, Clock, Upload, Edit2 } from 'lucide-react'
import { format, formatDistanceToNowStrict } from 'date-fns'
import {
  getResults, signResult, acknowledgeResult, updateResult,
  getResultDiagnoses,
  type ResultRow, type ResultType, type ResultStatus, type ResultDiagnosisRow,
} from '../../lib/api'

// Pathology inbox + Labs inbox — same component, different type filter
// driven by the URL. Mounted at /results/pathology and
// /results/labs. Sara 2026-11-15 for Direct Dermatology; 2026-11-16
// added diagnosis library + plan field + patient-callback handoff.

type StatusFilter = 'all' | 'pending_review' | 'signed' | 'acknowledged'

const STATUS_LABEL: Record<ResultStatus, string> = {
  pending_review: 'Needs review',
  signed:         'Awaiting patient callback',
  acknowledged:   'Patient notified',
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
  const resourceType = type === 'lab' ? 'lab' : 'pathology'
  const label = type === 'pathology' ? 'Pathology' : 'Labs'
  const Icon  = type === 'pathology' ? FlaskConical : FileText

  const [rows, setRows] = useState<ResultRow[]>([])
  const [diagnoses, setDiagnoses] = useState<ResultDiagnosisRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('pending_review')
  const [search, setSearch] = useState('')
  const [expanded, setExpanded] = useState<string | null>(null)
  const [actionBusy, setActionBusy] = useState<string | null>(null)

  // Per-row draft state for the diagnosis/plan form. Keyed by result id.
  const [draftDxId, setDraftDxId] = useState<Record<string, string>>({})
  const [draftPlan, setDraftPlan] = useState<Record<string, string>>({})
  const [dxSearch, setDxSearch]   = useState<Record<string, string>>({})
  const [editingId, setEditingId] = useState<string | null>(null)

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const [data, dx] = await Promise.all([
        getResults({ type, limit: 200 }),
        getResultDiagnoses({ resource_type: resourceType as 'pathology' | 'lab' }),
      ])
      setRows(Array.isArray(data) ? data : [])
      setDiagnoses(Array.isArray(dx) ? dx : [])
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
      return [r.patient_name, r.specimen_type, r.specimen_site, r.source_lab, r.test_name, r.diagnosis_label, r.plan]
        .filter(Boolean)
        .some(v => String(v).toLowerCase().includes(s))
    })
  }, [rows, statusFilter, search])

  const counts = useMemo(() => {
    const out: Record<StatusFilter, number> = { all: rows.length, pending_review: 0, signed: 0, acknowledged: 0 }
    for (const r of rows) out[r.status as StatusFilter] = (out[r.status as StatusFilter] ?? 0) + 1
    return out
  }, [rows])

  function filteredDiagnoses(rowId: string): ResultDiagnosisRow[] {
    const q = (dxSearch[rowId] ?? '').trim().toLowerCase()
    if (!q) return diagnoses
    return diagnoses.filter(d =>
      d.label.toLowerCase().includes(q) ||
      (d.short_code ?? '').toLowerCase().includes(q)
    )
  }

  async function sign(id: string) {
    const dxId = draftDxId[id]
    const planText = (draftPlan[id] ?? '').trim()
    if (!dxId)      { alert('Pick a diagnosis before signing.'); return }
    if (!planText)  { alert('Enter a plan before signing.'); return }
    setActionBusy(id)
    try { await signResult(id, { diagnosis_id: dxId, plan: planText }) ; await load() }
    catch (e: any) { alert('Sign failed: ' + (e?.message ?? '')) }
    finally { setActionBusy(null) }
  }
  async function savePlanEdit(id: string) {
    const dxId = draftDxId[id]
    const planText = (draftPlan[id] ?? '').trim()
    if (!dxId || !planText) { alert('Diagnosis and plan are both required.'); return }
    setActionBusy(id)
    try {
      await updateResult(id, { diagnosis_id: dxId, plan: planText } as any)
      setEditingId(null)
      await load()
    } catch (e: any) { alert('Save failed: ' + (e?.message ?? '')) }
    finally { setActionBusy(null) }
  }
  async function acknowledge(id: string, ack_channel?: string) {
    setActionBusy(id)
    try { await acknowledgeResult(id, { ack_channel }) ; await load() }
    catch (e: any) { alert('Mark notified failed: ' + (e?.message ?? '')) }
    finally { setActionBusy(null) }
  }

  // Seed the draft form when a row is expanded for the first time.
  function toggleExpand(r: ResultRow) {
    const next = expanded === r.id ? null : r.id
    setExpanded(next)
    if (next && draftDxId[r.id] === undefined) {
      setDraftDxId(d => ({ ...d, [r.id]: r.diagnosis_id ?? '' }))
      setDraftPlan(d => ({ ...d, [r.id]: r.plan ?? '' }))
    }
  }

  return (
    <div>
      <div className="bg-white border-b border-[#E8E8E4] px-6 py-4 flex items-center justify-between sticky top-0 z-10">
        <div className="flex items-center gap-2.5">
          <Icon size={18} className="text-[#7F77DD]" />
          <div>
            <div className="font-display text-[18px] font-medium text-[#1A1A2E]">{label} inbox</div>
            <div className="text-[12px] text-[#1A1A2E]/70">Review results, pick a diagnosis + plan, send to Patient Callbacks.</div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => navigate(`/results/${urlType}/new`)}
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
            placeholder={`Search by patient, diagnosis, plan, specimen${type === 'lab' ? ', test name' : ''}…`}
            className="w-full pl-7 pr-3 py-1.5 text-[12px] border border-[#E8E8E4] rounded-lg bg-white outline-none focus:border-[#7F77DD]"
          />
        </div>

        {error && (
          <div className="text-[12px] text-[#991B1B] bg-[#FCEBEB] border border-[#F5C6C6] px-3 py-2 rounded-lg">{error}</div>
        )}

        {diagnoses.length === 0 && !loading && (
          <div className="text-[12px] text-[#78350F] bg-[#FEF3C7] border border-[#F5B041] px-3 py-2 rounded-lg">
            Your diagnosis library is empty. Set up common {type} diagnoses first — <button className="underline" onClick={() => navigate('/admin/diagnosis-library')}>open library</button>.
          </div>
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
            const canEditPlan = editingId === r.id || r.status === 'pending_review'
            return (
              <div key={r.id} className="bg-white border border-[#E8E8E4] rounded-xl overflow-hidden">
                <button
                  onClick={() => toggleExpand(r)}
                  className="w-full text-left px-4 py-3 flex items-start justify-between gap-3 hover:bg-[#FAFAF8]">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 mb-1 flex-wrap">
                      <div className="text-[14px] font-medium text-[#1A1A2E] truncate">
                        {r.patient_name ?? 'Unknown patient'}
                      </div>
                      <span className={`inline-flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded-full border ${STATUS_TONE[r.status]}`}>
                        {r.status === 'pending_review' && <Clock size={9} />}
                        {r.status === 'signed' && <CheckCircle2 size={9} />}
                        {r.status === 'acknowledged' && <CheckCircle2 size={9} />}
                        {STATUS_LABEL[r.status]}
                      </span>
                      {r.diagnosis_label && (
                        <span className="text-[11px] font-medium text-[#3C3489] bg-[#EEEDFE] border border-[#AFA9EC] rounded-full px-2 py-0.5">
                          {r.diagnosis_label}
                        </span>
                      )}
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

                    {/* Diagnosis + plan form (needs-review OR editing) */}
                    {canEditPlan ? (
                      <div className="space-y-2 bg-white border border-[#E8E8E4] rounded-lg p-3">
                        <div>
                          <label className="block text-[11px] font-semibold text-[#1A1A2E] uppercase tracking-wide mb-1">Diagnosis</label>
                          <input
                            type="text"
                            value={dxSearch[r.id] ?? (draftDxId[r.id] ? (diagnoses.find(d => d.id === draftDxId[r.id])?.label ?? '') : '')}
                            onChange={e => {
                              setDxSearch(d => ({ ...d, [r.id]: e.target.value }))
                              setDraftDxId(d => ({ ...d, [r.id]: '' }))
                            }}
                            placeholder="Start typing to filter the library…"
                            className="w-full px-2.5 py-1.5 text-[12px] border border-[#E8E8E4] rounded-lg bg-white outline-none focus:border-[#7F77DD]"
                          />
                          {(dxSearch[r.id] ?? '').trim() && !draftDxId[r.id] && (
                            <div className="mt-1 max-h-48 overflow-y-auto border border-[#E8E8E4] rounded-lg bg-white">
                              {filteredDiagnoses(r.id).slice(0, 25).map(d => (
                                <button key={d.id}
                                  onClick={() => {
                                    setDraftDxId(x => ({ ...x, [r.id]: d.id }))
                                    setDxSearch(x => ({ ...x, [r.id]: d.label }))
                                  }}
                                  className="w-full text-left px-2.5 py-1.5 text-[12px] hover:bg-[#F1EFE8] border-b border-[#F1EFE8] last:border-b-0">
                                  {d.label}
                                  {d.short_code && <span className="ml-2 text-[10px] text-[#1A1A2E]/50 font-mono">{d.short_code}</span>}
                                </button>
                              ))}
                              {filteredDiagnoses(r.id).length === 0 && (
                                <div className="px-2.5 py-2 text-[11px] text-[#1A1A2E]/60">No matches. <button className="underline" onClick={() => navigate('/admin/diagnosis-library')}>Add to library</button></div>
                              )}
                            </div>
                          )}
                        </div>
                        <div>
                          <label className="block text-[11px] font-semibold text-[#1A1A2E] uppercase tracking-wide mb-1">Plan</label>
                          <textarea
                            value={draftPlan[r.id] ?? ''}
                            onChange={e => setDraftPlan(d => ({ ...d, [r.id]: e.target.value }))}
                            rows={3}
                            placeholder="e.g. Call to schedule Mohs; reassure; repeat in 3 months…"
                            className="w-full px-2.5 py-1.5 text-[12px] border border-[#E8E8E4] rounded-lg bg-white outline-none focus:border-[#7F77DD] resize-none"
                          />
                        </div>
                        <div className="flex items-center gap-2 pt-1">
                          {r.status === 'pending_review' ? (
                            <button onClick={() => sign(r.id)} disabled={actionBusy === r.id}
                              className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-[#7F77DD] text-white text-[12px] font-medium rounded-lg hover:bg-[#6B64C8] disabled:opacity-50">
                              <CheckCircle2 size={12} /> Save & send to callbacks
                            </button>
                          ) : (
                            <>
                              <button onClick={() => savePlanEdit(r.id)} disabled={actionBusy === r.id}
                                className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-[#7F77DD] text-white text-[12px] font-medium rounded-lg hover:bg-[#6B64C8] disabled:opacity-50">
                                <CheckCircle2 size={12} /> Save changes
                              </button>
                              <button onClick={() => { setEditingId(null); setDraftDxId(d => ({ ...d, [r.id]: r.diagnosis_id ?? '' })); setDraftPlan(d => ({ ...d, [r.id]: r.plan ?? '' })); setDxSearch(d => ({ ...d, [r.id]: '' })) }}
                                className="inline-flex items-center gap-1.5 px-3 py-1.5 border border-[#E8E8E4] text-[12px] font-medium rounded-lg bg-white hover:bg-[#F1EFE8]">
                                Cancel
                              </button>
                            </>
                          )}
                        </div>
                      </div>
                    ) : (
                      // Already signed — show the recorded diagnosis + plan with an Edit affordance.
                      <div className="bg-white border border-[#E8E8E4] rounded-lg p-3 space-y-2">
                        <div className="flex items-start justify-between gap-2">
                          <div className="flex-1 min-w-0">
                            <div className="text-[11px] font-semibold text-[#1A1A2E] uppercase tracking-wide mb-0.5">Diagnosis</div>
                            <div className="text-[13px] text-[#1A1A2E]">{r.diagnosis_label ?? '—'}</div>
                          </div>
                          <button onClick={() => setEditingId(r.id)}
                            className="inline-flex items-center gap-1 text-[11px] text-[#7F77DD] hover:underline">
                            <Edit2 size={10} /> Edit
                          </button>
                        </div>
                        <div>
                          <div className="text-[11px] font-semibold text-[#1A1A2E] uppercase tracking-wide mb-0.5">Plan</div>
                          <div className="text-[13px] text-[#1A1A2E] whitespace-pre-wrap">{r.plan ?? '—'}</div>
                        </div>
                      </div>
                    )}

                    {r.signed_at && (
                      <div className="text-[11px] text-[#1A1A2E]/60">
                        Reviewed {format(new Date(r.signed_at), 'MMM d, h:mm a')} by {r.signed_by_name ?? '?'}
                      </div>
                    )}
                    {r.acknowledged_at && (
                      <div className="text-[11px] text-[#1A1A2E]/60">
                        Patient notified {format(new Date(r.acknowledged_at), 'MMM d, h:mm a')}
                        {r.ack_channel ? ` via ${r.ack_channel}` : ''}
                        {r.ack_note ? ` — ${r.ack_note}` : ''}
                      </div>
                    )}

                    {/* Mark-notified shortcut on the inbox too (fast path).
                        The Patient Callbacks queue is the primary mark-
                        notified surface, but this lets the provider mark
                        a quick phone call done without jumping tabs. */}
                    {r.status === 'signed' && (
                      <div className="flex items-center gap-2 pt-1">
                        <div className="text-[11px] font-semibold text-[#1A1A2E]/60 uppercase tracking-wide">Patient notified via</div>
                        <button onClick={() => acknowledge(r.id, 'phone')} disabled={actionBusy === r.id}
                          className="inline-flex items-center gap-1 px-2.5 py-1 border border-[#E8E8E4] text-[11px] font-medium rounded-lg bg-white hover:bg-[#F1EFE8] disabled:opacity-50">
                          Phone
                        </button>
                        <button onClick={() => acknowledge(r.id, 'email')} disabled={actionBusy === r.id}
                          className="inline-flex items-center gap-1 px-2.5 py-1 border border-[#E8E8E4] text-[11px] font-medium rounded-lg bg-white hover:bg-[#F1EFE8] disabled:opacity-50">
                          Email
                        </button>
                        <button onClick={() => acknowledge(r.id, 'portal')} disabled={actionBusy === r.id}
                          className="inline-flex items-center gap-1 px-2.5 py-1 border border-[#E8E8E4] text-[11px] font-medium rounded-lg bg-white hover:bg-[#F1EFE8] disabled:opacity-50">
                          Portal
                        </button>
                      </div>
                    )}
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
