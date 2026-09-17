import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Link } from 'react-router-dom'
import { format } from 'date-fns'
import { FileText, AlertCircle, CheckCircle, XCircle, Clock, Send, ChevronDown, ChevronUp, RefreshCw, ExternalLink, Receipt, Pencil, Trash2, Plus, Zap, Search, X } from 'lucide-react'
import { Button } from '../../components/ui/Button'
import { getClaims, generateClaim, submitClaim, testClaim, updateClaim, deleteClaim, getFeeSchedule, markClaimReadyForBiller, unmarkClaimReadyForBiller, testStediEraSync, backfillStediCas, backfillStediCasForce, refetchKnownEras, getProviders, sendBillerQuestion, providerUpdateChild, writeOffClaim, type WriteOffReason } from '../../lib/api'
import { Ban } from 'lucide-react'

const CLAIM_WRITE_OFF_LABELS: Record<WriteOffReason, string> = {
  bad_debt:       'Bad debt (payer won\'t pay + patient won\'t either)',
  small_balance:  'Small balance (not worth pursuing)',
  hardship:       'Courtesy / hardship',
  billing_error:  'Billing error (our mistake)',
  timely_filing:  'Timely filing exceeded',
  other:          'Other',
}
import { useAuth } from '../../contexts/AuthContext'
import { PatientStatementModal } from './PatientStatementModal'

function moveItem<T>(arr: T[], from: number, to: number): T[] {
  const next = [...arr]
  const [item] = next.splice(from, 1)
  next.splice(to, 0, item)
  return next
}

// Extract a human-readable summary from any known Stedi rejection
// shape. Falls back to null when the shape is unknown so the caller
// can show the raw JSON.
function extractStediErrorSummary(details: any): string | null {
  if (!details) return null
  if (typeof details === 'string') return details
  if (Array.isArray(details?.errors) && details.errors.length) {
    return details.errors.map((e: any) => e.description || e.message || e.code || JSON.stringify(e)).join(' | ')
  }
  if (Array.isArray(details?.issues) && details.issues.length) {
    return details.issues.map((i: any) => `${i.path ?? ''}: ${i.message ?? JSON.stringify(i)}`).join(' | ')
  }
  // Stedi's pre-EDI validation errors: a plain object of
  // { "dotted.path": ["message"] } entries.
  if (details && typeof details === 'object' && !Array.isArray(details) && !details.status) {
    const entries = Object.entries(details)
    if (entries.length && entries.every(([, v]) => Array.isArray(v))) {
      return entries.map(([k, v]) => `${k}: ${(v as string[]).join(' ')}`).join(' | ')
    }
  }
  return details?.message ?? null
}

type Tab = 'review' | 'submitted'

const STATUS_BADGE: Record<string, { label: string; cls: string; icon: any }> = {
  pending_review: { label: 'Pending Review', cls: 'bg-[#FEF3E8] text-[#633806]', icon: Clock },
  submitted:      { label: 'Submitted',      cls: 'bg-[#E1F5EE] text-[#085041]', icon: Send },
  accepted:       { label: 'Accepted',       cls: 'bg-[#E1F5EE] text-[#085041]', icon: CheckCircle },
  rejected:       { label: 'Rejected',       cls: 'bg-[#FEE2E2] text-[#7F1D1D]', icon: XCircle },
  error:          { label: 'Error',          cls: 'bg-[#FEE2E2] text-[#7F1D1D]', icon: AlertCircle },
}

const KNOWN_PAYERS: Record<string, string> = {
  'Self Pay': 'PP',
  'BCBS of NC': 'UPICO', 'Anthem BCBS of VA': 'VABLS',
  'Aetna': '60054', 'Cigna': '62308',
  'United Healthcare': '87726', 'UMR': '39026', 'Humana': '61101',
  'PHCS / MultiPlan': '52133', 'Coventry': '38217',
  'Select Health': '53589', 'MedCost': '56196', 'Healthgram': '56162',
}

function fmtDate(d: any) {
  if (!d) return '—'
  try {
    const s = d instanceof Date ? d.toISOString() : String(d)
    const datePart = s.split('T')[0]
    const [y, m, day] = datePart.split('-').map(Number)
    if (isNaN(y) || isNaN(m) || isNaN(day)) return datePart || '—'
    return format(new Date(y, m - 1, day), 'MMM d, yyyy')
  } catch { return String(d).split('T')[0] || '—' }
}

function fmtMoney(n: any) {
  const v = parseFloat(n ?? 0)
  return isNaN(v) ? '—' : `$${v.toFixed(2)}`
}

