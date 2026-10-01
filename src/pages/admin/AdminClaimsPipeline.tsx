import { useEffect, useState } from 'react'
import { format } from 'date-fns'
import { AlertCircle, CheckCircle, Send, XCircle, FileText, Download, RefreshCw } from 'lucide-react'
import { getClaimsPipeline, type ClaimsPipelineData, type ClaimsPipelineRange, type ClaimsPipelineRow } from '../../lib/api'
import { Button } from '../../components/ui/Button'

function fmtMoney(n: number): string {
  if (!isFinite(n)) return '$0'
  const abs = Math.abs(n)
  return abs >= 1000
    ? '$' + (Math.round(n) as number).toLocaleString()
    : '$' + n.toFixed(2)
}

const STATUS_META: Record<string, { label: string; cls: string; icon: any }> = {
  not_yet_sent: { label: 'Not yet sent',  cls: 'bg-[#F1EFE8] text-[#555]',    icon: FileText },
  rejected:     { label: 'Rejected',      cls: 'bg-[#FEE2E2] text-[#7F1D1D]', icon: XCircle },
  sent_waiting: { label: 'Sent, waiting', cls: 'bg-[#EEF1F8] text-[#31447A]', icon: Send },
  paid:         { label: 'Paid',          cls: 'bg-[#E1F5EE] text-[#085041]', icon: CheckCircle },
  denied:       { label: 'Denied',        cls: 'bg-[#FEE2E2] text-[#7F1D1D]', icon: AlertCircle },
}

const RANGE_LABELS: Record<ClaimsPipelineRange, string> = {
  this_month: 'This month',
  last_90:    'Last 90 days',
  last_6mo:   'Last 6 months',
}

