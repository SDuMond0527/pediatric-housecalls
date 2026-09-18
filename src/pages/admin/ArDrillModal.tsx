import { useEffect, useState } from 'react'
import { X, ExternalLink, AlertCircle } from 'lucide-react'
import { getArDrill, type ArBucket } from '../../lib/api'
import { ChartNumberPill } from '../../components/ChartNumberPill'

function fmtMoney(n: any) {
  const v = parseFloat(String(n ?? 0))
  return isNaN(v) ? '$0.00' : `$${v.toFixed(2)}`
}
function fmtDate(d: string | null | undefined) {
  if (!d) return '—'
  try {
    const dt = new Date(d)
    if (isNaN(dt.getTime())) return String(d).split('T')[0] || '—'
    return dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
  } catch { return String(d).split('T')[0] || '—' }
}

const INSURANCE_STATUS_LABEL: Record<string, string> = {
  submitted:      'Submitted — awaiting ERA',
  pending_review: 'Pending biller review',
  error:          'Rejected — needs fix',
  draft:          'Draft',
}

export function ArDrillModal({
  open,
  type,
  group,
  groupLabel,
  bucket,
  bucketLabel,
  cellValue,
  onClose,
  onOpenClaim,
  onOpenStatement,
}: {
  open: boolean
  type: 'insurance' | 'patient'
  group: string
  groupLabel: string
  bucket: ArBucket
  bucketLabel: string
  cellValue: number
  onClose: () => void
  onOpenClaim: (claimId: string) => void
  onOpenStatement: (row: any) => void
}) {
  const [rows, setRows] = useState<any[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true); setError(null); setRows([])
    getArDrill({ type, group, bucket })
      .then(data => { if (!cancelled) setRows(data.rows ?? []) })
      .catch(e => { if (!cancelled) setError(e?.message ?? 'Failed to load') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [open, type, group, bucket])

  if (!open) return null

  const title =
    (groupLabel === '__all__' ? 'All' : groupLabel) +
    ' · ' + bucketLabel

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        className="bg-white rounded-2xl shadow-xl max-w-4xl w-full max-h-[85vh] flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-start justify-between px-5 py-4 border-b border-[#E8E8E4]">
          <div>
            <div className="text-[11px] uppercase tracking-wide text-[#1A1A2E]/60">
              {type === 'insurance' ? 'AR aging — insurance' : 'AR aging — patient'}
            </div>
            <h2 className="font-display text-[17px] font-semibold text-[#1A1A2E] mt-0.5">{title}</h2>
            <div className="text-[12px] text-[#1A1A2E]/70 mt-0.5">
              {fmtMoney(cellValue)} outstanding{rows.length > 0 ? ` · ${rows.length} ${type === 'insurance' ? (rows.length === 1 ? 'claim' : 'claims') : (rows.length === 1 ? 'statement' : 'statements')}` : ''}
            </div>
          </div>
          <button onClick={onClose} className="text-[#1A1A2E]/60 hover:text-[#1A1A2E] p-1 -mr-1">
            <X size={18} />
          </button>
        </div>

        <div className="overflow-auto flex-1">
          {loading && <div className="py-12 text-center text-[13px] text-[#1A1A2E]/60">Loading…</div>}
          {error && (
            <div className="m-5 flex items-start gap-2 text-[13px] text-[#991B1B] bg-[#FCEBEB] border border-[#F5C6C6] px-3 py-2 rounded-lg">
              <AlertCircle size={14} className="mt-0.5 flex-shrink-0" /> <span>{error}</span>
            </div>
          )}
          {!loading && !error && rows.length === 0 && (
            <div className="py-12 text-center text-[13px] text-[#1A1A2E]/60">
              No {type === 'insurance' ? 'claims' : 'statements'} in this bucket.
            </div>
          )}
          {!loading && !error && rows.length > 0 && type === 'insurance' && (
            <table className="w-full text-[13px]">
              <thead className="sticky top-0 bg-[#FAFAF8] text-[11px] uppercase tracking-wide text-[#1A1A2E]">
                <tr className="border-b border-[#E8E8E4]">
                  <th className="text-left px-4 py-2">Patient</th>
                  <th className="text-left px-3 py-2">Payer</th>
                  <th className="text-left px-3 py-2">DOS</th>
                  <th className="text-left px-3 py-2">Submitted</th>
                  <th className="text-right px-3 py-2">Age</th>
                  <th className="text-right px-3 py-2">Charge</th>
                  <th className="text-left px-3 py-2">Status</th>
                  <th className="text-right px-3 py-2 pr-4"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#F1EFE8]">
                {rows.map(r => (
                  <tr
                    key={r.id}
                    className="hover:bg-[#F5F5FF] cursor-pointer"
                    onClick={() => onOpenClaim(r.id)}
                  >
                    <td className="px-4 py-2">
                      <span className="inline-flex items-center gap-2 flex-wrap">
                        <span className="text-[#1A1A2E]">
                          {[r.patient_first_name, r.patient_last_name].filter(Boolean).join(' ') || 'Unknown patient'}
                        </span>
                        <ChartNumberPill value={r.chart_number} size="xs" />
                      </span>
                    </td>
                    <td className="px-3 py-2 text-[#1A1A2E]/80">{r.payer_name}</td>
                    <td className="px-3 py-2 text-[#1A1A2E]/80">{fmtDate(r.service_date)}</td>
                    <td className="px-3 py-2 text-[#1A1A2E]/80">{fmtDate(r.submitted_at ?? r.created_at)}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-[#1A1A2E]/80">{r.age_days}d</td>
                    <td className="px-3 py-2 text-right tabular-nums font-semibold text-[#1A1A2E]">{fmtMoney(r.total_charge)}</td>
                    <td className="px-3 py-2">
                      <span className={`inline-block px-2 py-0.5 rounded-full text-[11px] ${
                        r.status === 'error'          ? 'bg-[#FCEBEB] text-[#991B1B]' :
                        r.status === 'pending_review' ? 'bg-[#FFF4E5] text-[#8A4B00]' :
                                                        'bg-[#EEF1F8] text-[#31447A]'
                      }`}>
                        {INSURANCE_STATUS_LABEL[r.status] ?? r.status}
                      </span>
                    </td>
                    <td className="px-3 py-2 pr-4 text-right text-[#7F77DD]">
                      <ExternalLink size={14} className="inline-block" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {!loading && !error && rows.length > 0 && type === 'patient' && (
            <table className="w-full text-[13px]">
              <thead className="sticky top-0 bg-[#FAFAF8] text-[11px] uppercase tracking-wide text-[#1A1A2E]">
                <tr className="border-b border-[#E8E8E4]">
                  <th className="text-left px-4 py-2">Patient</th>
                  <th className="text-left px-3 py-2">DOS</th>
                  <th className="text-left px-3 py-2">Sent</th>
                  <th className="text-right px-3 py-2">Age</th>
                  <th className="text-right px-3 py-2">Owed</th>
                  <th className="text-right px-3 py-2 pr-4"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#F1EFE8]">
                {rows.map(r => (
                  <tr
                    key={r.id}
                    className="hover:bg-[#F5F5FF] cursor-pointer"
                    onClick={() => onOpenStatement(r)}
                  >
                    <td className="px-4 py-2">
                      <span className="inline-flex items-center gap-2 flex-wrap">
                        <span className="text-[#1A1A2E]">
                          {[r.patient_first_name, r.patient_last_name].filter(Boolean).join(' ') || 'Unknown patient'}
                        </span>
                        <ChartNumberPill value={r.chart_number} size="xs" />
                      </span>
                    </td>
                    <td className="px-3 py-2 text-[#1A1A2E]/80">{fmtDate(r.date_of_service)}</td>
                    <td className="px-3 py-2 text-[#1A1A2E]/80">{fmtDate(r.sent_at ?? r.created_at)}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-[#1A1A2E]/80">{r.age_days}d</td>
                    <td className="px-3 py-2 text-right tabular-nums font-semibold text-[#1A1A2E]">{fmtMoney(r.total_amount_due)}</td>
                    <td className="px-3 py-2 pr-4 text-right text-[#7F77DD]">
                      <ExternalLink size={14} className="inline-block" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="px-5 py-3 border-t border-[#E8E8E4] bg-[#FAFAF8] text-[12px] text-[#1A1A2E]/70">
          {type === 'insurance'
            ? 'Click a claim to open it in the Claims page and review why it hasn’t paid.'
            : 'Click a statement to open it and review or record a payment.'}
        </div>
      </div>
    </div>
  )
}
