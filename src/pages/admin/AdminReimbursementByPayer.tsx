// Reimbursement-by-payer pivot. Rows: visit types. Columns: payer
// buckets (business-level groupings per the ERA normalization rule).
// Each cell = average allowable per claim, with count.
//
// Default window = year to date. Allowable = amount_billed_era
// - contractual_adjustment_era, which equals insurance_payment +
// patient_responsibility per the 835 identity. Only ERAs received
// are counted. Self-pay excluded. Sara 2026-11-08.

import { useEffect, useState } from 'react'
import { Download, RefreshCw } from 'lucide-react'
import { apiFetch } from '../../lib/api'

type Cell = { n: number; avg_allowable: number; total_allowable: number }
type ReimbursementData = {
  start: string
  end: string
  visit_types: string[]
  payers: string[]
  cells: Record<string, Record<string, Cell>>
  payer_totals: Record<string, Cell>
  visit_type_totals: Record<string, Cell>
  grand: { n: number; avg_allowable: number; total_allowable: number }
}

function money(n: number): string {
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD' })
}

// Distinct palette for the payer-mix bar. Repeats after 10 payers;
// in practice PHC has 8-10 payer buckets so no reuse within one report.
const MIX_COLORS = ['#7F77DD', '#1D9E75', '#EF9F27', '#378ADD', '#D4537E', '#C0392B', '#0F6E56', '#8B5CF6', '#F97316', '#0EA5E9']

function toCsv(data: ReimbursementData): string {
  const header = ['Visit type', ...data.payers, 'Row total (avg)', 'Row total (n)']
  const rows: string[][] = [header]
  for (const vt of data.visit_types) {
    const row = [vt]
    for (const p of data.payers) {
      const c = data.cells[vt]?.[p]
      row.push(c ? `${c.avg_allowable.toFixed(2)} (n=${c.n})` : '')
    }
    const rt = data.visit_type_totals[vt]
    row.push(rt ? rt.avg_allowable.toFixed(2) : '')
    row.push(rt ? String(rt.n) : '')
    rows.push(row)
  }
  const footer = ['Column total (avg)']
  for (const p of data.payers) {
    const t = data.payer_totals[p]
    footer.push(t ? t.avg_allowable.toFixed(2) : '')
  }
  footer.push(data.grand.avg_allowable.toFixed(2))
  footer.push(String(data.grand.n))
  rows.push(footer)
  return rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n')
}

