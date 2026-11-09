import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { format, startOfMonth, subMonths } from 'date-fns'
import { RefreshCw, Download, DollarSign, Users, TrendingUp, Percent, RotateCcw, PieChart, HandCoins, XCircle } from 'lucide-react'
import { getFinancialReports, getArDrill, apiFetch, type ArBucket } from '../../lib/api'
import { ChartNumberPill } from '../../components/ChartNumberPill'
import { ArDrillModal } from './ArDrillModal'
import { PatientStatementModal } from './PatientStatementModal'
import { ClaimReviewModal } from './ClaimReviewModal'
import { AdminClaimsPipeline } from './AdminClaimsPipeline'
import { AdminCollectionsByMonth } from './AdminCollectionsByMonth'

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
function toCsv(rows: any[], headers: { key: string; label: string }[], meta?: { title?: string; periodStart?: string; periodEnd?: string }): string {
  const escape = (v: any) => {
    const s = v == null ? '' : String(v)
    return /[,"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const head = headers.map(h => escape(h.label)).join(',')
  const body = rows.map(r => headers.map(h => escape(r[h.key])).join(',')).join('\n')
  // Optional header lines above the column headers, so a printed CSV
  // identifies itself: report title, period covered, generated-on date.
  // Sara 2026-10-01 — bookkeeping needs the month/period on the sheet
  // so months don't blur together when printed.
  const metaLines: string[] = []
  if (meta?.title) metaLines.push(escape(meta.title))
  if (meta?.periodStart && meta?.periodEnd) {
    metaLines.push(escape(`Period: ${formatPeriodLabel(meta.periodStart, meta.periodEnd)}`))
  }
  metaLines.push(escape(`Generated: ${format(new Date(), 'MMM d, yyyy')}`))
  const metaBlock = metaLines.length ? metaLines.join('\n') + '\n\n' : ''
  return metaBlock + head + '\n' + body
}

/** Human label for a date range. Collapses to a single month name when
 *  start+end cover exactly one calendar month ("September 2026"),
 *  otherwise shows a readable range ("Jul 1 – Aug 31, 2026"). */
function formatPeriodLabel(start: string, end: string): string {
  try {
    const [sy, sm, sd] = start.split('-').map(Number)
    const [ey, em, ed] = end.split('-').map(Number)
    const sDate = new Date(sy, sm - 1, sd)
    const eDate = new Date(ey, em - 1, ed)
    const lastDayOfStartMonth = new Date(sy, sm, 0).getDate()
    if (sy === ey && sm === em && sd === 1 && ed === lastDayOfStartMonth) {
      return format(sDate, 'MMMM yyyy')
    }
    if (sy === ey) {
      return `${format(sDate, 'MMM d')} – ${format(eDate, 'MMM d, yyyy')}`
    }
    return `${format(sDate, 'MMM d, yyyy')} – ${format(eDate, 'MMM d, yyyy')}`
  } catch { return `${start} to ${end}` }
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
  const [tab, setTab] = useState<'reports' | 'pipeline' | 'collections'>('reports')
  const [start, setStart] = useState(format(startOfMonth(subMonths(today, 2)), 'yyyy-MM-dd'))
  const [end, setEnd]     = useState(format(today, 'yyyy-MM-dd'))
  const [data, setData]   = useState<ReportsData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [drill, setDrill] = useState<DrillTarget | null>(null)
  // When the biller clicks a claim in the insurance drill, we open a
  // lightweight review modal INLINE on this page — Sara / Andrea want
  // to stay on financials rather than get bounced to /admin/claims for
  // a "why hasn't this paid" glance. The modal has a "Open full editor"
  // link for the rare case where actual editing is needed.
  const [reviewClaimId, setReviewClaimId] = useState<string | null>(null)
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
      {/* Tab strip — Monthly reports vs Claims pipeline. Each tab has its
          own date-logic (reports uses charges/payment windowing, pipeline
          uses DOS windowing per Sara 2026-10-01). */}
      <div className="flex items-center gap-1 border-b border-[#E8E8E4] mb-6">
        <button onClick={() => setTab('reports')}
          className={`px-4 py-2 text-[13px] font-medium border-b-2 transition-colors ${tab === 'reports' ? 'border-[#7F77DD] text-[#7F77DD]' : 'border-transparent text-[#1A1A2E]/70 hover:text-[#1A1A2E]'}`}>
          Monthly reports
        </button>
        <button onClick={() => setTab('pipeline')}
          className={`px-4 py-2 text-[13px] font-medium border-b-2 transition-colors ${tab === 'pipeline' ? 'border-[#7F77DD] text-[#7F77DD]' : 'border-transparent text-[#1A1A2E]/70 hover:text-[#1A1A2E]'}`}>
          Claims pipeline
        </button>
        <button onClick={() => setTab('collections')}
          className={`px-4 py-2 text-[13px] font-medium border-b-2 transition-colors ${tab === 'collections' ? 'border-[#7F77DD] text-[#7F77DD]' : 'border-transparent text-[#1A1A2E]/70 hover:text-[#1A1A2E]'}`}>
          Collections by visit month
        </button>
      </div>

      {tab === 'pipeline' && <AdminClaimsPipeline />}
      {tab === 'collections' && <AdminCollectionsByMonth />}
      {tab === 'reports' && <>
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
            start={start}
            end={end}
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
            start={start}
            end={end}
          />

          <CashCollectionsSection data={data} start={start} end={end} />

          <ChargesVsCollectionsSection data={data} />

          <AdjustmentsSection data={data} start={start} end={end} />

          <RefundsSection data={data} start={start} end={end} />

          {/* ── Phase 2: practice health ─────────────────────────────── */}
          <div className="pt-4 mt-2 border-t border-[#E8E8E4]">
            <div className="text-[11px] font-semibold text-[#7F77DD] uppercase tracking-wider mb-1">Practice health (quarterly review)</div>
            <p className="text-[12px] text-[#1A1A2E]/70">Reports below are less about closing the month and more about spotting trends — payer concentration, contract quality, and problem payers.</p>
          </div>

          <PayerMixSection data={data} start={start} end={end} />
          <ReimbursementByPayerSection data={data} start={start} end={end} />
          <CvFeeSummarySection data={data} start={start} end={end} />
          <DenialsByPayerSection data={data} start={start} end={end} />
        </div>
      )}
      </>}

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
            setReviewClaimId(claimId)
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

      {reviewClaimId && (
        <ClaimReviewModal
          claimId={reviewClaimId}
          onClose={() => setReviewClaimId(null)}
          onOpenFullEditor={(id) => {
            setReviewClaimId(null)
            navigate(`/admin/claims?claim=${encodeURIComponent(id)}`)
          }}
        />
      )}
    </div>
  )
}

