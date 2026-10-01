import { useEffect, useMemo, useState } from 'react'
import { format } from 'date-fns'
import { Download, RefreshCw } from 'lucide-react'
import { getCollectionsByMonth, type CollectionsByMonth, type CollectionsMonthRow, type DayStatus } from '../../lib/api'
import { Button } from '../../components/ui/Button'

function fmtMoney(n: number | null | undefined): string {
  if (n == null || !isFinite(n)) return '—'
  if (Math.abs(n) >= 1000) return '$' + Math.round(n).toLocaleString()
  return '$' + n.toFixed(2)
}
function fmtPct(n: number | null | undefined, digits = 1): string {
  if (n == null || !isFinite(n)) return '—'
  return `${n.toFixed(digits)}%`
}

type Mode = 'net' | 'gross'

/** Compute the day-N collection rate for a month row given the mode. */
function rateFor(m: CollectionsMonthRow, day: 30 | 60 | 90, mode: Mode): number | null {
  const collected = day === 30 ? m.collected_30 : day === 60 ? m.collected_60 : m.collected_90
  const denom = mode === 'net' ? m.allowed_known : m.billed
  if (denom <= 0) return null
  return (collected / denom) * 100
}

function cellStatus(m: CollectionsMonthRow, day: 30 | 60 | 90): DayStatus {
  return day === 30 ? m.status_30 : day === 60 ? m.status_60 : m.status_90
}

/** Darker green as % rises. Caps the gradient at 100% → full saturation. */
function heatColor(pct: number | null): { bg: string; fg: string } {
  if (pct == null) return { bg: '#FAFAF8', fg: '#1A1A2E' }
  const p = Math.min(1, Math.max(0, pct / 100))
  // Interpolate from pale ivory → deep teal
  const r = Math.round(250 + (29  - 250) * p)
  const g = Math.round(248 + (158 - 248) * p)
  const b = Math.round(230 + (117 - 230) * p)
  const fg = p > 0.55 ? '#ffffff' : '#1A1A2E'
  return { bg: `rgb(${r},${g},${b})`, fg }
}

