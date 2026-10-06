import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { format } from 'date-fns'
import { FileText, Download, Search, CheckCircle2, AlertTriangle, Stethoscope, Users } from 'lucide-react'
import { getAdminSchoolNotes, type SchoolNoteRow } from '../../lib/api'
import { ChartNumberPill } from '../../components/ChartNumberPill'

function fmtDate(v: string | null | undefined, fallback = '—'): string {
  if (!v) return fallback
  try { return format(new Date(v), 'MMM d, yyyy') } catch { return v }
}
function fmtDateTime(v: string | null | undefined, fallback = '—'): string {
  if (!v) return fallback
  try { return format(new Date(v), 'MMM d, yyyy · h:mm a') } catch { return v }
}

/**
 * Admin audit list of every automated school note the system has
 * generated and sent. Added 2026-10-05 after Sara green-lit the
 * fully-automated school-note flow (previously Pam composed each
 * one by hand).
 */
export function AdminSchoolNotes() {
  const [rows, setRows] = useState<SchoolNoteRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')

  useEffect(() => {
    getAdminSchoolNotes()
      .then(data => setRows(data ?? []))
      .catch(e => setError(e?.message ?? 'Failed to load school notes'))
      .finally(() => setLoading(false))
  }, [])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return rows
    return rows.filter(r => {
      const name = `${r.child_first_name ?? ''} ${r.child_last_name ?? ''}`.toLowerCase()
      return (
        name.includes(q) ||
        (r.sent_to_email ?? '').toLowerCase().includes(q) ||
        (r.excuse_dates_text ?? '').toLowerCase().includes(q) ||
        (r.parent_additional_notes ?? '').toLowerCase().includes(q) ||
        (r.rendering_provider_name ?? '').toLowerCase().includes(q) ||
        (r.requested_by_provider_name ?? '').toLowerCase().includes(q)
      )
    })
  }, [rows, search])

  async function downloadPdf(url: string, filename: string) {
    try {
      const r = await fetch(url)
      const blob = await r.blob()
      const objUrl = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = objUrl; a.download = filename; a.click()
      URL.revokeObjectURL(objUrl)
    } catch {
      window.open(url, '_blank')
    }
  }

  const sentCount = rows.filter(r => r.status === 'sent').length
  const failedCount = rows.filter(r => r.status === 'send_failed').length

  return (
    <div>
      <div className="bg-white border-b border-[#E8E8E4] px-6 py-4 sticky top-0 z-10 flex items-center justify-between">
        <div>
          <div className="font-display text-[18px] font-medium text-[#1A1A2E]">School notes</div>
          <div className="text-[12px] text-[#1A1A2E] mt-0.5">
            Every school absence note the system has issued, newest first. Fully automated — no manual composition.
          </div>
        </div>
        <div className="flex items-center gap-4 text-[12px]">
          <div className="flex items-center gap-1.5 text-[#1D9E75]">
            <CheckCircle2 size={14} /> <span className="font-medium">{sentCount}</span> sent
          </div>
          {failedCount > 0 && (
            <div className="flex items-center gap-1.5 text-[#B91C1C]">
              <AlertTriangle size={14} /> <span className="font-medium">{failedCount}</span> failed
            </div>
          )}
          <div className="text-[#555]">{rows.length} total</div>
        </div>
      </div>

      <div className="p-6 max-w-6xl space-y-4">
        <div className="relative">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#999]" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search by patient, email, dates, parent notes, or provider…"
            className="w-full pl-9 pr-3 py-2 text-[13px] border border-[#E8E8E4] rounded-lg focus:outline-none focus:ring-2 focus:ring-[#7F77DD]/30"
          />
        </div>

        {loading ? (
          <div className="text-center py-12 text-[13px] text-[#1A1A2E]">Loading…</div>
        ) : error ? (
          <div className="text-[13px] text-red-500 bg-red-50 border border-red-200 rounded-xl px-4 py-3">{error}</div>
        ) : filtered.length === 0 ? (
          <div className="bg-white border border-[#E8E8E4] rounded-xl p-10 text-center text-[13px] text-[#1A1A2E]">
            {rows.length === 0 ? 'No school notes issued yet.' : 'No notes match your search.'}
          </div>
        ) : (
          <div className="space-y-2">
            {filtered.map(r => {
              const name = [r.child_first_name, r.child_last_name].filter(Boolean).join(' ') || 'Unknown patient'
              const sendFailed = r.status === 'send_failed'
              return (
                <div key={r.id} className="bg-white border border-[#E8E8E4] rounded-xl p-4 shadow-sm">
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <Link to={`/admin/chart/${r.child_id}`} className="text-[14px] font-medium text-[#1A1A2E] hover:underline">
                          {name}
                        </Link>
                        <ChartNumberPill value={r.chart_number != null ? String(r.chart_number) : null} />
                        {sendFailed ? (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-[#FEE2E2] text-[#991B1B] text-[10px] rounded-full font-semibold">
                            <AlertTriangle size={10} /> EMAIL FAILED
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-[#E1F5EE] text-[#085041] text-[10px] rounded-full font-semibold">
                            <CheckCircle2 size={10} /> SENT
                          </span>
                        )}
                        {/* Source badge — distinguish provider-initiated
                            (via the School note button in the encounter note
                            modal) from family-initiated (via the parent's
                            post-visit email link). Sara 2026-10-06. */}
                        {r.source === 'provider' ? (
                          <span
                            className="inline-flex items-center gap-1 px-2 py-0.5 bg-[#EEEDFE] text-[#4C1D95] text-[10px] rounded-full font-semibold"
                            title={r.requested_by_provider_name
                              ? `Provider-initiated by ${r.requested_by_provider_name}`
                              : 'Provider-initiated from the encounter note'}>
                            <Stethoscope size={10} /> PROVIDER
                          </span>
                        ) : (
                          <span
                            className="inline-flex items-center gap-1 px-2 py-0.5 bg-[#EEF6FB] text-[#2D7BA6] text-[10px] rounded-full font-semibold"
                            title={r.requested_by_name
                              ? `Family-initiated by ${r.requested_by_name}`
                              : 'Family-initiated from the post-visit email link'}>
                            <Users size={10} /> FAMILY
                          </span>
                        )}
                      </div>

                      <div className="text-[12px] text-[#555] mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
                        <span>Visit: {fmtDate(r.visit_date)}{r.visit_type ? ` · ${r.visit_type}` : ''}</span>
                        <span>Issued {fmtDateTime(r.sent_at ?? r.created_at)}</span>
                        {r.rendering_provider_name && <span>Signed by {r.rendering_provider_name}</span>}
                        {r.source === 'provider' && r.requested_by_provider_name && (
                          <span>Requested by {r.requested_by_provider_name}</span>
                        )}
                        {r.sent_to_email && <span>→ {r.sent_to_email}</span>}
                      </div>

                      <div className="mt-2 text-[12px] text-[#1A1A2E]">
                        <span className="text-[#555]">Dates excused: </span>
                        <span className="font-medium">{r.excuse_dates_text}</span>
                      </div>

                      {r.parent_additional_notes && (
                        <div className="mt-2 bg-[#FAFAF8] border border-[#E8E8E4] rounded-md p-2 text-[12px] text-[#1A1A2E]">
                          <div className="text-[10px] font-semibold text-[#555] uppercase tracking-wider mb-1">
                            {r.source === 'provider' ? 'Additional information' : 'Parent-provided additional notes'}
                          </div>
                          <div className="whitespace-pre-wrap italic">{r.parent_additional_notes}</div>
                        </div>
                      )}
                    </div>

                    <div className="flex-shrink-0 flex flex-col gap-1.5">
                      <button
                        onClick={() => downloadPdf(r.blob_url, r.filename)}
                        className="flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-medium text-[#5B54B5] border border-[#7F77DD] rounded-lg hover:bg-[#7F77DD]/10"
                      >
                        <Download size={13} /> Download PDF
                      </button>
                      <a
                        href={r.blob_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-medium text-[#555] border border-[#E8E8E4] rounded-lg hover:bg-[#F1EFE8]"
                      >
                        <FileText size={13} /> Preview
                      </a>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