// ─── Reusable AR aging table ─────────────────────────────────────────────

function ArAgingSection({
  title, icon: Icon, plainEnglish, rows, groupLabel, groupKey, countKey, filenameStem,
  drillType, onDrill, start, end,
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
  start: string
  end: string
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
  // Persistent link-styling (purple text + underline on hover) so the
  // biller can see at a glance that every cell is interactive without
  // having to hover to discover it. Color is applied per-cell (below)
  // so the 120+ red override wins deterministically.
  const cellCls = 'px-3 py-2 text-right tabular-nums cursor-pointer hover:bg-[#F0EEFA] hover:underline'
  const groupCellCls = 'px-3 py-2 cursor-pointer hover:bg-[#F0EEFA] hover:underline text-[#7F77DD]'
  const linkCls = 'text-[#7F77DD]'

  return (
    <ReportShell title={title} icon={Icon} plainEnglish={plainEnglish} onExport={async () => {
      // Insurance CSV: Andrea needs one row per claim, not aggregates.
      // Pulls the full drill (type=insurance, group=__all__, bucket=all)
      // which returns every outstanding insurance claim with patient,
      // DOS, submitted date, age, charge, payer, chart. Sara 2026-10-07.
      if (drillType === 'insurance') {
        try {
          const { rows: drillRows } = await getArDrill({ type: 'insurance', group: '__all__', bucket: 'all' })
          const bucketOf = (age: number) => {
            if (age <= 30)  return '0-30'
            if (age <= 60)  return '31-60'
            if (age <= 90)  return '61-90'
            if (age <= 120) return '91-120'
            return '120+'
          }
          const detail = drillRows.map((r: any) => ({
            payer:        r.canonical_payer ?? r.payer_name ?? '',
            payer_raw:    r.payer_name ?? '',
            patient:      [r.patient_first_name, r.patient_last_name].filter(Boolean).join(' '),
            chart_number: r.chart_number ?? '',
            service_date: r.service_date ? String(r.service_date).slice(0, 10) : '',
            submitted_at: r.submitted_at ? String(r.submitted_at).slice(0, 10) : '',
            age_days:     r.age_days ?? '',
            bucket:       r.age_days != null ? bucketOf(Number(r.age_days)) : '',
            charge:       r.total_charge != null ? Number(r.total_charge).toFixed(2) : '',
            status:       r.status ?? '',
            claim_id:     r.id ?? '',
          }))
          const csv = toCsv(detail, [
            { key: 'payer',        label: 'Payer' },
            { key: 'payer_raw',    label: 'Payer (as entered)' },
            { key: 'patient',      label: 'Patient' },
            { key: 'chart_number', label: 'Chart #' },
            { key: 'service_date', label: 'DOS' },
            { key: 'submitted_at', label: 'Submitted' },
            { key: 'age_days',     label: 'Age (days)' },
            { key: 'bucket',       label: 'Bucket' },
            { key: 'charge',       label: 'Outstanding $' },
            { key: 'status',       label: 'Status' },
            { key: 'claim_id',     label: 'Claim ID' },
          ], { title: title + ' — detail', periodStart: start, periodEnd: end })
          downloadCsv(`${filenameStem}-detail.csv`, csv)
          return
        } catch (e: any) {
          alert('Could not load detail rows for CSV: ' + (e?.message ?? String(e)))
          return
        }
      }
      // Patient AR CSV (unchanged — summary rows per patient).
      const csv = toCsv(rows, [
        { key: groupKey,   label: groupLabel },
        { key: 'b_0_30',   label: '0-30' },
        { key: 'b_31_60',  label: '31-60' },
        { key: 'b_61_90',  label: '61-90' },
        { key: 'b_91_120', label: '91-120' },
        { key: 'b_120_plus', label: '120+' },
        { key: 'total',    label: 'Total' },
        { key: countKey,   label: 'Count' },
      ], { title, periodStart: start, periodEnd: end })
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
                  <td className={`${cellCls} ${linkCls}`} onClick={() => drill('0_30',     '0-30 days',   parseFloat(r.b_0_30     ?? 0))}>{fmtMoney(r.b_0_30)}</td>
                  <td className={`${cellCls} ${linkCls}`} onClick={() => drill('31_60',    '31-60 days',  parseFloat(r.b_31_60    ?? 0))}>{fmtMoney(r.b_31_60)}</td>
                  <td className={`${cellCls} ${linkCls}`} onClick={() => drill('61_90',    '61-90 days',  parseFloat(r.b_61_90    ?? 0))}>{fmtMoney(r.b_61_90)}</td>
                  <td className={`${cellCls} ${linkCls}`} onClick={() => drill('91_120',   '91-120 days', parseFloat(r.b_91_120   ?? 0))}>{fmtMoney(r.b_91_120)}</td>
                  <td
                    className={`${cellCls} ${parseFloat(r.b_120_plus) > 0 ? 'text-[#991B1B] font-semibold' : linkCls}`}
                    onClick={() => drill('120_plus', '120+ days', parseFloat(r.b_120_plus ?? 0))}
                  >
                    {fmtMoney(r.b_120_plus)}
                  </td>
                  <td
                    className={`${cellCls} ${linkCls} font-semibold`}
                    onClick={() => drill('all', 'All ages', parseFloat(r.total ?? 0))}
                  >
                    {fmtMoney(r.total)}
                  </td>
                  <td
                    className={`${cellCls} ${linkCls}`}
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
                    className="px-3 py-2 cursor-pointer hover:bg-[#F0EEFA] hover:underline text-[#7F77DD]"
                    onClick={() => drillAll('all', 'All ages', totals.total)}
                  >
                    Total
                  </td>
                  <td className={`${cellCls} ${linkCls}`} onClick={() => drillAll('0_30',     '0-30 days',   totals.b_0_30)}>{fmtMoney(totals.b_0_30)}</td>
                  <td className={`${cellCls} ${linkCls}`} onClick={() => drillAll('31_60',    '31-60 days',  totals.b_31_60)}>{fmtMoney(totals.b_31_60)}</td>
                  <td className={`${cellCls} ${linkCls}`} onClick={() => drillAll('61_90',    '61-90 days',  totals.b_61_90)}>{fmtMoney(totals.b_61_90)}</td>
                  <td className={`${cellCls} ${linkCls}`} onClick={() => drillAll('91_120',   '91-120 days', totals.b_91_120)}>{fmtMoney(totals.b_91_120)}</td>
                  <td
                    className={`${cellCls} ${totals.b_120_plus > 0 ? 'text-[#991B1B]' : linkCls}`}
                    onClick={() => drillAll('120_plus', '120+ days', totals.b_120_plus)}
                  >
                    {fmtMoney(totals.b_120_plus)}
                  </td>
                  <td className={`${cellCls} ${linkCls}`} onClick={() => drillAll('all', 'All ages', totals.total)}>{fmtMoney(totals.total)}</td>
                  <td className={`${cellCls} ${linkCls}`} onClick={() => drillAll('all', 'All ages', totals.total)}>{totals.count}</td>
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
        ], { title: 'Cash collections', periodStart: start, periodEnd: end })
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

function AdjustmentsSection({ data, start, end }: { data: ReportsData; start: string; end: string }) {
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
        ], { title: 'Write-offs by reason', periodStart: start, periodEnd: end })
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

function RefundsSection({ data, start, end }: { data: ReportsData; start: string; end: string }) {
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
        ], { title: 'Refunds / overpayments', periodStart: start, periodEnd: end })
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

function PayerMixSection({ data, start, end }: { data: ReportsData; start: string; end: string }) {
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
        ], { title: 'Payer mix', periodStart: start, periodEnd: end })
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
// Pivot grid: visit types × payer buckets, each cell showing avg
// allowable (insurance paid + patient responsibility). Payer names are
// normalized to business-level buckets (Anthem stays its own bucket per
// Sara 2026-11-08). Claims with zero allowable (pure denials / pending
// reworks) excluded so one rejection doesn't drag a cell down. Sources
// its own data from /api/admin/reimbursement-by-visit-payer — refetches
// whenever the parent re-runs reports (parent's `data` reload is the
// trigger). Sara 2026-11-08.