export function AdminClaims() {
  const [tab, setTab] = useState<Tab>('review')
  const [claims, setClaims] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [expanded, setExpandedRaw] = useState<string | null>(null)
  const [eraTestRunning, setEraTestRunning] = useState(false)
  const [eraTestResult, setEraTestResult] = useState<Awaited<ReturnType<typeof testStediEraSync>> | null>(null)
  const [backfillRunning, setBackfillRunning] = useState(false)
  const [backfillResult, setBackfillResult] = useState<Awaited<ReturnType<typeof backfillStediCas>> | null>(null)
  const [refetchRunning, setRefetchRunning] = useState(false)
  const [refetchResult, setRefetchResult] = useState<Awaited<ReturnType<typeof refetchKnownEras>> | null>(null)

  const { provider: currentProvider } = useAuth()
  const [providerList, setProviderList] = useState<any[]>([])
  useEffect(() => {
    getProviders()
      .then(rows => setProviderList((rows ?? []).filter((p: any) => p.is_active && p.role !== 'admin')))
      .catch(() => setProviderList([]))
  }, [])

  // Per-claim "Notify provider" state: which claim's form is open, its
  // selected provider, the message draft, and the sending flag. Keyed
  // by claim id so multiple could be prepared at once without stepping
  // on each other. Cleared on send success.
  const [notifyOpen, setNotifyOpen] = useState<Record<string, boolean>>({})
  const [notifyForm, setNotifyForm] = useState<Record<string, { providerId: string; message: string }>>({})
  const [notifySending, setNotifySending] = useState<Record<string, boolean>>({})

  // Write-off modal — captures reason + optional note, hits the
  // /api/claims/[id]/write-off endpoint, then refreshes the list so the
  // written-off claim disappears from AR-insurance aging.
  const [writeOffTarget, setWriteOffTarget] = useState<any | null>(null)
  const [writeOffReason, setWriteOffReasonState] = useState<WriteOffReason>('bad_debt')
  const [writeOffNote, setWriteOffNote] = useState('')
  const [writingOff, setWritingOff] = useState(false)
  const [writeOffError, setWriteOffError] = useState<string | null>(null)

  async function confirmWriteOff() {
    if (!writeOffTarget) return
    setWritingOff(true)
    setWriteOffError(null)
    try {
      const result = await writeOffClaim(writeOffTarget.id, { reason: writeOffReason, note: writeOffNote })
      setWriteOffTarget(null)
      setWriteOffNote('')
      setWriteOffReasonState('bad_debt')
      await load()
      if (result?.action === 'pending') {
        // Confirmation for biller — request sent, awaiting owner approval.
        alert('Write-off request submitted. It will commit once the practice owner approves it.')
      }
    } catch (e: any) {
      setWriteOffError(e?.message ?? 'Failed to write off claim')
    } finally {
      setWritingOff(false)
    }
  }
  const [notifyResult, setNotifyResult] = useState<Record<string, string>>({})

  async function handleSendNotify(claimId: string) {
    const form = notifyForm[claimId]
    if (!form?.providerId || !form?.message?.trim()) {
      setNotifyResult(prev => ({ ...prev, [claimId]: 'Please pick a provider and enter a question.' }))
      return
    }
    setNotifySending(prev => ({ ...prev, [claimId]: true }))
    setNotifyResult(prev => ({ ...prev, [claimId]: '' }))
    try {
      const r = await sendBillerQuestion({
        claimId,
        providerId: form.providerId,
        question: form.message.trim(),
        billerName: currentProvider?.name || undefined,
      })
      const sentParts = [r.emailSent ? 'email' : null, r.smsSent ? 'text' : null].filter(Boolean).join(' + ')
      setNotifyResult(prev => ({ ...prev, [claimId]: sentParts ? `Sent via ${sentParts} to ${r.providerName ?? 'provider'}.` : 'Sent — but no email or phone on file for that provider.' }))
      setNotifyForm(prev => ({ ...prev, [claimId]: { providerId: '', message: '' } }))
      setTimeout(() => setNotifyOpen(prev => ({ ...prev, [claimId]: false })), 1400)
    } catch (e: any) {
      setNotifyResult(prev => ({ ...prev, [claimId]: e?.message ?? 'Failed to send.' }))
    } finally {
      setNotifySending(prev => ({ ...prev, [claimId]: false }))
    }
  }

  // Auto-mark ERA as seen when the biller expands a claim card that has
  // era_received_at but no era_seen_at yet. Optimistic — updates local
  // state first then persists.
  function setExpanded(nextId: string | null) {
    setExpandedRaw(nextId)
    if (!nextId) return
    const target = claims.find(c => c.id === nextId)
    if (target?.era_received_at && !target?.era_seen_at) {
      const nowIso = new Date().toISOString()
      setClaims(prev => prev.map(c => c.id === nextId ? { ...c, era_seen_at: nowIso } : c))
      updateClaim(nextId, { era_seen_at: nowIso }).catch(e => {
        // Roll back local state if the persist failed so the badge count
        // stays accurate.
        console.error('[AdminClaims] mark era_seen_at failed:', e)
        setClaims(prev => prev.map(c => c.id === nextId ? { ...c, era_seen_at: null } : c))
      })
    }
  }
  const [regenerating, setRegenerating] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState<string | null>(null)
  const [testing, setTesting] = useState<string | null>(null)
  const [testResults, setTestResults] = useState<Record<string, any>>({})
  const [reopening, setReopening] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [saving, setSaving] = useState<string | null>(null)
  const [markingReady, setMarkingReady] = useState<string | null>(null)
  const [readyOnly, setReadyOnly] = useState(false)
  const [statementClaim, setStatementClaim] = useState<any>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [feeSchedule, setFeeSchedule] = useState<any[]>([])
  const [cptSearch, setCptSearch] = useState<Record<string, string>>({})
  const [cptOpen, setCptOpen] = useState<Record<string, boolean>>({})
  const [cptTab, setCptTab] = useState<Record<string, string>>({})
  const [editPayer, setEditPayer] = useState<Record<string, { name: string; id: string }>>({})
  const [editCpt, setEditCpt] = useState<Record<string, any[]>>({})
  const [editDx, setEditDx] = useState<Record<string, any[]>>({})
  const [dxQuery, setDxQuery] = useState<Record<string, string>>({})
  const [dxResults, setDxResults] = useState<Record<string, any[]>>({})
  const [dxSearching, setDxSearching] = useState<Record<string, boolean>>({})
  const dxTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({})
  const [editPatient, setEditPatient] = useState<Record<string, {
    patient_first_name: string; patient_last_name: string; patient_dob: string; patient_gender: string;
    patient_address: string; patient_city: string; patient_state: string; patient_zip: string;
    member_id: string; group_number: string; insurance_dependent_code: string;
    subscriber_name: string; subscriber_dob: string; subscriber_gender: string;
    child_id?: string | null;
  }>>({})
  const [rejectionModal, setRejectionModal] = useState<{
    message: string
    summary: string
    details: any
    sentDependent?: any
  } | null>(null)

  async function load() {
    setLoading(true)
    try {
      // Fetch draft too — belt-and-suspenders so no claim can ever be
      // in a status that this page doesn't render, even accidentally.
      const [review, errored, submitted, draft] = await Promise.all([
        getClaims('pending_review'),
        getClaims('error'),
        getClaims('submitted'),
        getClaims('draft'),
      ])
      setClaims([...review, ...errored, ...submitted, ...draft])
    } catch (e: any) {
      alert('Failed to load claims: ' + (e.message ?? 'Unknown error'))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
    getFeeSchedule().then(data => setFeeSchedule(data ?? [])).catch(() => {})
  }, [])

  function onDxQueryChange(claimId: string, q: string) {
    setDxQuery(prev => ({ ...prev, [claimId]: q }))
    if (dxTimers.current[claimId]) clearTimeout(dxTimers.current[claimId])
    if (!q.trim()) { setDxResults(prev => ({ ...prev, [claimId]: [] })); return }
    dxTimers.current[claimId] = setTimeout(async () => {
      setDxSearching(prev => ({ ...prev, [claimId]: true }))
      try {
        const url = `https://clinicaltables.nlm.nih.gov/api/icd10cm/v3/search?sf=code,name&df=code,name&terms=${encodeURIComponent(q)}&maxList=8`
        const data = await fetch(url).then(r => r.json())
        const codes: string[] = data[1] ?? []
        const rows: string[][] = data[3] ?? []
        setDxResults(prev => ({ ...prev, [claimId]: codes.map((code, i) => ({ code, name: rows[i]?.[1] ?? rows[i]?.[0] ?? '' })) }))
      } catch { setDxResults(prev => ({ ...prev, [claimId]: [] })) }
      setDxSearching(prev => ({ ...prev, [claimId]: false }))
    }, 300)
  }

  async function saveDx(claimId: string) {
    setSaving(claimId)
    try {
      const updated = await updateClaim(claimId, { diagnoses: editDx[claimId] })
      setClaims(prev => prev.map(c => c.id === claimId ? { ...c, ...updated } : c))
      setEditDx(prev => { const n = { ...prev }; delete n[claimId]; return n })
      setDxQuery(prev => { const n = { ...prev }; delete n[claimId]; return n })
      setDxResults(prev => { const n = { ...prev }; delete n[claimId]; return n })
    } catch { alert('Failed to save diagnoses') }
    finally { setSaving(null) }
  }

  async function handleTest(claimId: string) {
    setTesting(claimId)
    try {
      const result = await testClaim(claimId)
      const ack = result.acknowledgment
      // Stedi validation error (e.g. bad field) — ack has errors[] array
      if (!result.accepted && ack?.errors?.length) {
        const msgs = ack.errors.map((e: any) => e.message ?? e.description ?? JSON.stringify(e)).join('; ')
        setTestResults(prev => ({ ...prev, [claimId]: { error: msgs } }))
        return
      }
      // 277CA structured response
      const status = ack?.transactionSets?.[0]?.claimStatusInformation?.[0]?.claimStatus ?? (result.accepted ? 'A' : null)
      const errors = ack?.transactionSets?.[0]?.claimStatusInformation?.[0]?.claimStatusDetails ?? []
      setTestResults(prev => ({ ...prev, [claimId]: { status, errors, raw: ack } }))
    } catch (e: any) {
      setTestResults(prev => ({ ...prev, [claimId]: { error: e.message } }))
    } finally {
      setTesting(null)
    }
  }

  async function handleRegenerate(claimId: string, noteId: string) {
    if (!confirm('Delete this claim and regenerate it from the current note? Use this if CPT codes were added after the claim was first generated.')) return
    setRegenerating(claimId)
    try {
      await deleteClaim(claimId)
      await generateClaim(noteId)
      await load()
    } catch (e: any) {
      alert(e.message || 'Regeneration failed')
    } finally {
      setRegenerating(null)
    }
  }

  async function handleSubmit(claimId: string) {
    if (!confirm('Submit this claim to insurance? This cannot be undone.')) return
    setSubmitting(claimId)
    try {
      await submitClaim(claimId)
      await load()
    } catch (e: any) {
      // Show the FULL Stedi response in a scrollable modal — the
      // browser's alert() truncates and the actual field-level reason
      // hides in the tail of the JSON. Extract a bold summary and
      // dump the raw response for copy/paste.
      const details = e.details
      const summary = extractStediErrorSummary(details) || e.message || 'Submission failed'
      setRejectionModal({
        message: e.message || 'Stedi rejected the claim',
        summary,
        details,
        sentDependent: e.sentDependent,
      })
      await load()
    } finally {
      setSubmitting(null)
    }
  }

  async function handleDelete(claimId: string) {
    if (!confirm('Permanently delete this claim? This cannot be undone.')) return
    setDeleting(claimId)
    try {
      await deleteClaim(claimId)
      setClaims(prev => prev.filter(c => c.id !== claimId))
      if (expanded === claimId) setExpanded(null)
    } catch (e: any) {
      alert(e.message || 'Failed to delete claim')
    } finally {
      setDeleting(null)
    }
  }

  async function handleToggleReady(claimId: string, currentlyReady: boolean) {
    setMarkingReady(claimId)
    try {
      const updated = currentlyReady
        ? await unmarkClaimReadyForBiller(claimId)
        : await markClaimReadyForBiller(claimId)
      setClaims(prev => prev.map(c => c.id === claimId
        ? { ...c, ready_for_biller_at: updated.ready_for_biller_at, ready_for_biller_by: updated.ready_for_biller_by }
        : c))
    } catch (e: any) {
      alert(e.message || 'Failed to update ready-for-biller status')
    } finally {
      setMarkingReady(null)
    }
  }

  async function handleReopen(claimId: string) {
    if (!confirm('Move this claim back to Pending Review? The claim has already been submitted to insurance — only do this if you need to correct an error and resubmit.')) return
    setReopening(claimId)
    try {
      await updateClaim(claimId, { status: 'pending_review' })
      await load()
      setTab('review')
    } catch (e: any) {
      alert(e.message || 'Failed to reopen claim')
    } finally {
      setReopening(null)
    }
  }

  async function handlePayerSave(claimId: string) {
    const p = editPayer[claimId]
    if (!p) return
    setSaving(claimId)
    setSaveError(null)
    try {
      await updateClaim(claimId, { payer_name: p.name, payer_id: p.id })
      setEditPayer(prev => { const n = { ...prev }; delete n[claimId]; return n })
      await load()
    } catch (e: any) {
      setSaveError(e.message ?? 'Save failed')
    } finally {
      setSaving(null)
    }
  }

  async function handleCptSave(claimId: string) {
    const codes = editCpt[claimId]
    if (!codes) return
    setSaving(claimId + '_cpt')
    setSaveError(null)
    try {
      await updateClaim(claimId, { cpt_codes: codes })
      setEditCpt(prev => { const n = { ...prev }; delete n[claimId]; return n })
      await load()
    } catch (e: any) {
      setSaveError(e.message ?? 'Save failed')
    } finally {
      setSaving(null)
    }
  }

  async function handlePatientSave(claimId: string) {
    const p = editPatient[claimId]
    if (!p) return
    setSaving(claimId + '_patient')
    setSaveError(null)
    try {
      const { child_id, ...claimFields } = p
      await updateClaim(claimId, claimFields)
      // Propagate the BCBS NC dependent code onto the child too so every
      // future claim for this kid inherits it automatically — otherwise
      // biller re-enters it every visit.
      if (child_id && p.insurance_dependent_code) {
        await providerUpdateChild(child_id, { insurance_dependent_code: p.insurance_dependent_code }).catch(() => {})
      }
      setEditPatient(prev => { const n = { ...prev }; delete n[claimId]; return n })
      await load()
    } catch (e: any) {
      setSaveError(e.message ?? 'Save failed')
    } finally {
      setSaving(null)
    }
  }

  // Once the admin has sent the patient statement for a self-pay claim, hide
  // the claim from the list — self-pay claims aren't submitted to insurance,
  // so the statement being sent is their end state. `statement_status` and
  // `statement_sent_at` come from the LEFT JOIN on patient_statements in
  // api/claims/index.ts.
  const isSelfPayWithSentStatement = (c: any) =>
    c.payer_id === 'PP' && (c.statement_status === 'sent' || !!c.statement_sent_at)
  const isReady = (c: any) => !!c.ready_for_biller_at
  const baseVisibleClaims = claims.filter(c => !isSelfPayWithSentStatement(c))
  const visibleClaims  = readyOnly ? baseVisibleClaims.filter(isReady) : baseVisibleClaims
  const reviewClaims    = visibleClaims.filter(c => c.status === 'pending_review' || c.status === 'error' || c.status === 'draft')
  const submittedClaims = visibleClaims.filter(c => c.status !== 'pending_review' && c.status !== 'error' && c.status !== 'draft')
  // Only count claims she still has to act on — same status filter as
  // reviewClaims. Once she submits a claim, ready_for_biller_at stays
  // set on the row (biller attribution), but for the counter it's
  // stale — she's already handled that one.
  const readyCount      = baseVisibleClaims.filter(c => isReady(c) && (c.status === 'pending_review' || c.status === 'error' || c.status === 'draft')).length
  // Unseen ERA payments — bill can see how many new payments landed since
  // last review. Cleared per-claim by clicking "Mark seen" on the ERA card.
  const unseenEraCount  = baseVisibleClaims.filter((c: any) => c.era_received_at && !c.era_seen_at).length

  const tabCls = (t: Tab) =>
    `px-4 py-2.5 text-[13px] font-medium border-b-2 transition-colors ${tab === t ? 'border-[#7F77DD] text-[#7F77DD]' : 'border-transparent text-[#1A1A2E] hover:text-[#555]'}`

  // "Notify provider" collapsible per-claim. Same JSX in both tabs, so
  // pulled into a local closure over component state. The button lives
  // inline with the other claim actions; the form only renders when
  // opened for that claim id.
  function renderNotifySection(claim: any) {
    const isOpen = !!notifyOpen[claim.id]
    const form = notifyForm[claim.id] ?? { providerId: '', message: '' }
    const sending = !!notifySending[claim.id]
    const result = notifyResult[claim.id] ?? ''
    return (
      <div className="border-t border-[#F1EFE8] pt-3">
        <button
          type="button"
          onClick={() => {
            setNotifyOpen(prev => ({ ...prev, [claim.id]: !isOpen }))
            setNotifyResult(prev => ({ ...prev, [claim.id]: '' }))
          }}
          className="flex items-center gap-1.5 text-[12px] font-medium px-2.5 py-1 rounded-lg border border-[#7F77DD] text-[#7F77DD] hover:bg-[#EEEDFE] transition-colors">
          {isOpen ? 'Cancel notify' : 'Notify provider'}
        </button>
        {isOpen && (
          <div className="mt-3 bg-[#F9F9F7] border border-[#E8E8E4] rounded-lg p-3 space-y-2">
            <div className="text-[11px] text-[#555]">
              Sending to a provider about <strong>{[(claim.child_first_name ?? claim.patient_first_name), (claim.child_last_name ?? claim.patient_last_name)].filter(Boolean).join(' ') || 'this patient'}</strong> · DOB {fmtDate(claim.patient_dob)} · Visit {fmtDate(claim.service_date)}
            </div>
            <div>
              <label className="text-[11px] font-medium text-[#555] block mb-1">Provider</label>
              <select
                value={form.providerId}
                onChange={e => setNotifyForm(prev => ({ ...prev, [claim.id]: { ...form, providerId: e.target.value } }))}
                className="w-full px-3 py-2 border border-[#E8E8E4] rounded-lg text-[13px] bg-white outline-none focus:border-[#7F77DD]">
                <option value="">— select provider —</option>
                {providerList.map(p => (
                  <option key={p.id} value={p.id}>{p.name}{p.role ? ` (${p.role})` : ''}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-[11px] font-medium text-[#555] block mb-1">Question</label>
              <textarea
                value={form.message}
                onChange={e => setNotifyForm(prev => ({ ...prev, [claim.id]: { ...form, message: e.target.value } }))}
                placeholder="What do you need to ask the provider about this encounter?"
                rows={4}
                className="w-full px-3 py-2 border border-[#E8E8E4] rounded-lg text-[13px] bg-white outline-none focus:border-[#7F77DD] resize-none" />
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => handleSendNotify(claim.id)}
                disabled={sending}
                className="text-[12px] font-medium px-3 py-1.5 rounded-lg bg-[#7F77DD] text-white hover:bg-[#3C3489] transition-colors disabled:opacity-50">
                {sending ? 'Sending…' : 'Send'}
              </button>
              {result && <span className={`text-[11px] ${result.startsWith('Sent') ? 'text-[#085041]' : 'text-[#791F1F]'}`}>{result}</span>}
            </div>
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="p-8">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="font-display text-[22px] font-medium text-[#1A1A2E]">Claims</h1>
          <p className="text-[13px] text-[#1A1A2E] mt-0.5">Generate and submit insurance claims from signed encounter notes</p>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={async () => {
              setEraTestRunning(true)
              setEraTestResult(null)
              try {
                const r = await testStediEraSync()
                setEraTestResult(r)
                // Refresh claims list so any newly-updated ERA rows show up.
                await load()
              } catch (e: any) {
                setEraTestResult({
                  ok: false, diagnosis: `Request failed: ${e?.message ?? 'unknown error'}`,
                  fetched: 0, matched: 0, statementsCreated: 0, statementsUpdated: 0, unmatched: 0,
                  errors: [], sampleUnmatchedStediIds: [],
                } as any)
              } finally {
                setEraTestRunning(false)
              }
            }}
            disabled={eraTestRunning}
            className="flex items-center gap-1.5 text-[12px] px-2.5 py-1 rounded-lg border border-[#7F77DD] text-[#7F77DD] hover:bg-[#EEEDFE] transition-colors disabled:opacity-50">
            <Zap size={12} /> {eraTestRunning ? 'Testing…' : 'Test Stedi ERA sync'}
          </button>
          <button
            onClick={async () => {
              if (!window.confirm('Backfill CAS breakdown for the last 60 days? Runs against all ERAs Stedi received in that window. Biller manual edits are preserved.')) return
              setBackfillRunning(true)
              setBackfillResult(null)
              try {
                const r = await backfillStediCas(60)
                setBackfillResult(r)
                await load()
              } catch (e: any) {
                setBackfillResult({ ok: false, days: 60, startDateTime: '', transactionsSeen: 0, transactionsProcessed: 0, skippedNotEra: 0, skippedAlreadyProcessed: 0, claimsUpdated: 0, pagesFetched: 0, errors: [e?.message ?? String(e)] } as any)
              } finally {
                setBackfillRunning(false)
              }
            }}
            disabled={backfillRunning}
            className="flex items-center gap-1.5 text-[12px] px-2.5 py-1 rounded-lg border border-[#7F77DD] text-[#7F77DD] hover:bg-[#EEEDFE] transition-colors disabled:opacity-50">
            <Zap size={12} /> {backfillRunning ? 'Backfilling…' : 'Backfill Stedi CAS (60d)'}
          </button>
          <button
            onClick={async () => {
              if (!window.confirm('FORCE re-run backfill for all ERAs Stedi received in the last 60 days? Bypasses the idempotency guard so already-processed transactions get re-fetched and re-applied. Use this to fix CAS breakdowns that landed as zero.')) return
              setBackfillRunning(true)
              setBackfillResult(null)
              try {
                const r = await backfillStediCasForce(60)
                setBackfillResult(r)
                await load()
              } catch (e: any) {
                setBackfillResult({ ok: false, days: 60, startDateTime: '', transactionsSeen: 0, transactionsProcessed: 0, skippedNotEra: 0, skippedAlreadyProcessed: 0, claimsUpdated: 0, pagesFetched: 0, errors: [e?.message ?? String(e)] } as any)
              } finally {
                setBackfillRunning(false)
              }
            }}
            disabled={backfillRunning}
            className="flex items-center gap-1.5 text-[12px] px-2.5 py-1 rounded-lg border border-[#B45309] text-[#B45309] hover:bg-[#FFF7ED] transition-colors disabled:opacity-50">
            <Zap size={12} /> {backfillRunning ? 'Backfilling…' : 'FORCE re-backfill (60d)'}
          </button>
          <button
            onClick={async () => {
              setRefetchRunning(true)
              setRefetchResult(null)
              try {
                const r = await refetchKnownEras()
                setRefetchResult(r)
              } catch (e: any) {
                setRefetchResult({
                  transactions_found_in_db: 0,
                  per_transaction: [],
                  totals: { stedi_fetched: 0, claims_saved: 0, errors: 1 },
                } as any)
                alert(e?.message ?? String(e))
              } finally {
                setRefetchRunning(false)
              }
            }}
            disabled={refetchRunning}
            className="flex items-center gap-1.5 text-[12px] px-2.5 py-1 rounded-lg border border-[#1D9E75] text-[#1D9E75] hover:bg-[#E6F6F2] transition-colors disabled:opacity-50">
            <Zap size={12} /> {refetchRunning ? 'Refetching…' : 'Refetch known ERAs by ID'}
          </button>
          <button onClick={load} className="flex items-center gap-1.5 text-[12px] text-[#1A1A2E] hover:text-[#555] transition-colors">
            <RefreshCw size={13} /> Refresh
          </button>
        </div>
      </div>

      {eraTestResult && (
        <div className={`mb-4 border rounded-xl px-4 py-3 ${eraTestResult.ok ? 'bg-[#F5F4FE] border-[#AFA9EC] text-[#3C3489]' : 'bg-[#FCEBEB] border-[#F4B4B4] text-[#791F1F]'}`}>
          <div className="flex items-start justify-between gap-3">
            <div className="text-[13px] font-medium">{eraTestResult.diagnosis || 'Test complete.'}</div>
            <button onClick={() => setEraTestResult(null)} className="text-[11px] opacity-70 hover:opacity-100 flex-shrink-0">Dismiss</button>
          </div>
          <div className="text-[11px] mt-2 grid grid-cols-3 sm:grid-cols-6 gap-x-4 gap-y-1 opacity-90">
            <div><span className="opacity-70">Fetched:</span> {eraTestResult.fetched}</div>
            <div><span className="opacity-70">Matched:</span> {eraTestResult.matched}</div>
            <div><span className="opacity-70">Statements created:</span> {eraTestResult.statementsCreated}</div>
            <div><span className="opacity-70">Statements updated:</span> {eraTestResult.statementsUpdated}</div>
            <div><span className="opacity-70">Unmatched:</span> {eraTestResult.unmatched}</div>
            <div><span className="opacity-70">Errors:</span> {eraTestResult.errors.length}</div>
          </div>
          {eraTestResult.sampleUnmatchedStediIds.length > 0 && (
            <div className="text-[11px] mt-2 opacity-80">
              Sample Stedi claim IDs with errors: <span className="font-mono">{eraTestResult.sampleUnmatchedStediIds.join(', ')}</span>
            </div>
          )}
          {eraTestResult.timelineStatusCodes && eraTestResult.timelineStatusCodes.length > 0 && (
            <div className="text-[11px] mt-1 opacity-80">
              Timeline HTTP status codes: <span className="font-mono">{eraTestResult.timelineStatusCodes.join(', ')}</span>
            </div>
          )}
          {eraTestResult.errors.length > 0 && (
            <div className="text-[11px] mt-1 opacity-80">Errors: {eraTestResult.errors.slice(0, 3).join(' · ')}</div>
          )}
          {eraTestResult.sampleTimelineResponse && (
            <details className="text-[11px] mt-2">
              <summary className="cursor-pointer opacity-80">Raw sample of Stedi claim timeline response (click to expand)</summary>
              <pre className="text-[10px] font-mono mt-1 p-2 bg-white/50 rounded whitespace-pre-wrap break-all">{eraTestResult.sampleTimelineResponse}</pre>
            </details>
          )}
        </div>
      )}

      {backfillResult && (
        <div className={`mb-4 border rounded-xl px-4 py-3 ${backfillResult.ok ? 'bg-[#F5F4FE] border-[#AFA9EC] text-[#3C3489]' : 'bg-[#FCEBEB] border-[#F4B4B4] text-[#791F1F]'}`}>
          <div className="flex items-start justify-between gap-3">
            <div className="text-[13px] font-medium">
              CAS backfill ({backfillResult.days}d) — {backfillResult.claimsUpdated} claim{backfillResult.claimsUpdated === 1 ? '' : 's'} updated from {backfillResult.transactionsProcessed} ERA{backfillResult.transactionsProcessed === 1 ? '' : 's'}.
            </div>
            <button onClick={() => setBackfillResult(null)} className="text-[11px] opacity-70 hover:opacity-100 flex-shrink-0">Dismiss</button>
          </div>
          <div className="text-[11px] mt-2 grid grid-cols-3 sm:grid-cols-6 gap-x-4 gap-y-1 opacity-90">
            <div><span className="opacity-70">Transactions seen:</span> {backfillResult.transactionsSeen}</div>
            <div><span className="opacity-70">Processed:</span> {backfillResult.transactionsProcessed}</div>
            <div><span className="opacity-70">Claims updated:</span> {backfillResult.claimsUpdated}</div>
            <div><span className="opacity-70">Already processed:</span> {backfillResult.skippedAlreadyProcessed}</div>
            <div><span className="opacity-70">Non-835 skipped:</span> {backfillResult.skippedNotEra}</div>
            <div><span className="opacity-70">Errors:</span> {backfillResult.errors.length}</div>
          </div>
          {backfillResult.errors.length > 0 && (
            <div className="text-[11px] mt-1 opacity-80">Errors: {backfillResult.errors.slice(0, 3).join(' · ')}</div>
          )}
        </div>
      )}

      {refetchResult && (
        <div className="mb-4 border rounded-xl px-4 py-3 bg-[#F0FDF4] border-[#A9DFBF] text-[#0F5F44]">
          <div className="flex items-start justify-between gap-3">
            <div className="text-[13px] font-medium">
              Refetch via /eras — {refetchResult.remittances_fetched}/{refetchResult.remittances_seen} remittances, {refetchResult.claims_matched} claim{refetchResult.claims_matched === 1 ? '' : 's'} matched + CAS applied.
            </div>
            <button onClick={() => setRefetchResult(null)} className="text-[11px] opacity-70 hover:opacity-100 flex-shrink-0">Dismiss</button>
          </div>
          <div className="text-[11px] mt-2 grid grid-cols-3 gap-x-4 gap-y-1 opacity-90">
            <div><span className="opacity-70">List HTTP:</span> {refetchResult.list_http}</div>
            <div><span className="opacity-70">Remittances seen:</span> {refetchResult.remittances_seen}</div>
            <div><span className="opacity-70">Claim payments seen:</span> {refetchResult.claim_payments_seen}</div>
          </div>
          {refetchResult.per_remittance.length > 0 && (
            <div className="mt-2 space-y-1 text-[11px] font-mono opacity-90">
              {refetchResult.per_remittance.map(r => (
                <div key={r.remittance_id} className="border-t border-[#A9DFBF] pt-1">
                  <div><span className="opacity-70">rem=</span>{r.remittance_id.slice(0, 20)}…  <span className="opacity-70">http=</span>{r.detail_http}  <span className="opacity-70">payments=</span>{r.claim_payments_seen}  <span className="opacity-70">matched=</span>{r.matched.length}</div>
                  {r.matched.map((m, i) => (
                    <div key={i} className="ml-3 text-[#0F5F44]">
                      claim={m.claim_id.slice(0, 8)}… CAS: ded=${m.cas.patient_deductible.toFixed(2)} coins=${m.cas.patient_coinsurance.toFixed(2)} copay=${m.cas.patient_copay.toFixed(2)} nonCov=${m.cas.patient_non_covered.toFixed(2)} contract=${m.cas.contractual_adjustment.toFixed(2)} · denial_codes={m.denial_codes_count}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}
          {refetchResult.errors.length > 0 && (
            <div className="text-[11px] mt-2 text-[#991B1B]">Errors: {refetchResult.errors.slice(0, 3).join(' · ')}</div>
          )}
          {refetchResult.payer_ids_queried.length > 0 && (
            <div className="text-[11px] mt-2 opacity-70">Payer IDs queried: {refetchResult.payer_ids_queried.join(', ')}</div>
          )}
          {refetchResult.sample_top_level_keys.length > 0 && (
            <div className="text-[11px] mt-2 opacity-90">
              <div className="opacity-70">First remittance response shape:</div>
              <div className="mt-1 font-mono">keys = [{refetchResult.sample_top_level_keys.join(', ')}]</div>
              <details className="mt-1">
                <summary className="opacity-70 cursor-pointer">Show full JSON (first 3000 chars)</summary>
                <pre className="mt-1 whitespace-pre-wrap text-[10px] max-h-96 overflow-y-auto bg-white border border-[#A9DFBF] rounded p-2">{refetchResult.sample_detail_shape}</pre>
              </details>
            </div>
          )}
        </div>
      )}

      {unseenEraCount > 0 && (
        <div className="mb-4 flex items-center gap-2 bg-[#E1F5EE] border border-[#5DCAA5] text-[#085041] px-4 py-2.5 rounded-xl">
          <Zap size={14} />
          <div className="text-[13px] font-medium">
            {unseenEraCount} new ERA payment{unseenEraCount === 1 ? '' : 's'} posted — look for the pulsing <span className="mx-1 inline-flex items-center gap-0.5 bg-[#5DCAA5] text-white px-1.5 py-0.5 rounded-full text-[10px] font-semibold">NEW</span> badge on claims below.
          </div>
          <button
            onClick={async () => {
              const nowIso = new Date().toISOString()
              const targets = claims.filter((c: any) => c.era_received_at && !c.era_seen_at)
              // Optimistic local update first so the banner disappears
              // immediately; roll back if any persist fails.
              setClaims(prev => prev.map(c => targets.some(t => t.id === c.id) ? { ...c, era_seen_at: nowIso } : c))
              try {
                await Promise.all(targets.map(t => updateClaim(t.id, { era_seen_at: nowIso })))
              } catch (e: any) {
                console.error('[AdminClaims] Mark all seen failed:', e)
                await load()
              }
            }}
            className="ml-auto text-[12px] font-medium px-3 py-1 rounded-lg bg-white border border-[#5DCAA5] text-[#085041] hover:bg-[#E1F5EE] transition-colors">
            Mark all as seen
          </button>
        </div>
      )}

      {/* Tabs + Ready-for-biller filter */}
      <div className="flex items-center justify-between border-b border-[#E8E8E4] mb-6">
        <div className="flex">
          <button className={tabCls('review')} onClick={() => setTab('review')}>
            Pending Review ({reviewClaims.length})
          </button>
          <button className={tabCls('submitted')} onClick={() => setTab('submitted')}>
            Submitted ({submittedClaims.length})
          </button>
        </div>
        <label className="flex items-center gap-1.5 text-[12px] text-[#555] pr-2 pb-2 cursor-pointer">
          <input type="checkbox" checked={readyOnly} onChange={e => setReadyOnly(e.target.checked)} />
          Ready for biller only
          {readyCount > 0 && <span className="ml-1 px-1.5 py-0.5 rounded-full bg-[#E1F5EE] text-[#085041] text-[10px] font-semibold">{readyCount}</span>}
        </label>
      </div>

      {loading ? (
        <div className="text-[#1A1A2E] text-[13px] py-12 text-center">Loading…</div>
      ) : (
        <>
          {/* PENDING REVIEW TAB */}
          {tab === 'review' && (
            <div className="space-y-3">
              {reviewClaims.length === 0 && (
                <div className="text-center py-12 text-[#1A1A2E] text-[13px]">No claims pending review.</div>
              )}
              {reviewClaims.map(c => {
                const isOpen = expanded === c.id
                const ep = editPayer[c.id]
                const isSelfPay = c.payer_id === 'PP'
                const missingPayer = !c.payer_id && !isSelfPay
                const isError = c.status === 'error'
                const readyForBiller = !!c.ready_for_biller_at
                // Only show the "Generate patient statement" button when
                // there's nothing for insurance to bill — either the
                // payer is Self Pay, or every CPT on the claim is a
                // Non-Covered Services code (Text e-visit alone, CPR
                // class alone, etc). Mixed visits — a real sick visit
                // 99349 plus a convenience fee, for example — still go
                // through insurance first, and the patient statement
                // gets generated from the ERA later.
                const cpts: any[] = Array.isArray(c.cpt_codes) ? c.cpt_codes : []
                const allCptsNonCovered = cpts.length > 0
                  && cpts.every((code: any) => code?.category === 'Non-Covered Services')
                const showStatementButton = isSelfPay || allCptsNonCovered
                const stediError = (() => {
                  if (!c.submission_error) return null
                  try {
                    const parsed = JSON.parse(c.submission_error)
                    return parsed?.errors?.[0]?.description ?? parsed?.message ?? c.submission_error
                  } catch { return c.submission_error }
                })()
                return (
                  <div key={c.id} className="bg-white border border-[#E8E8E4] rounded-xl overflow-hidden">
                    <button className="w-full flex items-center justify-between px-4 py-3.5 text-left hover:bg-[#FAFAF8] transition-colors"
                      onClick={() => setExpanded(isOpen ? null : c.id)}>
                      <div className="flex items-center gap-3 min-w-0">
                        <FileText size={15} className="text-[#7F77DD] flex-shrink-0" />
                        <div>
                          <div className="text-[14px] font-medium text-[#1A1A2E]">
                            {[(c.child_first_name ?? c.patient_first_name), (c.child_last_name ?? c.patient_last_name)].filter(Boolean).join(' ') || 'Unknown patient'}
                            <span className="ml-2 text-[12px] font-normal text-[#1A1A2E]">{fmtDate(c.service_date)}</span>
                          </div>
                          <div className="flex items-center gap-2 mt-0.5">
                            {isError ? (
                              <button
                                type="button"
                                onClick={e => { e.stopPropagation(); handleSubmit(c.id) }}
                                disabled={submitting === c.id}
                                className="text-[11px] text-[#DC2626] font-medium flex items-center gap-1 hover:underline disabled:opacity-60">
                                <AlertCircle size={11} /> {submitting === c.id ? 'Retrying…' : 'Submission failed — click to retry'}
                              </button>
                            ) : isSelfPay ? (
                              <span className="text-[12px] text-[#555]">
                                <span className="inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-semibold bg-[#F1EFE8] text-[#555] mr-1.5">Self-Pay</span>
                                {fmtMoney(c.total_charge)}
                              </span>
                            ) : missingPayer ? (
                              <span className="text-[11px] text-[#DC2626] font-medium flex items-center gap-1">
                                <AlertCircle size={11} /> Payer ID missing — review required
                              </span>
                            ) : (
                              <span className="text-[12px] text-[#555]">{c.payer_name} · {fmtMoney(c.total_charge)}</span>
                            )}
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        {readyForBiller && (
                          <span
                            className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold bg-[#E1F5EE] text-[#085041] whitespace-nowrap"
                            title={`Marked by ${c.ready_for_biller_by ?? 'Unknown'} on ${fmtDate(c.ready_for_biller_at)}`}
                          >
                            Ready for biller
                          </span>
                        )}
                        {isOpen ? <ChevronUp size={15} className="text-[#1A1A2E] flex-shrink-0" /> : <ChevronDown size={15} className="text-[#1A1A2E] flex-shrink-0" />}
                      </div>
                    </button>

                    {isOpen && (
                      <div className="px-4 pb-4 border-t border-[#F1EFE8] pt-4 space-y-4">
                        {stediError && (
                          <div className="bg-[#FEE2E2] border border-[#FECACA] rounded-lg px-3 py-2.5 text-[12px] text-[#7F1D1D]">
                            <span className="font-semibold">Stedi rejection: </span>{stediError}
                          </div>
                        )}
                        {/* Claim detail grid */}
                        {editPatient[c.id] ? (
                          <div className="space-y-3">
                            <div className="text-[11px] font-semibold text-[#1A1A2E] uppercase tracking-wider">Patient info</div>
                            <div className="grid grid-cols-2 gap-3">
                              <div>
                                <label className="text-[11px] text-[#555] block mb-1">First name</label>
                                <input className="w-full px-2.5 py-1.5 border border-[#E8E8E4] rounded-lg text-[13px] outline-none focus:border-[#7F77DD]"
                                  value={editPatient[c.id].patient_first_name}
                                  onChange={e => setEditPatient(p => ({ ...p, [c.id]: { ...p[c.id], patient_first_name: e.target.value } }))} />
                              </div>
                              <div>
                                <label className="text-[11px] text-[#555] block mb-1">Last name</label>
                                <input className="w-full px-2.5 py-1.5 border border-[#E8E8E4] rounded-lg text-[13px] outline-none focus:border-[#7F77DD]"
                                  value={editPatient[c.id].patient_last_name}
                                  onChange={e => setEditPatient(p => ({ ...p, [c.id]: { ...p[c.id], patient_last_name: e.target.value } }))} />
                              </div>
                              <div>
                                <label className="text-[11px] text-[#555] block mb-1">Date of birth</label>
                                <input type="date" className="w-full px-2.5 py-1.5 border border-[#E8E8E4] rounded-lg text-[13px] outline-none focus:border-[#7F77DD]"
                                  value={editPatient[c.id].patient_dob}
                                  onChange={e => setEditPatient(p => ({ ...p, [c.id]: { ...p[c.id], patient_dob: e.target.value } }))} />
                              </div>
                              <div>
                                <label className="text-[11px] text-[#555] block mb-1">Sex</label>
                                <select className="w-full px-2.5 py-1.5 border border-[#E8E8E4] rounded-lg text-[13px] bg-white outline-none focus:border-[#7F77DD]"
                                  value={editPatient[c.id].patient_gender}
                                  onChange={e => setEditPatient(p => ({ ...p, [c.id]: { ...p[c.id], patient_gender: e.target.value } }))}>
                                  <option value="">—</option>
                                  <option value="M">Male</option>
                                  <option value="F">Female</option>
                                </select>
                              </div>
                            </div>
                            <div className="col-span-2">
                                <label className="text-[11px] text-[#555] block mb-1">Street address</label>
                                <input className="w-full px-2.5 py-1.5 border border-[#E8E8E4] rounded-lg text-[13px] outline-none focus:border-[#7F77DD]"
                                  value={editPatient[c.id].patient_address}
                                  onChange={e => setEditPatient(p => ({ ...p, [c.id]: { ...p[c.id], patient_address: e.target.value } }))} />
                              </div>
                              <div>
                                <label className="text-[11px] text-[#555] block mb-1">City</label>
                                <input className="w-full px-2.5 py-1.5 border border-[#E8E8E4] rounded-lg text-[13px] outline-none focus:border-[#7F77DD]"
                                  value={editPatient[c.id].patient_city}
                                  onChange={e => setEditPatient(p => ({ ...p, [c.id]: { ...p[c.id], patient_city: e.target.value } }))} />
                              </div>
                              <div className="grid grid-cols-2 gap-2">
                                <div>
                                  <label className="text-[11px] text-[#555] block mb-1">State</label>
                                  <input className="w-full px-2.5 py-1.5 border border-[#E8E8E4] rounded-lg text-[13px] outline-none focus:border-[#7F77DD]"
                                    value={editPatient[c.id].patient_state}
                                    onChange={e => setEditPatient(p => ({ ...p, [c.id]: { ...p[c.id], patient_state: e.target.value } }))} />
                                </div>
                                <div>
                                  <label className="text-[11px] text-[#555] block mb-1">ZIP</label>
                                  <input className="w-full px-2.5 py-1.5 border border-[#E8E8E4] rounded-lg text-[13px] outline-none focus:border-[#7F77DD]"
                                    value={editPatient[c.id].patient_zip}
                                    onChange={e => setEditPatient(p => ({ ...p, [c.id]: { ...p[c.id], patient_zip: e.target.value } }))} />
                                </div>
                              </div>
                            <div className="text-[11px] font-semibold text-[#1A1A2E] uppercase tracking-wider pt-1">Insurance</div>
                            <div className="grid grid-cols-2 gap-3">
                              <div>
                                <label className="text-[11px] text-[#555] block mb-1">Member ID</label>
                                <input className="w-full px-2.5 py-1.5 border border-[#E8E8E4] rounded-lg text-[13px] outline-none focus:border-[#7F77DD]"
                                  value={editPatient[c.id].member_id}
                                  onChange={e => setEditPatient(p => ({ ...p, [c.id]: { ...p[c.id], member_id: e.target.value } }))} />
                              </div>
                              <div>
                                <label className="text-[11px] text-[#555] block mb-1">Group #</label>
                                <input className="w-full px-2.5 py-1.5 border border-[#E8E8E4] rounded-lg text-[13px] outline-none focus:border-[#7F77DD]"
                                  value={editPatient[c.id].group_number}
                                  onChange={e => setEditPatient(p => ({ ...p, [c.id]: { ...p[c.id], group_number: e.target.value } }))} />
                              </div>
                              {c.payer_id === 'UPICO' && (
                                <div>
                                  <label className="text-[11px] text-[#555] block mb-1">Dependent code (BCBS NC) — 2 digits</label>
                                  <input className="w-full px-2.5 py-1.5 border border-[#E8E8E4] rounded-lg text-[13px] outline-none focus:border-[#7F77DD]"
                                    maxLength={2} placeholder="e.g. 03"
                                    value={editPatient[c.id].insurance_dependent_code}
                                    onChange={e => setEditPatient(p => ({ ...p, [c.id]: { ...p[c.id], insurance_dependent_code: e.target.value.replace(/\D/g, '').slice(0, 2) } }))} />
                                  <p className="text-[10px] text-[#1A1A2E] mt-1">BCBS NC requires a 2-digit suffix identifying which dependent. Common: 01=subscriber, 02=spouse, 03+=kids by DOB.</p>
                                </div>
                              )}
                              <div>
                                <label className="text-[11px] text-[#555] block mb-1">Subscriber full name (first AND last)</label>
                                <input className="w-full px-2.5 py-1.5 border border-[#E8E8E4] rounded-lg text-[13px] outline-none focus:border-[#7F77DD]"
                                  placeholder="e.g., Sarah Rodgers"
                                  value={editPatient[c.id].subscriber_name}
                                  onChange={e => setEditPatient(p => ({ ...p, [c.id]: { ...p[c.id], subscriber_name: e.target.value } }))} />
                              </div>
                              <div>
                                <label className="text-[11px] text-[#555] block mb-1">Subscriber DOB</label>
                                <input type="date" className="w-full px-2.5 py-1.5 border border-[#E8E8E4] rounded-lg text-[13px] outline-none focus:border-[#7F77DD]"
                                  value={editPatient[c.id].subscriber_dob}
                                  onChange={e => setEditPatient(p => ({ ...p, [c.id]: { ...p[c.id], subscriber_dob: e.target.value } }))} />
                              </div>
                              <div>
                                <label className="text-[11px] text-[#555] block mb-1">Subscriber sex</label>
                                <select className="w-full px-2.5 py-1.5 border border-[#E8E8E4] rounded-lg text-[13px] bg-white outline-none focus:border-[#7F77DD]"
                                  value={editPatient[c.id].subscriber_gender}
                                  onChange={e => setEditPatient(p => ({ ...p, [c.id]: { ...p[c.id], subscriber_gender: e.target.value } }))}>
                                  <option value="">—</option>
                                  <option value="M">Male</option>
                                  <option value="F">Female</option>
                                </select>
                              </div>
                            </div>
                            {saveError && saving === null && <div className="text-[12px] text-[#DC2626]">{saveError}</div>}
                            <div className="flex gap-2 pt-1">
                              <Button size="sm" variant="teal" loading={saving === c.id + '_patient'} onClick={() => handlePatientSave(c.id)}>Save</Button>
                              <Button size="sm" variant="secondary" onClick={() => { setEditPatient(prev => { const n = { ...prev }; delete n[c.id]; return n }); setSaveError(null) }}>Cancel</Button>
                            </div>
                          </div>
                        ) : (
                          <div>
                            <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-[13px]">
                              <div><span className="text-[#1A1A2E]">Patient: </span><span className="text-[#1A1A2E] font-medium">{[c.patient_first_name, c.patient_last_name].filter(Boolean).join(' ') || '—'}</span></div>
                              <div><span className="text-[#1A1A2E]">DOB: </span><span className="text-[#1A1A2E]">{fmtDate(c.patient_dob)}</span></div>
                              <div><span className="text-[#1A1A2E]">Subscriber: </span><span className="text-[#1A1A2E] font-medium">{c.subscriber_name || '—'}</span></div>
                              <div><span className="text-[#1A1A2E]">Subscriber DOB: </span><span className="text-[#1A1A2E]">{fmtDate(c.subscriber_dob)}</span></div>
                              <div><span className="text-[#1A1A2E]">Member ID: </span><span className="text-[#1A1A2E]">{c.member_id || '—'}</span></div>
                              <div><span className="text-[#1A1A2E]">Group #: </span><span className="text-[#1A1A2E]">{c.group_number || '—'}</span></div>
                              <div><span className="text-[#1A1A2E]">Service date: </span><span className="text-[#1A1A2E]">{fmtDate(c.service_date)}</span></div>
                              <div><span className="text-[#1A1A2E]">Rendering provider: </span><span className="text-[#1A1A2E]">{c.rendering_provider_name || '—'} ({c.rendering_provider_npi || 'no NPI'})</span></div>
                              {(c.effective_child_id ?? c.child_id) && (
                                <div><span className="text-[#1A1A2E]">Encounter note: </span>
                                  <Link to={`/admin/chart/${c.effective_child_id ?? c.child_id}`} className="text-[#7F77DD] hover:underline inline-flex items-center gap-1 text-[13px]">
                                    <FileText size={12} /> View in patient chart
                                  </Link>
                                </div>
                              )}
                            </div>
                            <button
                              onClick={() => setEditPatient(prev => ({ ...prev, [c.id]: {
                                patient_first_name: c.patient_first_name ?? '',
                                patient_last_name: c.patient_last_name ?? '',
                                patient_dob: c.patient_dob ? String(c.patient_dob).split('T')[0] : '',
                                patient_gender: c.patient_gender ?? '',
                                patient_address: c.patient_address ?? '',
                                patient_city: c.patient_city ?? '',
                                patient_state: c.patient_state ?? '',
                                patient_zip: c.patient_zip ?? '',
                                member_id: c.member_id ?? '',
                                group_number: c.group_number ?? '',
                                insurance_dependent_code: c.insurance_dependent_code ?? '',
                                subscriber_name: c.subscriber_name ?? '',
                                subscriber_dob: c.subscriber_dob ? String(c.subscriber_dob).split('T')[0] : '',
                                subscriber_gender: c.subscriber_gender ?? '',
                                child_id: c.child_id ?? c.effective_child_id ?? null,
                              }}))}
                              className="mt-2 text-[11px] text-[#7F77DD] hover:underline">
                              Edit patient &amp; insurance info
                            </button>
                          </div>
                        )}

                        {/* Payer */}
                        <div>
                          <div className="text-[11px] font-semibold text-[#1A1A2E] uppercase tracking-wider mb-2">Payer</div>
                          {ep ? (
                            <div className="flex gap-2 items-end flex-wrap">
                              <div>
                                <label className="text-[11px] text-[#555] block mb-1">Insurance company</label>
                                <select value={ep.name}
                                  onChange={e => {
                                    const name = e.target.value
                                    const id = KNOWN_PAYERS[name] ?? ''
                                    setEditPayer(prev => ({ ...prev, [c.id]: { name, id } }))
                                  }}
                                  className="px-2.5 py-1.5 border border-[#E8E8E4] rounded-lg text-[13px] bg-white outline-none focus:border-[#7F77DD]">
                                  <option value="">— select —</option>
                                  {Object.keys(KNOWN_PAYERS).map(k => <option key={k} value={k}>{k}</option>)}
                                  <option value="Other">Other</option>
                                </select>
                              </div>
                              <div>
                                <label className="text-[11px] text-[#555] block mb-1">EDI Payer ID</label>
                                <input type="text" value={ep.id}
                                  onChange={e => setEditPayer(prev => ({ ...prev, [c.id]: { ...prev[c.id], id: e.target.value } }))}
                                  className="px-2.5 py-1.5 border border-[#E8E8E4] rounded-lg text-[13px] outline-none focus:border-[#7F77DD] w-28" />
                              </div>
                              <Button size="sm" variant="teal" loading={saving === c.id} onClick={() => handlePayerSave(c.id)}>Save</Button>
                              <Button size="sm" variant="secondary" onClick={() => { setEditPayer(prev => { const n = { ...prev }; delete n[c.id]; return n }); setSaveError(null) }}>Cancel</Button>
                            </div>
                          ) : (
                            <div className="flex items-center gap-3">
                              <span className={`text-[13px] ${missingPayer ? 'text-[#DC2626] font-medium' : 'text-[#1A1A2E]'}`}>
                                {c.payer_name || '—'}{c.payer_id ? ` (ID: ${c.payer_id})` : ' — ID unknown'}
                              </span>
                              <button onClick={() => setEditPayer(prev => ({ ...prev, [c.id]: { name: c.payer_name ?? '', id: c.payer_id ?? '' } }))}
                                className="text-[11px] text-[#7F77DD] hover:underline">Edit</button>
                            </div>
                          )}
                        </div>

                        {/* Diagnoses + CPT */}
                        <div className="grid grid-cols-2 gap-4">
                          <div>
                            <div className="flex items-center justify-between mb-1.5">
                              <div className="text-[11px] font-semibold text-[#1A1A2E] uppercase tracking-wider">Diagnoses</div>
                              {!editDx[c.id] && (
                                <button onClick={() => setEditDx(prev => ({ ...prev, [c.id]: JSON.parse(JSON.stringify(c.diagnoses ?? [])) }))}
                                  className="flex items-center gap-1 text-[11px] text-[#7F77DD] hover:underline">
                                  <Pencil size={10} /> Edit
                                </button>
                              )}
                              {editDx[c.id] && (
                                <div className="flex items-center gap-2">
                                  <button onClick={() => saveDx(c.id)} disabled={saving === c.id}
                                    className="text-[11px] text-white bg-[#7F77DD] px-2 py-0.5 rounded hover:bg-[#6B64C8] disabled:opacity-50">
                                    {saving === c.id ? 'Saving…' : 'Save'}
                                  </button>
                                  <button onClick={() => { setEditDx(prev => { const n={...prev}; delete n[c.id]; return n }); setDxQuery(prev => { const n={...prev}; delete n[c.id]; return n }); setDxResults(prev => { const n={...prev}; delete n[c.id]; return n }) }}
                                    className="text-[11px] text-[#1A1A2E] hover:text-[#555]">Cancel</button>
                                </div>
                              )}
                            </div>
                            {editDx[c.id] ? (
                              <div>
                                <div className="space-y-1.5 mb-2">
                                  {editDx[c.id].map((d: any, i: number) => (
                                    <div key={d.code} className="flex items-center gap-1.5 px-2 py-1.5 bg-white border border-[#E8E8E4] rounded-lg">
                                      <div className="flex flex-col gap-0.5 flex-shrink-0">
                                        <button disabled={i === 0} onClick={() => setEditDx(prev => ({ ...prev, [c.id]: moveItem(prev[c.id], i, i - 1) }))}
                                          className="w-5 h-5 flex items-center justify-center rounded bg-[#F1EFE8] hover:bg-[#EEEDFE] text-[#555] disabled:opacity-25 disabled:cursor-not-allowed">
                                          <ChevronUp size={13} />
                                        </button>
                                        <button disabled={i === editDx[c.id].length - 1} onClick={() => setEditDx(prev => ({ ...prev, [c.id]: moveItem(prev[c.id], i, i + 1) }))}
                                          className="w-5 h-5 flex items-center justify-center rounded bg-[#F1EFE8] hover:bg-[#EEEDFE] text-[#555] disabled:opacity-25 disabled:cursor-not-allowed">
                                          <ChevronDown size={13} />
                                        </button>
                                      </div>
                                      <span className="text-[11px] font-semibold text-[#7F77DD] flex-shrink-0">{d.code}</span>
                                      <span className="text-[11px] text-[#1A1A2E] flex-1 truncate">{d.name}</span>
                                      <button onClick={() => setEditDx(prev => ({ ...prev, [c.id]: prev[c.id].filter((x: any) => x.code !== d.code) }))}
                                        className="text-[#DC2626] hover:opacity-70 flex-shrink-0"><X size={11} /></button>
                                    </div>
                                  ))}
                                </div>
                                <div className="relative">
                                  <Search size={11} className="absolute left-2 top-1/2 -translate-y-1/2 text-[#1A1A2E]" />
                                  <input type="text" placeholder="Search ICD-10…" value={dxQuery[c.id] ?? ''}
                                    onChange={e => onDxQueryChange(c.id, e.target.value)}
                                    className="w-full pl-6 pr-2 py-1.5 border border-[#E8E8E4] rounded-lg text-[12px] outline-none focus:border-[#7F77DD]" />
                                  {(dxSearching[c.id] || (dxResults[c.id] ?? []).length > 0) && (
                                    <div className="absolute z-20 w-full mt-1 border border-[#E8E8E4] rounded-xl bg-white shadow-lg overflow-hidden">
                                      {dxSearching[c.id] && <div className="px-3 py-2 text-[11px] text-[#1A1A2E]">Searching…</div>}
                                      {!dxSearching[c.id] && (dxResults[c.id] ?? []).map((dx: any) => (
                                        <button key={dx.code} onClick={() => {
                                          if (!editDx[c.id].find((x: any) => x.code === dx.code))
                                            setEditDx(prev => ({ ...prev, [c.id]: [...prev[c.id], dx] }))
                                          setDxQuery(prev => ({ ...prev, [c.id]: '' }))
                                          setDxResults(prev => ({ ...prev, [c.id]: [] }))
                                        }} className="w-full text-left px-3 py-1.5 hover:bg-[#FAFAF8] border-b border-[#F1EFE8] last:border-0">
                                          <span className="text-[11px] font-semibold text-[#7F77DD]">{dx.code}</span>
                                          <span className="text-[11px] text-[#1A1A2E] ml-1.5">{dx.name}</span>
                                        </button>
                                      ))}
                                    </div>
                                  )}
                                </div>
                              </div>
                            ) : (
                              <div className="space-y-1">
                                {(c.diagnoses ?? []).map((d: any, i: number) => (
                                  <div key={d.code} className="text-[12px] text-[#1A1A2E]">
                                    <span className="inline-block w-4 text-right text-[10px] font-semibold text-[#1A1A2E] mr-1">{i + 1}</span>
                                    <span className="font-semibold text-[#7F77DD]">{d.code}</span> {d.name}
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                          <div>
                            <div className="flex items-center justify-between mb-1.5">
                              <div className="text-[11px] font-semibold text-[#1A1A2E] uppercase tracking-wider">Procedures &amp; Fees</div>
                              {!editCpt[c.id] && (
                                <button onClick={() => setEditCpt(prev => ({ ...prev, [c.id]: JSON.parse(JSON.stringify(c.cpt_codes ?? [])) }))}
                                  className="flex items-center gap-1 text-[11px] text-[#7F77DD] hover:underline">
                                  <Pencil size={10} /> Edit
                                </button>
                              )}
                            </div>
                            {editCpt[c.id] ? (
                              <div className="space-y-1.5">
                                {editCpt[c.id].map((cp: any, i: number) => (
                                  <div key={i} className="flex items-center gap-1.5 px-2 py-1.5 bg-white border border-[#E8E8E4] rounded-lg">
                                    <div className="flex flex-col gap-0.5 flex-shrink-0">
                                      <button disabled={i === 0} onClick={() => setEditCpt(prev => ({ ...prev, [c.id]: moveItem(prev[c.id], i, i - 1) }))}
                                        className="w-5 h-5 flex items-center justify-center rounded bg-[#F1EFE8] hover:bg-[#EEEDFE] text-[#555] disabled:opacity-25 disabled:cursor-not-allowed">
                                        <ChevronUp size={13} />
                                      </button>
                                      <button disabled={i === editCpt[c.id].length - 1} onClick={() => setEditCpt(prev => ({ ...prev, [c.id]: moveItem(prev[c.id], i, i + 1) }))}
                                        className="w-5 h-5 flex items-center justify-center rounded bg-[#F1EFE8] hover:bg-[#EEEDFE] text-[#555] disabled:opacity-25 disabled:cursor-not-allowed">
                                        <ChevronDown size={13} />
                                      </button>
                                    </div>
                                    <span className="text-[11px] font-semibold text-[#7F77DD] w-14 flex-shrink-0">{cp.code}</span>
                                    <span className="text-[11px] text-[#1A1A2E] flex-1 truncate">{cp.description}</span>
                                    <label className="text-[10px] text-[#1A1A2E] whitespace-nowrap">Mod:</label>
                                    <input
                                      value={cp.modifier ?? ''}
                                      maxLength={3}
                                      placeholder="25"
                                      onChange={e => setEditCpt(prev => {
                                        const next = [...prev[c.id]]
                                        next[i] = { ...next[i], modifier: e.target.value.toUpperCase() }
                                        return { ...prev, [c.id]: next }
                                      })}
                                      className="w-10 border border-[#E8E8E4] rounded px-1.5 py-0.5 text-[11px] font-mono uppercase outline-none focus:border-[#7F77DD]" />
                                    <span className="text-[11px] text-[#1A1A2E]">$</span>
                                    <input type="number" step="0.01" min="0"
                                      value={cp.charge_amount ?? ''}
                                      onChange={e => setEditCpt(prev => {
                                        const next = [...prev[c.id]]
                                        next[i] = { ...next[i], charge_amount: e.target.value }
                                        return { ...prev, [c.id]: next }
                                      })}
                                      className="w-20 px-1.5 py-0.5 border border-[#E8E8E4] rounded text-[12px] outline-none focus:border-[#7F77DD] [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none" />
                                    <button onClick={() => setEditCpt(prev => ({ ...prev, [c.id]: prev[c.id].filter((_: any, j: number) => j !== i) }))}
                                      className="text-[#DC2626] hover:opacity-70 flex-shrink-0">
                                      <Trash2 size={12} />
                                    </button>
                                  </div>
                                ))}

                                {/* Fee schedule picker */}
                                <div className="pt-0.5">
                                  <button
                                    onClick={() => setCptOpen(prev => ({ ...prev, [c.id]: !prev[c.id] }))}
                                    className="flex items-center gap-1.5 text-[12px] text-[#7F77DD] font-medium hover:text-[#534AB7] transition-colors mb-1.5">
                                    <Plus size={13} /> Add procedure or fee
                                  </button>
                                  {cptOpen[c.id] && (
                                    <div className="border border-[#E8E8E4] rounded-xl overflow-hidden bg-white">
                                      <div className="p-2 border-b border-[#F1EFE8]">
                                        <input type="text" placeholder="Search by code or description…"
                                          value={cptSearch[c.id] ?? ''}
                                          onChange={e => setCptSearch(prev => ({ ...prev, [c.id]: e.target.value }))}
                                          className="w-full px-3 py-1.5 border border-[#E8E8E4] rounded-lg text-[12px] outline-none focus:border-[#7F77DD]"
                                          autoFocus />
                                      </div>
                                      <div className="flex border-b border-[#F1EFE8]">
                                        {(['Procedure', 'Non-Covered Services'] as const).map(t => (
                                          <button key={t}
                                            onClick={() => setCptTab(prev => ({ ...prev, [c.id]: t }))}
                                            className={`flex-1 py-1.5 text-[11px] font-medium transition-colors ${(cptTab[c.id] ?? 'Procedure') === t ? 'text-[#7F77DD] border-b-2 border-[#7F77DD]' : 'text-[#1A1A2E]'}`}>
                                            {t === 'Procedure' ? 'Insurance Procedures' : 'Convenience & Self-Pay'}
                                          </button>
                                        ))}
                                      </div>
                                      <div className="max-h-44 overflow-y-auto">
                                        {feeSchedule
                                          .filter(fs => fs.category === (cptTab[c.id] ?? 'Procedure'))
                                          .filter(fs => {
                                            const q = (cptSearch[c.id] ?? '').toLowerCase()
                                            return !q || fs.code.toLowerCase().includes(q) || fs.description.toLowerCase().includes(q)
                                          })
                                          .filter(fs => !editCpt[c.id].find((x: any) => x.code === fs.code))
                                          .map(fs => (
                                            <button key={fs.code}
                                              onClick={() => {
                                                setEditCpt(prev => ({ ...prev, [c.id]: [...prev[c.id], { code: fs.code, description: fs.description, charge_amount: fs.charge_amount, ndc_code: (fs as any).ndc_code ?? null, ndc_unit_count: (fs as any).ndc_unit_count ?? null }] }))
                                                setCptSearch(prev => ({ ...prev, [c.id]: '' }))
                                                setCptOpen(prev => ({ ...prev, [c.id]: false }))
                                              }}
                                              className="w-full text-left px-3 py-2 hover:bg-[#FAFAF8] border-b border-[#F8F8F6] last:border-0 flex items-center justify-between gap-2 transition-colors">
                                              <div className="flex items-center gap-2 min-w-0">
                                                <span className="text-[11px] font-semibold text-[#7F77DD] flex-shrink-0">{fs.code}</span>
                                                <span className="text-[11px] text-[#1A1A2E] truncate">{fs.description}</span>
                                              </div>
                                              <span className="text-[11px] font-medium text-[#555] flex-shrink-0">${parseFloat(fs.charge_amount).toFixed(2)}</span>
                                            </button>
                                          ))
                                        }
                                        {feeSchedule
                                          .filter(fs => fs.category === (cptTab[c.id] ?? 'Procedure'))
                                          .filter(fs => { const q = (cptSearch[c.id] ?? '').toLowerCase(); return !q || fs.code.toLowerCase().includes(q) || fs.description.toLowerCase().includes(q) })
                                          .filter(fs => !editCpt[c.id].find((x: any) => x.code === fs.code))
                                          .length === 0 && (
                                          <div className="px-3 py-3 text-[11px] text-[#1A1A2E]">No codes match your search.</div>
                                        )}
                                      </div>
                                    </div>
                                  )}
                                </div>

                                {saveError && saving === null && <div className="text-[11px] text-[#DC2626]">{saveError}</div>}
                                <div className="flex gap-2 pt-1">
                                  <Button size="sm" variant="teal" loading={saving === c.id + '_cpt'} onClick={() => handleCptSave(c.id)}>Save</Button>
                                  <Button size="sm" variant="secondary" onClick={() => {
                                    setEditCpt(prev => { const n = { ...prev }; delete n[c.id]; return n })
                                    setCptOpen(prev => { const n = { ...prev }; delete n[c.id]; return n })
                                    setCptSearch(prev => { const n = { ...prev }; delete n[c.id]; return n })
                                    setSaveError(null)
                                  }}>Cancel</Button>
                                </div>
                              </div>
                            ) : (
                              <div className="space-y-1">
                                {(c.cpt_codes ?? []).map((cp: any, cpIdx: number) => {
                                  const units = parseInt(cp.units, 10) || 1
                                  const lineTotal = (parseFloat(cp.charge_amount ?? 0) || 0) * units
                                  const pointers: number[] = Array.isArray(cp.diagnosis_pointers) ? cp.diagnosis_pointers : []
                                  return (
                                  <div key={cp.code} className="flex justify-between items-start text-[12px] gap-2">
                                    <div className="flex-1 min-w-0">
                                      <span className="text-[#1A1A2E]">
                                        <span className="font-semibold text-[#555]">{cp.code}</span>
                                        {cp.modifier && <span className="ml-1 text-[10px] font-semibold text-[#F5943A]">-{cp.modifier}</span>}
                                        {' '}{cp.description}
                                        {units > 1 && <span className="ml-1 text-[10px] text-[#555]">× {units} units</span>}
                                      </span>
                                      <DxLineButton
                                        claim={c}
                                        cpIndex={cpIdx}
                                        pointers={pointers}
                                        onSave={async (nextPointers) => {
                                          const nextCpt = (c.cpt_codes ?? []).map((x: any, i: number) =>
                                            i === cpIdx ? { ...x, diagnosis_pointers: nextPointers } : x)
                                          try {
                                            await updateClaim(c.id, { cpt_codes: nextCpt })
                                            await load()
                                          } catch (e: any) {
                                            alert(e?.message || 'Failed to save Dx assignments')
                                          }
                                        }}
                                      />
                                      {cp.ndc_code && (
                                        <div className="text-[10px] text-[#555] mt-0.5">
                                          <span className="text-[#1A1A2E]">NDC:</span> <span className="font-mono">{cp.ndc_code}</span>
                                        </div>
                                      )}
                                    </div>
                                    <span className="text-[#1A1A2E] font-medium ml-2 flex-shrink-0">{fmtMoney(lineTotal)}</span>
                                  </div>
                                  )
                                })}
                                <div className="text-[12px] font-semibold text-[#1A1A2E] pt-1 border-t border-[#F1EFE8]">
                                  Total: {fmtMoney(c.total_charge)}
                                </div>
                                {c.clia_number && (
                                  <div className="mt-1.5 inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-[#E1F5EE] border border-[#A7F3D0] text-[11px] font-semibold text-[#085041]">
                                    CLIA: {c.clia_number}
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        </div>

                        {/* Test result */}
                        {testResults[c.id] && (
                          <div className={`rounded-lg px-3 py-2.5 text-[12px] border ${testResults[c.id].error ? 'bg-[#FEE2E2] border-[#FECACA] text-[#7F1D1D]' : testResults[c.id].status === 'A' ? 'bg-[#E1F5EE] border-[#A7F3D0] text-[#085041]' : 'bg-[#FEF3E8] border-[#FDE68A] text-[#633806]'}`}>
                            {testResults[c.id].error ? (
                              <>
                                <span><span className="font-semibold">Rejected: </span>{testResults[c.id].error}</span>
                                <button className="mt-1 ml-2 text-[11px] underline opacity-70" onClick={() => setTestResults(p => { const n={...p}; delete n[c.id]; return n })}>dismiss</button>
                              </>
                            ) : (
                              <>
                                <span className="font-semibold">
                                  277CA: {testResults[c.id].status === 'A' ? 'Accepted ✓' : testResults[c.id].status === 'R' ? 'Rejected' : testResults[c.id].status ? `Status: ${testResults[c.id].status}` : 'Response received'}
                                </span>
                                {testResults[c.id].errors?.length > 0 && (
                                  <ul className="mt-1 ml-3 list-disc space-y-0.5">
                                    {testResults[c.id].errors.map((e: any, i: number) => (
                                      <li key={i}>{e.statusCodeDescription ?? e.statusCode ?? JSON.stringify(e)}</li>
                                    ))}
                                  </ul>
                                )}
                                {!testResults[c.id].status && testResults[c.id].raw && (
                                  <pre className="mt-1 text-[10px] whitespace-pre-wrap break-all opacity-80">{JSON.stringify(testResults[c.id].raw, null, 2)}</pre>
                                )}
                                <button className="mt-1 text-[11px] underline opacity-70" onClick={() => setTestResults(p => { const n={...p}; delete n[c.id]; return n })}>dismiss</button>
                              </>
                            )}
                          </div>
                        )}

                        {/* Submit / Regenerate buttons */}
                        <div className="flex justify-between items-center pt-1">
                          <div className="flex gap-2">
                            {(!c.cpt_codes?.length || parseFloat(c.total_charge ?? 0) === 0) && c.encounter_note_id && (
                              <Button variant="secondary" size="sm"
                                loading={regenerating === c.id}
                                onClick={() => handleRegenerate(c.id, c.encounter_note_id)}>
                                <RefreshCw size={12} className="mr-1.5" /> Regenerate from note
                              </Button>
                            )}
                            <Button variant="secondary" size="sm"
                              loading={testing === c.id}
                              disabled={!!testing || missingPayer}
                              onClick={() => handleTest(c.id)}>
                              Test claim
                            </Button>
                            <Button variant="secondary" size="sm"
                              loading={deleting === c.id}
                              disabled={!!deleting}
                              onClick={() => handleDelete(c.id)}>
                              <Trash2 size={12} className="mr-1.5 text-[#DC2626]" /> Delete
                            </Button>
                          </div>
                          <div className="flex items-center gap-2">
                            <Button
                              variant={readyForBiller ? 'secondary' : 'teal'}
                              size="sm"
                              loading={markingReady === c.id}
                              disabled={!!markingReady}
                              onClick={() => handleToggleReady(c.id, readyForBiller)}
                            >
                              {readyForBiller ? 'Unmark ready for biller' : 'Mark ready for biller'}
                            </Button>
                            {readyForBiller && (
                              <span className="text-[11px] text-[#666]">
                                Marked by {c.ready_for_biller_by ?? 'Unknown'} · {fmtDate(c.ready_for_biller_at)}
                              </span>
                            )}
                          </div>
                          {renderNotifySection(c)}
                          <div className="flex flex-wrap gap-2">
                            {showStatementButton && (
                              <Button variant="teal" onClick={() => setStatementClaim(c)}>
                                <Receipt size={13} className="mr-1.5" /> Generate patient statement
                              </Button>
                            )}
                            {!isSelfPay && (
                              <Button variant={showStatementButton ? 'secondary' : 'teal'}
                                loading={submitting === c.id}
                                disabled={!!submitting || missingPayer}
                                onClick={() => handleSubmit(c.id)}>
                                <Send size={13} className="mr-1.5" /> Submit to insurance
                              </Button>
                            )}
                            {/* Write-off on the review tab — for stuck
                                errors + billing mistakes that shouldn't
                                sit here forever. */}
                            <Button variant="secondary"
                              onClick={() => { setWriteOffTarget(c); setWriteOffReasonState('billing_error'); setWriteOffNote(''); setWriteOffError(null) }}>
                              <Ban size={13} className="mr-1.5 text-[#991B1B]" /> Write off
                            </Button>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}

          {/* SUBMITTED TAB */}
          {tab === 'submitted' && (
            <div className="space-y-2">
              {submittedClaims.length === 0 && (
                <div className="text-center py-12 text-[#1A1A2E] text-[13px]">No submitted claims yet.</div>
              )}
              {submittedClaims.map(c => {
                const badge = STATUS_BADGE[c.status] ?? STATUS_BADGE.submitted
                const Icon = badge.icon
                const isOpen = expanded === c.id
                const patientBalance = [c.patient_deductible_era, c.patient_coinsurance_era, c.patient_copay_era, c.patient_non_covered_era]
                  .reduce((s, v) => s + (parseFloat(v ?? 0) || 0), 0)
                return (
                  <div key={c.id} className="bg-white border border-[#E8E8E4] rounded-xl overflow-hidden">
                    <button className="w-full p-4 flex items-center justify-between gap-4 text-left"
                      onClick={() => setExpanded(isOpen ? null : c.id)}>
                      <div className="flex items-center gap-3 min-w-0">
                        <FileText size={15} className="text-[#7F77DD] flex-shrink-0" />
                        <div>
                          <div className="text-[14px] font-medium text-[#1A1A2E]">
                            {[(c.child_first_name ?? c.patient_first_name), (c.child_last_name ?? c.patient_last_name)].filter(Boolean).join(' ') || 'Unknown patient'}
                            <span className="ml-2 text-[12px] font-normal text-[#1A1A2E]">{fmtDate(c.service_date)}</span>
                            {c.era_received_at && !c.era_seen_at && (
                              <span className="ml-2 inline-flex items-center gap-0.5 bg-[#5DCAA5] text-white px-1.5 py-0.5 rounded-full text-[10px] font-semibold animate-pulse">
                                <Zap size={9} /> NEW ERA
                              </span>
                            )}
                            {c.era_received_at && c.era_seen_at && (
                              <span className="ml-2 inline-flex items-center gap-0.5 bg-[#E1F5EE] text-[#085041] px-1.5 py-0.5 rounded-full text-[10px] font-semibold">
                                <Zap size={9} /> ERA received
                              </span>
                            )}
                          </div>
                          <div className="text-[12px] text-[#1A1A2E] mt-0.5">
                            {c.payer_name} · {fmtMoney(c.total_charge)}
                            {c.stedi_claim_id && ` · Ref: ${c.stedi_claim_id}`}
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center gap-2 flex-shrink-0">
                        <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold ${badge.cls}`}>
                          <Icon size={11} /> {badge.label}
                        </span>
                        {isOpen ? <ChevronUp size={14} className="text-[#1A1A2E]" /> : <ChevronDown size={14} className="text-[#1A1A2E]" />}
                      </div>
                    </button>

                    {isOpen && (
                      <div className="border-t border-[#F1EFE8] px-4 pb-4 pt-3 space-y-4">
                        {/* ERA payment breakdown */}
                        {c.era_received_at && (
                          <div className="bg-[#E1F5EE] border border-[#A9DFBF] rounded-xl p-4">
                            <div className="text-[11px] font-semibold text-[#085041] uppercase tracking-wider mb-3 flex items-center gap-1.5">
                              <Zap size={11} /> ERA Payment Received · {fmtDate(c.era_received_at)}
                            </div>
                            <div className="grid grid-cols-2 gap-x-6 gap-y-2">
                              {c.amount_billed_era != null && (
                                <div className="flex justify-between text-[12px]">
                                  <span className="text-[#444]">Billed amount</span>
                                  <span className="font-medium">{fmtMoney(c.amount_billed_era)}</span>
                                </div>
                              )}
                              {c.insurance_payment_era != null && (
                                <div className="flex justify-between text-[12px]">
                                  <span className="text-[#444]">Insurance paid</span>
                                  <span className="font-semibold text-[#085041]">{fmtMoney(c.insurance_payment_era)}</span>
                                </div>
                              )}
                              {c.contractual_adjustment_era != null && (
                                <div className="flex justify-between text-[12px]">
                                  <span className="text-[#444]">Contractual adjustment</span>
                                  <span className="font-medium text-[#1A1A2E]">({fmtMoney(c.contractual_adjustment_era)})</span>
                                </div>
                              )}
                              {c.patient_deductible_era != null && (
                                <div className="flex justify-between text-[12px]">
                                  <span className="text-[#444]">Patient deductible</span>
                                  <span className="font-medium">{fmtMoney(c.patient_deductible_era)}</span>
                                </div>
                              )}
                              {c.patient_coinsurance_era != null && (
                                <div className="flex justify-between text-[12px]">
                                  <span className="text-[#444]">Patient coinsurance</span>
                                  <span className="font-medium">{fmtMoney(c.patient_coinsurance_era)}</span>
                                </div>
                              )}
                              {c.patient_copay_era != null && (
                                <div className="flex justify-between text-[12px]">
                                  <span className="text-[#444]">Patient copay</span>
                                  <span className="font-medium">{fmtMoney(c.patient_copay_era)}</span>
                                </div>
                              )}
                              {c.patient_non_covered_era != null && (
                                <div className="flex justify-between text-[12px]">
                                  <span className="text-[#444]">Non-covered</span>
                                  <span className="font-medium">{fmtMoney(c.patient_non_covered_era)}</span>
                                </div>
                              )}
                            </div>
                            {patientBalance > 0 && (
                              <div className="mt-3 pt-3 border-t border-[#A9DFBF] flex justify-between text-[13px] font-semibold">
                                <span className="text-[#085041]">Patient balance due</span>
                                <span className="text-[#085041]">{fmtMoney(patientBalance)}</span>
                              </div>
                            )}
                          </div>
                        )}

                        {/* Actions */}
                        <div className="flex items-center gap-3">
                          <Button size="sm" variant="secondary"
                            loading={reopening === c.id}
                            onClick={() => handleReopen(c.id)}>
                            Reopen
                          </Button>
                          <a href="https://portal.stedi.com/app/healthcare/claims" target="_blank" rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 text-[11px] text-[#7F77DD] hover:underline">
                            View in Stedi <ExternalLink size={10} />
                          </a>
                          <button onClick={() => setStatementClaim(c)}
                            className="inline-flex items-center gap-1 text-[11px] text-[#7F77DD] hover:underline font-medium">
                            <Receipt size={11} /> Generate statement
                          </button>
                          {(c.statement_status === 'sent' || c.statement_status === 'paid') && (
                            <span className="inline-flex items-center gap-0.5 bg-[#EEF6FB] text-[#2D7BA6] px-1.5 py-0.5 rounded-full text-[10px] font-semibold">
                              <Send size={9} /> Statement sent {c.statement_sent_at ? fmtDate(c.statement_sent_at) : ''}
                            </span>
                          )}
                          {/* Write off — for stuck submitted claims that
                              will never be paid. Removes them from the
                              AR-insurance aging report with a categorized
                              reason so financial reports track the cause. */}
                          <button onClick={() => { setWriteOffTarget(c); setWriteOffReasonState('bad_debt'); setWriteOffNote(''); setWriteOffError(null) }}
                            className="inline-flex items-center gap-1 text-[11px] text-[#991B1B] hover:underline font-medium">
                            <Ban size={11} /> Write off
                          </button>
                        </div>
                        {renderNotifySection(c)}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </>
      )}

      {statementClaim && (
        <PatientStatementModal
          claim={statementClaim}
          onClose={() => setStatementClaim(null)}
          onSent={() => setStatementClaim(null)}
        />
      )}

      {/* Write-off modal — reason + optional note, then flips the claim to
          status='written_off' and drops it out of AR-insurance aging. */}
      {writeOffTarget && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onClick={() => setWriteOffTarget(null)}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-6" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <Ban size={18} className="text-[#991B1B]" />
                <h2 className="font-display text-[16px] font-medium text-[#1A1A2E]">Write off this claim</h2>
              </div>
              <button onClick={() => setWriteOffTarget(null)} className="text-[#1A1A2E]/60 hover:text-[#1A1A2E]"><X size={16} /></button>
            </div>
            <div className="text-[12px] text-[#1A1A2E] mb-3 bg-[#FAFAF8] border border-[#E8E8E4] rounded-lg p-2.5">
              <div className="font-medium">
                {[(writeOffTarget.child_first_name ?? writeOffTarget.patient_first_name), (writeOffTarget.child_last_name ?? writeOffTarget.patient_last_name)].filter(Boolean).join(' ')}
              </div>
              <div className="text-[#555] mt-0.5">
                {writeOffTarget.payer_name} · {fmtDate(writeOffTarget.service_date)} · Charged {fmtMoney(writeOffTarget.total_charge)}
              </div>
            </div>
            <p className="text-[12px] text-[#7A1414] mb-3">
              Removes this claim from AR-insurance aging and tags the reason so financial reports
              can show revenue leakage by cause.
            </p>
            <div className="space-y-3">
              <div>
                <label className="text-[11px] text-[#555] block mb-1">Reason</label>
                <select
                  className="w-full px-2.5 py-1.5 border border-[#E8E8E4] rounded-lg text-[13px] outline-none focus:border-[#7F77DD] bg-white"
                  value={writeOffReason}
                  onChange={e => setWriteOffReasonState(e.target.value as WriteOffReason)}>
                  {(Object.entries(CLAIM_WRITE_OFF_LABELS) as [WriteOffReason, string][]).map(([k, v]) => (
                    <option key={k} value={k}>{v}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-[11px] text-[#555] block mb-1">Note (optional — audit trail)</label>
                <input
                  type="text"
                  className="w-full px-2.5 py-1.5 border border-[#E8E8E4] rounded-lg text-[13px] outline-none focus:border-[#7F77DD] bg-white"
                  value={writeOffNote}
                  onChange={e => setWriteOffNote(e.target.value)}
                  placeholder="e.g. Timely filing deadline passed 2026-08-20"
                />
              </div>
              {writeOffError && (
                <div className="text-[12px] text-[#991B1B] bg-[#FCEBEB] border border-[#F5C6C6] px-2.5 py-1.5 rounded-lg">{writeOffError}</div>
              )}
            </div>
            <div className="flex justify-end gap-2 mt-5">
              <Button variant="secondary" size="sm" onClick={() => setWriteOffTarget(null)}>Cancel</Button>
              <Button variant="danger" size="sm" loading={writingOff} onClick={confirmWriteOff}>Write off</Button>
            </div>
          </div>
        </div>
      )}

      {rejectionModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={() => setRejectionModal(null)}>
          <div className="bg-white rounded-lg max-w-3xl w-full max-h-[85vh] flex flex-col" onClick={e => e.stopPropagation()}>
            <div className="p-4 border-b flex items-center justify-between">
              <div className="flex items-center gap-2 text-[#7F1D1D]">
                <AlertCircle size={18} />
                <h3 className="font-semibold">{rejectionModal.message}</h3>
              </div>
              <button onClick={() => setRejectionModal(null)} className="text-neutral-500 hover:text-neutral-900">
                <X size={18} />
              </button>
            </div>
            <div className="p-4 overflow-auto space-y-4">
              <div>
                <div className="text-xs font-semibold text-neutral-500 mb-1">STEDI SAID</div>
                <div className="bg-[#FEE2E2] border border-[#FCA5A5] text-[#7F1D1D] rounded p-3 text-sm whitespace-pre-wrap break-words">
                  {rejectionModal.summary}
                </div>
              </div>
              <div>
                <div className="text-xs font-semibold text-neutral-500 mb-1">FULL RESPONSE</div>
                <pre className="bg-neutral-50 border border-neutral-200 rounded p-3 text-xs overflow-auto max-h-[40vh] whitespace-pre-wrap break-all">
{typeof rejectionModal.details === 'string' ? rejectionModal.details : JSON.stringify(rejectionModal.details, null, 2)}
                </pre>
              </div>
              {rejectionModal.sentDependent !== undefined && (
                <div>
                  <div className="text-xs font-semibold text-neutral-500 mb-1">DEPENDENT WE SENT</div>
                  <pre className="bg-neutral-50 border border-neutral-200 rounded p-3 text-xs overflow-auto max-h-[30vh] whitespace-pre-wrap break-all">
{JSON.stringify(rejectionModal.sentDependent, null, 2)}
                  </pre>
                </div>
              )}
            </div>
            <div className="p-4 border-t flex justify-end gap-2">
              <button
                onClick={() => {
                  const text = JSON.stringify({ summary: rejectionModal.summary, details: rejectionModal.details, sentDependent: rejectionModal.sentDependent }, null, 2)
                  navigator.clipboard.writeText(text)
                }}
                className="px-3 py-1.5 text-sm border border-neutral-300 rounded hover:bg-neutral-50">
                Copy all
              </button>
              <Button variant="teal" onClick={() => setRejectionModal(null)}>Close</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// Per-line Dx assignment picker. Shows a small "Dx: 1, 3" badge plus
// a link that opens a popover of the claim's diagnoses with numbered
// checkboxes and up/down reorder arrows. Max 4 checked (X12 837P
// per-line pointer cap). Empty selection persists as [] — the payload
// builder falls back to "all diagnoses up to 4" for CPT lines that
// have no explicit selection, so pre-existing claims aren't
// regressed. Save is optimistic-then-reload via the parent's onSave.
function DxLineButton({ claim, cpIndex: _cpIndex, pointers, onSave }: {
  claim: any
  cpIndex: number
  pointers: number[]
  onSave: (next: number[]) => Promise<void> | void
}) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<number[]>(pointers)
  const [saving, setSaving] = useState(false)
  const [coords, setCoords] = useState<{ top?: number; bottom?: number; left: number; maxHeight: number } | null>(null)
  const buttonRef = useRef<HTMLButtonElement | null>(null)
  const diagnoses: any[] = Array.isArray(claim.diagnoses) ? claim.diagnoses : []

  const openPopover = () => {
    setDraft(pointers)
    // Fixed-position the popover using the button's rect so ancestor
    // overflow: hidden can't clip it. Also choose direction (below/
    // above the button) and horizontal offset based on available
    // viewport space, so the popover never runs off any edge. Sara
    // DuMond 2026-09-14 caught the "opens off the bottom" case when
    // the button is near the viewport bottom.
    if (buttonRef.current) {
      const r = buttonRef.current.getBoundingClientRect()
      const POPOVER_WIDTH = 320
      const MARGIN = 12
      const spaceBelow = window.innerHeight - r.bottom - MARGIN
      const spaceAbove = r.top - MARGIN
      // If there's meaningful room below, open below. Otherwise flip
      // above the button and cap by the space above.
      const openAbove = spaceBelow < 200 && spaceAbove > spaceBelow
      // Keep the popover on-screen horizontally: shift left if it
      // would overflow the right edge.
      const left = Math.min(r.left, window.innerWidth - POPOVER_WIDTH - MARGIN)
      if (openAbove) {
        setCoords({
          bottom: window.innerHeight - r.top + 4,
          left: Math.max(MARGIN, left),
          maxHeight: spaceAbove,
        })
      } else {
        setCoords({
          top: r.bottom + 4,
          left: Math.max(MARGIN, left),
          maxHeight: spaceBelow,
        })
      }
    }
    setOpen(true)
  }
  const toggle = (n: number) => {
    setDraft(cur => {
      if (cur.includes(n)) return cur.filter(x => x !== n)
      if (cur.length >= 4) return cur
      return [...cur, n]
    })
  }
  const move = (from: number, to: number) => {
    if (to < 0 || to >= draft.length) return
    setDraft(cur => {
      const next = [...cur]
      const [item] = next.splice(from, 1)
      next.splice(to, 0, item)
      return next
    })
  }
  const save = async () => {
    setSaving(true)
    try {
      await onSave(draft)
      setOpen(false)
    } finally {
      setSaving(false)
    }
  }

  const badge = pointers.length ? `Dx: ${pointers.join(', ')}` : 'Dx: all'

  return (
    <div className="inline-block ml-2">
      <button
        ref={buttonRef}
        type="button"
        onClick={openPopover}
        disabled={diagnoses.length === 0}
        className="text-[10px] px-1.5 py-0.5 rounded border border-[#7F77DD] text-[#7F77DD] hover:bg-[#F1EFE8] disabled:opacity-40 disabled:cursor-not-allowed">
        {badge}
      </button>
      {open && coords && createPortal(
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div
            className="fixed z-50 w-80 bg-white border border-[#E8E8E4] rounded-lg shadow-lg p-3 flex flex-col"
            style={{
              ...(coords.top !== undefined ? { top: coords.top } : {}),
              ...(coords.bottom !== undefined ? { bottom: coords.bottom } : {}),
              left: coords.left,
              maxHeight: coords.maxHeight,
            }}>
            <div className="text-[11px] font-semibold text-[#555] uppercase tracking-wider mb-2 flex-shrink-0">
              Link diagnoses to this CPT line
            </div>
            <div className="text-[11px] text-[#1A1A2E] mb-2 flex-shrink-0">
              First checked = primary. Max 4. Empty = all diagnoses apply.
            </div>
            {diagnoses.length === 0 ? (
              <div className="text-[12px] text-[#1A1A2E] italic py-2">No diagnoses on this claim yet.</div>
            ) : (
              <div className="space-y-1 flex-1 min-h-0 overflow-auto">
                {diagnoses.map((d: any, i: number) => {
                  const dxNumber = i + 1
                  const orderIdx = draft.indexOf(dxNumber)
                  const checked = orderIdx >= 0
                  const disabled = !checked && draft.length >= 4
                  return (
                    <div key={d.code} className={`flex items-center gap-2 text-[12px] p-1 rounded ${checked ? 'bg-[#F1EFE8]' : ''}`}>
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={disabled}
                        onChange={() => toggle(dxNumber)} />
                      <span className="inline-block w-4 text-right text-[10px] font-semibold text-[#1A1A2E]">{dxNumber}</span>
                      <span className="flex-1 min-w-0 truncate">
                        <span className="font-semibold text-[#7F77DD]">{d.code}</span> {d.name}
                      </span>
                      {checked && (
                        <>
                          <span className="text-[10px] font-semibold text-[#085041] bg-[#E1F5EE] rounded px-1">
                            #{orderIdx + 1}
                          </span>
                          <button
                            type="button"
                            disabled={orderIdx === 0}
                            onClick={() => move(orderIdx, orderIdx - 1)}
                            className="text-[10px] text-[#555] disabled:opacity-30">▲</button>
                          <button
                            type="button"
                            disabled={orderIdx === draft.length - 1}
                            onClick={() => move(orderIdx, orderIdx + 1)}
                            className="text-[10px] text-[#555] disabled:opacity-30">▼</button>
                        </>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
            <div className="flex justify-end gap-2 mt-3 pt-2 border-t border-[#F1EFE8] flex-shrink-0">
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="text-[11px] px-2 py-1 text-[#555] hover:underline">Cancel</button>
              <Button size="sm" variant="teal" loading={saving} onClick={save}>Save</Button>
            </div>
          </div>
        </>,
        document.body,
      )}
    </div>
  )
}
