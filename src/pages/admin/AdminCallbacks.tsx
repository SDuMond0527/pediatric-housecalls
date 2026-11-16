import { useEffect, useMemo, useState } from 'react'
import { PhoneCall, RefreshCw, Copy, CheckCircle2, FlaskConical, FileText } from 'lucide-react'
import { format } from 'date-fns'
import { getResults, acknowledgeResult, type ResultRow } from '../../lib/api'

// Patient Callbacks queue — unified across Pathology + Labs. Rows
// appear here after the clinician signs a result (which requires a
// diagnosis + plan). They stay here until someone calls the patient
// and clicks "Mark notified", at which point the row drops off.
// Sara 2026-11-16 for Dr. Cash.

type ResourceFilter = 'all' | 'pathology' | 'lab'

export function AdminCallbacks() {
  const [path, setPath]   = useState<ResultRow[]>([])
  const [labs, setLabs]   = useState<ResultRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter]   = useState<ResourceFilter>('all')
  const [busy, setBusy]       = useState<string | null>(null)
  const [copiedId, setCopiedId] = useState<string | null>(null)

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const [p, l] = await Promise.all([
        getResults({ type: 'pathology', status: 'signed', limit: 200 }),
        getResults({ type: 'lab',       status: 'signed', limit: 200 }),
      ])
      setPath(Array.isArray(p) ? p : [])
      setLabs(Array.isArray(l) ? l : [])
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load callbacks queue')
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { void load() }, [])

  const all = useMemo(() => {
    const rows = filter === 'pathology' ? path : filter === 'lab' ? labs : [...path, ...labs]
    return rows.sort((a, b) => {
      const ar = a.signed_at ?? a.received_at
      const br = b.signed_at ?? b.received_at
      return (ar ?? '') < (br ?? '') ? -1 : 1
    })
  }, [filter, path, labs])

  const counts = useMemo(() => ({
    all: path.length + labs.length,
    pathology: path.length,
    lab: labs.length,
  }), [path, labs])

  async function markNotified(id: string, channel: string) {
    setBusy(id)
    try { await acknowledgeResult(id, { ack_channel: channel }); await load() }
    catch (e: any) { alert('Mark notified failed: ' + (e?.message ?? '')) }
    finally { setBusy(null) }
  }

  async function copyPhone(row: ResultRow) {
    const phone = row.patient_phone ?? ''
    if (!phone) return
    try {
      await navigator.clipboard.writeText(phone)
      setCopiedId(row.id)
      setTimeout(() => setCopiedId(c => c === row.id ? null : c), 1800)
    } catch {}
  }

  return (
    <div>
      <div className="bg-white border-b border-[#E8E8E4] px-6 py-4 flex items-center justify-between sticky top-0 z-10">
        <div className="flex items-center gap-2.5">
          <PhoneCall size={18} className="text-[#7F77DD]" />
          <div>
            <div className="font-display text-[18px] font-medium text-[#1A1A2E]">Patient callbacks</div>
            <div className="text-[12px] text-[#1A1A2E]/70">Results you've reviewed that need a patient phone call. Mark each notified once you've called.</div>
          </div>
        </div>
        <button onClick={() => void load()}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 border border-[#E8E8E4] text-[12px] font-medium rounded-lg bg-white hover:bg-[#F1EFE8]">
          <RefreshCw size={12} className={loading ? 'animate-spin' : ''} /> Refresh
        </button>
      </div>

      <div className="p-6 max-w-6xl space-y-4">
        <div className="flex items-center gap-1 border-b border-[#E8E8E4]">
          {(['all', 'pathology', 'lab'] as const).map(f => (
            <button key={f}
              onClick={() => setFilter(f)}
              className={`px-3 py-2 text-[12px] font-medium border-b-2 transition-colors ${
                filter === f
                  ? 'border-[#7F77DD] text-[#7F77DD]'
                  : 'border-transparent text-[#1A1A2E]/70 hover:text-[#1A1A2E]'
              }`}>
              {f === 'all' ? 'All' : f === 'pathology' ? 'Pathology' : 'Labs'}
              <span className="ml-1.5 text-[11px] text-[#1A1A2E]/50">{counts[f] ?? 0}</span>
            </button>
          ))}
        </div>

        {error && (
          <div className="text-[12px] text-[#991B1B] bg-[#FCEBEB] border border-[#F5C6C6] px-3 py-2 rounded-lg">{error}</div>
        )}

        {loading && all.length === 0 && (
          <div className="text-[13px] text-[#1A1A2E]/60 py-12 text-center">Loading…</div>
        )}

        {!loading && all.length === 0 && (
          <div className="text-[13px] text-[#1A1A2E]/60 py-12 text-center bg-white rounded-xl border border-[#E8E8E4]">
            No pending callbacks. Everything's been called back — nice.
          </div>
        )}

        <div className="space-y-2">
          {all.map(r => {
            const Icon = r.type === 'pathology' ? FlaskConical : FileText
            return (
              <div key={r.id} className="bg-white border border-[#E8E8E4] rounded-xl p-4">
                <div className="flex items-start justify-between gap-4 flex-wrap">
                  <div className="min-w-0 flex-1 space-y-2">
                    <div className="flex items-center gap-2 flex-wrap">
                      <Icon size={14} className="text-[#7F77DD] flex-shrink-0" />
                      <div className="text-[14px] font-medium text-[#1A1A2E]">{r.patient_name ?? 'Unknown patient'}</div>
                      <span className="text-[10px] font-medium text-[#3C3489] bg-[#EEEDFE] border border-[#AFA9EC] rounded-full px-2 py-0.5">
                        {r.diagnosis_label ?? '—'}
                      </span>
                      <span className="text-[10px] text-[#1A1A2E]/60 uppercase tracking-wide">{r.type === 'pathology' ? 'Path' : 'Lab'}</span>
                    </div>

                    <div className="text-[13px] text-[#1A1A2E] whitespace-pre-wrap bg-[#FAFAF8] border border-[#E8E8E4] rounded-lg px-3 py-2">
                      <span className="text-[10px] font-semibold text-[#1A1A2E]/60 uppercase tracking-wide mr-2">Plan:</span>
                      {r.plan ?? '—'}
                    </div>

                    <div className="text-[11px] text-[#1A1A2E]/60 flex items-center flex-wrap gap-x-3 gap-y-1">
                      <span>
                        Reviewed {r.signed_at ? format(new Date(r.signed_at), 'MMM d, h:mm a') : '—'}
                        {r.signed_by_name ? ` by ${r.signed_by_name}` : ''}
                      </span>
                      {r.specimen_date && <span>· specimen {r.specimen_date}</span>}
                      {r.specimen_type && <span>· {r.specimen_type}</span>}
                      {r.specimen_site && <span>· {r.specimen_site}</span>}
                      {r.test_name && <span>· {r.test_name}</span>}
                    </div>

                    {r.patient_phone && (
                      <div className="flex items-center gap-2">
                        <span className="text-[11px] text-[#1A1A2E]/60 uppercase tracking-wide font-semibold">Phone</span>
                        <span className="font-mono text-[13px] text-[#1A1A2E]">{r.patient_phone}</span>
                        <button onClick={() => copyPhone(r)}
                          className="inline-flex items-center gap-1 text-[11px] text-[#7F77DD] hover:underline">
                          {copiedId === r.id ? <><CheckCircle2 size={10} /> Copied</> : <><Copy size={10} /> Copy</>}
                        </button>
                      </div>
                    )}
                  </div>

                  <div className="flex flex-col items-end gap-1">
                    <div className="text-[10px] font-semibold text-[#1A1A2E]/60 uppercase tracking-wide">Patient notified via</div>
                    <div className="flex items-center gap-2">
                      <button onClick={() => markNotified(r.id, 'phone')} disabled={busy === r.id}
                        className="inline-flex items-center gap-1 px-3 py-1.5 bg-[#7F77DD] text-white text-[12px] font-medium rounded-lg hover:bg-[#6B64C8] disabled:opacity-50">
                        Phone
                      </button>
                      <button onClick={() => markNotified(r.id, 'email')} disabled={busy === r.id}
                        className="inline-flex items-center gap-1 px-3 py-1.5 border border-[#E8E8E4] text-[12px] font-medium rounded-lg bg-white hover:bg-[#F1EFE8] disabled:opacity-50">
                        Email
                      </button>
                      <button onClick={() => markNotified(r.id, 'portal')} disabled={busy === r.id}
                        className="inline-flex items-center gap-1 px-3 py-1.5 border border-[#E8E8E4] text-[12px] font-medium rounded-lg bg-white hover:bg-[#F1EFE8] disabled:opacity-50">
                        Portal
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
