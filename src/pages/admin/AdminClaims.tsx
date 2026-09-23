import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Link, useSearchParams } from 'react-router-dom'
import { format } from 'date-fns'
import { FileText, AlertCircle, AlertOctagon, CheckCircle, XCircle, Clock, Send, ChevronDown, ChevronUp, RefreshCw, ExternalLink, Receipt, Pencil, Trash2, Plus, Zap, Search, X, Download } from 'lucide-react'
import { Button } from '../../components/ui/Button'
import { getClaims, generateClaim, submitClaim, testClaim, updateClaim, deleteClaim, getFeeSchedule, markClaimReadyForBiller, unmarkClaimReadyForBiller, testStediEraSync, backfillStediCas, backfillStediCasForce, refetchKnownEras, inspectUnmatchedEras, attach277X12, markRejectionHandled, download277X12, getProviders, sendBillerQuestion, providerUpdateChild, writeOffClaim, downloadEncounterNoteHtml, downloadClaim1500Pdf, downloadClaimEraPdf, reopenClaim, type WriteOffReason } from '../../lib/api'
import { detectErraOutcome, outcomeLabel } from '../../lib/carcCodes'
import { ChartNumberPill } from '../../components/ChartNumberPill'
import { Ban } from 'lucide-react'

const CLAIM_WRITE_OFF_LABELS: Record<WriteOffReason, string> = {
  bad_debt:       'Bad debt (payer won\'t pay + patient won\'t either)',
  small_balance:  'Small balance (not worth pursuing)',
  hardship:       'Courtesy / hardship',
  billing_error:  'Billing error (our mistake)',
  timely_filing:  'Timely filing exceeded',
  other:          'Other',
}

// Must stay in sync with REOPEN_REASONS on the server
// (api/claims/[id]/reopen.ts). If you add a reason here, add it there
// too or the server rejects with a 400.
const REOPEN_REASON_LABELS: Record<string, string> = {
  payer_denied_cpt_dx:       'Payer denied — CPT or diagnosis fix',
  payer_denied_member_info:  'Payer denied — member or insurance info fix',
  payer_denied_other:        'Payer denied — other rework',
  other_correction:          'Other correction needed',
}
const REOPEN_NOTE_MIN = 20
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

