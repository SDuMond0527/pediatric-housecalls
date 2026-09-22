import { useEffect, useState } from 'react'
import { format } from 'date-fns'
import { RefreshCw, Check, X, Ban, FileText, Receipt } from 'lucide-react'
import { getPendingWriteOffs, reviewPatientStatementWriteOff, reviewClaimWriteOff, invokeNotifications } from '../../lib/api'
import { ChartNumberPill } from '../../components/ChartNumberPill'

const REASON_LABEL: Record<string, string> = {
  bad_debt:       'Bad debt',
  small_balance:  'Small balance',
  hardship:       'Courtesy / hardship',
  billing_error:  'Billing error',
  timely_filing:  'Timely filing exceeded',
  other:          'Other',
}

function fmtMoney(n: any) {
  const v = parseFloat(String(n ?? 0))
  return isNaN(v) ? '$0.00' : `$${v.toFixed(2)}`
}
function fmtDate(d: string | null | undefined) {
  if (!d) return '—'
  try {
    const s = String(d).split('T')[0]
    const [y, m, day] = s.split('-').map(Number)
    return format(new Date(y, m - 1, day), 'MMM d, yyyy')
  } catch { return d ?? '—' }
}
function fmtDateTime(d: string | null | undefined) {
  if (!d) return '—'
  try { return format(new Date(d), 'MMM d, h:mm a') } catch { return d ?? '—' }
}

type Request = {
  side: 'statement' | 'claim'
  id: string
  reason: string | null
  note: string | null
  requested_at: string
  requested_by_name: string | null
  amount: string | number
  payer_name: string | null
  patient_first_name: string | null
  patient_last_name: string | null
  chart_number: string | null
  service_date: string | null
}

