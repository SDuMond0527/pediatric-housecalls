import { useEffect, useState } from 'react'
import { format } from 'date-fns'
import { X, Download, AlertOctagon, CheckCircle2, ChevronDown, ChevronUp, Pencil } from 'lucide-react'
import { Button } from '../../components/ui/Button'
import {
  getPatientStatement,
  createPatientStatement,
  updatePatientStatement,
  sendPatientStatement,
  pullStediEra,
  markPatientStatementPaid,
  writeOffPatientStatement,
  markClaimDenialHandled,
  type WriteOffReason,
} from '../../lib/api'
import { CARC_CODES, RARC_CODES, detectErraOutcome, outcomeLabel } from '../../lib/carcCodes'
import { ChartNumberPill } from '../../components/ChartNumberPill'

const WRITE_OFF_LABELS: Record<WriteOffReason, string> = {
  bad_debt:       'Bad debt (family will not pay)',
  small_balance:  'Small balance (not worth collecting)',
  hardship:       'Courtesy / hardship (patient can\'t pay)',
  billing_error:  'Billing error (our mistake)',
  timely_filing:  'Timely filing exceeded',
  other:          'Other',
}

interface Props {
  claim: any
  onClose: () => void
  onSent: () => void
}


function fmtDate(d: string | null | undefined) {
  if (!d) return '—'
  try {
    const s = String(d).split('T')[0]
    const [y, m, day] = s.split('-').map(Number)
    return format(new Date(y, m - 1, day), 'MMM d, yyyy')
  } catch { return d ?? '—' }
}

