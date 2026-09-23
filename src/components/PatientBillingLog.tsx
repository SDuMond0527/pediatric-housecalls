import { useState } from 'react'
import { format } from 'date-fns'
import { ChevronDown, Receipt, ExternalLink, DollarSign, Pencil } from 'lucide-react'

/** One row in the billing log — a claim plus its linked statement (if any). */
export type BillingLogEntry = {
  claim_id: string
  claim_status: string | null
  service_date: string | null
  payer_name: string | null
  payer_id: string | null
  cpt_codes: any[] | null
  total_charge: string | number | null
  amount_billed_era: string | number | null
  insurance_payment_era: string | number | null
  contractual_adjustment_era: string | number | null
  patient_copay_era: string | number | null
  patient_deductible_era: string | number | null
  patient_coinsurance_era: string | number | null
  patient_non_covered_era: string | number | null
  era_received_at: string | null
  submitted_at: string | null
  stedi_claim_id: string | null
  submission_error: string | null
  payer_control_number: string | null
  visit_type: string | null
  provider_name: string | null
  patient_first_name: string | null
  patient_last_name: string | null
  patient_dob: string | null
  subscriber_name: string | null
  subscriber_dob: string | null
  member_id: string | null

  statement_id: string | null
  statement_status: string | null
  statement_sent_at: string | null
  statement_paid_at: string | null
  statement_paid_amount_cents: number | null
  statement_payment_note: string | null
  statement_total_amount_due: string | null
  statement_amount_billed: string | number | null
  statement_insurance_payment: string | number | null
  statement_contractual_adjustment: string | number | null
  statement_patient_copay: string | number | null
  statement_patient_deductible: string | number | null
  statement_patient_coinsurance: string | number | null
  statement_patient_non_covered: string | number | null
  statement_remaining_balance: string | number | null
  statement_prior_balance: string | number | null
  statement_square_payment_url: string | null
  statement_created_at: string | null
}

function fmtDate(d: string | null | undefined) {
  if (!d) return '—'
  try {
    const s = String(d).split('T')[0]
    const [y, m, day] = s.split('-').map(Number)
    return format(new Date(y, m - 1, day), 'MMM d, yyyy')
  } catch { return d ?? '—' }
}

function fmtMoney(n: any) {
  if (n == null || String(n).trim() === '') return null
  const v = parseFloat(String(n))
  return isNaN(v) ? null : `$${v.toFixed(2)}`
}

const CLAIM_BADGE: Record<string, { label: string; cls: string }> = {
  draft:            { label: 'Draft',            cls: 'bg-[#F1EFE8] text-[#777]' },
  pending_review:   { label: 'Pending review',   cls: 'bg-[#FEF3C7] text-[#92400E]' },
  submitted:        { label: 'Submitted',        cls: 'bg-[#EEF6FB] text-[#2D7BA6]' },
  error:            { label: 'Error',            cls: 'bg-[#FCEBEB] text-[#991B1B]' },
  paid:             { label: 'Paid by payer',    cls: 'bg-[#E6F6F2] text-[#1A7D5A]' },
  denied:           { label: 'Denied',           cls: 'bg-[#FCEBEB] text-[#991B1B]' },
  self_pay:         { label: 'Self-pay',         cls: 'bg-[#EEEDFE] text-[#3C3489]' },
}

const STATEMENT_BADGE: Record<string, { label: string; cls: string }> = {
  draft: { label: 'Statement drafted',  cls: 'bg-[#F1EFE8] text-[#777]' },
  sent:  { label: 'Statement sent',     cls: 'bg-[#EEF6FB] text-[#2D7BA6]' },
  paid:  { label: 'Statement paid',     cls: 'bg-[#E6F6F2] text-[#1A7D5A]' },
  void:  { label: 'Statement void',     cls: 'bg-[#F1EFE8] text-[#777] line-through' },
}