type Tab = 'review' | 'rework' | 'submitted' | 'completed'

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
  // Diagnostic — "Inspect unmatched ERAs" surfaces ERAs Stedi pushed
  // to us but that findClaim() couldn't attach to any claim record.
  // Used when a biller says "the ERA came back at Stedi but not in the
  // app." Result modal renders the payer's PCN + patient name so we
  // can see the mismatch and either manually attach or fix findClaim.
  const [inspectRunning, setInspectRunning] = useState(false)
  const [inspectResult, setInspectResult]   = useState<any | null>(null)

  // Attach 277 X12 (retroactive) — for rejections that arrived before
  // the webhook was configured to process 277s (Olive Dings 2026-09-14
  // is the anchor case). Sara grabs the raw 277 X12 from the Stedi
  // portal (X12 tab) for a specific claim, pastes it here, and it
  // attaches as a rejection. Future 277s auto-attach via the webhook.
  const [attach277Target, setAttach277Target]     = useState<any | null>(null)
  const [attach277Text, setAttach277Text]         = useState('')
  const [attach277Error, setAttach277Error]       = useState<string | null>(null)
  const [attach277Submitting, setAttach277Submitting] = useState(false)

  // Mark rejection handled — biller acknowledges a 277 rejection banner
  // and records what she did about it. Same shape as the existing
  // mark-denial-handled flow.
  const [rejectionHandledOpen, setRejectionHandledOpen] = useState<string | null>(null)
  const [rejectionHandledNotes, setRejectionHandledNotes] = useState('')
  const [rejectionHandledSaving, setRejectionHandledSaving] = useState(false)

  // Reopen modal — replaces the old one-click Reopen. Requires a
  // categorized reason + a note (min 20 chars server-enforced) so a
  // reopen is always a deliberate act with an audit trail.
  const [reopenTarget, setReopenTarget]   = useState<any | null>(null)
  const [reopenReason, setReopenReason]   = useState<string>('payer_denied_cpt_dx')
  const [reopenNote, setReopenNote]       = useState<string>('')
  const [reopenError, setReopenError]     = useState<string | null>(null)
  const [reopenSubmitting, setReopenSubmitting] = useState<boolean>(false)
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
      // Fetch written_off so the Completed tab has somewhere to render
      // closed-via-write-off workflows (not just closed-via-payment).
      const [review, errored, submitted, draft, writtenOff] = await Promise.all([
        getClaims('pending_review'),
        getClaims('error'),
        getClaims('submitted'),
        getClaims('draft'),
        getClaims('written_off'),
      ])
      setClaims([...review, ...errored, ...submitted, ...draft, ...writtenOff])
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

  // Deep-link: /admin/claims?claim=<id> auto-switches to the correct tab
  // and expands the claim so the biller lands on it. Used by the AR
  // aging drill-down on the Financial Reports page.
  const [searchParams, setSearchParams] = useSearchParams()
  useEffect(() => {
    const targetId = searchParams.get('claim')
    if (!targetId || loading || claims.length === 0) return
    const target = claims.find(c => c.id === targetId)
    if (!target) return
    const isReviewTab = target.status === 'pending_review' || target.status === 'error' || target.status === 'draft'
    const isCompletedTab =
      (target.status === 'submitted' && !!target.era_received_at) || target.status === 'written_off'
    setTab(isReviewTab ? 'review' : isCompletedTab ? 'completed' : 'submitted')
    setExpanded(targetId)
    // Clear the param so a back-nav or refresh doesn't re-fire this.
    const next = new URLSearchParams(searchParams)
    next.delete('claim')
    setSearchParams(next, { replace: true })
    // Wait a tick for the tab switch + expand to render, then scroll.
    setTimeout(() => {
      document.getElementById(`claim-card-${targetId}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }, 100)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, claims, searchParams])

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

  // Old handleReopen (single click → status flip → tab switch) was
  // removed 2026-09-23. The read-only "What was submitted" panel now
  // lives in the expanded card so viewing is non-destructive.
  //
  // If Andrea genuinely needs to rework + resubmit, she opens the modal
  // below (setReopenTarget), picks a categorized reason, and writes a
  // note of at least REOPEN_NOTE_MIN characters. The server also
  // enforces both — reason must be in REOPEN_REASONS, note must clear
  // the min-length gate — so nothing bypasses the audit trail.
  async function confirmReopen() {
    if (!reopenTarget) return
    if (!REOPEN_REASON_LABELS[reopenReason]) {
      setReopenError('Please select a reason.')
      return
    }
    if (reopenNote.trim().length < REOPEN_NOTE_MIN) {
      setReopenError(`Note must be at least ${REOPEN_NOTE_MIN} characters. Describe the correction you're making.`)
      return
    }
    setReopenSubmitting(true)
    setReopenError(null)
    try {
      await reopenClaim(reopenTarget.id, { reason: reopenReason, note: reopenNote.trim() })
      await load()
      setReopenTarget(null)
      setReopenReason('payer_denied_cpt_dx')
      setReopenNote('')
      setTab('review')
    } catch (e: any) {
      setReopenError(e?.message ?? 'Failed to reopen claim')
    } finally {
      setReopenSubmitting(false)
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
  // "Submitted" now means truly waiting on the payer — sent to Stedi
  // but no ERA back yet. Once an ERA arrives (paid / partial / denied
  // / no-patient-responsibility), the claim moves to "Completed" so
  // the biller's Submitted queue only surfaces claims where the ball
  // is still in the payer's court. Written-off claims also live in
  // Completed — a closed workflow, just closed via write-off rather
  // than payment. (Andrea's ask 2026-09-18.)
  const submittedClaims = visibleClaims.filter(c => c.status === 'submitted' && !c.era_received_at)
  const completedClaims = visibleClaims.filter(c =>
    (c.status === 'submitted' && !!c.era_received_at) || c.status === 'written_off'
  )
  // Only count claims she still has to act on — same status filter as
  // reviewClaims. Once she submits a claim, ready_for_biller_at stays
  // set on the row (biller attribution), but for the counter it's
  // stale — she's already handled that one.
  const readyCount      = baseVisibleClaims.filter(c => isReady(c) && (c.status === 'pending_review' || c.status === 'error' || c.status === 'draft')).length
  // Unseen ERA payments — bill can see how many new payments landed since
  // last review. Cleared per-claim by clicking "Mark seen" on the ERA card.
  const unseenEraCount  = baseVisibleClaims.filter((c: any) => c.era_received_at && !c.era_seen_at).length
  // 277 rejections needing biller attention — payer rejected the claim at
  // intake and no one has acknowledged the rejection banner yet. Cleared
  // per-claim by clicking "Mark rejection handled" in the expanded card.
  const unhandledRejectionCount = baseVisibleClaims.filter((c: any) => c.claim_rejection_at && !c.claim_rejection_handled_at).length

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
          <button
            onClick={async () => {
              setInspectRunning(true)
              setInspectResult(null)
              try {
                const r = await inspectUnmatchedEras(60)
                setInspectResult(r)
              } catch (e: any) {
                setInspectResult({ ok: false, error: e?.message ?? String(e) })
              } finally {
                setInspectRunning(false)
              }
            }}
            disabled={inspectRunning}
            className="flex items-center gap-1.5 text-[12px] px-2.5 py-1 rounded-lg border border-[#4C1D95] text-[#4C1D95] hover:bg-[#EEEDFE] transition-colors disabled:opacity-50"
            title="Fetch the raw 835 for every ERA Stedi pushed us that didn't match any claim record — shows the PCN the payer echoed vs. the PCN we sent.">
            <Search size={12} /> {inspectRunning ? 'Inspecting…' : 'Inspect unmatched ERAs'}
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
          {(refetchResult.x12_http != null || refetchResult.x12_error) && (
            <div className="text-[11px] mt-2 opacity-90 border-t border-[#A9DFBF] pt-2">
              <div className="opacity-70">
                /eras/{'{'}id{'}'}/x12 endpoint — HTTP {refetchResult.x12_http ?? 'error'}
                {refetchResult.x12_error && <span className="text-[#991B1B]"> · {refetchResult.x12_error}</span>}
              </div>
              {refetchResult.x12_sample && (
                <details className="mt-1">
                  <summary className="opacity-70 cursor-pointer">Show X12 sample (first 3000 chars)</summary>
                  <pre className="mt-1 whitespace-pre-wrap text-[10px] max-h-96 overflow-y-auto bg-white border border-[#A9DFBF] rounded p-2">{refetchResult.x12_sample}</pre>
                </details>
              )}
            </div>
          )}
        </div>
      )}

      {unhandledRejectionCount > 0 && (
        <div className="mb-4 flex items-center gap-2 bg-[#FEE2E2] border border-[#FECACA] text-[#7F1D1D] px-4 py-2.5 rounded-xl">
          <AlertOctagon size={14} />
          <div className="text-[13px] font-medium">
            {unhandledRejectionCount} claim{unhandledRejectionCount === 1 ? '' : 's'} rejected at intake by the payer — needs rework. Look for the pulsing <span className="mx-1 inline-flex items-center gap-0.5 bg-[#FEE2E2] text-[#7F1D1D] px-1.5 py-0.5 rounded-full text-[10px] font-bold border border-[#FECACA]">REJECTED AT INTAKE</span> badge on the Submitted tab.
          </div>
          <button
            onClick={() => setTab('submitted')}
            className="ml-auto text-[12px] font-medium px-3 py-1 rounded-lg bg-white border border-[#DC2626] text-[#7F1D1D] hover:bg-[#FEE2E2] transition-colors">
            Go to Submitted
          </button>
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
          <button className={tabCls('completed')} onClick={() => setTab('completed')}>
            Completed ({completedClaims.length})
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
                // Sara asked 2026-09-17 that biller can generate a
                // statement on every claim regardless of payer type or
                // CPT categories. Previously this gated on self-pay /
                // all-non-covered CPTs.
                const showStatementButton = true
                const stediError = (() => {
                  if (!c.submission_error) return null
                  try {
                    const parsed = JSON.parse(c.submission_error)
                    return parsed?.errors?.[0]?.description ?? parsed?.message ?? c.submission_error
                  } catch { return c.submission_error }
                })()
                return (
                  <div key={c.id} id={`claim-card-${c.id}`} className="bg-white border border-[#E8E8E4] rounded-xl overflow-hidden">
                    <button className="w-full flex items-center justify-between px-4 py-3.5 text-left hover:bg-[#FAFAF8] transition-colors"
                      onClick={() => setExpanded(isOpen ? null : c.id)}>
                      <div className="flex items-center gap-3 min-w-0">
                        <FileText size={15} className="text-[#7F77DD] flex-shrink-0" />
                        <div>
                          <div className="text-[14px] font-medium text-[#1A1A2E] inline-flex items-center gap-2 flex-wrap">
                            <span>
                              {[(c.child_first_name ?? c.patient_first_name), (c.child_last_name ?? c.patient_last_name)].filter(Boolean).join(' ') || 'Unknown patient'}
                            </span>
                            <ChartNumberPill value={c.chart_number} />
                            <span className="text-[12px] font-normal text-[#1A1A2E]">{fmtDate(c.service_date)}</span>
                            {/* Reopened badge — claim was submitted, then a biller reopened
                                for correction. Distinct from brand-new pending claims so
                                rework doesn't drown in the queue. Hover for reason + note. */}
                            {c.reopened_at && (
                              <span
                                className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[10px] font-semibold bg-[#EEEDFE] text-[#4C1D95]"
                                title={`${REOPEN_REASON_LABELS[c.reopen_reason] ?? c.reopen_reason ?? 'Reopened'}${c.reopen_note ? ' — ' + String(c.reopen_note).slice(0, 240) : ''}`}
                              >
                                ↻ REOPENED{c.reopen_reason ? ` — ${(REOPEN_REASON_LABELS[c.reopen_reason] ?? c.reopen_reason).toUpperCase()}` : ''}
                              </span>
                            )}
                            {/* Same denial badge already used in Submitted+Completed. Rendered
                                here too because reworked claims (submitted → denied → reopened)
                                still show their denial context inline. */}
                            {(() => {
                              const outcome = detectErraOutcome(c.denial_codes)
                              if (outcome.status === 'clean') return null
                              if (c.denial_handled_at) {
                                return (
                                  <span
                                    className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[10px] font-semibold bg-[#ECFDF5] text-[#065F46]"
                                    title={`Handled by ${c.denial_handled_by_name ?? 'biller'}${c.denial_handling_notes ? ' — ' + c.denial_handling_notes.slice(0, 200) : ''}`}
                                  >
                                    ✓ {outcomeLabel(outcome.status).toUpperCase()} — HANDLED
                                  </span>
                                )
                              }
                              const isDoc = outcome.status === 'documentation_needed'
                              const cls = isDoc
                                ? 'bg-[#FEF3C7] text-[#78350F]'
                                : 'bg-[#FEE2E2] text-[#7F1D1D]'
                              return (
                                <span className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[10px] font-bold animate-pulse ${cls}`} title={outcome.codes.join(', ')}>
                                  <AlertOctagon size={9} /> {outcomeLabel(outcome.status).toUpperCase()}
                                </span>
                              )
                            })()}
                            {/* 277 rejection badge on Pending Review too (Olive Dings
                                was reopened after her 277 rejection, so she lives here). */}
                            {c.claim_rejection_at && !c.claim_rejection_handled_at && (
                              <span
                                className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[10px] font-bold animate-pulse bg-[#FEE2E2] text-[#7F1D1D]"
                                title={(c.claim_rejection_reasons ?? []).map((r: any) => `[${r.category}/${r.code}] ${r.message}`).join(' · ')}>
                                <AlertOctagon size={9} /> REJECTED AT INTAKE
                              </span>
                            )}
                            {c.claim_rejection_at && c.claim_rejection_handled_at && (
                              <span
                                className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[10px] font-semibold bg-[#ECFDF5] text-[#065F46]"
                                title={`Handled by ${c.claim_rejection_handled_by_name ?? 'biller'}${c.claim_rejection_handling_notes ? ' — ' + String(c.claim_rejection_handling_notes).slice(0, 200) : ''}`}>
                                ✓ REJECTED — HANDLED
                              </span>
                            )}
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
                        {/* 277 rejection banner on Pending Review — appears on
                            reopened claims that were previously rejected at
                            intake (Olive Dings pattern). Same structure and
                            handler as the banner on Submitted+Completed. */}
                        {c.claim_rejection_at && (() => {
                          const reasons: any[] = Array.isArray(c.claim_rejection_reasons) ? c.claim_rejection_reasons : []
                          const isHandled = !!c.claim_rejection_handled_at
                          const isOpenForm = rejectionHandledOpen === c.id
                          const borderCls = isHandled ? 'border-[#A7F3D0] bg-[#ECFDF5]' : 'border-[#FECACA] bg-[#FEE2E2]'
                          const textCls   = isHandled ? 'text-[#065F46]' : 'text-[#7F1D1D]'
                          return (
                            <div className={`rounded-xl border-2 ${borderCls} px-4 py-3`}>
                              <div className={`flex items-start gap-3 ${textCls}`}>
                                <AlertOctagon size={18} className="flex-shrink-0 mt-0.5" />
                                <div className="flex-1 min-w-0">
                                  <div className="text-[13px] font-semibold uppercase tracking-wide">
                                    {isHandled ? 'Rejected at intake — handled' : `Rejected by ${c.payer_name || 'payer'} at intake`}
                                  </div>
                                  <div className="text-[12px] mt-0.5 opacity-90">
                                    Received {fmtDate(c.claim_rejection_at)}. This claim never entered adjudication; correct + resubmit to get paid.
                                  </div>
                                  {reasons.length > 0 && (
                                    <ul className="mt-2 space-y-1.5 text-[12px]">
                                      {reasons.map((r: any, i: number) => (
                                        <li key={i} className="flex items-start gap-2">
                                          <span className="mt-0.5 flex-shrink-0 inline-flex items-center px-1.5 py-0.5 rounded-md text-[10px] font-mono font-semibold bg-white/70 border border-current/20">
                                            {r.category}/{r.code}
                                          </span>
                                          <span className="whitespace-pre-wrap">{r.message || '(no free-text reason provided)'}</span>
                                        </li>
                                      ))}
                                    </ul>
                                  )}
                                  {isHandled && (
                                    <div className="mt-2 text-[12px] italic">
                                      Handled by {c.claim_rejection_handled_by_name ?? 'biller'} · {fmtDate(c.claim_rejection_handled_at)}{c.claim_rejection_handling_notes ? ` — ${c.claim_rejection_handling_notes}` : ''}
                                    </div>
                                  )}
                                  <div className="mt-3 flex gap-2 flex-wrap">
                                    <button
                                      onClick={() => download277X12(c.id).catch(e => alert(e?.message ?? 'Failed to download 277 X12'))}
                                      className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-md bg-white/70 border border-current/30 hover:bg-white font-medium">
                                      <Download size={11} /> Download 277 X12
                                    </button>
                                    <a
                                      href={`https://portal.stedi.com/app/healthcare/claims/${String(c.id).replace(/-/g, '').slice(0, 20)}`}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-md bg-white/70 border border-current/30 hover:bg-white font-medium">
                                      View 277 in Stedi <ExternalLink size={10} />
                                    </a>
                                  </div>
                                </div>
                              </div>
                              {!isHandled && !isOpenForm && (
                                <div className="mt-3 flex gap-2">
                                  <button
                                    onClick={() => { setRejectionHandledOpen(c.id); setRejectionHandledNotes('') }}
                                    className="text-[12px] px-2.5 py-1 rounded-lg bg-white border border-[#DC2626] text-[#7F1D1D] hover:bg-[#FEE2E2] font-medium">
                                    Mark rejection handled
                                  </button>
                                </div>
                              )}
                              {!isHandled && isOpenForm && (
                                <div className="mt-3 space-y-2">
                                  <label className="text-[11px] text-[#555] block">What did you do about this rejection? (required)</label>
                                  <textarea
                                    className="w-full px-2.5 py-1.5 border border-[#E8E8E4] rounded-lg text-[13px] outline-none focus:border-[#7F77DD] bg-white min-h-[60px]"
                                    value={rejectionHandledNotes}
                                    onChange={e => setRejectionHandledNotes(e.target.value)}
                                    disabled={rejectionHandledSaving}
                                    placeholder="e.g. Added modifier 59 to 99345 line, resubmitting" />
                                  <div className="flex gap-2 justify-end">
                                    <button
                                      onClick={() => setRejectionHandledOpen(null)}
                                      disabled={rejectionHandledSaving}
                                      className="text-[12px] px-2.5 py-1 rounded-lg border border-[#E8E8E4] text-[#1A1A2E] hover:bg-[#FAFAF8]">Cancel</button>
                                    <button
                                      onClick={async () => {
                                        if (!rejectionHandledNotes.trim()) { alert('Please describe what you did.'); return }
                                        setRejectionHandledSaving(true)
                                        try {
                                          await markRejectionHandled(c.id, { notes: rejectionHandledNotes.trim() })
                                          await load()
                                          setRejectionHandledOpen(null)
                                          setRejectionHandledNotes('')
                                        } catch (err: any) {
                                          alert(err?.message ?? 'Failed to save')
                                        } finally {
                                          setRejectionHandledSaving(false)
                                        }
                                      }}
                                      disabled={rejectionHandledSaving || !rejectionHandledNotes.trim()}
                                      className="text-[12px] px-2.5 py-1 rounded-lg bg-[#DC2626] text-white hover:bg-[#B91C1C] disabled:opacity-50">
                                      {rejectionHandledSaving ? 'Saving…' : 'Save & mark handled'}
                                    </button>
                                  </div>
                                </div>
                              )}
                            </div>
                          )
                        })()}
                        {/* Aetna reminder — Aetna denies routine test CPT codes
                            for this pediatric practice, so the biller MUST swap
                            them to self-pay codes before submission. Sara
                            2026-09-17. Matches on payer_name or Stedi id. */}
                        {(() => {
                          const payer = String(c.payer_name ?? '').toLowerCase()
                          const isAetna = payer.includes('aetna') || String(c.payer_id ?? '') === '60054'
                          if (!isAetna) return null
                          return (
                            <div className="rounded-xl border-2 border-[#B45309] bg-[#FFF4D6] px-4 py-3 flex items-start gap-3">
                              <AlertOctagon size={18} className="text-[#B45309] flex-shrink-0 mt-0.5" />
                              <div className="text-[13px] font-semibold text-[#78350F] leading-snug">
                                Reminder: Aetna patient! Please change any test CPT codes to self-pay CPT codes before submitting!
                              </div>
                            </div>
                          )
                        })()}
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
                            {/* Attach 277 also available on Pending Review cards
                                for claims that were previously submitted (Olive
                                Dings is here — reopened before we knew what
                                happened). Only shows when submitted_at is set,
                                since a 277 can only exist for a claim that
                                actually reached the payer. */}
                            {c.submitted_at && (
                              <Button variant="secondary"
                                onClick={() => { setAttach277Target(c); setAttach277Text(''); setAttach277Error(null) }}
                                title="Attach a 277 Claim Acknowledgment (rejection) that came in before the webhook was configured. Paste the raw X12 from the Stedi portal.">
                                Attach 277 (paste X12)
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

          {/* SUBMITTED + COMPLETED TABS — same card layout. Submitted =
              still waiting on payer (no ERA yet). Completed = ERA back
              (paid / partial / denied / no-pt-resp) OR written off. */}
          {(tab === 'submitted' || tab === 'completed') && (() => {
            const list = tab === 'completed' ? completedClaims : submittedClaims
            const emptyMsg = tab === 'completed'
              ? 'No completed claims yet. Claims land here once the payer sends back an ERA.'
              : 'No submitted claims yet.'
            return (
            <div className="space-y-2">
              {list.length === 0 && (
                <div className="text-center py-12 text-[#1A1A2E] text-[13px]">{emptyMsg}</div>
              )}
              {list.map(c => {
                const badge = STATUS_BADGE[c.status] ?? STATUS_BADGE.submitted
                const Icon = badge.icon
                const isOpen = expanded === c.id
                const patientBalance = [c.patient_deductible_era, c.patient_coinsurance_era, c.patient_copay_era, c.patient_non_covered_era]
                  .reduce((s, v) => s + (parseFloat(v ?? 0) || 0), 0)
                return (
                  <div key={c.id} id={`claim-card-${c.id}`} className="bg-white border border-[#E8E8E4] rounded-xl overflow-hidden">
                    <button className="w-full p-4 flex items-center justify-between gap-4 text-left"
                      onClick={() => setExpanded(isOpen ? null : c.id)}>
                      <div className="flex items-center gap-3 min-w-0">
                        <FileText size={15} className="text-[#7F77DD] flex-shrink-0" />
                        <div>
                          <div className="text-[14px] font-medium text-[#1A1A2E] inline-flex items-center gap-2 flex-wrap">
                            <span>
                              {[(c.child_first_name ?? c.patient_first_name), (c.child_last_name ?? c.patient_last_name)].filter(Boolean).join(' ') || 'Unknown patient'}
                            </span>
                            <ChartNumberPill value={c.chart_number} />
                            <span className="text-[12px] font-normal text-[#1A1A2E]">{fmtDate(c.service_date)}</span>
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
                            {(() => {
                              const outcome = detectErraOutcome(c.denial_codes)
                              if (outcome.status === 'clean') return null
                              // Biller has acknowledged + noted what she did →
                              // swap the flashing alert badge for a muted
                              // "handled" tag so the row is still spottable
                              // but not screaming at everyone.
                              if (c.denial_handled_at) {
                                return (
                                  <span
                                    className="ml-2 inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[10px] font-semibold bg-[#ECFDF5] text-[#065F46]"
                                    title={`Handled by ${c.denial_handled_by_name ?? 'biller'}${c.denial_handling_notes ? ' — ' + c.denial_handling_notes.slice(0, 200) : ''}`}
                                  >
                                    ✓ {outcomeLabel(outcome.status).toUpperCase()} — HANDLED
                                  </span>
                                )
                              }
                              const isDoc = outcome.status === 'documentation_needed'
                              const cls = isDoc
                                ? 'bg-[#FEF3C7] text-[#78350F]'
                                : 'bg-[#FEE2E2] text-[#7F1D1D]'
                              return (
                                <span className={`ml-2 inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[10px] font-bold animate-pulse ${cls}`} title={outcome.codes.join(', ')}>
                                  <AlertOctagon size={9} /> {outcomeLabel(outcome.status).toUpperCase()}
                                </span>
                              )
                            })()}
                            {/* 277 rejection badge — payer rejected at intake (before
                                adjudication), never entered the payment workflow.
                                Distinct from 835 denial (which reaches adjudication
                                and generates CAS). Flashing red until biller acks. */}
                            {c.claim_rejection_at && !c.claim_rejection_handled_at && (
                              <span
                                className="ml-2 inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[10px] font-bold animate-pulse bg-[#FEE2E2] text-[#7F1D1D]"
                                title={(c.claim_rejection_reasons ?? []).map((r: any) => `[${r.category}/${r.code}] ${r.message}`).join(' · ')}>
                                <AlertOctagon size={9} /> REJECTED AT INTAKE
                              </span>
                            )}
                            {c.claim_rejection_at && c.claim_rejection_handled_at && (
                              <span
                                className="ml-2 inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[10px] font-semibold bg-[#ECFDF5] text-[#065F46]"
                                title={`Handled by ${c.claim_rejection_handled_by_name ?? 'biller'}${c.claim_rejection_handling_notes ? ' — ' + String(c.claim_rejection_handling_notes).slice(0, 200) : ''}`}>
                                ✓ REJECTED — HANDLED
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
                        {/* Aetna reminder — Aetna denies routine test CPT codes
                            for pediatric practice, so the biller MUST swap them
                            to self-pay codes before submission. Sara 2026-09-17. */}
                        {(() => {
                          const payer = String(c.payer_name ?? '').toLowerCase()
                          const isAetna = payer.includes('aetna') || String(c.payer_id ?? '') === '60054'
                          if (!isAetna) return null
                          return (
                            <div className="rounded-xl border-2 border-[#B45309] bg-[#FFF4D6] px-4 py-3 flex items-start gap-3">
                              <AlertOctagon size={18} className="text-[#B45309] flex-shrink-0 mt-0.5" />
                              <div className="text-[13px] font-semibold text-[#78350F] leading-snug">
                                Reminder: Aetna patient! Please change any test CPT codes to self-pay CPT codes before submitting!
                              </div>
                            </div>
                          )
                        })()}

                        {/* 277 rejection banner — payer rejected the claim before
                            adjudication (bundling, missing modifiers, invalid
                            member ID, etc.). Shows the full reason list Stedi
                            captured. "Mark handled" swaps the flashing red badge
                            for the muted "REJECTED — HANDLED" tag; details stay
                            visible for audit. */}
                        {c.claim_rejection_at && (() => {
                          const reasons: any[] = Array.isArray(c.claim_rejection_reasons) ? c.claim_rejection_reasons : []
                          const isHandled = !!c.claim_rejection_handled_at
                          const isOpenForm = rejectionHandledOpen === c.id
                          const borderCls = isHandled ? 'border-[#A7F3D0] bg-[#ECFDF5]' : 'border-[#FECACA] bg-[#FEE2E2]'
                          const textCls   = isHandled ? 'text-[#065F46]' : 'text-[#7F1D1D]'
                          return (
                            <div className={`rounded-xl border-2 ${borderCls} px-4 py-3`}>
                              <div className={`flex items-start gap-3 ${textCls}`}>
                                <AlertOctagon size={18} className="flex-shrink-0 mt-0.5" />
                                <div className="flex-1 min-w-0">
                                  <div className="text-[13px] font-semibold uppercase tracking-wide">
                                    {isHandled ? 'Rejected at intake — handled' : `Rejected by ${c.payer_name || 'payer'} at intake`}
                                  </div>
                                  <div className="text-[12px] mt-0.5 opacity-90">
                                    {isHandled
                                      ? `Received ${fmtDate(c.claim_rejection_at)}. This claim never entered adjudication; you'll need to correct + resubmit to get paid.`
                                      : `Received ${fmtDate(c.claim_rejection_at)}. This claim never entered adjudication.`}
                                  </div>
                                  {reasons.length > 0 && (
                                    <ul className="mt-2 space-y-1.5 text-[12px]">
                                      {reasons.map((r: any, i: number) => (
                                        <li key={i} className="flex items-start gap-2">
                                          <span className="mt-0.5 flex-shrink-0 inline-flex items-center px-1.5 py-0.5 rounded-md text-[10px] font-mono font-semibold bg-white/70 border border-current/20">
                                            {r.category}/{r.code}
                                          </span>
                                          <span className="whitespace-pre-wrap">{r.message || '(no free-text reason provided)'}</span>
                                        </li>
                                      ))}
                                    </ul>
                                  )}
                                  {isHandled && (
                                    <div className="mt-2 text-[12px] italic">
                                      Handled by {c.claim_rejection_handled_by_name ?? 'biller'} · {fmtDate(c.claim_rejection_handled_at)}{c.claim_rejection_handling_notes ? ` — ${c.claim_rejection_handling_notes}` : ''}
                                    </div>
                                  )}
                                </div>
                              </div>
                              {!isHandled && !isOpenForm && (
                                <div className="mt-3 flex gap-2">
                                  <button
                                    onClick={() => { setRejectionHandledOpen(c.id); setRejectionHandledNotes('') }}
                                    className="text-[12px] px-2.5 py-1 rounded-lg bg-white border border-[#DC2626] text-[#7F1D1D] hover:bg-[#FEE2E2] font-medium">
                                    Mark rejection handled
                                  </button>
                                </div>
                              )}
                              {!isHandled && isOpenForm && (
                                <div className="mt-3 space-y-2">
                                  <label className="text-[11px] text-[#555] block">What did you do about this rejection? (required)</label>
                                  <textarea
                                    className="w-full px-2.5 py-1.5 border border-[#E8E8E4] rounded-lg text-[13px] outline-none focus:border-[#7F77DD] bg-white min-h-[60px]"
                                    value={rejectionHandledNotes}
                                    onChange={e => setRejectionHandledNotes(e.target.value)}
                                    disabled={rejectionHandledSaving}
                                    placeholder="e.g. Added modifier 59 to 99345 line, resubmitting" />
                                  <div className="flex gap-2 justify-end">
                                    <button
                                      onClick={() => setRejectionHandledOpen(null)}
                                      disabled={rejectionHandledSaving}
                                      className="text-[12px] px-2.5 py-1 rounded-lg border border-[#E8E8E4] text-[#1A1A2E] hover:bg-[#FAFAF8]">Cancel</button>
                                    <button
                                      onClick={async () => {
                                        if (!rejectionHandledNotes.trim()) { alert('Please describe what you did.'); return }
                                        setRejectionHandledSaving(true)
                                        try {
                                          await markRejectionHandled(c.id, { notes: rejectionHandledNotes.trim() })
                                          await load()
                                          setRejectionHandledOpen(null)
                                          setRejectionHandledNotes('')
                                        } catch (err: any) {
                                          alert(err?.message ?? 'Failed to save')
                                        } finally {
                                          setRejectionHandledSaving(false)
                                        }
                                      }}
                                      disabled={rejectionHandledSaving || !rejectionHandledNotes.trim()}
                                      className="text-[12px] px-2.5 py-1 rounded-lg bg-[#DC2626] text-white hover:bg-[#B91C1C] disabled:opacity-50">
                                      {rejectionHandledSaving ? 'Saving…' : 'Save & mark handled'}
                                    </button>
                                  </div>
                                </div>
                              )}
                            </div>
                          )
                        })()}

                        {/* Read-only "what was submitted" panel. Andrea was clicking
                            Reopen just to view submitted claims, which flipped their
                            status back to pending_review and hid them from the
                            Submitted tab — exactly the Olive Dings / Rhett Richmond
                            / Carson Yates confusion. Rendering the details here as a
                            passive view means she doesn't need to touch Reopen unless
                            she actually intends to rework the claim. Sara 2026-09-23. */}
                        <div className="bg-[#F9F9F7] border border-[#E8E8E4] rounded-xl p-4 space-y-4">
                          <div className="text-[11px] font-semibold text-[#1A1A2E] uppercase tracking-wider">What was submitted</div>

                          {/* Patient + subscriber grid */}
                          <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-[13px]">
                            <div><span className="text-[#1A1A2E]">Patient: </span><span className="text-[#1A1A2E] font-medium">{[c.patient_first_name, c.patient_last_name].filter(Boolean).join(' ') || '—'}</span></div>
                            <div><span className="text-[#1A1A2E]">DOB: </span><span className="text-[#1A1A2E]">{fmtDate(c.patient_dob)}</span></div>
                            <div><span className="text-[#1A1A2E]">Subscriber: </span><span className="text-[#1A1A2E] font-medium">{c.subscriber_name || '—'}</span></div>
                            <div><span className="text-[#1A1A2E]">Subscriber DOB: </span><span className="text-[#1A1A2E]">{fmtDate(c.subscriber_dob)}</span></div>
                            <div><span className="text-[#1A1A2E]">Member ID: </span><span className="text-[#1A1A2E]">{c.member_id || '—'}</span></div>
                            <div><span className="text-[#1A1A2E]">Group #: </span><span className="text-[#1A1A2E]">{c.group_number || '—'}</span></div>
                            <div><span className="text-[#1A1A2E]">Service date: </span><span className="text-[#1A1A2E]">{fmtDate(c.service_date)}</span></div>
                            <div><span className="text-[#1A1A2E]">Rendering provider: </span><span className="text-[#1A1A2E]">{c.rendering_provider_name || '—'} ({c.rendering_provider_npi || 'no NPI'})</span></div>
                            <div><span className="text-[#1A1A2E]">Payer: </span><span className="text-[#1A1A2E] font-medium">{c.payer_name || '—'}{c.payer_id ? ` (ID: ${c.payer_id})` : ''}</span></div>
                            {c.stedi_claim_id && (
                              <div><span className="text-[#1A1A2E]">Stedi ref: </span><span className="text-[#1A1A2E] font-mono text-[12px]">{c.stedi_claim_id}</span></div>
                            )}
                            {(c.effective_child_id ?? c.child_id) && (
                              <div className="col-span-2"><span className="text-[#1A1A2E]">Encounter note: </span>
                                <Link to={`/admin/chart/${c.effective_child_id ?? c.child_id}`} className="text-[#7F77DD] hover:underline inline-flex items-center gap-1 text-[13px]">
                                  <FileText size={12} /> View in patient chart
                                </Link>
                              </div>
                            )}
                          </div>

                          {/* Diagnoses + Procedures side by side */}
                          <div className="grid grid-cols-2 gap-6">
                            <div>
                              <div className="text-[11px] font-semibold text-[#1A1A2E] uppercase tracking-wider mb-1.5">Diagnoses</div>
                              {(c.diagnoses ?? []).length === 0 ? (
                                <div className="text-[12px] text-[#555]">—</div>
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
                              <div className="text-[11px] font-semibold text-[#1A1A2E] uppercase tracking-wider mb-1.5">Procedures &amp; Fees</div>
                              {(c.cpt_codes ?? []).length === 0 ? (
                                <div className="text-[12px] text-[#555]">—</div>
                              ) : (
                                <div className="space-y-1">
                                  {(c.cpt_codes ?? []).map((cp: any) => {
                                    const units = parseInt(cp.units, 10) || 1
                                    const lineTotal = (parseFloat(cp.charge_amount ?? 0) || 0) * units
                                    return (
                                      <div key={cp.code} className="flex justify-between items-start text-[12px] gap-2">
                                        <div className="flex-1 min-w-0">
                                          <span className="text-[#1A1A2E]">
                                            <span className="font-semibold text-[#555]">{cp.code}</span>
                                            {cp.modifier && <span className="ml-1 text-[10px] font-semibold text-[#F5943A]">-{cp.modifier}</span>}
                                            {' '}{cp.description}
                                            {units > 1 && <span className="ml-1 text-[10px] text-[#555]">× {units} units</span>}
                                          </span>
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
                                </div>
                              )}
                            </div>
                          </div>
                        </div>

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
                        <div className="flex items-center gap-3 flex-wrap">
                          <Button size="sm" variant="secondary"
                            onClick={() => {
                              setReopenTarget(c)
                              setReopenReason('payer_denied_cpt_dx')
                              setReopenNote('')
                              setReopenError(null)
                            }}
                            title="Reopen this claim for correction + resubmission. Requires a reason and a note; logged for audit.">
                            Reopen for correction
                          </Button>
                          {/* Retroactive 277 attachment — for rejections that
                              arrived before the webhook was configured to
                              process 277s. Sara grabs the raw 277 X12 from
                              the Stedi portal's X12 tab and pastes it here. */}
                          <Button size="sm" variant="secondary"
                            onClick={() => { setAttach277Target(c); setAttach277Text(''); setAttach277Error(null) }}
                            title="Attach a 277 Claim Acknowledgment (rejection) that came in before the webhook was configured. Paste the raw X12 from the Stedi portal's X12 tab.">
                            Attach 277 (paste X12)
                          </Button>
                          <a href="https://portal.stedi.com/app/healthcare/claims" target="_blank" rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 text-[11px] text-[#7F77DD] hover:underline">
                            View in Stedi <ExternalLink size={10} />
                          </a>
                          <button onClick={() => setStatementClaim(c)}
                            className="inline-flex items-center gap-1 text-[11px] text-[#7F77DD] hover:underline font-medium">
                            <Receipt size={11} /> Generate statement
                          </button>
                          {c.encounter_note_id && (
                            <button
                              onClick={() => downloadEncounterNoteHtml(c.encounter_note_id).catch(e => alert(e?.message ?? 'Download failed'))}
                              className="inline-flex items-center gap-1 text-[11px] text-[#7F77DD] hover:underline font-medium"
                              title="Opens the encounter note in a new tab. Use browser print → Save as PDF for payer portal upload."
                            >
                              <Download size={11} /> Download encounter note
                            </button>
                          )}
                          {/* Stedi auto-generates a rendered CMS-1500 PDF for
                              every submitted professional claim. Hidden
                              until the claim actually made it to Stedi
                              (correlationId returned in the sync response). */}
                          {c.stedi_response?.claimReference?.correlationId && (
                            <button
                              onClick={() => downloadClaim1500Pdf(c.id).catch(e => alert(e?.message ?? 'Failed to load 1500 PDF'))}
                              className="inline-flex items-center gap-1 text-[11px] text-[#7F77DD] hover:underline font-medium"
                              title="Opens the CMS-1500 form Stedi generated when we submitted this claim. Use browser download from the PDF viewer.">
                              <Download size={11} /> View 1500 form
                            </button>
                          )}
                          {c.era_received_at && (
                            <button
                              onClick={() => downloadClaimEraPdf(c.id).catch(e => alert(e?.message ?? 'Failed to load ERA PDF'))}
                              className="inline-flex items-center gap-1 text-[11px] text-[#7F77DD] hover:underline font-medium"
                              title="Opens the 835 ERA remittance PDF from Stedi.">
                              <Download size={11} /> View ERA PDF
                            </button>
                          )}
                          {/* 277 rejection artifacts — parallel to View 1500 / View ERA.
                              Only shows when this claim has an attached rejection. */}
                          {c.claim_rejection_at && (
                            <button
                              onClick={() => download277X12(c.id).catch(e => alert(e?.message ?? 'Failed to download 277 X12'))}
                              className="inline-flex items-center gap-1 text-[11px] text-[#DC2626] hover:underline font-medium"
                              title="Downloads the raw 277 Claim Acknowledgment X12 (EDI text). Same file the payer sent — useful for archiving or forwarding to payer support.">
                              <Download size={11} /> Download 277 X12
                            </button>
                          )}
                          {c.claim_rejection_at && (() => {
                            // Stedi's portal deep-link uses the truncated PCN
                            // (first 20 chars of our claim UUID with dashes
                            // stripped — confirmed 2026-09-23 by inspecting
                            // Stedi's returned patientControlNumber for Olive
                            // Dings and Carson Yates).
                            const pcn = String(c.id).replace(/-/g, '').slice(0, 20)
                            return (
                              <a
                                href={`https://portal.stedi.com/app/healthcare/claims/${pcn}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-1 text-[11px] text-[#DC2626] hover:underline font-medium"
                                title="Opens this claim's 277 acknowledgment directly in the Stedi portal.">
                                View 277 in Stedi <ExternalLink size={10} />
                              </a>
                            )
                          })()}
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
            )
          })()}
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

      {/* Reopen modal — categorized reason + required note. Replaces
          the old one-click Reopen that was silently mutating state. */}
      {reopenTarget && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onClick={() => !reopenSubmitting && setReopenTarget(null)}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-6" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <RefreshCw size={18} className="text-[#4C1D95]" />
                <h2 className="font-display text-[16px] font-medium text-[#1A1A2E]">Reopen claim for correction</h2>
              </div>
              <button onClick={() => !reopenSubmitting && setReopenTarget(null)} className="text-[#1A1A2E]/60 hover:text-[#1A1A2E]"><X size={16} /></button>
            </div>
            <div className="text-[12px] text-[#1A1A2E] mb-3 bg-[#FAFAF8] border border-[#E8E8E4] rounded-lg p-2.5">
              <div className="font-medium">
                {[(reopenTarget.child_first_name ?? reopenTarget.patient_first_name), (reopenTarget.child_last_name ?? reopenTarget.patient_last_name)].filter(Boolean).join(' ')}
              </div>
              <div className="text-[#555] mt-0.5">
                {reopenTarget.payer_name} · {fmtDate(reopenTarget.service_date)} · {fmtMoney(reopenTarget.total_charge)}
              </div>
            </div>
            <p className="text-[12px] text-[#4C1D95] mb-3 leading-relaxed">
              Moves this claim back to <strong>Pending Review</strong> so you can correct the fields and resubmit it. The claim's submitted_at and Stedi response stay on record for audit — resubmitting later stamps a new submission on top.
            </p>
            <div className="space-y-3">
              <div>
                <label className="text-[11px] text-[#555] block mb-1">Reason</label>
                <select
                  className="w-full px-2.5 py-1.5 border border-[#E8E8E4] rounded-lg text-[13px] outline-none focus:border-[#7F77DD] bg-white"
                  value={reopenReason}
                  onChange={e => setReopenReason(e.target.value)}
                  disabled={reopenSubmitting}>
                  {Object.entries(REOPEN_REASON_LABELS).map(([k, v]) => (
                    <option key={k} value={k}>{v}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-[11px] text-[#555] block mb-1">Note (required — minimum {REOPEN_NOTE_MIN} characters)</label>
                <textarea
                  className="w-full px-2.5 py-1.5 border border-[#E8E8E4] rounded-lg text-[13px] outline-none focus:border-[#7F77DD] bg-white min-h-[70px]"
                  value={reopenNote}
                  onChange={e => setReopenNote(e.target.value)}
                  disabled={reopenSubmitting}
                  placeholder="e.g. UHC denial CO-16 M62 — wrong dx pointer on 99213; fixing pointer + resubmitting" />
                <div className="text-[10px] text-[#555] mt-1 text-right">{reopenNote.trim().length} / {REOPEN_NOTE_MIN}</div>
              </div>
              {reopenError && (
                <div className="text-[12px] text-[#991B1B] bg-[#FCEBEB] border border-[#F5C6C6] px-2.5 py-1.5 rounded-lg">{reopenError}</div>
              )}
            </div>
            <div className="flex justify-end gap-2 mt-5">
              <Button variant="secondary" size="sm" onClick={() => setReopenTarget(null)} disabled={reopenSubmitting}>Cancel</Button>
              <Button
                variant="teal"
                size="sm"
                loading={reopenSubmitting}
                disabled={reopenNote.trim().length < REOPEN_NOTE_MIN}
                onClick={confirmReopen}>
                Reopen &amp; move to Pending Review
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Attach 277 (paste X12) — retroactive rejection attachment.
          For 277s that came in before the webhook processed them. */}
      {attach277Target && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onClick={() => !attach277Submitting && setAttach277Target(null)}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[85vh] overflow-hidden flex flex-col" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between p-4 border-b border-[#E8E8E4]">
              <div className="flex items-center gap-2">
                <AlertOctagon size={18} className="text-[#7F1D1D]" />
                <h2 className="font-display text-[16px] font-medium text-[#1A1A2E]">Attach 277 rejection (paste X12)</h2>
              </div>
              <button onClick={() => !attach277Submitting && setAttach277Target(null)} className="text-[#1A1A2E]/60 hover:text-[#1A1A2E]"><X size={16} /></button>
            </div>
            <div className="p-4 overflow-auto space-y-3">
              <div className="text-[12px] text-[#1A1A2E] bg-[#FAFAF8] border border-[#E8E8E4] rounded-lg p-2.5">
                <div className="font-medium">
                  {[(attach277Target.child_first_name ?? attach277Target.patient_first_name), (attach277Target.child_last_name ?? attach277Target.patient_last_name)].filter(Boolean).join(' ')}
                </div>
                <div className="text-[#555] mt-0.5">
                  {attach277Target.payer_name} · {fmtDate(attach277Target.service_date)} · {fmtMoney(attach277Target.total_charge)}
                </div>
              </div>
              <div className="text-[12px] text-[#555] leading-relaxed">
                <strong>How to get the X12:</strong> Open this claim in the Stedi portal → click the <strong>X12</strong> tab (top-right of the Acknowledgment page) → copy the whole ISA...IEA block → paste below.
              </div>
              <label className="text-[11px] text-[#555] block">Raw 277 X12</label>
              <textarea
                className="w-full px-2.5 py-2 border border-[#E8E8E4] rounded-lg text-[11px] font-mono outline-none focus:border-[#7F77DD] bg-white min-h-[200px]"
                value={attach277Text}
                onChange={e => setAttach277Text(e.target.value)}
                disabled={attach277Submitting}
                placeholder="ISA*00*          *00*          *ZZ*STEDI          *ZZ*..." />
              {attach277Error && (
                <div className="text-[12px] text-[#991B1B] bg-[#FCEBEB] border border-[#F5C6C6] px-2.5 py-1.5 rounded-lg">{attach277Error}</div>
              )}
            </div>
            <div className="flex justify-end gap-2 p-4 border-t border-[#E8E8E4]">
              <Button variant="secondary" size="sm" onClick={() => setAttach277Target(null)} disabled={attach277Submitting}>Cancel</Button>
              <Button
                variant="teal"
                size="sm"
                loading={attach277Submitting}
                disabled={attach277Text.trim().length < 50}
                onClick={async () => {
                  setAttach277Submitting(true)
                  setAttach277Error(null)
                  try {
                    await attach277X12({ claim_id: attach277Target.id, x12_text: attach277Text.trim() })
                    await load()
                    setAttach277Target(null)
                    setAttach277Text('')
                  } catch (err: any) {
                    setAttach277Error(err?.message ?? 'Failed to attach 277')
                  } finally {
                    setAttach277Submitting(false)
                  }
                }}>
                Attach rejection
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Inspect unmatched ERAs — diagnostic result modal.
          Shows per-transaction: payer, patient name (from the 835),
          the PCN the payer echoed back, the payer's claim control
          number, service dates, dollar amounts. Compare the PCN to
          the expected PCN (claim UUID with dashes stripped) to see
          why findClaim() missed the match. */}
      {inspectResult && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onClick={() => setInspectResult(null)}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-4xl max-h-[85vh] overflow-hidden flex flex-col" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between p-4 border-b border-[#E8E8E4]">
              <div className="flex items-center gap-2">
                <Search size={18} className="text-[#4C1D95]" />
                <h2 className="font-display text-[16px] font-medium text-[#1A1A2E]">Unmatched ERAs (last {inspectResult.days ?? 60}d)</h2>
              </div>
              <button onClick={() => setInspectResult(null)} className="text-[#1A1A2E]/60 hover:text-[#1A1A2E]"><X size={16} /></button>
            </div>
            <div className="overflow-auto p-4 space-y-3">
              {inspectResult.error && (
                <div className="text-[13px] text-[#991B1B] bg-[#FCEBEB] border border-[#F5C6C6] p-3 rounded-lg">{inspectResult.error}</div>
              )}
              {inspectResult.results?.length === 0 && (
                <div className="text-[13px] text-[#1A1A2E] text-center py-8">No unmatched ERAs in the window — everything matched to a claim.</div>
              )}
              {(inspectResult.results ?? []).map((r: any, i: number) => (
                <div key={r.transaction_id ?? i} className="border border-[#E8E8E4] rounded-xl p-3 bg-[#FAFAF8] text-[12px]">
                  <div className="flex items-center justify-between mb-2">
                    <div className="font-mono text-[11px] text-[#555]">tx {r.transaction_id}</div>
                    <div className="text-[10px] text-[#555]">
                      {r.source} · {r.processed_at ? new Date(r.processed_at).toLocaleString() : '—'}
                    </div>
                  </div>
                  {r.error ? (
                    <div className="text-[12px] text-[#991B1B]">Error fetching: {r.error}</div>
                  ) : (
                    <>
                      <div className="mb-2"><span className="text-[#555]">Payer:</span> <span className="font-medium">{r.payer_name ?? '—'}</span></div>
                      {(r.claims ?? []).map((cl: any, j: number) => (
                        <div key={j} className="bg-white border border-[#E8E8E4] rounded-lg p-2.5 mb-2 space-y-1">
                          <div><span className="text-[#555]">Patient:</span> <span className="font-medium">{[cl.patient_first, cl.patient_last].filter(Boolean).join(' ') || '—'}</span></div>
                          <div><span className="text-[#555]">Patient control # (returned):</span> <span className="font-mono text-[11px]">{cl.patient_control_number ?? '—'}</span></div>
                          <div><span className="text-[#555]">Payer claim control #:</span> <span className="font-mono text-[11px]">{cl.payer_claim_control_number ?? '—'}</span></div>
                          <div><span className="text-[#555]">Service date(s):</span> <span>{(cl.service_dates ?? []).join(', ') || '—'}</span></div>
                          <div><span className="text-[#555]">Charge:</span> <span>${cl.total_claim_charge ?? '—'}</span> · <span className="text-[#555]">Paid:</span> <span>${cl.insurance_payment ?? '—'}</span></div>
                          <div><span className="text-[#555]">Claim status code:</span> <span className="font-mono text-[11px]">{cl.claim_status_code ?? '—'}</span></div>
                        </div>
                      ))}
                    </>
                  )}
                </div>
              ))}
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
    // If no pointers have been explicitly saved yet, default the draft
    // to "all diagnoses checked" (up to the X12 max of 4). Sara asked
    // for this on 2026-09-23 — previously the popover opened empty and
    // the biller had to check them all manually. Once she saves an
    // explicit set, re-opening shows those saved picks unchanged.
    const initialDraft = pointers.length > 0
      ? pointers
      : Array.from({ length: Math.min(diagnoses.length, 4) }, (_, i) => i + 1)
    setDraft(initialDraft)
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