function toCsv(rows: ClaimsPipelineRow[], rangeLabel: string): string {
  const escape = (v: any) => {
    const s = v == null ? '' : String(v)
    return /[,"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const headers = ['Patient', 'Payer', 'Visit date', 'Rendering provider', 'Amount', 'Status', 'Reason', 'Days waiting']
  const meta = [
    escape('Claims pipeline — action items'),
    escape('Period: ' + rangeLabel),
    escape('Generated: ' + format(new Date(), 'MMM d, yyyy')),
    '',
  ].join('\n') + '\n'
  const body = [headers.join(',')]
  for (const r of rows) {
    body.push([
      escape(r.patient_name),
      escape(r.payer_name ?? ''),
      escape(r.service_date),
      escape(r.rendering_provider),
      r.billed.toFixed(2),
      escape(STATUS_META[r.status]?.label ?? r.status),
      escape(r.reason_label ?? ''),
      String(r.days_waiting ?? 0),
    ].join(','))
  }
  return meta + body.join('\n')
}

export function AdminClaimsPipeline() {
  const [range, setRange] = useState<ClaimsPipelineRange>('this_month')
  const [data, setData] = useState<ClaimsPipelineData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  async function load() {
    setLoading(true); setError(null)
    try { setData(await getClaimsPipeline(range)) }
    catch (e: any) { setError(e?.message ?? 'Failed to load pipeline') }
    finally { setLoading(false) }
  }
  useEffect(() => { load() /* eslint-disable-next-line */ }, [range])

  function downloadCsv() {
    if (!data) return
    const csv = toCsv(data.action_items, RANGE_LABELS[range])
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = `claims-pipeline-${range}.csv`; a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div>
      {/* Range picker */}
      <div className="flex items-center justify-between mb-5 flex-wrap gap-3">
        <div className="flex items-center gap-2">
          <label className="text-[11px] text-[#1A1A2E] uppercase tracking-wide font-semibold">Date of service</label>
          <select value={range} onChange={e => setRange(e.target.value as ClaimsPipelineRange)}
            className="px-2.5 py-1.5 border border-[#E8E8E4] rounded-lg text-[13px] bg-white">
            {(Object.entries(RANGE_LABELS) as [ClaimsPipelineRange, string][]).map(([v, l]) => (
              <option key={v} value={v}>{l}</option>
            ))}
          </select>
        </div>
        <button onClick={load} disabled={loading}
          className="inline-flex items-center gap-1.5 text-[12px] text-[#7F77DD] hover:underline">
          <RefreshCw size={12} className={loading ? 'animate-spin' : ''} /> Refresh
        </button>
      </div>

      {error && <div className="mb-4 text-[13px] text-red-600 bg-[#FCEBEB] border border-[#F5C6C6] px-3 py-2 rounded-lg">{error}</div>}
      {loading && !data && <div className="text-[13px] text-[#1A1A2E]/60 py-12 text-center">Loading…</div>}

      {data && (
        <>
          {/* ── Section 1: Follow the money ─────────────────────────── */}
          <section className="mb-8">
            <h2 className="font-display text-[16px] font-semibold text-[#1A1A2E] mb-3">Follow the money</h2>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <MoneyCard label="Billed"               value={fmtMoney(data.follow_the_money.billed)}               color="#1A1A2E" />
              <MoneyCard label="Collected"            value={fmtMoney(data.follow_the_money.total_collected)}      color="#1D9E75"
                sub={`${fmtMoney(data.follow_the_money.insurance_collected)} ins · ${fmtMoney(data.follow_the_money.family_collected)} fam`} />
              <MoneyCard label="Families still owe"   value={fmtMoney(data.follow_the_money.family_balance)}       color="#B45309" />
              <MoneyCard label="Waiting on insurance" value={fmtMoney(data.follow_the_money.waiting_on_insurance)} color="#31447A" />
            </div>
          </section>

          {/* ── Section 2: By status + aging buckets ───────────────── */}
          <section className="mb-8">
            <h2 className="font-display text-[16px] font-semibold text-[#1A1A2E] mb-3">By status</h2>
            <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-5">
              {data.by_status.map(s => {
                const meta = STATUS_META[s.status] ?? { label: s.status, cls: 'bg-[#F1EFE8] text-[#555]', icon: FileText }
                const Icon = meta.icon
                return (
                  <div key={s.status} className="bg-white border border-[#E8E8E4] rounded-xl p-3">
                    <div className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-semibold ${meta.cls} mb-2`}>
                      <Icon size={10} /> {meta.label}
                    </div>
                    <div className="font-display text-[18px] font-semibold text-[#1A1A2E] tabular-nums">{fmtMoney(s.dollar_total)}</div>
                    <div className="text-[11px] text-[#1A1A2E]/70 mt-0.5">
                      {s.claim_count} claim{s.claim_count === 1 ? '' : 's'} · oldest {s.oldest_age_days}d
                    </div>
                  </div>
                )
              })}
            </div>

            <h3 className="text-[11px] text-[#1A1A2E] uppercase tracking-wide font-semibold mb-2">Aging — unpaid insurance claims (days since submission)</h3>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {[
                ['0–30 days',   data.aging_buckets.b_0_30,   '#31447A'],
                ['31–60 days',  data.aging_buckets.b_31_60,  '#633806'],
                ['61–90 days',  data.aging_buckets.b_61_90,  '#B45309'],
                ['90+ days',    data.aging_buckets.b_90_plus,'#991B1B'],
              ].map(([label, b, color]) => {
                const bb = b as { total: number; count: number }
                return (
                  <div key={label as string} className="bg-white border border-[#E8E8E4] rounded-xl p-3">
                    <div className="text-[11px] text-[#1A1A2E]/70 uppercase tracking-wide">{label as string}</div>
                    <div className="font-display text-[16px] font-semibold tabular-nums" style={{ color: color as string }}>{fmtMoney(bb.total)}</div>
                    <div className="text-[11px] text-[#1A1A2E]/60">{bb.count} claim{bb.count === 1 ? '' : 's'}</div>
                  </div>
                )
              })}
            </div>
          </section>

          {/* ── Section 3: Action items table ──────────────────────── */}
          <section>
            <div className="flex items-center justify-between mb-3">
              <h2 className="font-display text-[16px] font-semibold text-[#1A1A2E]">
                Action items <span className="text-[12px] text-[#1A1A2E]/60 font-normal">({data.action_items.length})</span>
              </h2>
              <Button variant="secondary" size="xs" onClick={downloadCsv} disabled={data.action_items.length === 0}>
                <Download size={11} /> CSV
              </Button>
            </div>
            <div className="text-[12px] text-[#1A1A2E]/70 mb-2 italic">
              Not sent, rejected, denied, or waiting more than 30 days. Oldest first.
            </div>
            {data.action_items.length === 0 ? (
              <div className="text-[13px] text-[#1A1A2E]/60 py-8 text-center bg-white border border-[#E8E8E4] rounded-xl">
                Nothing needs attention right now in this window.
              </div>
            ) : (
              <div className="bg-white border border-[#E8E8E4] rounded-xl overflow-x-auto">
                <table className="w-full text-[13px]">
                  <thead className="bg-[#FAFAF8] text-[11px] uppercase tracking-wide text-[#1A1A2E]">
                    <tr className="border-b border-[#E8E8E4]">
                      <th className="text-left px-3 py-2">Patient</th>
                      <th className="text-left px-3 py-2">Payer</th>
                      <th className="text-left px-3 py-2">Visit date</th>
                      <th className="text-left px-3 py-2">Provider</th>
                      <th className="text-right px-3 py-2">Amount</th>
                      <th className="text-left px-3 py-2">Status</th>
                      <th className="text-left px-3 py-2">Reason</th>
                      <th className="text-right px-3 py-2 pr-4">Days waiting</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#F1EFE8]">
                    {data.action_items.map(r => {
                      const meta = STATUS_META[r.status] ?? { label: r.status, cls: 'bg-[#F1EFE8] text-[#555]', icon: FileText }
                      const Icon = meta.icon
                      return (
                        <tr key={r.id} className="hover:bg-[#FAFAF8]">
                          <td className="px-3 py-2 text-[#1A1A2E]">{r.patient_name}</td>
                          <td className="px-3 py-2 text-[#1A1A2E]/80">{r.payer_name ?? '—'}</td>
                          <td className="px-3 py-2 text-[#1A1A2E]/80">{r.service_date}</td>
                          <td className="px-3 py-2 text-[#1A1A2E]/80">{r.rendering_provider}</td>
                          <td className="px-3 py-2 text-right tabular-nums font-semibold">{fmtMoney(r.billed)}</td>
                          <td className="px-3 py-2">
                            <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold ${meta.cls}`}>
                              <Icon size={10} /> {meta.label}
                            </span>
                          </td>
                          <td className="px-3 py-2 text-[#1A1A2E]/80">
                            {r.reason_code && <span className="font-mono text-[11px] text-[#555] mr-1">{r.reason_code}</span>}
                            {r.reason_label ?? '—'}
                          </td>
                          <td className="px-3 py-2 pr-4 text-right tabular-nums text-[#1A1A2E]">
                            {r.days_waiting > 0 ? `${r.days_waiting}d` : '—'}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </div>
  )
}

function MoneyCard({ label, value, sub, color }: { label: string; value: string; sub?: string; color: string }) {
  return (
    <div className="bg-white border border-[#E8E8E4] rounded-xl p-4">
      <div className="text-[11px] text-[#1A1A2E] uppercase tracking-wide">{label}</div>
      <div className="font-display text-[22px] font-semibold tabular-nums mt-0.5" style={{ color }}>{value}</div>
      {sub && <div className="text-[11px] text-[#1A1A2E]/60 mt-0.5">{sub}</div>}
    </div>
  )
}