export function PatientBillingLog({
  entries,
  loading,
  error,
  onOpenClaim,
}: {
  entries: BillingLogEntry[]
  loading: boolean
  error: string | null
  /** Opens the full PatientStatementModal so the biller can edit + send +
   *  record payment. The click passes a claim-shaped object matching what
   *  PatientStatementModal expects (see AdminStatements for the shape). */
  onOpenClaim: (entry: BillingLogEntry) => void
}) {
  if (loading) {
    return <div className="text-[13px] text-[#1A1A2E]/60 py-8 text-center">Loading billing log…</div>
  }
  if (error) {
    return <div className="text-[13px] text-red-600 py-8 text-center">{error}</div>
  }
  if (!entries.length) {
    return (
      <div className="bg-white border border-[#E8E8E4] rounded-xl p-10 text-center shadow-sm">
        <Receipt size={28} className="text-[#aeaeb2] mx-auto mb-3" />
        <div className="text-[13px] text-[#1A1A2E]">No billing activity for this patient yet.</div>
        <div className="text-[11px] text-[#1A1A2E]/60 mt-1">Claims and statements will appear here after the first encounter is signed.</div>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {entries.map(e => (
        <LogRow key={e.claim_id} entry={e} onOpenClaim={onOpenClaim} />
      ))}
    </div>
  )
}

function LogRow({ entry: e, onOpenClaim }: { entry: BillingLogEntry; onOpenClaim: (e: BillingLogEntry) => void }) {
  const [open, setOpen] = useState(false)
  const [pcnCopied, setPcnCopied] = useState(false)

  // Patient Control Number — prefer the short PEDS00042 form assigned
  // to claims submitted after 2026-09-23; fall back to the 20-char UUID
  // prefix for pre-existing already-submitted claims (payer already has
  // that PCN on file, can't retroactively rename).
  const pcn = e.payer_control_number
    ? String(e.payer_control_number)
    : String(e.claim_id ?? '').replace(/-/g, '').slice(0, 20)
  async function copyPcn(ev: React.MouseEvent) {
    ev.stopPropagation()
    try {
      await navigator.clipboard.writeText(pcn)
      setPcnCopied(true)
      setTimeout(() => setPcnCopied(false), 1500)
    } catch {
      window.prompt('Copy the PCN below:', pcn)
    }
  }

  const claimBadge = CLAIM_BADGE[e.claim_status ?? ''] ?? { label: e.claim_status ?? 'Unknown', cls: 'bg-[#F1EFE8] text-[#777]' }
  const stmtBadge = e.statement_status ? (STATEMENT_BADGE[e.statement_status] ?? { label: e.statement_status, cls: 'bg-[#F1EFE8] text-[#777]' }) : null

  // Top-line amount: prefer statement's total_amount_due, else ERA
  // patient responsibility (copay+ded+coins+non-covered), else the
  // claim's original total_charge. That gives the biller the most
  // recent view of "what the patient owes".
  const patientResponsibility =
    (parseFloat(String(e.patient_copay_era ?? 0)) || 0) +
    (parseFloat(String(e.patient_deductible_era ?? 0)) || 0) +
    (parseFloat(String(e.patient_coinsurance_era ?? 0)) || 0) +
    (parseFloat(String(e.patient_non_covered_era ?? 0)) || 0)

  const topAmount =
    fmtMoney(e.statement_total_amount_due) ??
    (patientResponsibility > 0 ? `$${patientResponsibility.toFixed(2)}` : null) ??
    fmtMoney(e.total_charge)

  const cpts: any[] = Array.isArray(e.cpt_codes) ? e.cpt_codes : []

  // ERA financial rows — hidden until we have ERA data
  const eraRows = e.era_received_at ? [
    { label: 'Billed (ERA)',           value: e.amount_billed_era },
    { label: 'Insurance payment',      value: e.insurance_payment_era },
    { label: 'Contractual adjustment', value: e.contractual_adjustment_era },
    { label: 'Copay',                  value: e.patient_copay_era },
    { label: 'Deductible',             value: e.patient_deductible_era },
    { label: 'Coinsurance',            value: e.patient_coinsurance_era },
    { label: 'Non-covered services',   value: e.patient_non_covered_era },
  ].filter(r => r.value != null && String(r.value).trim() !== '' && parseFloat(String(r.value)) !== 0) : []

  // Statement rows — shown when we have a statement, using its own
  // stored numbers (may differ from ERA if the biller edited them)
  const stmtRows = e.statement_id ? [
    { label: 'Amount billed',          value: e.statement_amount_billed },
    { label: 'Insurance payment',      value: e.statement_insurance_payment },
    { label: 'Contractual adjustment', value: e.statement_contractual_adjustment },
    { label: 'Copay',                  value: e.statement_patient_copay },
    { label: 'Deductible',             value: e.statement_patient_deductible },
    { label: 'Coinsurance',            value: e.statement_patient_coinsurance },
    { label: 'Non-covered services',   value: e.statement_patient_non_covered },
    { label: 'Prior balance',          value: e.statement_prior_balance },
    { label: 'Remaining balance',      value: e.statement_remaining_balance },
  ].filter(r => r.value != null && String(r.value).trim() !== '' && parseFloat(String(r.value)) !== 0) : []

  return (
    <div className="bg-white border border-[#E8E8E4] rounded-xl shadow-sm overflow-hidden">
      {/* Row header */}
      <button
        onClick={() => setOpen(v => !v)}
        className="w-full text-left px-4 py-4 hover:bg-[#FAFAF8] transition-colors">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-display text-[14px] font-medium text-[#1A1A2E]">{fmtDate(e.service_date)}</span>
              {e.visit_type && <span className="text-[12px] text-[#555]">· {e.visit_type}</span>}
              <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium ${claimBadge.cls}`}>
                {claimBadge.label}
              </span>
              {stmtBadge && (
                <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium ${stmtBadge.cls}`}>
                  {stmtBadge.label}
                </span>
              )}
              {pcn && (
                <button
                  type="button"
                  onClick={copyPcn}
                  className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[10px] font-mono border transition-colors ${pcnCopied ? 'border-[#1D9E75] bg-[#E1F5EE] text-[#085041]' : 'border-[#E8E8E4] bg-[#FAFAF8] text-[#555] hover:bg-white hover:border-[#7F77DD] hover:text-[#7F77DD]'}`}
                  title="Click to copy this claim's Patient Control Number — paste it into Stedi's claim search."
                >
                  {pcnCopied ? '✓ Copied' : `PCN: ${pcn}`}
                </button>
              )}
            </div>
            <div className="flex items-center gap-3 mt-1 text-[12px] text-[#555] flex-wrap">
              {e.payer_name && <span>{e.payer_name}</span>}
              {e.provider_name && <span>· {e.provider_name}</span>}
              {e.era_received_at && <span>· ERA {fmtDate(e.era_received_at)}</span>}
              {e.statement_paid_at && <span className="text-[#1D9E75] font-medium">· Paid {fmtDate(e.statement_paid_at)}</span>}
            </div>
            {e.submission_error && (
              <div className="text-[11px] text-[#991B1B] mt-1 truncate">Submission error: {e.submission_error}</div>
            )}
          </div>
          <div className="flex flex-col items-end gap-1 flex-shrink-0">
            {topAmount && (
              <div className="font-display text-lg font-semibold text-[#1A1A2E] tabular-nums">{topAmount}</div>
            )}
            <div className="flex items-center gap-1 text-[11px] text-[#7F77DD] font-medium">
              {open ? 'Hide details' : 'View details'}
              <ChevronDown size={12} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
            </div>
          </div>
        </div>
      </button>

      {/* Expanded body */}
      {open && (
        <div className="border-t border-[#E8E8E4] bg-[#FAFAF8] px-4 py-4 space-y-5">
          {/* Encounter + CPTs */}
          <div>
            <div className="text-[10px] font-semibold text-[#1A1A2E] uppercase tracking-wider mb-2">Claim</div>
            <div className="bg-white border border-[#E8E8E4] rounded-lg p-3 space-y-2 text-[12px]">
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <div className="text-[10px] text-[#1A1A2E]/60 uppercase mb-0.5">Payer</div>
                  <div className="text-[#1A1A2E]">{e.payer_name || '—'}</div>
                </div>
                <div>
                  <div className="text-[10px] text-[#1A1A2E]/60 uppercase mb-0.5">Submitted</div>
                  <div className="text-[#1A1A2E]">{fmtDate(e.submitted_at)}</div>
                </div>
                <div>
                  <div className="text-[10px] text-[#1A1A2E]/60 uppercase mb-0.5">Total charge</div>
                  <div className="text-[#1A1A2E] tabular-nums">{fmtMoney(e.total_charge) ?? '—'}</div>
                </div>
              </div>
              {cpts.length > 0 && (
                <div className="pt-2 border-t border-[#E8E8E4]">
                  <div className="text-[10px] text-[#1A1A2E]/60 uppercase mb-1.5">Services (CPT)</div>
                  <div className="space-y-1">
                    {cpts.map((c: any, i: number) => (
                      <div key={c.code ?? i} className="flex items-center gap-2">
                        <span className="font-semibold text-[#7F77DD] w-14 flex-shrink-0">{c.code}</span>
                        <span className="text-[#555] flex-1">{c.description || '—'}</span>
                        {c.units && Number(c.units) > 1 && <span className="text-[#1A1A2E]/60 flex-shrink-0">×{c.units}</span>}
                        {c.charge_amount != null && (
                          <span className="text-[#1A1A2E] font-medium flex-shrink-0 tabular-nums">
                            ${parseFloat(String(c.charge_amount)).toFixed(2)}
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* ERA breakdown — only if we received an ERA */}
          {e.era_received_at && (
            <div>
              <div className="text-[10px] font-semibold text-[#1A1A2E] uppercase tracking-wider mb-2">
                ERA — payer response
              </div>
              <div className="bg-white border border-[#E8E8E4] rounded-lg p-3 text-[12px]">
                {eraRows.length === 0 ? (
                  <div className="text-[#1A1A2E]/60">No ERA line breakdown available.</div>
                ) : (
                  <div className="space-y-1.5">
                    {eraRows.map(row => (
                      <div key={row.label} className="flex items-center justify-between">
                        <span className="text-[#555]">{row.label}</span>
                        <span className="text-[#1A1A2E] tabular-nums">{fmtMoney(row.value)}</span>
                      </div>
                    ))}
                    {patientResponsibility > 0 && (
                      <div className="border-t border-[#E8E8E4] pt-2 mt-2 flex items-center justify-between">
                        <span className="font-semibold text-[#1A1A2E]">Patient responsibility</span>
                        <span className="font-semibold text-[#1A1A2E] tabular-nums">${patientResponsibility.toFixed(2)}</span>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Statement breakdown — only if a statement exists */}
          {e.statement_id && (
            <div>
              <div className="text-[10px] font-semibold text-[#1A1A2E] uppercase tracking-wider mb-2">
                Statement to family
              </div>
              <div className="bg-white border border-[#E8E8E4] rounded-lg p-3 text-[12px] space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-[#555]">Status</span>
                  <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium ${stmtBadge?.cls ?? ''}`}>
                    {stmtBadge?.label}
                  </span>
                </div>
                {e.statement_sent_at && (
                  <div className="flex items-center justify-between">
                    <span className="text-[#555]">Sent</span>
                    <span className="text-[#1A1A2E]">{fmtDate(e.statement_sent_at)}</span>
                  </div>
                )}
                {e.statement_paid_at && (
                  <div className="flex items-center justify-between">
                    <span className="text-[#1D9E75] font-semibold">Paid</span>
                    <span className="text-[#1D9E75] font-semibold">{fmtDate(e.statement_paid_at)}</span>
                  </div>
                )}
                {e.statement_paid_amount_cents != null && (
                  <div className="flex items-center justify-between">
                    <span className="text-[#555]">Paid amount</span>
                    <span className="text-[#1A1A2E] tabular-nums">${(e.statement_paid_amount_cents / 100).toFixed(2)}</span>
                  </div>
                )}
                {e.statement_payment_note && (
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[#555]">Payment note</span>
                    <span className="text-[#1A1A2E] truncate max-w-xs" title={e.statement_payment_note}>{e.statement_payment_note}</span>
                  </div>
                )}
                {stmtRows.length > 0 && (
                  <div className="border-t border-[#E8E8E4] pt-2 mt-2 space-y-1.5">
                    {stmtRows.map(row => (
                      <div key={row.label} className="flex items-center justify-between">
                        <span className="text-[#555]">{row.label}</span>
                        <span className="text-[#1A1A2E] tabular-nums">{fmtMoney(row.value)}</span>
                      </div>
                    ))}
                  </div>
                )}
                {e.statement_total_amount_due && (
                  <div className="border-t border-[#E8E8E4] pt-2 mt-2 flex items-center justify-between">
                    <span className="font-semibold text-[#1A1A2E]">Total amount due</span>
                    <span className="font-display text-[14px] font-semibold text-[#1A1A2E] tabular-nums">{fmtMoney(e.statement_total_amount_due)}</span>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Actions — open full statement modal for edit/send/record-payment */}
          <div className="flex justify-end gap-2">
            {e.statement_square_payment_url && e.statement_status === 'sent' && (
              <a
                href={e.statement_square_payment_url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-white border border-[#E8E8E4] text-[#555] text-[12px] font-medium rounded-lg hover:bg-[#F1EFE8] transition-colors">
                <ExternalLink size={12} /> Open Square link
              </a>
            )}
            <button
              onClick={() => onOpenClaim(e)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-[#7F77DD] text-white text-[12px] font-medium rounded-lg hover:bg-[#6C64C8] transition-colors">
              {e.statement_id ? (<><Pencil size={12} /> Edit statement</>) : (<><DollarSign size={12} /> Generate statement</>)}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
