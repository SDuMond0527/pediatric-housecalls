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
} from '../../lib/api'

interface Props {
  claim: any
  onClose: () => void
  onSent: () => void
}

type ExplanationType = 'deductible' | 'coinsurance' | 'copay'

interface Explanation {
  type: ExplanationType
  applied?: string
  paid?: string
  responsibility?: string
  copayAmount?: string
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

  // Explanations
  const [explanations, setExplanations] = useState<Explanation[]>([])

  useEffect(() => {
    async function load() {
      setLoading(true)
      try {
        const stmt = await getPatientStatement(claim.id)
        if (stmt) {
          setStatement(stmt)
          populateFromStatement(stmt)
        } else {
          // No statement yet — pre-fill from ERA if already received
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

  function populateFromStatement(stmt: any) {
    // Use family contact as fallback if patient-specific not set
    const fe = stmt.family_email ?? ''
    const fp = stmt.family_phone ?? ''
    setFamilyEmail(fe)
    setFamilyPhone(fp)
    setPatientEmail(stmt.patient_email ?? fe)
    setPatientPhone(stmt.patient_phone ?? fp)
    setAmountBilled(stmt.amount_billed ?? '')
    setInsurancePayment(stmt.insurance_payment ?? '')
    setContractualAdjustment(stmt.contractual_adjustment ?? '')
    setPatientCopay(stmt.patient_copay ?? '')
    setPatientDeductible(stmt.patient_deductible ?? '')
    setPatientCoinsurance(stmt.patient_coinsurance ?? '')
    setPatientNonCovered(stmt.patient_non_covered ?? '')
    setRemainingBalance(stmt.remaining_balance ?? '')
    setPriorBalance(stmt.prior_balance ?? '')
    setTotalAmountDue(stmt.total_amount_due ?? '')
    setExplanations(stmt.explanations ?? [])
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
      explanations,
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

  function toggleExplanation(type: ExplanationType) {
    setExplanations(prev => {
      const exists = prev.find(e => e.type === type)
      if (exists) return prev.filter(e => e.type !== type)
      return [...prev, { type }]
    })
  }

  function updateExplanation(type: ExplanationType, field: string, value: string) {
    setExplanations(prev =>
      prev.map(e => e.type === type ? { ...e, [field]: value } : e)
    )
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
            <p className="text-[12px] text-[#999] mt-0.5">
              {patientName} &bull; DOS: {fmtDate(claim.service_date)}
            </p>
          </div>
          <div className="flex items-center gap-3">
            {isSent && (
              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold bg-[#E1F5EE] text-[#085041]">
                Sent {statement.sent_at ? fmtDate(statement.sent_at) : ''}
              </span>
            )}
            <button onClick={onClose} className="text-[#999] hover:text-[#555] transition-colors">
              <X size={18} />
            </button>
          </div>
        </div>

        {/* Scrollable body */}
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6">
          {loading ? (
            <div className="py-12 text-center text-[13px] text-[#999]">Loading…</div>
          ) : (
            <>
              {/* Section 1: Patient Contact */}
              <div>
                <div className="text-[11px] font-semibold text-[#999] uppercase tracking-wider mb-3">Patient Contact</div>
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
                  <div className="text-[11px] font-semibold text-[#999] uppercase tracking-wider">Encounter Details</div>
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
                      <span className="text-[#999] text-[11px] block mb-0.5">Patient</span>
                      <span className="text-[#1A1A2E] font-medium">{patientName}</span>
                    </div>
                    <div>
                      <span className="text-[#999] text-[11px] block mb-0.5">DOB</span>
                      <span className="text-[#1A1A2E]">{fmtDate(claim.patient_dob)}</span>
                    </div>
                    <div>
                      <span className="text-[#999] text-[11px] block mb-0.5">Date of Service</span>
                      <span className="text-[#1A1A2E]">{fmtDate(claim.service_date)}</span>
                    </div>
                  </div>
                  {(claim.cpt_codes ?? []).length > 0 && (
                    <div className="pt-2 border-t border-[#E8E8E4]">
                      <span className="text-[#999] text-[11px] block mb-1.5">CPT Codes</span>
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

              {/* Section 3: Financial Summary */}
              <div>
                <div className="text-[11px] font-semibold text-[#999] uppercase tracking-wider mb-3">Financial Summary</div>
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
                          <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[#999] text-[13px] pointer-events-none">$</span>
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

              {/* Section 4: Explanation Messages */}
              <div>
                <div className="text-[11px] font-semibold text-[#999] uppercase tracking-wider mb-1">Explanation Messages</div>
                <p className="text-[12px] text-[#999] mb-3">Select all that apply to include in the statement.</p>
                <div className="space-y-3">

                  {/* Deductible */}
                  {(() => {
                    const active = explanations.find(e => e.type === 'deductible')
                    return (
                      <div className={`border rounded-xl p-3 transition-colors ${active ? 'border-[#7F77DD] bg-[#EEEDFE]' : 'border-[#E8E8E4]'}`}>
                        <label className="flex items-center gap-2 cursor-pointer" onClick={() => (editing || !statement) && toggleExplanation('deductible')}>
                          <input
                            type="checkbox"
                            checked={!!active}
                            onChange={() => (editing || !statement) && toggleExplanation('deductible')}
                            className="accent-[#7F77DD]"
                            disabled={!editing && !!statement}
                          />
                          <span className="text-[13px] font-medium text-[#1A1A2E]">Applied to deductible</span>
                        </label>
                        {active && (
                          <div className="mt-2 ml-6">
                            <label className={labelCls}>Amount applied to deductible</label>
                            <div className="relative w-40">
                              <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[#999] text-[13px] pointer-events-none">$</span>
                              <input
                                type="text"
                                inputMode="decimal"
                                className={`${inputCls} pl-6`}
                                value={active.applied ?? ''}
                                onChange={e => updateExplanation('deductible', 'applied', e.target.value)}
                                disabled={!editing && !!statement}
                                placeholder="0.00"
                              />
                            </div>
                          </div>
                        )}
                      </div>
                    )
                  })()}

                  {/* Coinsurance */}
                  {(() => {
                    const active = explanations.find(e => e.type === 'coinsurance')
                    return (
                      <div className={`border rounded-xl p-3 transition-colors ${active ? 'border-[#7F77DD] bg-[#EEEDFE]' : 'border-[#E8E8E4]'}`}>
                        <label className="flex items-center gap-2 cursor-pointer" onClick={() => (editing || !statement) && toggleExplanation('coinsurance')}>
                          <input
                            type="checkbox"
                            checked={!!active}
                            onChange={() => (editing || !statement) && toggleExplanation('coinsurance')}
                            className="accent-[#7F77DD]"
                            disabled={!editing && !!statement}
                          />
                          <span className="text-[13px] font-medium text-[#1A1A2E]">Co-insurance</span>
                        </label>
                        {active && (
                          <div className="mt-2 ml-6 grid grid-cols-2 gap-3">
                            <div>
                              <label className={labelCls}>Insurance paid</label>
                              <div className="relative">
                                <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[#999] text-[13px] pointer-events-none">$</span>
                                <input
                                  type="text"
                                  inputMode="decimal"
                                  className={`${inputCls} pl-6`}
                                  value={active.paid ?? ''}
                                  onChange={e => updateExplanation('coinsurance', 'paid', e.target.value)}
                                  disabled={!editing && !!statement}
                                  placeholder="0.00"
                                />
                              </div>
                            </div>
                            <div>
                              <label className={labelCls}>Co-insurance amount</label>
                              <div className="relative">
                                <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[#999] text-[13px] pointer-events-none">$</span>
                                <input
                                  type="text"
                                  inputMode="decimal"
                                  className={`${inputCls} pl-6`}
                                  value={active.responsibility ?? ''}
                                  onChange={e => updateExplanation('coinsurance', 'responsibility', e.target.value)}
                                  disabled={!editing && !!statement}
                                  placeholder="0.00"
                                />
                              </div>
                            </div>
                          </div>
                        )}
                      </div>
                    )
                  })()}

                  {/* Copay */}
                  {(() => {
                    const active = explanations.find(e => e.type === 'copay')
                    return (
                      <div className={`border rounded-xl p-3 transition-colors ${active ? 'border-[#7F77DD] bg-[#EEEDFE]' : 'border-[#E8E8E4]'}`}>
                        <label className="flex items-center gap-2 cursor-pointer" onClick={() => (editing || !statement) && toggleExplanation('copay')}>
                          <input
                            type="checkbox"
                            checked={!!active}
                            onChange={() => (editing || !statement) && toggleExplanation('copay')}
                            className="accent-[#7F77DD]"
                            disabled={!editing && !!statement}
                          />
                          <span className="text-[13px] font-medium text-[#1A1A2E]">Co-pay</span>
                        </label>
                        {active && (
                          <div className="mt-2 ml-6 grid grid-cols-2 gap-3">
                            <div>
                              <label className={labelCls}>Insurance paid</label>
                              <div className="relative">
                                <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[#999] text-[13px] pointer-events-none">$</span>
                                <input
                                  type="text"
                                  inputMode="decimal"
                                  className={`${inputCls} pl-6`}
                                  value={active.paid ?? ''}
                                  onChange={e => updateExplanation('copay', 'paid', e.target.value)}
                                  disabled={!editing && !!statement}
                                  placeholder="0.00"
                                />
                              </div>
                            </div>
                            <div>
                              <label className={labelCls}>Co-pay amount</label>
                              <div className="relative">
                                <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[#999] text-[13px] pointer-events-none">$</span>
                                <input
                                  type="text"
                                  inputMode="decimal"
                                  className={`${inputCls} pl-6`}
                                  value={active.copayAmount ?? ''}
                                  onChange={e => updateExplanation('copay', 'copayAmount', e.target.value)}
                                  disabled={!editing && !!statement}
                                  placeholder="0.00"
                                />
                              </div>
                            </div>
                          </div>
                        )}
                      </div>
                    )
                  })()}

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
