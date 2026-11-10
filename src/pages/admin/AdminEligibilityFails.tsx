import { useEffect, useState } from 'react'
import { format } from 'date-fns'
import { AlertCircle, CheckCircle2, X, ChevronDown, ChevronUp, RefreshCw } from 'lucide-react'
import {
  getEligibilityFails, decideEligibilityFail,
  type EligibilityFailItem,
} from '../../lib/api'

// Dedicated surface for eligibility-check failures caught by the
// auto-eligibility pre-submit hook. Sara 2026-11-10: wanted a separate
// tab (not buried in the Billing agent queue) with a red badge count
// on the sidebar so Pam (new biller) can't miss them.

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

export function AdminEligibilityFails() {
  const [items, setItems] = useState<EligibilityFailItem[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')
  const [expanded, setExpanded] = useState<string | null>(null)
  const [deciding, setDeciding] = useState<string | null>(null)

  async function load() {
    setLoading(true)
    setErr('')
    try {
      const r = await getEligibilityFails()
      setItems(r.items)
    } catch (e: any) {
      setErr(e?.message ?? 'Failed to load eligibility fails')
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { void load() }, [])

  async function doDecide(id: string, action: 'approve' | 'reject') {
    const prompt = action === 'approve'
      ? 'What did you do about it? (e.g. "called family — insurance active now, retrying" or "switched to self-pay")'
      : 'Reason for dismissing (optional):'
    const note = window.prompt(prompt)
    if (note == null) return // cancelled
    if (action === 'approve' && !note.trim()) {
      alert('A short note is required so the audit trail says what happened.')
      return
    }
    setDeciding(id)
    try {
      await decideEligibilityFail(id, action, note.trim() || undefined)
      await load()
    } catch (e: any) {
      setErr(e?.message ?? `${action} failed`)
    } finally {
      setDeciding(null)
    }
  }

  return (
    <div className="max-w-6xl mx-auto px-6 py-6">
      <div className="flex items-start justify-between gap-4 mb-5">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <AlertCircle size={20} className="text-[#DC2626]" />
            <h1 className="text-[24px] font-display font-medium text-[#1A1A2E] leading-tight">Eligibility fails</h1>
          </div>
          <p className="text-[13px] text-[#555] leading-snug max-w-2xl">
            Claims where the pre-submit eligibility check told us the patient's insurance is not active. The claim was NOT sent — verify coverage with the family or payer, then retry.
          </p>
        </div>
        <button onClick={() => void load()} disabled={loading}
          className="inline-flex items-center gap-1.5 text-[12px] text-[#555] hover:text-[#1A1A2E] border border-[#E8E8E4] rounded-lg px-3 py-1.5 bg-white hover:bg-[#F1EFE8] disabled:opacity-50">
          <RefreshCw size={12} className={loading ? 'animate-spin' : ''} /> Refresh
        </button>
      </div>

      {err && (
        <div className="mb-4 rounded-lg border border-[#DC2626] bg-[#FEE2E2] text-[#7F1D1D] px-3 py-2 text-[12px]">{err}</div>
      )}

      {loading && items.length === 0 && (
        <div className="text-[13px] text-[#555] py-16 text-center">Loading…</div>
      )}

      {!loading && items.length === 0 && !err && (
        <div className="rounded-xl border border-dashed border-[#E8E8E4] bg-[#FAFAF8] px-6 py-10 text-center">
          <CheckCircle2 size={32} className="mx-auto text-[#1D9E75] mb-2 opacity-70" />
          <div className="text-[14px] font-medium text-[#1A1A2E] mb-1">No eligibility fails.</div>
          <p className="text-[12px] text-[#555]">All submitted claims passed pre-submit eligibility checks.</p>
        </div>
      )}

      <div className="space-y-2">
        {items.map(it => {
          const open = expanded === it.id
          return (
            <div key={it.id} className="bg-white border border-[#E8E8E4] rounded-xl overflow-hidden">
              <div className="flex items-start gap-3 p-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1 flex-wrap">
                    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold bg-[#FEE2E2] text-[#7F1D1D]">
                      Eligibility failed
                    </span>
                    <span className="text-[13px] font-medium text-[#1A1A2E]">{it.patient_name ?? 'Unknown patient'}</span>
                    {it.service_date && <span className="text-[12px] text-[#555]">· DOS {fmtDate(it.service_date)}</span>}
                    {it.payer_name && <span className="text-[12px] text-[#555]">· {it.payer_name}</span>}
                  </div>
                  <p className="text-[13px] text-[#1A1A2E] leading-snug">{it.summary}</p>
                  <div className="text-[11px] text-[#777] mt-1">Queued {fmtDateTime(it.created_at)}</div>
                </div>
                <div className="flex items-center gap-1 flex-shrink-0">
                  <button onClick={() => void doDecide(it.id, 'approve')}
                    disabled={deciding === it.id}
                    className="inline-flex items-center gap-1 text-[12px] font-medium text-white bg-[#1D9E75] hover:bg-[#188960] rounded-lg px-2.5 py-1.5 disabled:opacity-50">
                    <CheckCircle2 size={11} /> Mark handled
                  </button>
                  <button onClick={() => void doDecide(it.id, 'reject')}
                    disabled={deciding === it.id}
                    className="inline-flex items-center gap-1 text-[12px] font-medium text-[#7F1D1D] border border-[#FDA4AF] rounded-lg px-2.5 py-1.5 hover:bg-[#FEE2E2] disabled:opacity-50">
                    <X size={11} /> Dismiss
                  </button>
                  <button onClick={() => setExpanded(open ? null : it.id)}
                    className="p-1.5 rounded-lg hover:bg-[#F1EFE8] text-[#555]"
                    aria-label={open ? 'Collapse details' : 'Expand details'}>
                    {open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                  </button>
                </div>
              </div>
              {open && (
                <div className="px-4 pb-4 pt-0 border-t border-[#F1EFE8] bg-[#FAFAF8]">
                  <div className="text-[11px] font-semibold text-[#1A1A2E] uppercase tracking-wider mb-1.5 mt-3">Eligibility response</div>
                  <pre className="text-[11px] text-[#1A1A2E] font-mono whitespace-pre-wrap bg-white rounded-lg border border-[#E8E8E4] p-3 overflow-x-auto">
                    {JSON.stringify(it.agent_reasoning ?? {}, null, 2)}
                  </pre>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