export function AdminReimbursementByPayer() {
  const today = new Date()
  const defaultStart = `${today.getFullYear()}-01-01`
  const defaultEnd = today.toISOString().slice(0, 10)

  const [start, setStart] = useState(defaultStart)
  const [end, setEnd] = useState(defaultEnd)
  const [data, setData] = useState<ReimbursementData | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function load() {
    setLoading(true); setError(null)
    try {
      const d = await apiFetch<ReimbursementData>(
        `/api/admin/reimbursement-by-visit-payer?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`
      )
      setData(d)
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load report')
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { void load() /* eslint-disable-line react-hooks/exhaustive-deps */ }, [])

  function downloadCsv() {
    if (!data) return
    const csv = toCsv(data)
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `reimbursement-${start}_to_${end}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div>
      {/* Header + controls */}
      <div className="flex items-start justify-between mb-6 flex-wrap gap-4">
        <div>
          <h1 className="font-display text-xl font-semibold text-[#1A1A2E]">Reimbursement by payer</h1>
          <p className="text-[12px] text-[#1A1A2E]/70 mt-0.5 max-w-2xl">
            Average allowable per visit type, broken down by payer. "Allowable" = insurance payment + patient responsibility (what we will collect in total). Self-pay excluded. Claims with ERA received but <strong>zero allowable</strong> (pure denials / pending reworks) excluded so one rejection doesn't pull the average down.
          </p>
        </div>
        <div className="flex items-end gap-2 flex-wrap">
          <div>
            <label className="text-[10px] text-[#1A1A2E]/60 uppercase tracking-wide block mb-0.5">Start</label>
            <input type="date" value={start} onChange={e => setStart(e.target.value)}
              className="px-2.5 py-1.5 border border-[#E8E8E4] rounded-lg text-[13px] bg-white" />
          </div>
          <div>
            <label className="text-[10px] text-[#1A1A2E]/60 uppercase tracking-wide block mb-0.5">End</label>
            <input type="date" value={end} onChange={e => setEnd(e.target.value)}
              className="px-2.5 py-1.5 border border-[#E8E8E4] rounded-lg text-[13px] bg-white" />
          </div>
          <button onClick={load} disabled={loading}
            className="flex items-center gap-1.5 px-3 py-2 text-[12px] font-medium text-white bg-[#7F77DD] rounded-lg hover:bg-[#6C64C8] transition-colors disabled:opacity-50">
            <RefreshCw size={13} className={loading ? 'animate-spin' : ''} /> Run
          </button>
          <button onClick={downloadCsv} disabled={!data}
            className="flex items-center gap-1.5 px-3 py-2 text-[12px] font-medium text-[#1A1A2E] border border-[#E8E8E4] rounded-lg hover:bg-[#F8F8F4] transition-colors disabled:opacity-50">
            <Download size={13} /> CSV
          </button>
        </div>
      </div>

      {error && <div className="mb-4 text-[13px] text-red-600 bg-[#FCEBEB] border border-[#F5C6C6] px-3 py-2 rounded-lg">{error}</div>}
      {loading && !data && <div className="text-[13px] text-[#1A1A2E]/60 py-16 text-center">Running report…</div>}

      {data && (
        <>
          {/* Summary bar */}
          <div className="flex flex-wrap items-center gap-6 mb-5 text-[12px] text-[#1A1A2E]">
            <div>
              <span className="text-[#1A1A2E]/60">Window:</span>{' '}
              <span className="font-medium">{data.start} → {data.end}</span>
            </div>
            <div>
              <span className="text-[#1A1A2E]/60">Claims counted:</span>{' '}
              <span className="font-medium">{data.grand.n}</span>
            </div>
            <div>
              <span className="text-[#1A1A2E]/60">Grand avg allowable:</span>{' '}
              <span className="font-semibold">{money(data.grand.avg_allowable)}</span>
            </div>
            <div>
              <span className="text-[#1A1A2E]/60">Total allowable:</span>{' '}
              <span className="font-medium">{money(data.grand.total_allowable)}</span>
            </div>
          </div>

          {/* Payer mix — horizontal stacked bar with legend. Ordered by
              total revenue descending so the biggest slice is first. */}
          {(() => {
            const mix = data.payers
              .map(p => ({ payer: p, total: data.payer_totals[p]?.total_allowable ?? 0, n: data.payer_totals[p]?.n ?? 0 }))
              .sort((a, b) => b.total - a.total)
              .map(p => ({ ...p, pct: data.grand.total_allowable ? (p.total / data.grand.total_allowable) * 100 : 0 }))
            if (mix.length === 0 || data.grand.total_allowable === 0) return null
            return (
              <div className="mb-5">
                <div className="text-[11px] uppercase tracking-wide text-[#1A1A2E]/60 mb-1.5">Payer mix (% of total allowable)</div>
                <div className="flex h-7 rounded-md overflow-hidden border border-[#E8E8E4] bg-white">
                  {mix.map((p, i) => (
                    <div
                      key={p.payer}
                      style={{ width: `${p.pct}%`, background: MIX_COLORS[i % MIX_COLORS.length] }}
                      title={`${p.payer}: ${money(p.total)} · ${p.pct.toFixed(1)}% · ${p.n} claims`}
                      className="h-full first:rounded-l-md last:rounded-r-md"
                    />
                  ))}
                </div>
                <div className="flex flex-wrap gap-x-4 gap-y-1.5 mt-2 text-[11px] text-[#1A1A2E]">
                  {mix.map((p, i) => (
                    <div key={p.payer} className="flex items-center gap-1.5">
                      <div className="w-2.5 h-2.5 rounded-sm flex-shrink-0" style={{ background: MIX_COLORS[i % MIX_COLORS.length] }} />
                      <span className="font-medium">{p.payer}</span>
                      <span className="text-[#1A1A2E]/60 tabular-nums">{p.pct.toFixed(1)}% · {money(p.total)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )
          })()}

          {/* Pivot table */}
          {data.visit_types.length === 0 ? (
            <div className="bg-white border border-[#E8E8E4] rounded-xl px-6 py-12 text-center text-[13px] text-[#1A1A2E]/60">
              No claims with ERA in this window.
            </div>
          ) : (
            <div className="bg-white border border-[#E8E8E4] rounded-xl overflow-auto">
              <table className="w-full text-[12px]">
                <thead className="bg-[#F8F8F4]">
                  <tr>
                    <th className="text-left px-4 py-2.5 font-medium text-[#1A1A2E] sticky left-0 bg-[#F8F8F4] z-10">Visit type</th>
                    {data.payers.map(p => (
                      <th key={p} className="text-right px-3 py-2.5 font-medium text-[#1A1A2E] whitespace-nowrap">{p}</th>
                    ))}
                    <th className="text-right px-3 py-2.5 font-semibold text-[#1A1A2E] bg-[#EEEDFE] whitespace-nowrap">Row avg</th>
                  </tr>
                </thead>
                <tbody>
                  {data.visit_types.map(vt => {
                    const rt = data.visit_type_totals[vt]
                    return (
                      <tr key={vt} className="border-t border-[#F1EFE8]">
                        <td className="px-4 py-2 text-[#1A1A2E] sticky left-0 bg-white z-10">{vt}</td>
                        {data.payers.map(p => {
                          const c = data.cells[vt]?.[p]
                          return (
                            <td key={p} className="text-right px-3 py-2 tabular-nums">
                              {c ? (
                                <>
                                  <div className="font-medium text-[#1A1A2E]">{money(c.avg_allowable)}</div>
                                  <div className="text-[10px] text-[#1A1A2E]/55">n={c.n}</div>
                                </>
                              ) : (
                                <span className="text-[#1A1A2E]/25">—</span>
                              )}
                            </td>
                          )
                        })}
                        <td className="text-right px-3 py-2 tabular-nums bg-[#EEEDFE]/40">
                          <div className="font-semibold text-[#1A1A2E]">{rt ? money(rt.avg_allowable) : '—'}</div>
                          <div className="text-[10px] text-[#1A1A2E]/55">n={rt?.n ?? 0}</div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 border-[#1A1A2E]/15 bg-[#F8F8F4]">
                    <td className="px-4 py-2.5 font-semibold text-[#1A1A2E] sticky left-0 bg-[#F8F8F4] z-10">Column avg</td>
                    {data.payers.map(p => {
                      const t = data.payer_totals[p]
                      return (
                        <td key={p} className="text-right px-3 py-2.5 tabular-nums">
                          <div className="font-semibold text-[#1A1A2E]">{t ? money(t.avg_allowable) : '—'}</div>
                          <div className="text-[10px] text-[#1A1A2E]/55">n={t?.n ?? 0}</div>
                        </td>
                      )
                    })}
                    <td className="text-right px-3 py-2.5 tabular-nums bg-[#EEEDFE]">
                      <div className="font-bold text-[#1A1A2E]">{money(data.grand.avg_allowable)}</div>
                      <div className="text-[10px] text-[#1A1A2E]/55">n={data.grand.n}</div>
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  )
}
