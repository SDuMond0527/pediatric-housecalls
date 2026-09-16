import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { format, formatDistanceToNowStrict } from 'date-fns'
import { RefreshCw, Check, ExternalLink, Coffee, Trophy, AlertTriangle } from 'lucide-react'
import { getReportsSchedule, markReportReviewed } from '../../lib/api'

// The list of reports Sara should be running + how often, plus playful
// copy so the checklist doesn't feel like a chore.
type ReportDef = {
  key: string
  title: string
  vibe: string           // funny one-liner
  frequencyDays: number  // "you should look at this every N days"
  frequencyLabel: string
  linkTo: string         // where clicking "Open report" takes you
}

const MONTHLY: ReportDef[] = [
  {
    key: 'monthly_ar_insurance',
    title: 'AR aging — insurance',
    vibe: 'Which payers ghosted you and how long ago. Anything in the 120+ column is one bad breakup away from being a write-off.',
    frequencyDays: 30, frequencyLabel: 'Monthly',
    linkTo: '/admin/financial-reports',
  },
  {
    key: 'monthly_ar_patient',
    title: 'AR aging — patient',
    vibe: 'Families who still owe you money, ranked by how long they\'ve been dodging. Charge that card on file after 14 days.',
    frequencyDays: 30, frequencyLabel: 'Monthly',
    linkTo: '/admin/financial-reports',
  },
  {
    key: 'monthly_cash_collections',
    title: 'Cash collections',
    vibe: 'Did you actually get paid this month? Great question. Here\'s the answer.',
    frequencyDays: 30, frequencyLabel: 'Monthly',
    linkTo: '/admin/financial-reports',
  },
  {
    key: 'monthly_charges_vs_collections',
    title: 'Charges vs. collections',
    vibe: 'The "for every dollar I billed, how many cents came back" reality check. Deep breath before you look.',
    frequencyDays: 30, frequencyLabel: 'Monthly',
    linkTo: '/admin/financial-reports',
  },
  {
    key: 'monthly_adjustments_writeoffs',
    title: 'Adjustments & write-offs',
    vibe: 'Where money goes to die. Normal to have some. Not normal for "bad debt" to be climbing.',
    frequencyDays: 30, frequencyLabel: 'Monthly',
    linkTo: '/admin/financial-reports',
  },
  {
    key: 'monthly_refunds',
    title: 'Refunds / overpayments',
    vibe: 'Families you owe money back to (yes, this happens). Try to spot these before they email you asking.',
    frequencyDays: 30, frequencyLabel: 'Monthly',
    linkTo: '/admin/financial-reports',
  },
]

const QUARTERLY: ReportDef[] = [
  {
    key: 'quarterly_payer_mix',
    title: 'Payer mix',
    vibe: 'Who\'s paying your bills. If BCBS is 45% of your practice, that\'s not a contract — that\'s a hostage situation.',
    frequencyDays: 90, frequencyLabel: 'Quarterly',
    linkTo: '/admin/financial-reports',
  },
  {
    key: 'quarterly_reimbursement_by_payer',
    title: 'Reimbursement by payer',
    vibe: 'Ranking your payers from "generous friend" to "stingy jerk who pays 32% and thinks that\'s reasonable." Bring this to your next contract call.',
    frequencyDays: 90, frequencyLabel: 'Quarterly',
    linkTo: '/admin/financial-reports',
  },
  {
    key: 'quarterly_denials',
    title: 'Denial rate by payer',
    vibe: 'Payers who keep saying "nah." If one keeps denying, it\'s usually a wrong payer ID or something equally boring — but worth catching.',
    frequencyDays: 90, frequencyLabel: 'Quarterly',
    linkTo: '/admin/financial-reports',
  },
]

// Overdue vibes → escalating levels of playful shade
const OVERDUE_MESSAGES = [
  'Just a nudge — this one\'s ready for a look.',
  'It\'s been a minute. This report is giving you the side-eye.',
  'Your bookkeeper is judging you from another room.',
  'This report has been sitting so long it has cobwebs. Please help.',
]