export function AdminCollectionsByMonth() {
  const [data, setData] = useState<CollectionsByMonth | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [mode, setMode] = useState<Mode>('net')
  const [payer, setPayer] = useState<string>('')
  const [providerId, setProviderId] = useState<string>('')

  async function load() {
    setLoading(true); setError(null)
    try { setData(await getCollectionsByMonth({ payer, providerId })) }
    catch (e: any) { setError(e?.message ?? 'Failed to load') }
    finally { setLoading(false) }
  }
  useEffect(() => { load() /* eslint-disable-next-line */ }, [payer, providerId])

  // Pre-compute the per-month rates, then build the "red flag" mask by
  // comparing each cell to the average of the prior 3 completed months
  // at the same day mark. Flag if more than 10 points below. Months
  // are newest-first; "prior" means later in the array.
  const flagMask = useMemo(() => {
    const mask: Record<string, { d30: boolean; d60: boolean; d90: boolean }> = {}
    if (!data) return mask
    const months = data.months
    for (let i = 0; i < months.length; i++) {
      const m = months[i]
      const flagFor = (day: 30 | 60 | 90): boolean => {
        if (cellStatus(m, day) !== 'complete') return false
        const myRate = rateFor(m, day, mode)
        if (myRate == null) return false
        // Prior 3 months with same day-mark complete
        const prior: number[] = []
        for (let j = i + 1; j < months.length && prior.length < 3; j++) {
          if (cellStatus(months[j], day) !== 'complete') continue
          const r = rateFor(months[j], day, mode)
          if (r != null) prior.push(r)
        }
        if (prior.length < 3) return false
        const avg = prior.reduce((s, v) => s + v, 0) / prior.length
        return myRate < (avg - 10)
      }
      mask[m.month] = { d30: flagFor(30), d60: flagFor(60), d90: flagFor(90) }
    }
    return mask
  }, [data, mode])

  function downloadCsv() {
    if (!data) return
    const escape = (v: any) => {
      const s = v == null ? '' : String(v)
      return /[,"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
    }
    const metaLines = [
      escape(`Collections by visit month — ${mode === 'net' ? 'Allowed (net)' : 'Billed (gross)'}`),
      escape(`Filters: ${payer || 'all payers'}, ${data.options.providers.find(p => p.id === providerId)?.name || 'all providers'}`),
      escape(`Generated: ${format(new Date(), 'MMM d, yyyy')}`),
      '',
    ].join('\n')
    const headers = ['Month','Visits','Billed','Allowed','Allowed pending','Collected total','% by day 30','% by day 60','% by day 90']
    const body = [headers.join(',')]
    for (const m of data.months) {
      body.push([
        escape(m.label),
        m.visits,
        m.billed.toFixed(2),
        m.allowed_known > 0 ? m.allowed_known.toFixed(2) : '',
        m.allowed_pending_count,
        m.collected_total.toFixed(2),
        rateFor(m, 30, mode) != null ? rateFor(m, 30, mode)!.toFixed(1) : (cellStatus(m, 30) === 'not_yet' ? 'Not yet' : cellStatus(m, 30) === 'filling_in' ? 'Filling in' : ''),
        rateFor(m, 60, mode) != null ? rateFor(m, 60, mode)!.toFixed(1) : (cellStatus(m, 60) === 'not_yet' ? 'Not yet' : cellStatus(m, 60) === 'filling_in' ? 'Filling in' : ''),
        rateFor(m, 90, mode) != null ? rateFor(m, 90, mode)!.toFixed(1) : (cellStatus(m, 90) === 'not_yet' ? 'Not yet' : cellStatus(m, 90) === 'filling_in' ? 'Filling in' : ''),
      ].join(','))
    }
    const csv = metaLines + '\n' + body.join('\n')
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = `collections-by-month-${mode}.csv`; a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div>
      {/* Filters + toggle */}
      <div className="flex items-end justify-between gap-3 flex-wrap mb-5">
        <div className="flex items-end gap-2 flex-wrap">
          <div>
            <label className="text-[10px] text-[#1A1A2E]/60 uppercase tracking-wide block mb-0.5">Payer</label>
            <select value={payer} onChange={e => setPayer(e.target.value)}
              className="px-2.5 py-1.5 border border-[#E8E8E4] rounded-lg text-[13px] bg-white min-w-[140px]">
              <option value="">All payers</option>
              {data?.options.payers.map(p => <option key={p} value={p}>{p}</option>)}
            </select>
          </div>
          <div>
            <label className="text-[10px] text-[#1A1A2E]/60 uppercase tracking-wide block mb-0.5">Rendering provider</label>
            <select value={providerId} onChange={e => setProviderId(e.target.value)}
              className="px-2.5 py-1.5 border border-[#E8E8E4] rounded-lg text-[13px] bg-white min-w-[160px]">
              <option value="">All providers</option>
              {data?.options.providers.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
          <div>
            <label className="text-[10px] text-[#1A1A2E]/60 uppercase tracking-wide block mb-0.5">Denominator</label>
            <div className="inline-flex rounded-lg border border-[#E8E8E4] overflow-hidden">
              <button onClick={() => setMode('net')}
                className={`px-3 py-1.5 text-[12px] ${mode === 'net' ? 'bg-[#7F77DD] text-white font-semibold' : 'bg-white text-[#1A1A2E]'}`}>
                Allowed (net)
              </button>
              <button onClick={() => setMode('gross')}
                className={`px-3 py-1.5 text-[12px] ${mode === 'gross' ? 'bg-[#7F77DD] text-white font-semibold' : 'bg-white text-[#1A1A2E]'}`}>
                Billed (gross)
              </button>
            </div>
          </div>
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
          {/* Headline tiles */}
          <section className="mb-6">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <HeadlineTile label={`Net collection rate (day 90)`} value={fmtPct(data.headline.net_collection_rate_90)}
                sub={data.headline.reference_month ? `from ${data.headline.reference_month}` : 'not enough data yet'} color="#1D9E75" />
              <HeadlineTile label="Allowed per visit" value={fmtMoney(data.headline.allowed_per_visit)}
                sub={data.headline.reference_month ? `in ${data.headline.reference_month}` : '—'} color="#31447A" />
              <HeadlineTile label="Collected per visit (day 90)" value={fmtMoney(data.headline.collected_per_visit_90)}
                sub={data.headline.reference_month ? `in ${data.headline.reference_month}` : '—'} color="#1A1A2E" />
              <HeadlineTile label="Days to get paid"
                value={data.headline.avg_days_to_final_payment != null ? `${data.headline.avg_days_to_final_payment}d` : '—'}
                sub="avg from DOS to final payment" color="#B45309" />
            </div>
          </section>

          {/* Table */}
          <section>
            <div className="flex items-center justify-between mb-2">
              <h2 className="font-display text-[16px] font-semibold text-[#1A1A2E]">
                Last 12 months (newest first)
              </h2>
              <Button variant="secondary" size="xs" onClick={downloadCsv}>
                <Download size={11} /> CSV
              </Button>
            </div>
            <div className="text-[12px] text-[#1A1A2E]/70 italic mb-2">
              Each payment credited to the visit it paid for. Cells shade green as % rises; red border = more than 10 points below the prior 3-month avg at the same day mark.
            </div>
            <div className="bg-white border border-[#E8E8E4] rounded-xl overflow-x-auto">
              <table className="w-full text-[13px]">
                <thead className="bg-[#FAFAF8] text-[11px] uppercase tracking-wide text-[#1A1A2E]">
                  <tr className="border-b border-[#E8E8E4]">
                    <th className="text-left px-3 py-2">Month</th>
                    <th className="text-right px-3 py-2">Visits</th>
                    <th className="text-right px-3 py-2">Billed</th>
                    <th className="text-right px-3 py-2">Allowed</th>
                    <th className="text-right px-3 py-2">Collected</th>
                    <th className="text-center px-3 py-2">% by 30</th>
                    <th className="text-center px-3 py-2">% by 60</th>
                    <th className="text-center px-3 py-2">% by 90</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#F1EFE8]">
                  {data.months.map(m => (
                    <tr key={m.month}>
                      <td className="px-3 py-2 text-[#1A1A2E] font-medium">{m.label}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{m.visits}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{fmtMoney(m.billed)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {m.allowed_known > 0 ? fmtMoney(m.allowed_known) : '—'}
                        {m.allowed_pending_count > 0 && (
                          <div className="text-[10px] text-[#B45309] italic">+ {m.allowed_pending_count} pending</div>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{fmtMoney(m.collected_total)}</td>
                      {([30, 60, 90] as const).map(day => {
                        const status = cellStatus(m, day)
                        const pct = rateFor(m, day, mode)
                        const flag = flagMask[m.month]?.[day === 30 ? 'd30' : day === 60 ? 'd60' : 'd90']
                        if (status === 'not_yet') return (
                          <td key={day} className="px-3 py-2 text-center text-[11px] text-[#1A1A2E]/50 italic">Not yet</td>
                        )
                        const { bg, fg } = heatColor(pct)
                        return (
                          <td key={day} className="px-3 py-2 text-center tabular-nums font-semibold"
                            style={{
                              backgroundColor: bg, color: fg,
                              boxShadow: flag ? 'inset 0 0 0 2px #991B1B' : undefined,
                            }}
                            title={flag ? 'More than 10 points below prior 3-month avg' : undefined}>
                            {fmtPct(pct)}
                            {status === 'filling_in' && <div className="text-[10px] font-normal italic opacity-80">filling in</div>}
                          </td>
                        )
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </div>
  )
}

function HeadlineTile({ label, value, sub, color }: { label: string; value: string; sub?: string; color: string }) {
  return (
    <div className="bg-white border border-[#E8E8E4] rounded-xl p-4">
      <div className="text-[11px] text-[#1A1A2E] uppercase tracking-wide">{label}</div>
      <div className="font-display text-[22px] font-semibold tabular-nums mt-0.5" style={{ color }}>{value}</div>
      {sub && <div className="text-[11px] text-[#1A1A2E]/60 mt-0.5">{sub}</div>}
    </div>
  )
}