type ReimbursementCell = { n: number; avg_allowable: number; total_allowable: number }
type ReimbursementGrid = {
  start: string
  end: string
  visit_types: string[]
  payers: string[]
  cells: Record<string, Record<string, ReimbursementCell>>
  payer_totals: Record<string, ReimbursementCell>
  visit_type_totals: Record<string, ReimbursementCell>
  grand: { n: number; avg_allowable: number; total_allowable: number }
}

const REIMB_MIX_COLORS = ['#7F77DD', '#1D9E75', '#EF9F27', '#378ADD', '#D4537E', '#C0392B', '#0F6E56', '#8B5CF6', '#F97316', '#0EA5E9']

function ReimbursementByPayerSection({ data: _data, start, end }: { data: ReportsData; start: string; end: string }) {
  const [grid, setGrid] = useState<ReimbursementGrid | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Refetch whenever the parent's `data` prop reference changes
  // (parent fires `load()` on Run → new ReportsData → this effect runs).
  // Mount is covered because _data is initially null until the first load.
  useEffect(() => {
    let cancelled = false
    setLoading(true); setError(null)
    apiFetch<ReimbursementGrid>(`/api/admin/reimbursement-by-visit-payer?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`)
      .then(d => { if (!cancelled) setGrid(d) })
      .catch(e => { if (!cancelled) setError(e?.message ?? 'Failed to load reimbursement grid') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [_data, start, end])

  return (
    <ReportShell
      title="Reimbursement by payer"
      icon={HandCoins}
      plainEnglish="Average allowable per visit type, grouped by payer. 'Allowable' = insurance payment + patient responsibility (the total you'll collect). Payer names are normalized — all BCBS variants roll up, Anthem stays separate. Self-pay excluded. Claims with zero allowable (pure denials / pending reworks) excluded so one rejection doesn't pull an average down."
      onExport={() => {
        if (!grid) return
        const header = ['Visit type', ...grid.payers, 'Row avg', 'Row n']
        const lines: string[] = [header.map(c => `"${c}"`).join(',')]
        for (const vt of grid.visit_types) {
          const row: (string | number)[] = [vt]
          for (const p of grid.payers) {
            const c = grid.cells[vt]?.[p]
            row.push(c ? `${c.avg_allowable.toFixed(2)} (n=${c.n})` : '')
          }
          const rt = grid.visit_type_totals[vt]
          row.push(rt ? rt.avg_allowable.toFixed(2) : '')
          row.push(rt ? rt.n : '')
          lines.push(row.map(c => `"${String(c).replace(/"/g, '""')}"`).join(','))
        }
        const footer: (string | number)[] = ['Column avg']
        for (const p of grid.payers) {
          const t = grid.payer_totals[p]
          footer.push(t ? t.avg_allowable.toFixed(2) : '')
        }
        footer.push(grid.grand.avg_allowable.toFixed(2))
        footer.push(grid.grand.n)
        lines.push(footer.map(c => `"${String(c).replace(/"/g, '""')}"`).join(','))
        downloadCsv(`reimbursement-${start}_to_${end}.csv`, lines.join('\n'))
      }}>
      {error && (
        <div className="text-[13px] text-red-600 bg-[#FCEBEB] border border-[#F5C6C6] px-3 py-2 rounded-lg mb-3">{error}</div>
      )}
      {loading && !grid ? (
        <div className="text-[13px] text-[#1A1A2E]/60 py-4 text-center">Loading reimbursement grid…</div>
      ) : !grid || grid.visit_types.length === 0 ? (
        <div className="text-[13px] text-[#1A1A2E]/60 py-4 text-center">No ERAs with allowable amounts in this window.</div>
      ) : (
        <>
          {/* Summary row */}
          <div className="flex flex-wrap items-center gap-5 mb-4 text-[12px] text-[#1A1A2E]">
            <div><span className="text-[#1A1A2E]/60">Claims counted:</span> <span className="font-medium">{grid.grand.n}</span></div>
            <div><span className="text-[#1A1A2E]/60">Grand avg allowable:</span> <span className="font-semibold">{fmtMoney(grid.grand.avg_allowable)}</span></div>
            <div><span className="text-[#1A1A2E]/60">Total allowable:</span> <span className="font-medium">{fmtMoney(grid.grand.total_allowable)}</span></div>
          </div>

          {/* Payer mix bar */}
          {(() => {
            const mix = grid.payers
              .map(p => ({ payer: p, total: grid.payer_totals[p]?.total_allowable ?? 0, n: grid.payer_totals[p]?.n ?? 0 }))
              .sort((a, b) => b.total - a.total)
              .map(p => ({ ...p, pct: grid.grand.total_allowable ? (p.total / grid.grand.total_allowable) * 100 : 0 }))
            if (mix.length === 0 || grid.grand.total_allowable === 0) return null
            return (
              <div className="mb-4">
                <div className="text-[11px] uppercase tracking-wide text-[#1A1A2E]/60 mb-1.5">Payer mix (% of total allowable)</div>
                <div className="flex h-6 rounded-md overflow-hidden border border-[#E8E8E4] bg-white">
                  {mix.map((p, i) => (
                    <div key={p.payer}
                      style={{ width: `${p.pct}%`, background: REIMB_MIX_COLORS[i % REIMB_MIX_COLORS.length] }}
                      title={`${p.payer}: ${fmtMoney(p.total)} · ${p.pct.toFixed(1)}% · ${p.n} claims`}
                      className="h-full first:rounded-l-md last:rounded-r-md" />
                  ))}
                </div>
                <div className="flex flex-wrap gap-x-4 gap-y-1.5 mt-2 text-[11px] text-[#1A1A2E]">
                  {mix.map((p, i) => (
                    <div key={p.payer} className="flex items-center gap-1.5">
                      <div className="w-2.5 h-2.5 rounded-sm flex-shrink-0" style={{ background: REIMB_MIX_COLORS[i % REIMB_MIX_COLORS.length] }} />
                      <span className="font-medium">{p.payer}</span>
                      <span className="text-[#1A1A2E]/60 tabular-nums">{p.pct.toFixed(1)}% · {fmtMoney(p.total)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )
          })()}

          {/* Pivot grid */}
          <div className="overflow-auto border border-[#E8E8E4] rounded-lg">
            <table className="w-full text-[12px]">
              <thead className="bg-[#F8F8F4]">
                <tr>
                  <th className="text-left px-3 py-2 font-medium text-[#1A1A2E] sticky left-0 bg-[#F8F8F4] z-10">Visit type</th>
                  {grid.payers.map(p => (
                    <th key={p} className="text-right px-3 py-2 font-medium text-[#1A1A2E] whitespace-nowrap">{p}</th>
                  ))}
                  <th className="text-right px-3 py-2 font-semibold text-[#1A1A2E] bg-[#EEEDFE] whitespace-nowrap">Row avg</th>
                </tr>
              </thead>
              <tbody>
                {grid.visit_types.map(vt => {
                  const rt = grid.visit_type_totals[vt]
                  return (
                    <tr key={vt} className="border-t border-[#F1EFE8]">
                      <td className="px-3 py-2 text-[#1A1A2E] sticky left-0 bg-white z-10">{vt}</td>
                      {grid.payers.map(p => {
                        const c = grid.cells[vt]?.[p]
                        return (
                          <td key={p} className="text-right px-3 py-2 tabular-nums">
                            {c ? (
                              <>
                                <div className="font-medium text-[#1A1A2E]">{fmtMoney(c.avg_allowable)}</div>
                                <div className="text-[10px] text-[#1A1A2E]/55">n={c.n}</div>
                              </>
                            ) : (
                              <span className="text-[#1A1A2E]/25">—</span>
                            )}
                          </td>
                        )
                      })}
                      <td className="text-right px-3 py-2 tabular-nums bg-[#EEEDFE]/40">
                        <div className="font-semibold text-[#1A1A2E]">{rt ? fmtMoney(rt.avg_allowable) : '—'}</div>
                        <div className="text-[10px] text-[#1A1A2E]/55">n={rt?.n ?? 0}</div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-[#1A1A2E]/15 bg-[#F8F8F4]">
                  <td className="px-3 py-2 font-semibold text-[#1A1A2E] sticky left-0 bg-[#F8F8F4] z-10">Column avg</td>
                  {grid.payers.map(p => {
                    const t = grid.payer_totals[p]
                    return (
                      <td key={p} className="text-right px-3 py-2 tabular-nums">
                        <div className="font-semibold text-[#1A1A2E]">{t ? fmtMoney(t.avg_allowable) : '—'}</div>
                        <div className="text-[10px] text-[#1A1A2E]/55">n={t?.n ?? 0}</div>
                      </td>
                    )
                  })}
                  <td className="text-right px-3 py-2 tabular-nums bg-[#EEEDFE]">
                    <div className="font-bold text-[#1A1A2E]">{fmtMoney(grid.grand.avg_allowable)}</div>
                    <div className="text-[10px] text-[#1A1A2E]/55">n={grid.grand.n}</div>
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        </>
      )}
    </ReportShell>
  )
}

// ─── Convenience fee summary ─────────────────────────────────────────────
// Headline: average CV per successfully-billed visit. Scope matches the
// Reimbursement grid above (same date range, same refetch trigger). Only
// includes CVs with status 'auto_charged' or 'manually_charged' — the
// actually-collected ones. Sara 2026-11-08.

type CvMonthRow = { month: string; n: number; avg: number; total: number }
type CvSummary = {
  start: string
  end: string
  overall: { n: number; avg: number; total: number }
  by_month: CvMonthRow[]
}

function CvFeeSummarySection({ data: _data, start, end }: { data: ReportsData; start: string; end: string }) {
  const [summary, setSummary] = useState<CvSummary | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true); setError(null)
    apiFetch<CvSummary>(`/api/admin/cv-fee-summary?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`)
      .then(d => { if (!cancelled) setSummary(d) })
      .catch(e => { if (!cancelled) setError(e?.message ?? 'Failed to load CV summary') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [_data, start, end])

  return (
    <ReportShell
      title="Convenience fee per visit"
      icon={DollarSign}
      plainEnglish="Average CV fee attached to signed encounter notes, from September 1 forward (CV workflow matured in September; earlier data is unreliable). Monthly trend below shows the shape over the window."
      onExport={() => {
        if (!summary) return
        const header = ['Month', 'Visits w/ CV', 'Avg CV', 'Total CV']
        const lines: string[] = [header.map(c => `"${c}"`).join(',')]
        for (const m of summary.by_month) {
          lines.push([m.month, m.n, m.avg.toFixed(2), m.total.toFixed(2)].map(c => `"${String(c)}"`).join(','))
        }
        lines.push(['Total (YTD)', summary.overall.n, summary.overall.avg.toFixed(2), summary.overall.total.toFixed(2)].map(c => `"${String(c)}"`).join(','))
        downloadCsv(`cv-fee-summary-${start}_to_${end}.csv`, lines.join('\n'))
      }}>
      {error && (
        <div className="text-[13px] text-red-600 bg-[#FCEBEB] border border-[#F5C6C6] px-3 py-2 rounded-lg mb-3">{error}</div>
      )}
      {loading && !summary ? (
        <div className="text-[13px] text-[#1A1A2E]/60 py-4 text-center">Loading CV summary…</div>
      ) : !summary || summary.overall.n === 0 ? (
        <div className="text-[13px] text-[#1A1A2E]/60 py-4 text-center">No successfully-billed CV charges in this window.</div>
      ) : (
        <>
          {/* Headline block */}
          <div className="grid grid-cols-3 gap-3 mb-4">
            <div className="bg-[#EEEDFE]/50 border border-[#E8E8E4] rounded-lg px-4 py-3">
              <div className="text-[10px] uppercase tracking-wide text-[#1A1A2E]/60 mb-0.5">Avg CV per visit</div>
              <div className="font-display text-[22px] font-semibold text-[#1A1A2E] tabular-nums">{fmtMoney(summary.overall.avg)}</div>
            </div>
            <div className="bg-[#FAFAF8] border border-[#E8E8E4] rounded-lg px-4 py-3">
              <div className="text-[10px] uppercase tracking-wide text-[#1A1A2E]/60 mb-0.5">Visits counted</div>
              <div className="font-display text-[22px] font-semibold text-[#1A1A2E] tabular-nums">{summary.overall.n}</div>
            </div>
            <div className="bg-[#FAFAF8] border border-[#E8E8E4] rounded-lg px-4 py-3">
              <div className="text-[10px] uppercase tracking-wide text-[#1A1A2E]/60 mb-0.5">Total CV collected</div>
              <div className="font-display text-[22px] font-semibold text-[#1A1A2E] tabular-nums">{fmtMoney(summary.overall.total)}</div>
            </div>
          </div>

          {/* Monthly breakdown */}
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-b border-[#E8E8E4] bg-[#FAFAF8] text-[11px] text-[#1A1A2E] uppercase tracking-wide">
                <th className="text-left px-3 py-2">Month</th>
                <th className="text-right px-3 py-2">Visits with CV</th>
                <th className="text-right px-3 py-2">Avg CV</th>
                <th className="text-right px-3 py-2">Total CV</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#F1EFE8]">
              {summary.by_month.map(m => (
                <tr key={m.month}>
                  <td className="px-3 py-2 text-[#1A1A2E]">{m.month}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{m.n}</td>
                  <td className="px-3 py-2 text-right tabular-nums font-medium">{fmtMoney(m.avg)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{fmtMoney(m.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </ReportShell>
  )
}

// ─── Denials by payer ────────────────────────────────────────────────────

function DenialsByPayerSection({ data, start, end }: { data: ReportsData; start: string; end: string }) {
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
        ], { title: 'Denials by payer', periodStart: start, periodEnd: end })
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
