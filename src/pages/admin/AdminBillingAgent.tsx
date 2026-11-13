import { useEffect, useMemo, useState } from 'react'
import { format } from 'date-fns'
import { Bot, CheckCircle2, X, Pencil, ChevronDown, ChevronUp, RefreshCw, AlertTriangle, Info } from 'lucide-react'
import {
  getReviewQueue, batchDecideReviewItems, decideReviewItem,
  getBillingAgentSettings, setBillingAgentCategory,
  type ReviewQueueItem, type ReviewQueueStats, type ReviewWorkCategory,
  type BillingAgentCategorySetting,
} from '../../lib/api'

// Billing-agent review surface. Two tabs:
//   1. Review queue — every item the agent has prepared and is waiting
//      on Sara's approve/edit/reject.
//   2. Settings     — the per-work-category auto-on toggles, plus the
//      30-day approval-rate counter that informs those decisions.
//
// Nothing in this file CREATES queue rows — the agent-logic jobs ship
// in later commits once this shell is confirmed. Sara 2026-11-09.

const CATEGORY_LABEL: Record<ReviewWorkCategory, string> = {
  claim_submission: 'Claim submission',
  rejections:       'Rejections',
  denials:          'Denials',
}

const ITEM_TYPE_BADGE: Record<string, { label: string; cls: string }> = {
  new_claim:            { label: 'New claim',            cls: 'bg-[#EEF1F8] text-[#31447A]' },
  stale_claim:          { label: 'Stale claim',          cls: 'bg-[#FEF3E8] text-[#633806]' },
  underpayment:         { label: 'Underpayment',         cls: 'bg-[#FDECEC] text-[#7F1D1D]' },
  rejection_fix:        { label: 'Rejection fix',        cls: 'bg-[#FEE2E2] text-[#7F1D1D]' },
  denial_fix:           { label: 'Denial fix',           cls: 'bg-[#FFE4E6] text-[#9F1239]' },
  appeal_draft:         { label: 'Appeal draft',         cls: 'bg-[#EEEDFE] text-[#3C3489]' },
  eligibility_blocked:  { label: 'Eligibility failed',   cls: 'bg-[#FEE2E2] text-[#7F1D1D]' },
}