function overdueMessage(daysOverdue: number): string {
  if (daysOverdue < 7)  return OVERDUE_MESSAGES[0]
  if (daysOverdue < 30) return OVERDUE_MESSAGES[1]
  if (daysOverdue < 90) return OVERDUE_MESSAGES[2]
  return OVERDUE_MESSAGES[3]
}

const FRESH_MESSAGES = [
  'Look at you go 🌟',
  'On top of it — respect.',
  'Nailed it. Take a breath.',
  'Practice-owner brain: activated.',
]
function freshMessage(key: string): string {
  // Deterministic pick so a given report keeps the same vibe within a
  // session — feels like a personality, not random noise.
  let n = 0; for (const c of key) n = (n * 31 + c.charCodeAt(0)) >>> 0
  return FRESH_MESSAGES[n % FRESH_MESSAGES.length]
}

export function AdminReportsSchedule() {
  const [reviews, setReviews] = useState<Record<string, { reviewed_at: string; reviewed_by_name: string | null }>>({})
  const [loading, setLoading] = useState(true)
  const [marking, setMarking] = useState<string | null>(null)

  async function load() {
    setLoading(true)
    try {
      const { reviews } = await getReportsSchedule()
      const map: Record<string, { reviewed_at: string; reviewed_by_name: string | null }> = {}
      for (const r of reviews) map[r.report_key] = { reviewed_at: r.reviewed_at, reviewed_by_name: r.reviewed_by_name }
      setReviews(map)
    } catch { /* silent — page is safe to show empty */ }
    finally { setLoading(false) }
  }
  useEffect(() => { load() }, [])

  async function mark(key: string) {
    setMarking(key)
    try {
      const { reviewed_at } = await markReportReviewed(key)
      setReviews(prev => ({ ...prev, [key]: { reviewed_at, reviewed_by_name: 'You' } }))
    } catch (e: any) {
      alert(e?.message ?? 'Failed to mark reviewed')
    } finally {
      setMarking(null)
    }
  }

  const now = Date.now()
  const decorate = (def: ReportDef): DecoratedRow => {
    const rev = reviews[def.key]
    const last = rev?.reviewed_at ?? null
    const lastMs = last ? new Date(last).getTime() : null
    const ageDays = lastMs ? Math.floor((now - lastMs) / (1000 * 60 * 60 * 24)) : Infinity
    const overdue = ageDays > def.frequencyDays
    const daysOverdue = overdue && isFinite(ageDays) ? ageDays - def.frequencyDays : 0
    const neverReviewed = !last
    return { def, last, ageDays, overdue, daysOverdue, neverReviewed, reviewedByName: rev?.reviewed_by_name ?? null }
  }

  const monthly = MONTHLY.map(decorate)
  const quarterly = QUARTERLY.map(decorate)
  const monthlyOverdueCount = monthly.filter(m => m.overdue || m.neverReviewed).length
  const quarterlyOverdueCount = quarterly.filter(m => m.overdue || m.neverReviewed).length

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="flex items-start justify-between mb-6 gap-4">
        <div>
          <h1 className="font-display text-xl font-semibold text-[#1A1A2E]">Your reports schedule</h1>
          <p className="text-[13px] text-[#1A1A2E]/70 mt-1 max-w-2xl">
            Running a practice is like keeping a plant alive — check on it regularly or things start looking weird.
            Here's what to look at each month and each quarter. Click "Open report" to jump in, "Mark reviewed" when
            you're done, and try not to feel judged by the vibes.
          </p>
        </div>
        <button onClick={load} disabled={loading}
          className="flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-medium text-[#666] border border-[#E8E8E4] rounded-lg bg-white hover:bg-[#F1EFE8] transition-colors disabled:opacity-50">
          <RefreshCw size={13} className={loading ? 'animate-spin' : ''} /> Refresh
        </button>
      </div>

      {/* Monthly */}
      <section className="mb-8">
        <div className="flex items-center gap-2 mb-3">
          <Coffee size={16} className="text-[#7F77DD]" />
          <h2 className="font-display text-[16px] font-semibold text-[#1A1A2E]">Monthly close</h2>
          {monthlyOverdueCount > 0 ? (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-[#FCEBEB] text-[#991B1B]">
              {monthlyOverdueCount} waiting on you
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-[#E6F6F2] text-[#1A7D5A]">
              All caught up
            </span>
          )}
        </div>
        <p className="text-[12px] text-[#1A1A2E]/70 mb-3">Do these once a month — usually the first week after month-end, alongside your coffee.</p>
        <div className="space-y-3">
          {monthly.map(row => <ReportRow key={row.def.key} row={row} onMark={mark} marking={marking} />)}
        </div>
      </section>

      {/* Quarterly */}
      <section>
        <div className="flex items-center gap-2 mb-3">
          <Trophy size={16} className="text-[#7F77DD]" />
          <h2 className="font-display text-[16px] font-semibold text-[#1A1A2E]">Quarterly practice-health check</h2>
          {quarterlyOverdueCount > 0 ? (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-[#FCEBEB] text-[#991B1B]">
              {quarterlyOverdueCount} overdue
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-[#E6F6F2] text-[#1A7D5A]">
              All caught up
            </span>
          )}
        </div>
        <p className="text-[12px] text-[#1A1A2E]/70 mb-3">Do these once a quarter. Great excuse to feel very "CEO-mode" for an afternoon.</p>
        <div className="space-y-3">
          {quarterly.map(row => <ReportRow key={row.def.key} row={row} onMark={mark} marking={marking} />)}
        </div>
      </section>
    </div>
  )
}

type DecoratedRow = {
  def: ReportDef
  last: string | null
  ageDays: number
  overdue: boolean
  daysOverdue: number
  neverReviewed: boolean
  reviewedByName: string | null
}

function ReportRow({
  row, onMark, marking,
}: {
  row: DecoratedRow
  onMark: (key: string) => void
  marking: string | null
}) {
  const { def, last, overdue, daysOverdue, neverReviewed, reviewedByName } = row
  const status =
    neverReviewed ? { cls: 'border-[#FDBA74] bg-[#FFF7ED]', tone: 'text-[#B45309]', label: 'Never reviewed', message: 'This one\'s brand new. Say hi 👋' }
    : overdue      ? { cls: 'border-[#F5C6C6] bg-[#FCEBEB]', tone: 'text-[#991B1B]', label: `${daysOverdue}d overdue`, message: overdueMessage(daysOverdue) }
    :                { cls: 'border-[#A9DFBF] bg-[#E6F6F2]', tone: 'text-[#1A7D5A]', label: 'Fresh',           message: freshMessage(def.key) }

  return (
    <div className={`border rounded-xl p-4 ${status.cls}`}>
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="font-display text-[15px] font-semibold text-[#1A1A2E]">{def.title}</h3>
            <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium ${status.tone} bg-white/60`}>
              {overdue && <AlertTriangle size={10} />}
              {status.label}
            </span>
            <span className="text-[11px] text-[#1A1A2E]/60">· {def.frequencyLabel}</span>
          </div>
          <p className="text-[13px] text-[#1A1A2E] mt-1 italic">{def.vibe}</p>
          <p className={`text-[12px] mt-1 ${status.tone}`}>{status.message}</p>
          {last && (
            <div className="text-[11px] text-[#1A1A2E]/60 mt-2">
              Last reviewed by {reviewedByName ?? 'someone'} · {format(new Date(last), 'MMM d, yyyy')} ({formatDistanceToNowStrict(new Date(last), { addSuffix: true })})
            </div>
          )}
        </div>
        <div className="flex flex-col gap-2 flex-shrink-0 min-w-[10rem]">
          <Link to={def.linkTo}
            className="flex items-center justify-center gap-1.5 px-3 py-1.5 bg-white border border-[#E8E8E4] text-[#1A1A2E] text-[12px] font-medium rounded-lg hover:bg-[#F1EFE8] transition-colors">
            <ExternalLink size={12} /> Open report
          </Link>
          <button
            onClick={() => onMark(def.key)}
            disabled={marking === def.key}
            className="flex items-center justify-center gap-1.5 px-3 py-1.5 bg-[#7F77DD] text-white text-[12px] font-medium rounded-lg hover:bg-[#6C64C8] transition-colors disabled:opacity-50">
            <Check size={12} /> {marking === def.key ? 'Marking…' : (last ? 'Mark reviewed again' : 'Mark reviewed')}
          </button>
        </div>
      </div>
    </div>
  )
}