export function PatientStatementModal({ claim, onClose, onSent }: Props) {
  const [statement, setStatement] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [sending, setSending] = useState(false)
  const [pullingEra, setPullingEra] = useState(false)
  const [editing, setEditing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Contact fields
  const [familyEmail, setFamilyEmail] = useState('')
  const [familyPhone, setFamilyPhone] = useState('')
  const [patientEmail, setPatientEmail] = useState('')
  const [patientPhone, setPatientPhone] = useState('')

  // Financial fields
  const [amountBilled, setAmountBilled] = useState('')
  const [insurancePayment, setInsurancePayment] = useState('')
  const [contractualAdjustment, setContractualAdjustment] = useState('')
  const [patientCopay, setPatientCopay] = useState('')
  const [patientDeductible, setPatientDeductible] = useState('')
  const [patientCoinsurance, setPatientCoinsurance] = useState('')
  const [patientNonCovered, setPatientNonCovered] = useState('')
  const [remainingBalance, setRemainingBalance] = useState('')
  const [priorBalance, setPriorBalance] = useState('')
  const [totalAmountDue, setTotalAmountDue] = useState('')

  // "Record a payment" (manual mark-paid) — used by the biller when they
  // run the card in Square outside the portal per the practice's
  // "auto-charge card on file after 2 weeks" policy. Not shown until
  // the biller clicks "Record payment" on a sent statement.
  const [recordingPayment, setRecordingPayment] = useState(false)
  const [markingPaid, setMarkingPaid] = useState(false)
  const [paidAmount, setPaidAmount] = useState('')
  const [paidDate, setPaidDate] = useState('')
  const [paidMethod, setPaidMethod] = useState('Card on file (Square)')
  const [paidNote, setPaidNote] = useState('')

  // Write-off flow — same "small inline form" pattern as record-payment.
  // Reason is required; note optional. Never shown on paid statements.
  const [writingOff, setWritingOff]     = useState(false)
  const [writeOffReason, setWriteOffReason] = useState<WriteOffReason>('bad_debt')
  const [writeOffNote, setWriteOffNote] = useState('')
  const [savingWriteOff, setSavingWriteOff] = useState(false)

  // Denial-handling state — after Pam clicks "Mark as being handled by
  // biller" and saves a note, we stamp locally so the UI flips from
  // flashing alert → compact "handled" strip without a round-trip
  // refetch. Notes editable so she can update as she works the
  // resolution (fax records, call payer, etc.). Sara 2026-09-17.
  const [handledAt, setHandledAt] = useState<string | null>(claim.denial_handled_at ?? null)
  const [handledByName, setHandledByName] = useState<string | null>(claim.denial_handled_by_name ?? null)
  const [handlingNotesSaved, setHandlingNotesSaved] = useState<string>(claim.denial_handling_notes ?? '')
  const [handlingOpen, setHandlingOpen] = useState(false)  // inline notes form
  const [handlingNotes, setHandlingNotes] = useState('')   // draft in form
  const [handlingSaving, setHandlingSaving] = useState(false)
  const [handledExpanded, setHandledExpanded] = useState(false)  // strip open/collapsed

  async function submitHandling() {
    if (!handlingNotes.trim()) return
    setHandlingSaving(true)
    setError(null)
    try {
      const updated = await markClaimDenialHandled(claim.id, handlingNotes.trim())
      setHandledAt(updated.denial_handled_at)
      setHandledByName(updated.denial_handled_by_name)
      setHandlingNotesSaved(updated.denial_handling_notes)
      setHandlingOpen(false)
      setHandlingNotes('')
      onSent()
    } catch (e: any) {
      setError(e?.message ?? 'Failed to save handling note')
    } finally {
      setHandlingSaving(false)
    }
  }

  // One-click "No patient responsibility" — for cases where the ERA came
  // back showing the payer covers everything (either fully paid by
  // insurance or 100% contractual write-off), so the family owes $0.
  // Flips the statement to paid at $0 without needing to enter amounts.
  const [markingNoResp, setMarkingNoResp] = useState(false)
  async function markNoPatientResponsibility() {
    if (!statement) return
    if (!window.confirm('Mark this statement as $0 owed by the patient? This flips it to paid. Use this when the payer covers the full amount or the whole claim is a contractual adjustment.')) return
    setMarkingNoResp(true)
    setError(null)
    try {
      const saved = await markPatientStatementPaid(statement.id, {
        amount_paid: 0,
        payment_method: 'No patient responsibility',
        payment_note: 'Insurance covered fully or contractual adjustment — nothing owed by patient.',
      })
      setStatement(saved)
      populateFromStatement(saved)
      onSent()
    } catch (e: any) {
      setError(e?.message ?? 'Failed to mark as no patient responsibility')
    } finally {
      setMarkingNoResp(false)
    }
  }

  async function submitWriteOff() {
    if (!statement) return
    setSavingWriteOff(true)
    setError(null)
    try {
      const result = await writeOffPatientStatement(statement.id, { reason: writeOffReason, note: writeOffNote })
      const saved = (result as any)?.statement ?? result
      setStatement(saved)
      populateFromStatement(saved)
      setWritingOff(false)
      setWriteOffNote('')
      onSent()
      if ((result as any)?.action === 'pending') {
        alert('Write-off request submitted. It will commit once the practice owner approves it.')
      }
    } catch (e: any) {
      setError(e?.message ?? 'Failed to write off statement')
    } finally {
      setSavingWriteOff(false)
    }
  }


  useEffect(() => {
    async function load() {
      setLoading(true)
      try {
        const stmt = await getPatientStatement(claim.id)
        if (stmt) {
          setStatement(stmt)
          // If the saved statement is missing contact info, backfill from family profile
          const resolvedEmail = stmt.patient_email || claim.family_email || ''
          const resolvedPhone = stmt.patient_phone || stmt.family_phone || claim.family_phone || ''
          populateFromStatement({ ...stmt, patient_email: resolvedEmail, patient_phone: resolvedPhone, family_phone: resolvedPhone })
        } else {
          // No statement yet — pre-fill contact from family profile
          if (claim.family_email) setPatientEmail(claim.family_email)
          if (claim.family_phone) setPatientPhone(claim.family_phone)
          // Auto-compute total from CPT code charge amounts
          const computed = cptTotal(claim.cpt_codes ?? [])
          if (computed > 0) { setAmountBilled(String(computed)); setTotalAmountDue(String(computed)) }
          // Pre-fill financial fields from ERA if already received (overrides CPT total)
          if (claim.era_received_at) {
            if (claim.amount_billed_era != null)        setAmountBilled(String(claim.amount_billed_era))
            if (claim.insurance_payment_era != null)    setInsurancePayment(String(claim.insurance_payment_era))
            if (claim.contractual_adjustment_era != null) setContractualAdjustment(String(claim.contractual_adjustment_era))
            if (claim.patient_copay_era != null)        setPatientCopay(String(claim.patient_copay_era))
            if (claim.patient_deductible_era != null)   setPatientDeductible(String(claim.patient_deductible_era))
            if (claim.patient_coinsurance_era != null)  setPatientCoinsurance(String(claim.patient_coinsurance_era))
            if (claim.patient_non_covered_era != null)  setPatientNonCovered(String(claim.patient_non_covered_era))
          }
          setEditing(true)
        }
      } catch (e: any) {
        setError(e.message ?? 'Failed to load statement')
      } finally {
        setLoading(false)
      }
    }
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [claim.id])

  function cptTotal(cptCodes: any[]): number {
    return (cptCodes ?? []).reduce((sum: number, c: any) => {
      const charge = c.charge_amount != null ? parseFloat(String(c.charge_amount)) : 0
      const units = c.units != null ? parseInt(String(c.units), 10) || 1 : 1
      return sum + charge * units
    }, 0)
  }

  function populateFromStatement(stmt: any) {
    const fe = stmt.family_email ?? ''
    const fp = stmt.family_phone ?? ''
    setFamilyEmail(fe)
    setFamilyPhone(fp)
    setPatientEmail(stmt.patient_email ?? fe)
    setPatientPhone(stmt.patient_phone ?? fp)
    setInsurancePayment(stmt.insurance_payment ?? '')
    setContractualAdjustment(stmt.contractual_adjustment ?? '')
    setPatientCopay(stmt.patient_copay ?? '')
    setPatientDeductible(stmt.patient_deductible ?? '')
    setPatientCoinsurance(stmt.patient_coinsurance ?? '')
    setPatientNonCovered(stmt.patient_non_covered ?? '')
    setRemainingBalance(stmt.remaining_balance ?? '')
    setPriorBalance(stmt.prior_balance ?? '')
    // Auto-compute from CPT codes ONLY when the statement never had
    // an explicit value (server returned null/undefined). If the
    // biller explicitly saved a 0 — e.g., the whole claim was zeroed
    // out by contractual adjustment and there's nothing owed —
    // treating 0 as "empty" and falling back to the CPT total made
    // the save appear to revert. Trust an explicit 0. Sara DuMond
    // 2026-09-15.
    const computed = cptTotal(claim.cpt_codes ?? stmt.cpt_codes)
    setAmountBilled(
      stmt.amount_billed != null ? String(stmt.amount_billed)
      : computed > 0 ? String(computed)
      : ''
    )
    setTotalAmountDue(
      stmt.total_amount_due != null ? String(stmt.total_amount_due)
      : computed > 0 ? String(computed)
      : ''
    )
  }

  function buildPayload() {
    return {
      claim_id: claim.id,
      patient_first_name: claim.patient_first_name ?? claim.child_first_name ?? '',
      patient_last_name: claim.patient_last_name ?? claim.child_last_name ?? '',
      patient_dob: claim.patient_dob ?? '',
      date_of_service: claim.service_date ?? '',
      cpt_codes: claim.cpt_codes ?? [],
      patient_email: patientEmail,
      patient_phone: patientPhone,
      amount_billed: amountBilled,
      insurance_payment: insurancePayment,
      contractual_adjustment: contractualAdjustment,
      patient_copay: patientCopay,
      patient_deductible: patientDeductible,
      patient_coinsurance: patientCoinsurance,
      patient_non_covered: patientNonCovered,
      remaining_balance: remainingBalance,
      prior_balance: priorBalance,
      total_amount_due: totalAmountDue,
    }
  }

  async function handleSave() {
    setSaving(true)
    setError(null)
    try {
      const payload = buildPayload()
      let saved: any
      if (statement) {
        saved = await updatePatientStatement(statement.id, payload)
      } else {
        saved = await createPatientStatement(payload)
      }
      setStatement(saved)
      populateFromStatement(saved)
      setEditing(false)
    } catch (e: any) {
      setError(e.message ?? 'Failed to save statement')
    } finally {
      setSaving(false)
    }
  }

  async function handleSend() {
    if (!statement) return
    setSending(true)
    setError(null)
    try {
      await sendPatientStatement(statement.id)
      onSent()
    } catch (e: any) {
      setError(e.message ?? 'Failed to send statement')
      setSending(false)
    }
  }

  function openRecordPayment() {
    // Default paid amount to the balance we're expecting (total_amount_due).
    // Default paid date to today. Biller can override either.
    setPaidAmount(totalAmountDue || amountBilled || '')
    setPaidDate(new Date().toISOString().slice(0, 10))
    setPaidMethod('Card on file (Square)')
    setPaidNote('')
    setRecordingPayment(true)
    setError(null)
  }

  async function submitRecordPayment() {
    if (!statement) return
    setMarkingPaid(true)
    setError(null)
    try {
      const saved = await markPatientStatementPaid(statement.id, {
        amount_paid: paidAmount,
        paid_at: paidDate ? new Date(paidDate + 'T12:00:00').toISOString() : undefined,
        payment_method: paidMethod,
        payment_note: paidNote,
      })
      setStatement(saved)
      populateFromStatement(saved)
      setRecordingPayment(false)
      onSent()
    } catch (e: any) {
      setError(e?.message ?? 'Failed to record payment')
    } finally {
      setMarkingPaid(false)
    }
  }

  async function handlePullEra() {
    if (!claim.stedi_claim_id) return
    setPullingEra(true)
    setError(null)
    try {
      const era = await pullStediEra(claim.id)
      if (!era.available) {
        setError(era.message ?? 'ERA not yet available')
        return
      }
      // Pre-fill financial fields from ERA
      if (era.amount_billed != null) setAmountBilled(String(era.amount_billed))
      if (era.insurance_payment != null) setInsurancePayment(String(era.insurance_payment))
      if (era.contractual_adjustment != null) setContractualAdjustment(String(era.contractual_adjustment))
      if (era.patient_copay != null) setPatientCopay(String(era.patient_copay))
      if (era.patient_deductible != null) setPatientDeductible(String(era.patient_deductible))
      if (era.patient_coinsurance != null) setPatientCoinsurance(String(era.patient_coinsurance))
      if (era.patient_non_covered != null) setPatientNonCovered(String(era.patient_non_covered))
    } catch (e: any) {
      setError(e.message ?? 'Failed to pull ERA')
    } finally {
      setPullingEra(false)
    }
  }


  const isSent = statement?.status === 'sent'
  const canSend = !!(patientEmail || patientPhone)
  const patientName = [claim.patient_first_name ?? claim.child_first_name, claim.patient_last_name ?? claim.child_last_name].filter(Boolean).join(' ') || 'Unknown patient'

  const inputCls = 'w-full px-2.5 py-1.5 border border-[#E8E8E4] rounded-lg text-[13px] outline-none focus:border-[#7F77DD] bg-white'
  const labelCls = 'text-[11px] text-[#555] block mb-1'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-2xl flex flex-col max-h-[90vh]">

        {/* Header */}
        <div className="flex items-start justify-between px-6 py-4 border-b border-[#E8E8E4] flex-shrink-0">
          <div>
            <h2 className="text-[17px] font-semibold text-[#1A1A2E]">Patient Statement</h2>
            <p className="text-[12px] text-[#1A1A2E] mt-0.5 flex items-center gap-2">
              <span>{patientName}</span>
              <ChartNumberPill value={claim.chart_number} />
              <span>&bull; DOS: {fmtDate(claim.service_date)}</span>
            </p>
          </div>
          <div className="flex items-center gap-3">
            {isSent && (
              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold bg-[#E1F5EE] text-[#085041]">
                Sent {statement.sent_at ? fmtDate(statement.sent_at) : ''}
              </span>
            )}
            <button onClick={onClose} className="text-[#1A1A2E] hover:text-[#555] transition-colors">
              <X size={18} />
            </button>
          </div>
        </div>

        {/* Scrollable body */}
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6">
          {(() => {
            const outcome = detectErraOutcome(claim.denial_codes)
            if (outcome.status === 'clean') return null
            const cas: Array<{ group_code: string; reason_code: string; amount: number }> = claim.denial_codes ?? []
            const remarks: string[] = claim.remark_codes ?? []

            // Handled state — flashing alert is replaced by a compact
            // green strip once biller acknowledges + records what she did.
            // Notes stay visible for anyone to expand and read.
            if (handledAt) {
              return (
                <div className="rounded-xl border-2 border-[#059669] bg-[#ECFDF5] px-4 py-3">
                  <button
                    onClick={() => setHandledExpanded(v => !v)}
                    className="w-full flex items-center gap-2 text-left">
                    <CheckCircle2 size={16} className="text-[#065F46] flex-shrink-0" />
                    <div className="flex-1 min-w-0 text-[12px] text-[#065F46]">
                      <span className="font-bold uppercase tracking-wide">Being handled by biller</span>
                      {handledByName && <span className="ml-2 font-medium">· {handledByName}</span>}
                      {handledAt && <span className="ml-2 opacity-75">· {format(new Date(handledAt), 'MMM d, yyyy h:mm a')}</span>}
                    </div>
                    {handledExpanded
                      ? <ChevronUp size={14} className="text-[#065F46]" />
                      : <ChevronDown size={14} className="text-[#065F46]" />}
                  </button>
                  {handledExpanded && (
                    <div className="mt-3 pt-3 border-t border-[#A7F3D0]">
                      <div className="text-[11px] font-semibold text-[#065F46] uppercase tracking-wider mb-1">Notes</div>
                      <div className="text-[13px] text-[#064E3B] whitespace-pre-wrap leading-relaxed">
                        {handlingNotesSaved || '(no notes recorded)'}
                      </div>
                      <div className="mt-3 pt-3 border-t border-[#A7F3D0] text-[11px] text-[#065F46] opacity-75">
                        Original payer response:
                        <div className="mt-1 space-y-0.5 text-[11px]">
                          {cas.filter(c => {
                            if (c.group_code === 'PR') return false
                            if (c.group_code === 'CO' && new Set(['45','97','24','131','137']).has(c.reason_code)) return false
                            return true
                          }).map((c, i) => (
                            <div key={`${c.group_code}-${c.reason_code}-${i}`}>
                              <span className="font-mono font-semibold">{c.group_code}-{c.reason_code}</span>
                              <span className="ml-2">{CARC_CODES[c.reason_code]?.description ?? '(unknown code)'}</span>
                            </div>
                          ))}
                          {remarks.map(code => (
                            <div key={code}>
                              <span className="font-mono font-semibold">{code}</span>
                              <span className="ml-2">{RARC_CODES[code] ?? '(unknown remark code)'}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                      <button
                        onClick={() => {
                          setHandlingNotes(handlingNotesSaved)
                          setHandlingOpen(true)
                        }}
                        className="mt-3 inline-flex items-center gap-1 text-[11px] text-[#065F46] font-semibold hover:underline">
                        <Pencil size={11} /> Edit / update notes
                      </button>
                    </div>
                  )}
                  {/* Edit form — same textarea style as the initial "mark as
                      handled" flow, just pre-populated with saved notes. */}
                  {handlingOpen && (
                    <div className="mt-3 pt-3 border-t border-[#A7F3D0]">
                      <label className="text-[11px] font-semibold text-[#065F46] uppercase tracking-wider block mb-1">
                        Update notes
                      </label>
                      <textarea
                        value={handlingNotes}
                        onChange={e => setHandlingNotes(e.target.value)}
                        rows={4}
                        placeholder="What did you do next?"
                        className="w-full px-2.5 py-2 border border-[#065F46] rounded-lg text-[13px] outline-none focus:ring-2 focus:ring-[#059669]/30 bg-white"
                      />
                      <div className="mt-2 flex gap-2 justify-end">
                        <button
                          onClick={() => { setHandlingOpen(false); setHandlingNotes('') }}
                          disabled={handlingSaving}
                          className="px-3 py-1.5 text-[12px] text-[#065F46] border border-[#065F46] rounded-lg hover:bg-white transition-colors disabled:opacity-50">
                          Cancel
                        </button>
                        <button
                          onClick={submitHandling}
                          disabled={handlingSaving || !handlingNotes.trim()}
                          className="px-3 py-1.5 text-[12px] text-white bg-[#065F46] rounded-lg hover:bg-[#064E3B] transition-colors disabled:opacity-50">
                          {handlingSaving ? 'Saving…' : 'Save notes'}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )
            }

            // Not yet handled — flashing red / amber alert.
            const isDoc = outcome.status === 'documentation_needed'
            const bannerBg = isDoc ? 'bg-[#FEF3C7] border-[#F59E0B]' : 'bg-[#FEE2E2] border-[#DC2626]'
            const bannerText = isDoc ? 'text-[#78350F]' : 'text-[#7F1D1D]'
            const pulseColor = isDoc ? 'bg-[#F59E0B]' : 'bg-[#DC2626]'
            return (
              <div className={`rounded-xl border-2 p-4 ${bannerBg} ${bannerText}`}>
                <div className="flex items-center gap-2 mb-2">
                  <span className={`relative inline-flex h-3 w-3`}>
                    <span className={`animate-ping absolute inline-flex h-full w-full rounded-full ${pulseColor} opacity-75`}></span>
                    <span className={`relative inline-flex rounded-full h-3 w-3 ${pulseColor}`}></span>
                  </span>
                  <AlertOctagon size={16} />
                  <div className="text-[13px] font-bold uppercase tracking-wide">
                    {outcomeLabel(outcome.status)}
                  </div>
                </div>
                <div className="text-[12px] leading-relaxed">
                  {isDoc
                    ? 'Payer has NOT paid this claim — they need documentation. Do not send this statement to the family. Gather the items below, then resubmit with attachments.'
                    : outcome.status === 'partial_denial'
                      ? 'Payer paid part of this claim and denied the rest. Review the reason codes before sending.'
                      : 'Payer denied this claim. Review the reason codes and either resubmit corrected or bill the family per practice policy.'}
                </div>
                {cas.filter(c => {
                  if (c.group_code === 'PR') return false
                  if (c.group_code === 'CO' && new Set(['45','97','24','131','137']).has(c.reason_code)) return false
                  return true
                }).length > 0 && (
                  <div className="mt-3 space-y-1">
                    <div className="text-[11px] font-semibold uppercase opacity-75">Reason codes</div>
                    {cas.filter(c => {
                      if (c.group_code === 'PR') return false
                      if (c.group_code === 'CO' && new Set(['45','97','24','131','137']).has(c.reason_code)) return false
                      return true
                    }).map((c, i) => (
                      <div key={`${c.group_code}-${c.reason_code}-${i}`} className="text-[12px]">
                        <span className="font-mono font-semibold">{c.group_code}-{c.reason_code}</span>
                        {c.amount ? <span className="ml-2 opacity-75">${Math.abs(c.amount).toFixed(2)}</span> : null}
                        <span className="ml-2">
                          {CARC_CODES[c.reason_code]?.description ?? '(unknown code — look up in payer portal)'}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
                {remarks.length > 0 && (
                  <div className="mt-3 space-y-1">
                    <div className="text-[11px] font-semibold uppercase opacity-75">Payer remarks (what to send)</div>
                    {remarks.map(code => (
                      <div key={code} className="text-[12px]">
                        <span className="font-mono font-semibold">{code}</span>
                        <span className="ml-2">{RARC_CODES[code] ?? '(unknown remark code — look up in payer portal)'}</span>
                      </div>
                    ))}
                  </div>
                )}

                {/* Mark-as-handled control — either the button OR the inline
                    notes textarea, never both. Extracted here so it's the
                    last thing the biller sees inside the alert. */}
                <div className="mt-4 pt-3 border-t border-current opacity-100">
                  {handlingOpen ? (
                    <div>
                      <label className={`text-[11px] font-semibold uppercase tracking-wider block mb-1 ${bannerText}`}>
                        What are you doing / have you done about this?
                      </label>
                      <textarea
                        value={handlingNotes}
                        onChange={e => setHandlingNotes(e.target.value)}
                        rows={4}
                        placeholder={`e.g. "Faxed patient medical records to Aetna 9/17. Awaiting reprocessing."`}
                        className={`w-full px-2.5 py-2 border-2 rounded-lg text-[13px] outline-none focus:ring-2 bg-white ${
                          isDoc ? 'border-[#F59E0B] focus:ring-[#F59E0B]/30' : 'border-[#DC2626] focus:ring-[#DC2626]/30'
                        }`}
                        autoFocus
                      />
                      <div className="mt-2 flex gap-2 justify-end">
                        <button
                          onClick={() => { setHandlingOpen(false); setHandlingNotes('') }}
                          disabled={handlingSaving}
                          className={`px-3 py-1.5 text-[12px] font-medium border-2 rounded-lg hover:bg-white transition-colors disabled:opacity-50 ${
                            isDoc ? 'border-[#B45309] text-[#78350F]' : 'border-[#B91C1C] text-[#7F1D1D]'
                          }`}>
                          Cancel
                        </button>
                        <button
                          onClick={submitHandling}
                          disabled={handlingSaving || !handlingNotes.trim()}
                          className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-semibold text-white rounded-lg transition-colors disabled:opacity-50 ${
                            isDoc ? 'bg-[#B45309] hover:bg-[#78350F]' : 'bg-[#B91C1C] hover:bg-[#7F1D1D]'
                          }`}>
                          {handlingSaving ? 'Saving…' : <><CheckCircle2 size={12} /> Save + mark handled</>}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button
                      onClick={() => { setHandlingOpen(true); setHandlingNotes('') }}
                      className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-semibold text-white rounded-lg transition-colors ${
                        isDoc ? 'bg-[#B45309] hover:bg-[#78350F]' : 'bg-[#B91C1C] hover:bg-[#7F1D1D]'
                      }`}>
                      <CheckCircle2 size={12} /> Mark as being handled by biller
                    </button>
                  )}
                </div>
              </div>
            )
          })()}
          {loading ? (
            <div className="py-12 text-center text-[13px] text-[#1A1A2E]">Loading…</div>
          ) : (
            <>
              {/* Section 1: Patient Contact */}
              <div>
                <div className="text-[11px] font-semibold text-[#1A1A2E] uppercase tracking-wider mb-3">Patient Contact</div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className={labelCls}>
                      Email {familyEmail && patientEmail !== familyEmail && (
                        <span className="text-[#7F77DD] cursor-pointer hover:underline ml-1" onClick={() => setPatientEmail(familyEmail)}>
                          use family: {familyEmail}
                        </span>
                      )}
                    </label>
                    <input
                      type="email"
                      className={inputCls}
                      value={patientEmail}
                      onChange={e => setPatientEmail(e.target.value)}
                      placeholder={familyEmail || 'patient@example.com'}
                      disabled={!editing && !!statement}
                    />
                  </div>
                  <div>
                    <label className={labelCls}>
                      Phone {familyPhone && patientPhone !== familyPhone && (
                        <span className="text-[#7F77DD] cursor-pointer hover:underline ml-1" onClick={() => setPatientPhone(familyPhone)}>
                          use family: {familyPhone}
                        </span>
                      )}
                    </label>
                    <input
                      type="tel"
                      className={inputCls}
                      value={patientPhone}
                      onChange={e => setPatientPhone(e.target.value)}
                      placeholder={familyPhone || '+1 (555) 000-0000'}
                      disabled={!editing && !!statement}
                    />
                  </div>
                </div>
              </div>

              {/* Section 2: Encounter Details */}
              <div>
                <div className="flex items-center justify-between mb-3">
                  <div className="text-[11px] font-semibold text-[#1A1A2E] uppercase tracking-wider">Encounter Details</div>
                  {claim.stedi_claim_id && (
                    <button
                      onClick={handlePullEra}
                      disabled={pullingEra}
                      className="inline-flex items-center gap-1.5 text-[11px] text-[#7F77DD] hover:underline disabled:opacity-50 disabled:cursor-not-allowed font-medium"
                    >
                      <Download size={11} />
                      {pullingEra
                        ? 'Pulling…'
                        : claim.era_received_at
                          ? 'Refresh ERA'
                          : 'Pull from Stedi ERA'}
                    </button>
                  )}
                </div>
                <div className="bg-[#FAFAF8] rounded-xl border border-[#E8E8E4] p-4 space-y-2">
                  <div className="grid grid-cols-3 gap-4 text-[13px]">
                    <div>
                      <span className="text-[#1A1A2E] text-[11px] block mb-0.5">Patient</span>
                      <span className="text-[#1A1A2E] font-medium">{patientName}</span>
                    </div>
                    <div>
                      <span className="text-[#1A1A2E] text-[11px] block mb-0.5">DOB</span>
                      <span className="text-[#1A1A2E]">{fmtDate(claim.patient_dob)}</span>
                    </div>
                    <div>
                      <span className="text-[#1A1A2E] text-[11px] block mb-0.5">Date of Service</span>
                      <span className="text-[#1A1A2E]">{fmtDate(claim.service_date)}</span>
                    </div>
                  </div>
                  {(claim.cpt_codes ?? []).length > 0 && (
                    <div className="pt-2 border-t border-[#E8E8E4]">
                      <span className="text-[#1A1A2E] text-[11px] block mb-1.5">CPT Codes</span>
                      <div className="space-y-1">
                        {(claim.cpt_codes ?? []).map((c: any) => (
                          <div key={c.code} className="flex items-center gap-2 text-[12px]">
                            <span className="font-semibold text-[#7F77DD] w-14 flex-shrink-0">{c.code}</span>
                            <span className="text-[#555] flex-1">{c.description}</span>
                            {c.charge_amount != null && (
                              <span className="text-[#1A1A2E] font-medium flex-shrink-0">${parseFloat(c.charge_amount).toFixed(2)}</span>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* Record-a-payment inline form — only shown while the biller
                  is filling out the manual payment record. Sits above the
                  financial summary so it's the first thing they see after
                  clicking "Record payment". */}
              {recordingPayment && (
                <div className="border border-[#1D9E75] rounded-xl p-4 bg-[#F0FDF4]">
                  <div className="flex items-center justify-between mb-3">
                    <div className="text-[13px] font-semibold text-[#1A7D5A] uppercase tracking-wider">
                      Record a payment
                    </div>
                    <button
                      onClick={() => { setRecordingPayment(false); setError(null) }}
                      className="text-[#1A7D5A] hover:text-[#0F5F44]">
                      <X size={14} />
                    </button>
                  </div>
                  <p className="text-[12px] text-[#0F5F44] mb-3">
                    Use this when you've run the card in Square (or received a check / cash) outside the portal.
                    Marks the statement as paid and stamps the amount + date.
                  </p>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className={labelCls}>Amount paid</label>
                      <div className="relative">
                        <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[#1A1A2E] text-[13px] pointer-events-none">$</span>
                        <input
                          type="text"
                          inputMode="decimal"
                          className={`${inputCls} pl-6`}
                          value={paidAmount}
                          onChange={e => setPaidAmount(e.target.value)}
                          placeholder="0.00"
                        />
                      </div>
                    </div>
                    <div>
                      <label className={labelCls}>Paid date</label>
                      <input
                        type="date"
                        className={inputCls}
                        value={paidDate}
                        onChange={e => setPaidDate(e.target.value)}
                      />
                    </div>
                    <div>
                      <label className={labelCls}>Payment method</label>
                      <select
                        className={inputCls}
                        value={paidMethod}
                        onChange={e => setPaidMethod(e.target.value)}>
                        <option value="Card on file (Square)">Card on file (Square)</option>
                        <option value="Card charged in Square">Card charged in Square</option>
                        <option value="Check">Check</option>
                        <option value="Cash">Cash</option>
                        <option value="Other">Other</option>
                      </select>
                    </div>
                    <div>
                      <label className={labelCls}>Reference / note (optional)</label>
                      <input
                        type="text"
                        className={inputCls}
                        value={paidNote}
                        onChange={e => setPaidNote(e.target.value)}
                        placeholder="Square receipt #, check #, etc."
                      />
                    </div>
                  </div>
                  <div className="flex justify-end gap-2 mt-4">
                    <Button variant="secondary" size="sm" onClick={() => { setRecordingPayment(false); setError(null) }}>
                      Cancel
                    </Button>
                    <Button variant="teal" size="sm" loading={markingPaid} onClick={submitRecordPayment}>
                      Mark as paid
                    </Button>
                  </div>
                </div>
              )}

              {/* Write-off inline form — same pattern as record-payment */}
              {writingOff && (
                <div className="border border-[#991B1B] rounded-xl p-4 bg-[#FCEBEB]">
                  <div className="flex items-center justify-between mb-3">
                    <div className="text-[13px] font-semibold text-[#991B1B] uppercase tracking-wider">
                      Write off this statement
                    </div>
                    <button
                      onClick={() => { setWritingOff(false); setError(null) }}
                      className="text-[#991B1B] hover:text-[#7A1414]">
                      <X size={14} />
                    </button>
                  </div>
                  <p className="text-[12px] text-[#7A1414] mb-3">
                    This clears the balance from AR and marks it as revenue leakage. Categorized by reason so
                    financial reports can distinguish bad debt from small balances / courtesy / billing errors.
                  </p>
                  <div className="space-y-3">
                    <div>
                      <label className={labelCls}>Reason</label>
                      <select
                        className={inputCls}
                        value={writeOffReason}
                        onChange={e => setWriteOffReason(e.target.value as WriteOffReason)}>
                        {(Object.entries(WRITE_OFF_LABELS) as [WriteOffReason, string][]).map(([k, v]) => (
                          <option key={k} value={k}>{v}</option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className={labelCls}>Note (optional — audit trail)</label>
                      <input
                        type="text"
                        className={inputCls}
                        value={writeOffNote}
                        onChange={e => setWriteOffNote(e.target.value)}
                        placeholder="e.g. Called 3x, family unresponsive"
                      />
                    </div>
                  </div>
                  <div className="flex justify-end gap-2 mt-4">
                    <Button variant="secondary" size="sm" onClick={() => { setWritingOff(false); setError(null) }}>
                      Cancel
                    </Button>
                    <Button variant="danger" size="sm" loading={savingWriteOff} onClick={submitWriteOff}>
                      Write off
                    </Button>
                  </div>
                </div>
              )}

              {/* Section 3: Financial Summary */}
              <div>
                <div className="text-[11px] font-semibold text-[#1A1A2E] uppercase tracking-wider mb-3">Financial Summary</div>
                <div className="grid grid-cols-2 gap-x-6 gap-y-3">
                  {[
                    { label: 'Amount Billed', value: amountBilled, set: setAmountBilled, prefix: true },
                    { label: 'Insurance Payment', value: insurancePayment, set: setInsurancePayment, prefix: true },
                    { label: 'Contractual Adjustment', value: contractualAdjustment, set: setContractualAdjustment, prefix: true },
                    { label: 'Patient Copay', value: patientCopay, set: setPatientCopay, prefix: true },
                    { label: 'Patient Deductible', value: patientDeductible, set: setPatientDeductible, prefix: true },
                    { label: 'Patient Coinsurance', value: patientCoinsurance, set: setPatientCoinsurance, prefix: true },
                    { label: 'Non-Covered Services', value: patientNonCovered, set: setPatientNonCovered, prefix: true },
                    { label: 'Remaining Balance', value: remainingBalance, set: setRemainingBalance, prefix: true },
                    { label: 'Prior Balance', value: priorBalance, set: setPriorBalance, prefix: false },
                    { label: 'Total Amount Due', value: totalAmountDue, set: setTotalAmountDue, prefix: false, bold: true },
                  ].map(({ label, value, set, prefix, bold }) => (
                    <div key={label}>
                      <label className={`${labelCls} ${bold ? 'font-semibold text-[#1A1A2E]' : ''}`}>{label}</label>
                      <div className="relative">
                        {prefix && (
                          <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[#1A1A2E] text-[13px] pointer-events-none">$</span>
                        )}
                        <input
                          type="text"
                          inputMode="decimal"
                          className={`${inputCls} ${prefix ? 'pl-6' : ''} ${bold ? 'font-semibold' : ''}`}
                          value={value}
                          onChange={e => set(e.target.value)}
                          disabled={!editing && !!statement}
                          placeholder="0.00"
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </div>

            </>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-6 py-4 border-t border-[#E8E8E4] flex-shrink-0 bg-white rounded-b-xl">
          <div className="flex-1 min-w-0 mr-4">
            {error && (
              <p className="text-[12px] text-[#DC2626] truncate">{error}</p>
            )}
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            {(!statement || editing) && (
              <>
                {editing && statement && (
                  <Button variant="secondary" size="sm" onClick={() => { setEditing(false); setError(null) }}>
                    Cancel
                  </Button>
                )}
                <Button variant="teal" size="sm" loading={saving} onClick={handleSave}>
                  Save
                </Button>
              </>
            )}

            {statement && !editing && (
              <Button variant="secondary" size="sm" onClick={() => { setEditing(true); setError(null) }}>
                Edit
              </Button>
            )}

            {statement && !editing && !isSent && (
              <Button
                variant="primary"
                size="sm"
                loading={sending}
                disabled={!canSend}
                onClick={handleSend}
                title={!canSend ? 'Add an email or phone number to send' : undefined}
              >
                Generate &amp; Send Statement
              </Button>
            )}

            {/* "No patient responsibility" — one click, marks paid at $0.
                Visible for any statement that isn't already paid, so the
                biller can flip a draft (ERA came back showing family owes
                nothing) OR a sent statement (later discovered nothing was
                owed) with a single confirm dialog. */}
            {statement && statement.status !== 'paid' && !editing && !recordingPayment && !writingOff && (
              <Button
                variant="secondary"
                size="sm"
                loading={markingNoResp}
                onClick={markNoPatientResponsibility}
              >
                No patient responsibility
              </Button>
            )}

            {/* Biller manual "Record payment" — shown for sent (unpaid)
                statements. Hidden while the record-payment inline form
                is open (its own Save/Cancel controls take over). */}
            {isSent && !editing && !recordingPayment && !writingOff && (
              <Button variant="teal" size="sm" onClick={openRecordPayment}>
                Record payment
              </Button>
            )}

            {/* Write off — only on sent (unpaid) statements. */}
            {isSent && !editing && !recordingPayment && !writingOff && (
              <Button variant="secondary" size="sm" onClick={() => { setWritingOff(true); setError(null) }}>
                Write off
              </Button>
            )}

            {isSent && (
              <Button variant="primary" size="sm" loading={sending} onClick={handleSend}>
                Resend
              </Button>
            )}
          </div>
        </div>

      </div>
    </div>
  )
}
