import { useState } from 'react'
import { X, DollarSign, AlertCircle } from 'lucide-react'
import { Button } from './ui/Button'
import { Input } from './ui/Input'
import { postInsurancePayment } from '../lib/api'

// Modal for Andrea to post an insurance payment that arrived outside the
// Stedi ERA pipeline (paper EOB, EFT without ERA, manually keyed check).
// Server writes the same columns the ERA path writes, so downstream
// behavior — Completed-tab routing, patient-statement generation — is
// identical. Sara 2026-10-19.

interface Props {
  claim: {
    id: string
    patient_first_name?: string | null
    patient_last_name?: string | null
    service_date?: string | null
    total_charge?: number | string | null
    payer_name?: string | null
  }
  onClose: () => void
  onPosted: (updatedClaim: any) => void
}

function toNum(v: string): number {
  const n = parseFloat(v.trim().replace(/[^0-9.-]/g, ''))
  return Number.isFinite(n) ? n : 0
}

export function PostPaymentModal({ claim, onClose, onPosted }: Props) {
  const defaultBilled = claim.total_charge ? String(claim.total_charge) : ''
  const [amountBilled, setAmountBilled]           = useState(defaultBilled)
  const [insurancePayment, setInsurancePayment]   = useState('')
  const [contractualAdj, setContractualAdj]       = useState('')
  const [copay, setCopay]                         = useState('')
  const [deductible, setDeductible]               = useState('')
  const [coinsurance, setCoinsurance]             = useState('')
  const [nonCovered, setNonCovered]               = useState('')
  const [paymentReference, setPaymentReference]   = useState('')
  const [paymentDate, setPaymentDate]             = useState(() => new Date().toISOString().slice(0, 10))
  const [submitting, setSubmitting]               = useState(false)
  const [error, setError]                         = useState<string | null>(null)

  const patientResp = toNum(copay) + toNum(deductible) + toNum(coinsurance) + toNum(nonCovered)
  const billed      = toNum(amountBilled)
  const remaining   = +(billed - toNum(insurancePayment) - toNum(contractualAdj)).toFixed(2)
  const check       = +(toNum(insurancePayment) + toNum(contractualAdj) + patientResp).toFixed(2)
  const checkDiff   = +(billed - check).toFixed(2)

  async function submit() {
    setError(null)
    if (toNum(insurancePayment) <= 0 && toNum(contractualAdj) <= 0 && patientResp <= 0) {
      setError('Enter at least one payment or adjustment amount.')
      return
    }
    if (billed <= 0) {
      setError('Billed amount is required (defaulted to the claim total — override if the payer billed something different).')
      return
    }
    setSubmitting(true)
    try {
      const updated = await postInsurancePayment(claim.id, {
        amount_billed: amountBilled,
        insurance_payment: insurancePayment,
        contractual_adjustment: contractualAdj,
        patient_copay: copay,
        patient_deductible: deductible,
        patient_coinsurance: coinsurance,
        patient_non_covered: nonCovered,
        payment_reference: paymentReference.trim() || undefined,
        payment_date: paymentDate,
      })
      onPosted(updated)
    } catch (e: any) {
      setError(e?.message ?? 'Failed to post payment')
    } finally {
      setSubmitting(false)
    }
  }

  const patientName = [claim.patient_first_name, claim.patient_last_name].filter(Boolean).join(' ') || 'Unknown patient'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-xl max-w-xl w-full max-h-[90vh] flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="flex items-start justify-between px-5 py-4 border-b border-[#E8E8E4]">
          <div>
            <div className="text-[11px] uppercase tracking-wide text-[#1A1A2E]/60">Post insurance payment</div>
            <h2 className="font-display text-[17px] font-semibold text-[#1A1A2E] mt-0.5">{patientName}</h2>
            <div className="text-[12px] text-[#1A1A2E]/70 mt-0.5">
              {claim.payer_name || 'Payer'} · DOS {claim.service_date ? new Date(claim.service_date).toLocaleDateString() : '—'}
            </div>
          </div>
          <button onClick={onClose} className="text-[#1A1A2E]/60 hover:text-[#1A1A2E] p-1 -mr-1"><X size={18} /></button>
        </div>

        <div className="overflow-auto flex-1 p-5 space-y-4">
          {error && (
            <div className="flex items-start gap-2 text-[13px] text-[#991B1B] bg-[#FCEBEB] border border-[#F5C6C6] px-3 py-2 rounded-lg">
              <AlertCircle size={14} className="mt-0.5 flex-shrink-0" /> <span>{error}</span>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <Input label="Billed amount *" type="text" value={amountBilled} onChange={e => setAmountBilled(e.target.value)} placeholder="0.00" />
            <Input label="Insurance payment *" type="text" value={insurancePayment} onChange={e => setInsurancePayment(e.target.value)} placeholder="0.00" />
            <Input label="Contractual adjustment" type="text" value={contractualAdj} onChange={e => setContractualAdj(e.target.value)} placeholder="0.00" />
            <Input label="Payment date" type="date" value={paymentDate} onChange={e => setPaymentDate(e.target.value)} />
          </div>

          <div className="pt-3 border-t border-[#F1EFE8]">
            <div className="text-[11px] font-semibold text-[#555] uppercase tracking-wider mb-2">Patient responsibility</div>
            <div className="grid grid-cols-2 gap-3">
              <Input label="Copay"           type="text" value={copay}       onChange={e => setCopay(e.target.value)}       placeholder="0.00" />
              <Input label="Deductible"      type="text" value={deductible}  onChange={e => setDeductible(e.target.value)}  placeholder="0.00" />
              <Input label="Coinsurance"     type="text" value={coinsurance} onChange={e => setCoinsurance(e.target.value)} placeholder="0.00" />
              <Input label="Non-covered"     type="text" value={nonCovered}  onChange={e => setNonCovered(e.target.value)}  placeholder="0.00" />
            </div>
          </div>

          <div className="pt-3 border-t border-[#F1EFE8]">
            <Input label="Check / EFT / reference (optional)" type="text" value={paymentReference} onChange={e => setPaymentReference(e.target.value)} placeholder="e.g. check #4218, EFT 2026-10-18" />
          </div>

          {/* Live math summary — shows how the numbers balance against the
              billed amount so Andrea sees a mistyped field before saving. */}
          <div className="p-3 bg-[#FAFAF8] border border-[#E8E8E4] rounded-lg text-[12px] space-y-1">
            <div className="flex justify-between"><span className="text-[#555]">Patient responsibility total</span><strong>${patientResp.toFixed(2)}</strong></div>
            <div className="flex justify-between"><span className="text-[#555]">Remaining AR after this post</span><strong>${remaining.toFixed(2)}</strong></div>
            {billed > 0 && Math.abs(checkDiff) > 0.01 && (
              <div className="flex justify-between text-[#8A4B00] bg-[#FEF3C7] rounded px-2 py-1 mt-1">
                <span>Insurance paid + adjustments + patient resp does not match billed by</span>
                <strong>${checkDiff.toFixed(2)}</strong>
              </div>
            )}
          </div>

          <div className="text-[11px] text-[#1A1A2E]/60 leading-relaxed">
            Posting this moves the claim to <strong>Completed</strong> and creates a draft patient statement for ${patientResp.toFixed(2)}.
            If the patient owes $0 and insurance paid the full billed amount, the statement is created as already paid.
            This is for payments that arrived outside the Stedi ERA pipeline — Stedi-posted ERAs are handled automatically.
          </div>
        </div>

        <div className="px-5 py-3 border-t border-[#E8E8E4] bg-[#FAFAF8] flex items-center justify-end gap-2">
          <Button variant="secondary" size="sm" onClick={onClose} disabled={submitting}>Cancel</Button>
          <Button variant="teal" size="sm" loading={submitting} onClick={submit}>
            <DollarSign size={12} /> Post payment
          </Button>
        </div>
      </div>
    </div>
  )
}
