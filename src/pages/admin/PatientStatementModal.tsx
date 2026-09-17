import { useEffect, useState } from 'react'
import { format } from 'date-fns'
import { X, Download } from 'lucide-react'
import { Button } from '../../components/ui/Button'
import {
  getPatientStatement,
  createPatientStatement,
  updatePatientStatement,
  sendPatientStatement,
  pullStediEra,
  markPatientStatementPaid,
  writeOffPatientStatement,
  type WriteOffReason,
} from '../../lib/api'

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
            <p className="text-[12px] text-[#1A1A2E] mt-0.5">
              {patientName} &bull; DOS: {fmtDate(claim.service_date)}
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