// Buttons are contextual per item type. Stage 1 items (stale_claim,
// underpayment) are NOTIFICATIONS — the "action" is "I handled this"
// with a note describing WHAT the biller did. Stage 2 items (new_claim,
// rejection_fix, denial_fix, appeal_draft) are PROPOSALS the biller is
// accepting or rejecting — "Approve" / "Reject" wording fits those.
// Sara 2026-11-09.
const ACTION_LABELS: Record<string, {
  primary: string
  dismiss: string
  notePrompt: string
  noteRequired: boolean
}> = {
  stale_claim: {
    primary: 'Mark handled',
    dismiss: 'Dismiss',
    notePrompt: 'What did you do about it? (e.g. "called Cigna, claim being reprocessed" or "posted payment manually")',
    noteRequired: true,
  },
  underpayment: {
    primary: 'Mark handled',
    dismiss: 'Dismiss',
    notePrompt: 'What did you do about it? (e.g. "called payer, confirmed fee schedule" or "wrote off the gap")',
    noteRequired: true,
  },
  eligibility_blocked: {
    primary: 'Mark handled',
    dismiss: 'Dismiss',
    notePrompt: 'What did you do about it? (e.g. "called family — insurance is now active, retrying" or "switched to self-pay")',
    noteRequired: true,
  },
  new_claim: {
    primary: 'Approve + submit',
    dismiss: 'Reject',
    notePrompt: 'Optional note:',
    noteRequired: false,
  },
  rejection_fix: {
    primary: 'Approve fix',
    dismiss: 'Reject',
    notePrompt: 'Optional note:',
    noteRequired: false,
  },
  denial_fix: {
    primary: 'Approve fix',
    dismiss: 'Reject',
    notePrompt: 'Optional note:',
    noteRequired: false,
  },
  appeal_draft: {
    primary: 'Send appeal',
    dismiss: 'Reject',
    notePrompt: 'Optional note:',
    noteRequired: false,
  },
}
const DEFAULT_ACTION_LABELS = {
  primary: 'Mark handled',
  dismiss: 'Dismiss',
  notePrompt: 'Note (optional):',
  noteRequired: false,
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

function approvalRate(s: ReviewQueueStats): number | null {
  if (!s || s.total === 0) return null
  // "Approved without changes" is the metric that matters for auto-on.
  return s.approved / s.total
}

export function AdminBillingAgent() {
  const [tab, setTab] = useState<'queue' | 'settings'>('queue')
  const [items, setItems] = useState<ReviewQueueItem[]>([])
  const [stats, setStats] = useState<ReviewQueueStats[]>([])
  const [settings, setSettings] = useState<BillingAgentCategorySetting[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [expanded, setExpanded] = useState<string | null>(null)
  const [deciding, setDeciding] = useState<string | null>(null)
  const [filter, setFilter] = useState<'all' | ReviewWorkCategory>('all')

  async function load() {
    setLoading(true)
    setErr('')
    try {
      const [q, s] = await Promise.all([getReviewQueue(), getBillingAgentSettings()])
      setItems(q.items)
      setStats(q.stats)
      setSettings(s.settings)
      // Prune the selection set of anything that's no longer in the queue
      // (approved / rejected in another tab, or just gone).
      setSelected(prev => {
        const next = new Set<string>()
        for (const it of q.items) if (prev.has(it.id)) next.add(it.id)
        return next
      })
    } catch (e: any) {
      setErr(e?.message ?? 'Failed to load review queue')
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { void load() }, [])

  const filteredItems = useMemo(() => {
    if (filter === 'all') return items
    return items.filter(it => it.work_category === filter)
  }, [items, filter])

  const statsByCategory = useMemo(() => {
    const m = new Map<ReviewWorkCategory, ReviewQueueStats>()
    for (const s of stats) m.set(s.work_category, s)
    return m
  }, [stats])

  function toggleSelect(id: string) {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }
  function selectAllVisible() {
    setSelected(new Set(filteredItems.map(i => i.id)))
  }
  function clearSelection() { setSelected(new Set()) }

  async function doBatch(action: 'approve' | 'reject') {
    if (selected.size === 0) return
    const label = action === 'approve' ? 'Approve' : 'Reject'
    if (!window.confirm(`${label} ${selected.size} item(s)?`)) return
    setDeciding('batch')
    try {
      await batchDecideReviewItems(Array.from(selected), action)
      await load()
    } catch (e: any) {
      setErr(e?.message ?? `Batch ${action} failed`)
    } finally {
      setDeciding(null)
    }
  }

  async function doDecide(id: string, action: 'approve' | 'reject', note?: string) {
    setDeciding(id)
    try {
      await decideReviewItem(id, action, note ? { note } : undefined)
      await load()
    } catch (e: any) {
      setErr(e?.message ?? `${action} failed`)
    } finally {
      setDeciding(null)
    }
  }

  async function toggleCategory(cat: ReviewWorkCategory, current: boolean) {
    const nextVal = !current
    if (nextVal) {
      const s = statsByCategory.get(cat)
      const r = s ? approvalRate(s) : null
      const rateStr = r == null ? 'no decisions in the last 30 days' : `${Math.round(r * 100)}% clean-approval rate over ${s!.total} decisions`
      const ok = window.confirm(
        `Turn ON automatic handling for "${CATEGORY_LABEL[cat]}"?\n\n` +
        `Current performance: ${rateStr}.\n\n` +
        `Once ON, the agent commits directly for this category instead of queuing. ` +
        `You can flip it back off anytime. Continue?`,
      )
      if (!ok) return
    }
    try {
      await setBillingAgentCategory(cat, nextVal)
      await load()
    } catch (e: any) {
      setErr(e?.message ?? 'Failed to update setting')
    }
  }

  return (
    <div className="max-w-6xl mx-auto px-6 py-6">
      <div className="flex items-start justify-between gap-4 mb-5">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Bot size={20} className="text-[#7F77DD]" />
            <h1 className="text-[24px] font-display font-medium text-[#1A1A2E] leading-tight">Billing agent</h1>
          </div>
          <p className="text-[13px] text-[#555] leading-snug max-w-2xl">
            Every proposal the agent prepares lands here for your approval. Nothing submits, resubmits, or appeals without your explicit go.
          </p>
        </div>
        <button onClick={() => void load()} disabled={loading}
          className="inline-flex items-center gap-1.5 text-[12px] text-[#555] hover:text-[#1A1A2E] border border-[#E8E8E4] rounded-lg px-3 py-1.5 bg-white hover:bg-[#F1EFE8] disabled:opacity-50">
          <RefreshCw size={12} className={loading ? 'animate-spin' : ''} /> Refresh
        </button>
      </div>

      <div className="flex items-center gap-1 border-b border-[#E8E8E4] mb-5">
        {(['queue', 'settings'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)}
            className={`px-4 py-2 text-[13px] font-medium border-b-2 -mb-px transition-colors ${
              tab === t ? 'border-[#7F77DD] text-[#1A1A2E]' : 'border-transparent text-[#555] hover:text-[#1A1A2E]'
            }`}>
            {t === 'queue' ? `Review queue (${items.length})` : 'Settings'}
          </button>
        ))}
      </div>

      {err && (
        <div className="mb-4 rounded-lg border border-[#DC2626] bg-[#FEE2E2] text-[#7F1D1D] px-3 py-2 text-[12px]">
          {err}
        </div>
      )}

      {tab === 'queue' && (
        <QueueTab
          items={filteredItems}
          loading={loading}
          selected={selected}
          expanded={expanded}
          deciding={deciding}
          filter={filter}
          totalCount={items.length}
          setFilter={setFilter}
          toggleSelect={toggleSelect}
          selectAllVisible={selectAllVisible}
          clearSelection={clearSelection}
          setExpanded={setExpanded}
          doDecide={doDecide}
          doBatch={doBatch}
        />
      )}

      {tab === 'settings' && (
        <SettingsTab
          settings={settings}
          stats={statsByCategory}
          loading={loading}
          onToggle={toggleCategory}
        />
      )}
    </div>
  )
}

function QueueTab(props: {
  items: ReviewQueueItem[]
  loading: boolean
  selected: Set<string>
  expanded: string | null
  deciding: string | null
  filter: 'all' | ReviewWorkCategory
  totalCount: number
  setFilter: (f: 'all' | ReviewWorkCategory) => void
  toggleSelect: (id: string) => void
  selectAllVisible: () => void
  clearSelection: () => void
  setExpanded: (id: string | null) => void
  doDecide: (id: string, action: 'approve' | 'reject', note?: string) => Promise<void>
  doBatch: (action: 'approve' | 'reject') => Promise<void>
}) {
  const { items, loading, selected, expanded, deciding, filter, totalCount } = props
  return (
    <>
      <div className="flex items-center justify-between gap-3 mb-3 flex-wrap">
        <div className="flex items-center gap-1 bg-[#F1EFE8] rounded-full p-1">
          {([
            ['all', `All (${totalCount})`],
            ['claim_submission', 'Claim submission'],
            ['rejections', 'Rejections'],
            ['denials', 'Denials'],
          ] as const).map(([val, label]) => (
            <button key={val} onClick={() => props.setFilter(val as any)}
              className={`px-3 py-1 text-[12px] font-medium rounded-full transition-colors ${
                filter === val ? 'bg-white text-[#1A1A2E] shadow-sm' : 'text-[#555] hover:text-[#1A1A2E]'
              }`}>
              {label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          {selected.size > 0 ? (
            <>
              <span className="text-[12px] text-[#555]">{selected.size} selected</span>
              <button onClick={() => void props.doBatch('approve')} disabled={deciding === 'batch'}
                title="Mark selected as handled (you did something about each)"
                className="inline-flex items-center gap-1.5 text-[12px] font-medium text-white bg-[#1D9E75] hover:bg-[#188960] rounded-lg px-3 py-1.5 disabled:opacity-50">
                <CheckCircle2 size={12} /> Mark selected handled
              </button>
              <button onClick={() => void props.doBatch('reject')} disabled={deciding === 'batch'}
                title="Dismiss selected (false alarm or won't act)"
                className="inline-flex items-center gap-1.5 text-[12px] font-medium text-[#7F1D1D] border border-[#FDA4AF] rounded-lg px-3 py-1.5 hover:bg-[#FEE2E2] disabled:opacity-50">
                <X size={12} /> Dismiss selected
              </button>
              <button onClick={props.clearSelection}
                className="text-[12px] text-[#555] hover:text-[#1A1A2E] px-2">
                Clear
              </button>
            </>
          ) : (
            items.length > 0 && (
              <button onClick={props.selectAllVisible}
                className="text-[12px] text-[#555] hover:text-[#1A1A2E] border border-[#E8E8E4] rounded-lg px-3 py-1.5 bg-white hover:bg-[#F1EFE8]">
                Select all visible
              </button>
            )
          )}
        </div>
      </div>

      {loading && items.length === 0 && (
        <div className="text-[13px] text-[#555] py-16 text-center">Loading…</div>
      )}

      {!loading && items.length === 0 && (
        <div className="rounded-xl border border-dashed border-[#E8E8E4] bg-[#FAFAF8] px-6 py-10 text-center">
          <Bot size={32} className="mx-auto text-[#7F77DD] mb-2 opacity-70" />
          <div className="text-[14px] font-medium text-[#1A1A2E] mb-1">Nothing waiting on you.</div>
          <p className="text-[12px] text-[#555] max-w-md mx-auto leading-snug">
            The agent will add items here as it finishes preparing claims, reading ERAs, and working rejections or denials. Agent jobs ship in a later build — this is the review surface.
          </p>
        </div>
      )}

      <div className="space-y-2">
        {items.map(it => {
          const checked = selected.has(it.id)
          const badge = ITEM_TYPE_BADGE[it.item_type] ?? { label: it.item_type, cls: 'bg-[#F1EFE8] text-[#555]' }
          const labels = ACTION_LABELS[it.item_type] ?? DEFAULT_ACTION_LABELS
          const open = expanded === it.id
          const isStage2Proposal = ['new_claim', 'rejection_fix', 'denial_fix', 'appeal_draft'].includes(it.item_type)
          return (
            <div key={it.id} className="bg-white border border-[#E8E8E4] rounded-xl overflow-hidden">
              <div className="flex items-start gap-3 p-4">
                <input type="checkbox" checked={checked} onChange={() => props.toggleSelect(it.id)}
                  className="mt-1" aria-label="Select for batch action" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1 flex-wrap">
                    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold ${badge.cls}`}>{badge.label}</span>
                    <span className="text-[13px] font-medium text-[#1A1A2E]">{it.patient_name ?? 'Unknown patient'}</span>
                    {it.service_date && <span className="text-[12px] text-[#555]">· DOS {fmtDate(it.service_date)}</span>}
                    {it.payer_name && <span className="text-[12px] text-[#555]">· {it.payer_name}</span>}
                  </div>
                  <p className="text-[13px] text-[#1A1A2E] leading-snug">{it.summary}</p>
                  <div className="text-[11px] text-[#777] mt-1">Queued {fmtDateTime(it.created_at)}</div>
                </div>
                <div className="flex items-center gap-1 flex-shrink-0">
                  <button onClick={() => {
                      // Notification-style items (stale_claim, underpayment) need
                      // a note describing WHAT was done so the audit trail is
                      // useful. Proposal-style items (Stage 2) can skip the note.
                      let note: string | undefined
                      if (labels.noteRequired) {
                        const entered = window.prompt(labels.notePrompt)
                        if (entered == null) return  // user cancelled
                        if (!entered.trim()) {
                          alert('A short note is required so the audit trail says what happened.')
                          return
                        }
                        note = entered.trim()
                      }
                      void props.doDecide(it.id, 'approve', note)
                    }}
                    disabled={deciding === it.id}
                    title={labels.primary}
                    className="inline-flex items-center gap-1 text-[12px] font-medium text-white bg-[#1D9E75] hover:bg-[#188960] rounded-lg px-2.5 py-1.5 disabled:opacity-50">
                    <CheckCircle2 size={11} /> {labels.primary}
                  </button>
                  {isStage2Proposal && (
                    <button
                      onClick={() => alert('Edit opens a side-by-side diff — wires in with Stage 2 when the agent is producing real proposals. Sara 2026-11-09.')}
                      className="inline-flex items-center gap-1 text-[12px] font-medium text-[#555] border border-[#E8E8E4] rounded-lg px-2.5 py-1.5 hover:bg-[#F1EFE8]">
                      <Pencil size={11} /> Edit
                    </button>
                  )}
                  <button onClick={() => {
                      const entered = window.prompt('Reason for dismissing (optional):')
                      if (entered == null) return  // cancelled
                      void props.doDecide(it.id, 'reject', entered.trim() || undefined)
                    }}
                    disabled={deciding === it.id}
                    title={labels.dismiss}
                    className="inline-flex items-center gap-1 text-[12px] font-medium text-[#7F1D1D] border border-[#FDA4AF] rounded-lg px-2.5 py-1.5 hover:bg-[#FEE2E2] disabled:opacity-50">
                    <X size={11} /> {labels.dismiss}
                  </button>
                  <button onClick={() => props.setExpanded(open ? null : it.id)}
                    className="p-1.5 rounded-lg hover:bg-[#F1EFE8] text-[#555]"
                    aria-label={open ? 'Collapse details' : 'Expand details'}>
                    {open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                  </button>
                </div>
              </div>
              {open && (
                <div className="px-4 pb-4 pt-0 border-t border-[#F1EFE8] bg-[#FAFAF8]">
                  <div className="text-[11px] font-semibold text-[#1A1A2E] uppercase tracking-wider mb-1.5 mt-3">Agent reasoning</div>
                  <pre className="text-[11px] text-[#1A1A2E] font-mono whitespace-pre-wrap bg-white rounded-lg border border-[#E8E8E4] p-3 overflow-x-auto">
                    {JSON.stringify(it.agent_reasoning ?? {}, null, 2)}
                  </pre>
                  {(it.proposed_change as any)?.demographics_diff && (
                    <>
                      <div className="text-[11px] font-semibold text-[#1A1A2E] uppercase tracking-wider mb-1.5 mt-3">Demographics diff — claim vs chart</div>
                      <DemographicsDiffBlock diff={(it.proposed_change as any).demographics_diff} />
                    </>
                  )}
                  {it.proposed_change && (
                    <>
                      <div className="text-[11px] font-semibold text-[#1A1A2E] uppercase tracking-wider mb-1.5 mt-3">Proposed change</div>
                      <pre className="text-[11px] text-[#1A1A2E] font-mono whitespace-pre-wrap bg-white rounded-lg border border-[#E8E8E4] p-3 overflow-x-auto">
                        {JSON.stringify(it.proposed_change, null, 2)}
                      </pre>
                    </>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </>
  )
}

function SettingsTab(props: {
  settings: BillingAgentCategorySetting[]
  stats: Map<ReviewWorkCategory, ReviewQueueStats>
  loading: boolean
  onToggle: (cat: ReviewWorkCategory, current: boolean) => Promise<void>
}) {
  const { settings, stats, loading } = props
  return (
    <>
      <div className="rounded-xl border border-[#F1EFE8] bg-[#FAFAF8] p-4 mb-4 flex items-start gap-3">
        <Info size={16} className="text-[#7F77DD] flex-shrink-0 mt-0.5" />
        <div className="text-[12px] text-[#555] leading-snug">
          <strong>Every toggle starts OFF.</strong> When a category is OFF, the agent prepares work and puts it in your review queue. When a category is ON, the agent commits directly — but write-offs, CPT/ICD changes, and family contact ALWAYS stay in the queue regardless.
        </div>
      </div>

      <div className="space-y-2">
        {settings.map(s => {
          const stat = stats.get(s.work_category)
          const rate = stat ? approvalRate(stat) : null
          const ratePct = rate == null ? null : Math.round(rate * 100)
          const rateCls = rate == null
            ? 'text-[#777]'
            : rate >= 0.95
              ? 'text-[#1D9E75]'
              : rate >= 0.8
                ? 'text-[#633806]'
                : 'text-[#7F1D1D]'
          return (
            <div key={s.work_category} className="bg-white border border-[#E8E8E4] rounded-xl p-4">
              <div className="flex items-center justify-between gap-4">
                <div className="flex-1">
                  <div className="text-[14px] font-medium text-[#1A1A2E]">{CATEGORY_LABEL[s.work_category]}</div>
                  <div className="text-[12px] text-[#555] mt-0.5">
                    {stat && stat.total > 0 ? (
                      <>
                        Last 30 days: <span className={`font-semibold ${rateCls}`}>{ratePct}%</span> approved clean · {stat.approved} approved · {stat.edited} edited · {stat.rejected} rejected · {stat.total} total
                      </>
                    ) : (
                      <>No decisions in the last 30 days yet.</>
                    )}
                  </div>
                  {s.auto_enabled && (
                    <div className="mt-1 inline-flex items-center gap-1 text-[11px] text-[#7F1D1D] bg-[#FEE2E2] border border-[#FDA4AF] rounded-full px-2 py-0.5">
                      <AlertTriangle size={11} /> Auto-on — agent commits directly
                    </div>
                  )}
                  {s.updated_at && (
                    <div className="text-[11px] text-[#777] mt-1">
                      Last changed {fmtDateTime(s.updated_at)}{s.updated_by_name ? ` by ${s.updated_by_name}` : ''}
                    </div>
                  )}
                </div>
                <button onClick={() => void props.onToggle(s.work_category, s.auto_enabled)}
                  disabled={loading}
                  aria-label={`Toggle ${CATEGORY_LABEL[s.work_category]} auto-mode`}
                  className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                    s.auto_enabled ? 'bg-[#1D9E75]' : 'bg-[#E8E8E4]'
                  } disabled:opacity-50`}>
                  <span className={`inline-block h-5 w-5 transform rounded-full bg-white transition-transform ${
                    s.auto_enabled ? 'translate-x-5' : 'translate-x-0.5'
                  }`} />
                </button>
              </div>
            </div>
          )
        })}
      </div>

      <div className="mt-6 rounded-xl border border-[#F1EFE8] bg-white p-4">
        <div className="text-[12px] font-semibold text-[#1A1A2E] uppercase tracking-wider mb-2">Never auto — always in queue</div>
        <ul className="space-y-1 text-[12px] text-[#555] list-disc list-inside leading-snug">
          <li>Any CPT or ICD-10 code change (add, remove, or substitute)</li>
          <li>Write-offs</li>
          <li>Family contact (email, text, letter)</li>
          <li>Appeals above the dollar threshold you set</li>
        </ul>
      </div>
    </>
  )
}

// Pretty render for PR-31 demographics-diff proposals. Three visual
// states:
//   - Mismatches present → red rows, side-by-side claim vs chart
//   - All fields match → amber banner recommending card review
// Sara 2026-11-13 after Sophie Slutzker's PR-31 showed the raw
// JSON wasn't fast enough to scan.
function DemographicsDiffBlock({ diff }: { diff: {
  diffs: Array<{ field: string; claim_value: string | null; chart_value: string | null }>
  all_match: boolean
  fields_checked: string[]
  summary: string
} }) {
  if (diff.all_match) {
    return (
      <div className="rounded-lg border border-[#F5B041] bg-[#FEF3C7] p-3 text-[12px] text-[#78350F] leading-relaxed">
        {diff.summary}
        <div className="mt-2 text-[10px] text-[#78350F]/70">
          Checked: {diff.fields_checked.join(' · ')}
        </div>
      </div>
    )
  }
  return (
    <div className="rounded-lg border border-[#E8E8E4] bg-white overflow-hidden">
      <div className="grid grid-cols-[1fr_1fr_1fr] text-[10px] uppercase tracking-wider font-semibold text-[#1A1A2E]/60 bg-[#FAFAF8] border-b border-[#E8E8E4]">
        <div className="px-3 py-2">Field</div>
        <div className="px-3 py-2 border-l border-[#E8E8E4]">On claim</div>
        <div className="px-3 py-2 border-l border-[#E8E8E4]">On chart</div>
      </div>
      {diff.diffs.map((d, i) => (
        <div key={i} className="grid grid-cols-[1fr_1fr_1fr] text-[12px] border-b border-[#F1EFE8] last:border-b-0">
          <div className="px-3 py-2 font-medium text-[#1A1A2E]">{d.field}</div>
          <div className="px-3 py-2 border-l border-[#E8E8E4] font-mono text-[#991B1B] bg-[#FEE2E2]/40">
            {d.claim_value ?? <span className="italic text-[#1A1A2E]/40">(empty)</span>}
          </div>
          <div className="px-3 py-2 border-l border-[#E8E8E4] font-mono text-[#065F46] bg-[#D1FAE5]/40">
            {d.chart_value ?? <span className="italic text-[#1A1A2E]/40">(empty)</span>}
          </div>
        </div>
      ))}
      <div className="px-3 py-2 bg-[#FAFAF8] border-t border-[#E8E8E4] text-[11px] text-[#1A1A2E]/70">
        Update the <strong>claim</strong> to match the chart, then resubmit. (Per Sara's rule: never auto-fix the chart from a denial.)
      </div>
    </div>
  )
}
