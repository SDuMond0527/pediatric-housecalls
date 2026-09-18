import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { format, startOfMonth, subMonths } from 'date-fns'
import { RefreshCw, Download, DollarSign, Users, TrendingUp, Percent, RotateCcw, PieChart, HandCoins, XCircle } from 'lucide-react'
import { getFinancialReports, type ArBucket } from '../../lib/api'
import { ChartNumberPill } from '../../components/ChartNumberPill'
import { ArDrillModal } from './ArDrillModal'
import { PatientStatementModal } from './PatientStatementModal'

type DrillTarget = {
  type: 'insurance' | 'patient'
  group: string
  groupLabel: string
  bucket: ArBucket
  bucketLabel: string
  cellValue: number
}

type ReportsData = Awaited<ReturnType<typeof getFinancialReports>>

function fmtMoney(n: any) {
  const v = parseFloat(String(n ?? 0))
  return isNaN(v) ? '$0.00' : `$${v.toFixed(2)}`
}
function fmtDay(d: string | null) {
  if (!d) return '—'
  try {
    const [y, m, day] = d.split('-').map(Number)
    return format(new Date(y, m - 1, day), 'MMM d, yyyy')
  } catch { return d }
}
function toCsv(rows: any[], headers: { key: string; label: string }[]): string {
  const escape = (v: any) => {
    const s = v == null ? '' : String(v)
    return /[,"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const head = headers.map(h => escape(h.label)).join(',')
  const body = rows.map(r => headers.map(h => escape(r[h.key])).join(',')).join('\n')
  return head + '\n' + body
}
function downloadCsv(filename: string, csv: string) {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a'); a.href = url; a.download = filename; a.click()
  URL.revokeObjectURL(url)
}

export function AdminFinancialReports() {
  const today = new Date()
  const navigate = useNavigate()
  const [start, setStart] = useState(format(startOfMonth(subMonths(today, 2)), 'yyyy-MM-dd'))
  const [end, setEnd]     = useState(format(today, 'yyyy-MM-dd'))
  const [data, setData]   = useState<ReportsData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [drill, setDrill] = useState<DrillTarget | null>(null)
  // When the biller clicks a statement in the patient AR drill, we open
  // the shared PatientStatementModal inline — it expects a claim-shaped
  // object (id + snapshot fields), which the drill row already carries.
  const [statementTarget, setStatementTarget] = useState<any | null>(null)

  async function load() {
    setLoading(true); setError(null)
    try { setData(await getFinancialReports(start, end)) }
    catch (e: any) { setError(e?.message ?? 'Failed to load reports') }
    finally { setLoading(false) }
  }
  useEffect(() => { load() }, [])

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <div className="flex items-start justify-between mb-6 flex-wrap gap-4">
        <div>
          <h1 className="font-display text-xl font-semibold text-[#1A1A2E]">Financial reports</h1>
          <p className="text-[12px] text-[#1A1A2E]/70 mt-0.5">
            The month-end suite a bookkeeper uses to close the books and understand the health of your practice.
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
        </div>
      </div>

      {error && <div className="mb-4 text-[13px] text-red-600 bg-[#FCEBEB] border border-[#F5C6C6] px-3 py-2 rounded-lg">{error}</div>}
      {loading && !data && <div className="text-[13px] text-[#1A1A2E]/60 py-16 text-center">Running reports…</div>}

      {data && (
        <div className="space-y-8">
          <ArAgingSection
            title="AR aging — insurance"
            icon={Users}
            plainEnglish="Money that insurance companies still owe you, sorted by how long you've been waiting. Numbers in the &quot;120+&quot; column are the ones your biller should chase first — anything past 90 days is at risk of hitting the payer's filing deadline."
            rows={data.ar_insurance}
            groupLabel="Payer"
            groupKey="payer_name"
            countKey="claim_count"
            filenameStem="ar-aging-insurance"
            drillType="insurance"
            onDrill={setDrill}
          />

          <ArAgingSection
            title="AR aging — patient"
            icon={Users}
            plainEnglish="Money that families still owe you after their insurance paid, sorted by how long you've been waiting. Once a balance hits 60+ days, the biller usually runs the card on file (per your practice policy)."
            rows={data.ar_patient}
            groupLabel="Patient"
            groupKey="patient_name"
            countKey="statement_count"
            filenameStem="ar-aging-patient"
            drillType="patient"
            onDrill={setDrill}
          />

          <CashCollectionsSection data={data} start={start} end={end} />

          <ChargesVsCollectionsSection data={data} />

          <AdjustmentsSection data={data} />

          <RefundsSection data={data} />

          {/* ── Phase 2: practice health ─────────────────────────────── */}
          <div className="pt-4 mt-2 border-t border-[#E8E8E4]">
            <div className="text-[11px] font-semibold text-[#7F77DD] uppercase tracking-wider mb-1">Practice health (quarterly review)</div>
            <p className="text-[12px] text-[#1A1A2E]/70">Reports below are less about closing the month and more about spotting trends — payer concentration, contract quality, and problem payers.</p>
          </div>

          <PayerMixSection data={data} />
          <ReimbursementByPayerSection data={data} />
          <DenialsByPayerSection data={data} />
        </div>
      )}

      {drill && (
        <ArDrillModal
          open
          type={drill.type}
          group={drill.group}
          groupLabel={drill.groupLabel}
          bucket={drill.bucket}
          bucketLabel={drill.bucketLabel}
          cellValue={drill.cellValue}
          onClose={() => setDrill(null)}
          onOpenClaim={(claimId) => {
            setDrill(null)
            navigate(`/admin/claims?claim=${encodeURIComponent(claimId)}`)
          }}
          onOpenStatement={(row) => {
            setDrill(null)
            // PatientStatementModal expects a claim-shaped object. The
            // drill row already carries patient snapshot + claim_id; the
            // modal fetches the full statement via claim.id (which is
            // actually claim_id in this context).
            setStatementTarget({
              id: row.claim_id,
              patient_first_name: row.patient_first_name,
              patient_last_name:  row.patient_last_name,
              service_date:       row.date_of_service,
              chart_number:       row.chart_number,
            })
          }}
        />
      )}

      {statementTarget && (
        <PatientStatementModal
          claim={statementTarget}
          onClose={() => setStatementTarget(null)}
          onSent={() => { load() }}
        />
      )}
    </div>
  )
}

// ─── Reusable AR aging table ─────────────────────────────────────────────

function ArAgingSection({
  title, icon: Icon, plainEnglish, rows, groupLabel, groupKey, countKey, filenameStem,
  drillType, onDrill,
}: {
  title: string
  icon: any
  plainEnglish: string
  rows: any[]
  groupLabel: string
  groupKey: string
  countKey: string
  filenameStem: string
  drillType: 'insurance' | 'patient'
  onDrill: (t: DrillTarget) => void
}) {
  const totals = rows.reduce((acc, r) => ({
    b_0_30: acc.b_0_30 + parseFloat(r.b_0_30 ?? 0),
    b_31_60: acc.b_31_60 + parseFloat(r.b_31_60 ?? 0),
    b_61_90: acc.b_61_90 + parseFloat(r.b_61_90 ?? 0),
    b_91_120: acc.b_91_120 + parseFloat(r.b_91_120 ?? 0),
    b_120_plus: acc.b_120_plus + parseFloat(r.b_120_plus ?? 0),
    total: acc.total + parseFloat(r.total ?? 0),
    count: acc.count + parseInt(r[countKey] ?? 0, 10),
  }), { b_0_30: 0, b_31_60: 0, b_61_90: 0, b_91_120: 0, b_120_plus: 0, total: 0, count: 0 })

  // Every dollar cell (and the # count) drills into the underlying
  // rows. $0 cells are still clickable per Sara's ask — an empty
  // list is a valid answer ("nothing in 31-60 for BCBS yet").
  const cellCls = 'px-3 py-2 text-right tabular-nums cursor-pointer hover:bg-[#F0EEFA] hover:text-[#7F77DD]'
  const groupCellCls = 'px-3 py-2 text-[#1A1A2E] cursor-pointer hover:bg-[#F0EEFA] hover:text-[#7F77DD]'

  return (
    <ReportShell title={title} icon={Icon} plainEnglish={plainEnglish} onExport={() => {
      const csv = toCsv(rows, [
        { key: groupKey,   label: groupLabel },
        { key: 'b_0_30',   label: '0-30' },
        { key: 'b_31_60',  label: '31-60' },
        { key: 'b_61_90',  label: '61-90' },
        { key: 'b_91_120', label: '91-120' },
        { key: 'b_120_plus', label: '120+' },
        { key: 'total',    label: 'Total' },
        { key: countKey,   label: 'Count' },
      ])
      downloadCsv(`${filenameStem}.csv`, csv)
    }}>
      {rows.length === 0 ? (
        <div className="text-[13px] text-[#1A1A2E]/60 py-4 text-center">No outstanding balances — you're all caught up.</div>
      ) : (
        <table className="w-full text-[13px]">
          <thead>
            <tr className="border-b border-[#E8E8E4] bg-[#FAFAF8] text-[11px] text-[#1A1A2E] uppercase tracking-wide">
              <th className="text-left px-3 py-2">{groupLabel}</th>
              <th className="text-right px-3 py-2">0-30</th>
              <th className="text-right px-3 py-2">31-60</th>
              <th className="text-right px-3 py-2">61-90</th>
              <th className="text-right px-3 py-2">91-120</th>
              <th className="text-right px-3 py-2">120+</th>
              <th className="text-right px-3 py-2">Total</th>
              <th className="text-right px-3 py-2">#</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#F1EFE8]">
            {rows.map((r, i) => {
              const groupVal = r[groupKey]
              const drill = (bucket: ArBucket, bucketLabel: string, cellValue: number) =>
                onDrill({ type: drillType, group: groupVal, groupLabel: groupVal, bucket, bucketLabel, cellValue })
              return (
                <tr key={i} className="hover:bg-[#FAFAF8]">
                  <td
                    className={groupCellCls}
                    title={`See all ${drillType === 'insurance' ? 'claims' : 'statements'} for ${groupVal}`}
                    onClick={() => drill('all', 'All ages', parseFloat(r.total ?? 0))}
                  >
                    <span className="inline-flex items-center gap-2 flex-wrap">
                      <span>{groupVal}</span>
                      <ChartNumberPill value={r.chart_number} size="xs" />
                    </span>
                  </td>
                  <td className={cellCls} onClick={() => drill('0_30',     '0-30 days',   parseFloat(r.b_0_30     ?? 0))}>{fmtMoney(r.b_0_30)}</td>
                  <td className={cellCls} onClick={() => drill('31_60',    '31-60 days',  parseFloat(r.b_31_60    ?? 0))}>{fmtMoney(r.b_31_60)}</td>
                  <td className={cellCls} onClick={() => drill('61_90',    '61-90 days',  parseFloat(r.b_61_90    ?? 0))}>{fmtMoney(r.b_61_90)}</td>
                  <td className={cellCls} onClick={() => drill('91_120',   '91-120 days', parseFloat(r.b_91_120   ?? 0))}>{fmtMoney(r.b_91_120)}</td>
                  <td
                    className={`${cellCls} ${parseFloat(r.b_120_plus) > 0 ? 'text-[#991B1B] font-semibold' : ''}`}
                    onClick={() => drill('120_plus', '120+ days', parseFloat(r.b_120_plus ?? 0))}
                  >
                    {fmtMoney(r.b_120_plus)}
                  </td>
                  <td
                    className={`${cellCls} font-semibold text-[#1A1A2E]`}
                    onClick={() => drill('all', 'All ages', parseFloat(r.total ?? 0))}
                  >
                    {fmtMoney(r.total)}
                  </td>
                  <td
                    className={`${cellCls} text-[#1A1A2E]/60`}
                    onClick={() => drill('all', 'All ages', parseFloat(r.total ?? 0))}
                  >
                    {r[countKey]}
                  </td>
                </tr>
              )
            })}
            {(() => {
              const drillAll = (bucket: ArBucket, bucketLabel: string, cellValue: number) =>
                onDrill({ type: drillType, group: '__all__', groupLabel: 'All ' + (drillType === 'insurance' ? 'payers' : 'patients'), bucket, bucketLabel, cellValue })
              return (
                <tr className="border-t-2 border-[#E8E8E4] bg-[#FAFAF8] font-semibold">
                  <td
                    className="px-3 py-2 text-[#1A1A2E] cursor-pointer hover:bg-[#F0EEFA] hover:text-[#7F77DD]"
                    onClick={() => drillAll('all', 'All ages', totals.total)}
                  >
                    Total
                  </td>
                  <td className={cellCls} onClick={() => drillAll('0_30',     '0-30 days',   totals.b_0_30)}>{fmtMoney(totals.b_0_30)}</td>
                  <td className={cellCls} onClick={() => drillAll('31_60',    '31-60 days',  totals.b_31_60)}>{fmtMoney(totals.b_31_60)}</td>
                  <td className={cellCls} onClick={() => drillAll('61_90',    '61-90 days',  totals.b_61_90)}>{fmtMoney(totals.b_61_90)}</td>
                  <td className={cellCls} onClick={() => drillAll('91_120',   '91-120 days', totals.b_91_120)}>{fmtMoney(totals.b_91_120)}</td>
                  <td
                    className={`${cellCls} ${totals.b_120_plus > 0 ? 'text-[#991B1B]' : ''}`}
                    onClick={() => drillAll('120_plus', '120+ days', totals.b_120_plus)}
                  >
                    {fmtMoney(totals.b_120_plus)}
                  </td>
                  <td className={cellCls} onClick={() => drillAll('all', 'All ages', totals.total)}>{fmtMoney(totals.total)}</td>
                  <td className={`${cellCls} text-[#1A1A2E]/60`} onClick={() => drillAll('all', 'All ages', totals.total)}>{totals.count}</td>
                </tr>
              )
            })()}
          </tbody>
        </table>
      )}
    </ReportShell>
  )
}

// ─── Cash collections ─────────────────────────────────────────────────────

function CashCollectionsSection({ data, start, end }: { data: ReportsData; start: string; end: string }) {
  const insurance = parseFloat(String(data.cash_totals.insurance_total ?? 0))
  const patient   = parseFloat(String(data.cash_totals.patient_total ?? 0))
  const total     = insurance + patient
  return (
    <ReportShell
      title="Cash collections"
      icon={DollarSign}
      plainEnglish="How much money actually landed in your bank account during this window — split into what insurance paid and what parents paid. This is the number a bookkeeper reconciles against your Square + bank deposits at month-end."
      onExport={() => {
        const csv = toCsv(data.cash_by_day, [
          { key: 'day', label: 'Day' },
          { key: 'insurance_amount', label: 'Insurance' },
          { key: 'patient_amount',   label: 'Patient' },
          { key: 'total',            label: 'Total' },
        ])
        downloadCsv(`cash-collections-${start}-to-${end}.csv`, csv)
      }}>
      <div className="grid grid-cols-3 gap-3 mb-4">
        <MoneyCard label="Insurance (ERAs)"  value={fmtMoney(insurance)} color="#2D7BA6" />
        <MoneyCard label="Patient (Square + biller-recorded)" value={fmtMoney(patient)} color="#1D9E75" />
        <MoneyCard label="Total collected" value={fmtMoney(total)} color="#1A1A2E" bold />
      </div>
      {data.cash_by_day.length === 0 ? (
        <div className="text-[13px] text-[#1A1A2E]/60 py-4 text-center">No collections in this window.</div>
      ) : (
        <table className="w-full text-[13px]">
          <thead>
            <tr className="border-b border-[#E8E8E4] bg-[#FAFAF8] text-[11px] text-[#1A1A2E] uppercase tracking-wide">
              <th className="text-left px-3 py-2">Day</th>
              <th className="text-right px-3 py-2">Insurance</th>
              <th className="text-right px-3 py-2">Patient</th>
              <th className="text-right px-3 py-2">Total</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#F1EFE8]">
            {data.cash_by_day.map((r: any) => (
              <tr key={r.day} className="hover:bg-[#FAFAF8]">
                <td className="px-3 py-2 text-[#1A1A2E]">{fmtDay(r.day)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{fmtMoney(r.insurance_amount)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{fmtMoney(r.patient_amount)}</td>
                <td className="px-3 py-2 text-right font-semibold tabular-nums">{fmtMoney(r.total)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </ReportShell>
  )
}

// ─── Charges vs. collections ──────────────────────────────────────────────

function ChargesVsCollectionsSection({ data }: { data: ReportsData }) {
  const charges = parseFloat(String(data.charges_vs_collections.charges ?? 0))
  const insCol  = parseFloat(String(data.charges_vs_collections.insurance_collected ?? 0))
  const patCol  = parseFloat(String(data.charges_vs_collections.patient_collected ?? 0))
  const collected = insCol + patCol
  const rate = charges > 0 ? (collected / charges) * 100 : 0
  return (
    <ReportShell
      title="Charges vs. collections"
      icon={Percent}
      plainEnglish="For every dollar you billed, how many cents came back? A healthy in-network pediatric practice typically lands between 60% and 85%. Below that means you're leaving money on the table (denials, missed charges, contract issues). Above 100% means you collected on older claims than what you billed this month.">
      <div className="grid grid-cols-4 gap-3">
        <MoneyCard label="Charges submitted" value={fmtMoney(charges)} color="#1A1A2E" />
        <MoneyCard label="Insurance collected" value={fmtMoney(insCol)} color="#2D7BA6" />
        <MoneyCard label="Patient collected"  value={fmtMoney(patCol)} color="#1D9E75" />
        <MoneyCard label="Collection rate"    value={`${rate.toFixed(1)}%`} color={rate >= 60 ? '#1D9E75' : rate >= 40 ? '#B45309' : '#991B1B'} bold />
      </div>
    </ReportShell>
  )
}

// ─── Adjustments & write-offs ─────────────────────────────────────────────

const REASON_LABEL: Record<string, string> = {
  bad_debt:       'Bad debt',
  small_balance:  'Small balance',
  hardship:       'Courtesy / hardship',
  billing_error:  'Billing error',
  timely_filing:  'Timely filing exceeded',
  other:          'Other',
}

function AdjustmentsSection({ data }: { data: ReportsData }) {
  const adj = parseFloat(String(data.adjustments.contractual_adjustments ?? 0))
  const woffStatement = parseFloat(String(data.adjustments.write_offs ?? 0))
  const claimWoffTotal = (data.write_offs_claim_by_reason ?? []).reduce((s, r: any) => s + parseFloat(String(r.amount ?? 0)), 0)
  const totalWoff = woffStatement + claimWoffTotal
  return (
    <ReportShell
      title="Adjustments & write-offs"
      icon={TrendingUp}
      plainEnglish="What insurance discounted from your bills (contractual adjustment — normal, that's your negotiated rate) and what you had to write off entirely, split by REASON. If &quot;Bad debt&quot; or &quot;Timely filing&quot; is climbing, that's a collections / workflow problem to fix. Small balances and hardship write-offs are usually healthy business decisions."
      onExport={() => {
        const rows = [
          ...(data.write_offs_statement_by_reason ?? []).map((r: any) => ({ side: 'Patient statement', ...r })),
          ...(data.write_offs_claim_by_reason ?? []).map((r: any) => ({ side: 'Insurance claim', ...r })),
        ]
        const csv = toCsv(rows, [
          { key: 'side',   label: 'Side' },
          { key: 'reason', label: 'Reason' },
          { key: 'count',  label: 'Count' },
          { key: 'amount', label: 'Amount' },
        ])
        downloadCsv('write-offs-by-reason.csv', csv)
      }}>
      <div className="grid grid-cols-3 gap-3 mb-4">
        <MoneyCard label="Contractual adjustments (normal payer discounts)" value={fmtMoney(adj)} color="#B45309" />
        <MoneyCard label={`Statement write-offs (${data.adjustments.write_off_count})`} value={fmtMoney(woffStatement)} color="#991B1B" />
        <MoneyCard label="Claim write-offs" value={fmtMoney(claimWoffTotal)} color="#991B1B" />
      </div>

      {totalWoff > 0 && (
        <div className="mb-6">
          <div className="text-[11px] font-semibold text-[#1A1A2E] uppercase tracking-wide mb-2">Write-offs by reason</div>
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-b border-[#E8E8E4] bg-[#FAFAF8] text-[11px] text-[#1A1A2E] uppercase tracking-wide">
                <th className="text-left px-3 py-2">Side</th>
                <th className="text-left px-3 py-2">Reason</th>
                <th className="text-right px-3 py-2">Count</th>
                <th className="text-right px-3 py-2">Amount</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#F1EFE8]">
              {(data.write_offs_statement_by_reason ?? []).map((r: any, i: number) => (
                <tr key={`stmt-${i}`} className="hover:bg-[#FAFAF8]">
                  <td className="px-3 py-2 text-[#555]">Patient statement</td>
                  <td className="px-3 py-2 text-[#1A1A2E]">{REASON_LABEL[r.reason] ?? r.reason}</td>
                  <td className="px-3 py-2 text-right text-[#1A1A2E]/60 tabular-nums">{r.count}</td>
                  <td className="px-3 py-2 text-right font-semibold text-[#991B1B] tabular-nums">{fmtMoney(r.amount)}</td>
                </tr>
              ))}
              {(data.write_offs_claim_by_reason ?? []).map((r: any, i: number) => (
                <tr key={`claim-${i}`} className="hover:bg-[#FAFAF8]">
                  <td className="px-3 py-2 text-[#555]">Insurance claim</td>
                  <td className="px-3 py-2 text-[#1A1A2E]">{REASON_LABEL[r.reason] ?? r.reason}</td>
                  <td className="px-3 py-2 text-right text-[#1A1A2E]/60 tabular-nums">{r.count}</td>
                  <td className="px-3 py-2 text-right font-semibold text-[#991B1B] tabular-nums">{fmtMoney(r.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {data.adjustments_by_payer.length > 0 && (
        <>
          <div className="text-[11px] font-semibold text-[#1A1A2E] uppercase tracking-wide mb-2">Contractual adjustments by payer</div>
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-b border-[#E8E8E4] bg-[#FAFAF8] text-[11px] text-[#1A1A2E] uppercase tracking-wide">
                <th className="text-left px-3 py-2">Payer</th>
                <th className="text-right px-3 py-2">Adjustment</th>
                <th className="text-right px-3 py-2">Claims</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#F1EFE8]">
              {data.adjustments_by_payer.map((r: any, i: number) => (
                <tr key={i} className="hover:bg-[#FAFAF8]">
                  <td className="px-3 py-2 text-[#1A1A2E]">{r.payer_name}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{fmtMoney(r.contractual_adjustment)}</td>
                  <td className="px-3 py-2 text-right text-[#1A1A2E]/60 tabular-nums">{r.claim_count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </ReportShell>
  )
}

// ─── Refunds ──────────────────────────────────────────────────────────────

function RefundsSection({ data }: { data: ReportsData }) {
  return (
    <ReportShell
      title="Refunds / overpayments"
      icon={RotateCcw}
      plainEnglish="Statements where the parent paid more than what was owed. Usually happens when insurance ends up covering more than expected after the family already paid. These families are due a refund."
      onExport={() => {
        const csv = toCsv(data.refunds, [
          { key: 'patient_first_name', label: 'First name' },
          { key: 'patient_last_name',  label: 'Last name' },
          { key: 'paid_at',            label: 'Paid on' },
          { key: 'total_amount_due',   label: 'Amount due' },
          { key: 'paid_amount_cents',  label: 'Amount paid (cents)' },
          { key: 'overpayment',        label: 'Overpayment' },
        ])
        downloadCsv('refunds-overpayments.csv', csv)
      }}>
      {data.refunds.length === 0 ? (
        <div className="text-[13px] text-[#1A1A2E]/60 py-4 text-center">No overpayments in this window.</div>
      ) : (
        <table className="w-full text-[13px]">
          <thead>
            <tr className="border-b border-[#E8E8E4] bg-[#FAFAF8] text-[11px] text-[#1A1A2E] uppercase tracking-wide">
              <th className="text-left px-3 py-2">Patient</th>
              <th className="text-left px-3 py-2">Paid on</th>
              <th className="text-right px-3 py-2">Owed</th>
              <th className="text-right px-3 py-2">Paid</th>
              <th className="text-right px-3 py-2">Overpayment</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#F1EFE8]">
            {data.refunds.map((r: any) => (
              <tr key={r.statement_id} className="hover:bg-[#FAFAF8]">
                <td className="px-3 py-2 text-[#1A1A2E]">{[r.patient_first_name, r.patient_last_name].filter(Boolean).join(' ')}</td>
                <td className="px-3 py-2 text-[#1A1A2E]">{fmtDay(String(r.paid_at ?? '').slice(0, 10))}</td>
                <td className="px-3 py-2 text-right tabular-nums">{fmtMoney(r.total_amount_due)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{fmtMoney((r.paid_amount_cents ?? 0) / 100)}</td>
                <td className="px-3 py-2 text-right font-semibold text-[#991B1B] tabular-nums">{fmtMoney(r.overpayment)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </ReportShell>
  )
}

// ─── Payer mix ────────────────────────────────────────────────────────────

function PayerMixSection({ data }: { data: ReportsData }) {
  const rows = data.payer_mix
  return (
    <ReportShell
      title="Payer mix"
      icon={PieChart}
      plainEnglish="What share of your visits (and dollars billed) go to each payer. If any single payer is above 40%, your practice is heavily dependent on that contract — worth knowing before you negotiate."
      onExport={() => {
        const csv = toCsv(rows, [
          { key: 'payer_name',      label: 'Payer' },
          { key: 'claim_count',     label: 'Claims' },
          { key: 'pct_of_claims',   label: '% of claims' },
          { key: 'total_charged',   label: 'Total charged' },
          { key: 'pct_of_charges',  label: '% of charges' },
        ])
        downloadCsv('payer-mix.csv', csv)
      }}>
      {rows.length === 0 ? (
        <div className="text-[13px] text-[#1A1A2E]/60 py-4 text-center">No claims with a service date in this window.</div>
      ) : (
        <table className="w-full text-[13px]">
          <thead>
            <tr className="border-b border-[#E8E8E4] bg-[#FAFAF8] text-[11px] text-[#1A1A2E] uppercase tracking-wide">
              <th className="text-left px-3 py-2">Payer</th>
              <th className="text-right px-3 py-2">Claims</th>
              <th className="text-right px-3 py-2">% of claims</th>
              <th className="text-right px-3 py-2">Charged</th>
              <th className="text-right px-3 py-2">% of $</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#F1EFE8]">
            {rows.map((r: any, i: number) => {
              const claimsPct = parseFloat(String(r.pct_of_claims ?? 0))
              const claimsHigh = claimsPct >= 40
              return (
                <tr key={i} className="hover:bg-[#FAFAF8]">
                  <td className="px-3 py-2 text-[#1A1A2E]">{r.payer_name}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{r.claim_count}</td>
                  <td className={`px-3 py-2 text-right tabular-nums ${claimsHigh ? 'text-[#991B1B] font-semibold' : ''}`}>{claimsPct.toFixed(1)}%</td>
                  <td className="px-3 py-2 text-right tabular-nums">{fmtMoney(r.total_charged)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{parseFloat(String(r.pct_of_charges ?? 0)).toFixed(1)}%</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </ReportShell>
  )
}

// ─── Reimbursement by payer × visit type ──────────────────────────────────

function ReimbursementByPayerSection({ data }: { data: ReportsData }) {
  const rows = data.reimbursement_by_payer
  return (
    <ReportShell
      title="Reimbursement by payer"
      icon={HandCoins}
      plainEnglish="For visits where insurance paid, what each payer actually gave you for each visit type. Compare the &quot;% of charges&quot; column across payers — a payer paying 30% on a sick visit vs. another paying 65% is your negotiation talking point."
      onExport={() => {
        const csv = toCsv(rows, [
          { key: 'payer_name',     label: 'Payer' },
          { key: 'visit_type',     label: 'Visit type' },
          { key: 'claim_count',    label: 'Claims' },
          { key: 'avg_charged',    label: 'Avg charged' },
          { key: 'avg_paid',       label: 'Avg paid' },
          { key: 'avg_adjustment', label: 'Avg adjustment' },
          { key: 'payment_pct',    label: '% of charges' },
        ])
        downloadCsv('reimbursement-by-payer.csv', csv)
      }}>
      {rows.length === 0 ? (
        <div className="text-[13px] text-[#1A1A2E]/60 py-4 text-center">No ERAs received in this window — nothing to reimburse-analyze yet.</div>
      ) : (
        <table className="w-full text-[13px]">
          <thead>
            <tr className="border-b border-[#E8E8E4] bg-[#FAFAF8] text-[11px] text-[#1A1A2E] uppercase tracking-wide">
              <th className="text-left px-3 py-2">Payer</th>
              <th className="text-left px-3 py-2">Visit type</th>
              <th className="text-right px-3 py-2">Claims</th>
              <th className="text-right px-3 py-2">Avg charged</th>
              <th className="text-right px-3 py-2">Avg paid</th>
              <th className="text-right px-3 py-2">Adjustment</th>
              <th className="text-right px-3 py-2">% paid</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#F1EFE8]">
            {rows.map((r: any, i: number) => {
              const pct = parseFloat(String(r.payment_pct ?? 0))
              const color = pct >= 60 ? 'text-[#1D9E75]' : pct >= 40 ? 'text-[#B45309]' : 'text-[#991B1B]'
              return (
                <tr key={i} className="hover:bg-[#FAFAF8]">
                  <td className="px-3 py-2 text-[#1A1A2E]">{r.payer_name}</td>
                  <td className="px-3 py-2 text-[#555]">{r.visit_type}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{r.claim_count}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{fmtMoney(r.avg_charged)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{fmtMoney(r.avg_paid)}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-[#B45309]">{fmtMoney(r.avg_adjustment)}</td>
                  <td className={`px-3 py-2 text-right font-semibold tabular-nums ${color}`}>{pct.toFixed(1)}%</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </ReportShell>
  )
}

// ─── Denials by payer ────────────────────────────────────────────────────

function DenialsByPayerSection({ data }: { data: ReportsData }) {
  const rows = data.denials_by_payer
  return (
    <ReportShell
      title="Denial rate by payer"
      icon={XCircle}
      plainEnglish="For claims you sent to each payer, how often they either bounced back with an error, denied, or paid $0. Anything above 5-10% is a problem to investigate — usually wrong payer ID, missing subscriber info, or a coding issue the biller needs to fix."
      onExport={() => {
        const csv = toCsv(rows, [
          { key: 'payer_name',       label: 'Payer' },
          { key: 'total_submitted',  label: 'Submitted' },
          { key: 'paid_count',       label: 'Paid' },
          { key: 'error_count',      label: 'Errored' },
          { key: 'denied_count',     label: 'Denied' },
          { key: 'zero_pay_count',   label: 'Zero-pay' },
          { key: 'denial_rate_pct',  label: 'Denial %' },
        ])
        downloadCsv('denials-by-payer.csv', csv)
      }}>
      {rows.length === 0 ? (
        <div className="text-[13px] text-[#1A1A2E]/60 py-4 text-center">No claims submitted in this window.</div>
      ) : (
        <table className="w-full text-[13px]">
          <thead>
            <tr className="border-b border-[#E8E8E4] bg-[#FAFAF8] text-[11px] text-[#1A1A2E] uppercase tracking-wide">
              <th className="text-left px-3 py-2">Payer</th>
              <th className="text-right px-3 py-2">Submitted</th>
              <th className="text-right px-3 py-2">Paid</th>
              <th className="text-right px-3 py-2">Errored</th>
              <th className="text-right px-3 py-2">Denied</th>
              <th className="text-right px-3 py-2">Zero-pay</th>
              <th className="text-right px-3 py-2">Denial %</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#F1EFE8]">
            {rows.map((r: any, i: number) => {
              const denialPct = parseFloat(String(r.denial_rate_pct ?? 0))
              const color = denialPct >= 10 ? 'text-[#991B1B]' : denialPct >= 5 ? 'text-[#B45309]' : 'text-[#1D9E75]'
              return (
                <tr key={i} className="hover:bg-[#FAFAF8]">
                  <td className="px-3 py-2 text-[#1A1A2E]">{r.payer_name}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{r.total_submitted}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-[#1D9E75]">{r.paid_count}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{r.error_count}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{r.denied_count}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{r.zero_pay_count}</td>
                  <td className={`px-3 py-2 text-right font-semibold tabular-nums ${color}`}>{denialPct.toFixed(1)}%</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </ReportShell>
  )
}

// ─── Building blocks ──────────────────────────────────────────────────────

function ReportShell({
  title, icon: Icon, plainEnglish, onExport, children,
}: {
  title: string
  icon: any
  plainEnglish: string
  onExport?: () => void
  children: React.ReactNode
}) {
  return (
    <section className="bg-white border border-[#E8E8E4] rounded-xl p-5 shadow-sm">
      <div className="flex items-start justify-between mb-2 gap-4">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-[#7F77DD]/10 flex items-center justify-center">
            <Icon size={16} className="text-[#7F77DD]" />
          </div>
          <h2 className="font-display text-[16px] font-semibold text-[#1A1A2E]">{title}</h2>
        </div>
        {onExport && (
          <button onClick={onExport}
            className="flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-medium text-[#666] border border-[#E8E8E4] rounded-lg hover:bg-[#F1EFE8] transition-colors">
            <Download size={11} /> CSV
          </button>
        )}
      </div>
      <p className="text-[12px] text-[#1A1A2E]/70 mb-4 italic">{plainEnglish}</p>
      {children}
    </section>
  )
}

function MoneyCard({ label, value, color, bold }: { label: string; value: string; color: string; bold?: boolean }) {
  return (
    <div className="bg-[#FAFAF8] border border-[#E8E8E4] rounded-xl p-3">
      <div className="text-[10px] font-semibold text-[#1A1A2E]/60 uppercase tracking-wide mb-1">{label}</div>
      <div className={`font-display text-[20px] tabular-nums ${bold ? 'font-bold' : 'font-semibold'}`} style={{ color }}>{value}</div>
    </div>
  )
}