export function AdminPendingWriteOffs() {
  const [data, setData] = useState<{ statements: Request[]; claims: Request[]; total: number } | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [reviewing, setReviewing] = useState<string | null>(null)
  const [denyNoteOpen, setDenyNoteOpen] = useState<string | null>(null)
  const [denyNote, setDenyNote] = useState('')

  async function load() {
    setLoading(true); setError(null)
    try { setData(await getPendingWriteOffs()) }
    catch (e: any) { setError(e?.message ?? 'Failed to load pending write-offs') }
    finally { setLoading(false) }
  }
  useEffect(() => { load() }, [])

  async function approve(r: Request) {
    setReviewing(r.id)
    try {
      if (r.side === 'statement') await reviewPatientStatementWriteOff(r.id, { approved: true })
      else                        await reviewClaimWriteOff(r.id, { approved: true })
      // Non-blocking: the requester gets a "your write-off was approved" email so
      // they have a feedback loop; before this the request just vanished from the queue.
      invokeNotifications({ type: 'write_off_reviewed', side: r.side, recordId: r.id, approved: true })
        .catch(err => console.error('[write-off approved] notify failed:', err))
      await load()
    } catch (e: any) { alert(e?.message ?? 'Failed to approve') }
    finally { setReviewing(null) }
  }

  async function deny(r: Request) {
    setReviewing(r.id)
    const noteToSend = denyNote
    try {
      if (r.side === 'statement') await reviewPatientStatementWriteOff(r.id, { approved: false, review_note: noteToSend })
      else                        await reviewClaimWriteOff(r.id, { approved: false, review_note: noteToSend })
      invokeNotifications({ type: 'write_off_reviewed', side: r.side, recordId: r.id, approved: false, reviewNote: noteToSend })
        .catch(err => console.error('[write-off denied] notify failed:', err))
      setDenyNoteOpen(null)
      setDenyNote('')
      await load()
    } catch (e: any) { alert(e?.message ?? 'Failed to deny') }
    finally { setReviewing(null) }
  }

  const all: Request[] = [
    ...((data?.statements ?? []) as Request[]),
    ...((data?.claims ?? []) as Request[]),
  ]

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="flex items-start justify-between mb-6 gap-4">
        <div>
          <h1 className="font-display text-xl font-semibold text-[#1A1A2E]">Pending write-offs</h1>
          <p className="text-[12px] text-[#1A1A2E]/70 mt-0.5">
            Every write-off proposed by your billing team lands here for your approval before it commits. You're the last say.
          </p>
        </div>
        <button onClick={load} disabled={loading}
          className="flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-medium text-[#666] border border-[#E8E8E4] rounded-lg bg-white hover:bg-[#F1EFE8] transition-colors disabled:opacity-50">
          <RefreshCw size={13} className={loading ? 'animate-spin' : ''} /> Refresh
        </button>
      </div>

      {error && <div className="mb-4 text-[13px] text-red-600 bg-[#FCEBEB] border border-[#F5C6C6] px-3 py-2 rounded-lg">{error}</div>}
      {loading && !data && <div className="text-[13px] text-[#1A1A2E]/60 py-16 text-center">Loading…</div>}

      {data && all.length === 0 && (
        <div className="bg-white border border-[#E8E8E4] rounded-xl p-10 text-center shadow-sm">
          <Check size={28} className="text-[#1D9E75] mx-auto mb-3" />
          <div className="text-[13px] text-[#1A1A2E]">Nothing waiting for your approval right now.</div>
        </div>
      )}

      <div className="space-y-3">
        {all.map(r => (
          <div key={`${r.side}-${r.id}`} className="bg-white border border-[#E8E8E4] rounded-xl p-4 shadow-sm">
            <div className="flex items-start justify-between gap-4 flex-wrap">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  {r.side === 'statement'
                    ? <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-[#EEF6FB] text-[#2D7BA6]"><Receipt size={11} /> Statement</span>
                    : <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-[#EEEDFE] text-[#3C3489]"><FileText size={11} /> Claim</span>}
                  <span className="font-display text-[15px] font-medium text-[#1A1A2E]">
                    {[r.patient_first_name, r.patient_last_name].filter(Boolean).join(' ') || 'Unknown patient'}
                  </span>
                  <ChartNumberPill value={r.chart_number} size="xs" />
                  <span className="text-[12px] text-[#555]">· {fmtDate(r.service_date)}</span>
                </div>
                <div className="text-[12px] text-[#555] mt-1">
                  {r.payer_name || '—'} · Amount {fmtMoney(r.amount)}
                </div>
                <div className="text-[13px] text-[#1A1A2E] mt-2">
                  <span className="font-semibold">Reason:</span> {REASON_LABEL[r.reason ?? ''] ?? r.reason ?? '—'}
                </div>
                {r.note && (
                  <div className="text-[13px] text-[#1A1A2E] mt-1">
                    <span className="font-semibold">Note:</span> {r.note}
                  </div>
                )}
                <div className="text-[11px] text-[#1A1A2E]/60 mt-2">
                  Requested by {r.requested_by_name ?? 'Unknown'} · {fmtDateTime(r.requested_at)}
                </div>
              </div>
              <div className="flex flex-col gap-2 flex-shrink-0 min-w-[8rem]">
                <button
                  onClick={() => approve(r)}
                  disabled={!!reviewing}
                  className="flex items-center justify-center gap-1.5 px-3 py-1.5 bg-[#1D9E75] text-white text-[12px] font-medium rounded-lg hover:bg-[#178860] transition-colors disabled:opacity-50">
                  <Check size={13} /> Approve
                </button>
                <button
                  onClick={() => { setDenyNoteOpen(`${r.side}-${r.id}`); setDenyNote('') }}
                  disabled={!!reviewing}
                  className="flex items-center justify-center gap-1.5 px-3 py-1.5 bg-white text-[#991B1B] border border-[#991B1B] text-[12px] font-medium rounded-lg hover:bg-[#FCEBEB] transition-colors disabled:opacity-50">
                  <Ban size={13} /> Deny
                </button>
              </div>
            </div>

            {denyNoteOpen === `${r.side}-${r.id}` && (
              <div className="mt-3 pt-3 border-t border-[#F1EFE8]">
                <label className="text-[11px] text-[#555] block mb-1">Deny reason (visible to the biller)</label>
                <input
                  type="text"
                  className="w-full px-2.5 py-1.5 border border-[#E8E8E4] rounded-lg text-[13px] outline-none focus:border-[#7F77DD] bg-white"
                  value={denyNote}
                  onChange={e => setDenyNote(e.target.value)}
                  placeholder="e.g. Try one more collections call before writing off"
                />
                <div className="flex justify-end gap-2 mt-2">
                  <button
                    onClick={() => { setDenyNoteOpen(null); setDenyNote('') }}
                    className="text-[12px] text-[#555] px-2.5 py-1 rounded-lg hover:bg-[#F1EFE8]">
                    Cancel
                  </button>
                  <button
                    onClick={() => deny(r)}
                    disabled={!!reviewing}
                    className="flex items-center gap-1 text-[12px] text-white bg-[#991B1B] hover:bg-[#7A1414] px-3 py-1 rounded-lg disabled:opacity-50">
                    <X size={12} /> Confirm deny
                  </button>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
