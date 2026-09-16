import { useState } from 'react'
import { format } from 'date-fns'
import { CheckCircle2, Send, ExternalLink, Receipt, ChevronDown } from 'lucide-react'

export type BillingStatement = {
  id: string
  status: string
  visit_type: string | null
  provider_name: string | null
  cpt_codes: any
  total_amount_due: string | null
  amount_billed: string | number | null
  insurance_payment: string | number | null
  contractual_adjustment: string | number | null
  patient_copay: string | number | null
  patient_deductible: string | number | null
  patient_coinsurance: string | number | null
  patient_non_covered: string | number | null
  remaining_balance: string | number | null
  prior_balance: string | number | null
  square_payment_url: string | null
  sent_at: string | null
  paid_at: string | null
  paid_amount_cents: number | null
  created_at: string | null
  payer_name?: string | null
  patient_first_name?: string | null
  patient_last_name?: string | null
  patient_dob?: string | null
  service_date?: string | null
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
  const v = parseFloat(n ?? 0)
  return isNaN(v) ? '—' : `$${v.toFixed(2)}`
}

const STATUS_BADGE: Record<string, { label: string; cls: string; icon: any }> = {
  sent: { label: 'Balance due', cls: 'bg-[#EEF6FB] text-[#2D7BA6]',   icon: Send },
  paid: { label: 'Paid',        cls: 'bg-[#E6F6F2] text-[#1A7D5A]',   icon: CheckCircle2 },
}

export function PatientBillingList({
  statements,
  loading,
  error,
  showPatientName = false,
  emptyLabel = 'No statements yet.',
}: {
  statements: BillingStatement[]
  loading: boolean
  error: string | null
  showPatientName?: boolean
  emptyLabel?: string
}) {
  if (loading) {
    return <div className="text-[13px] text-[#1A1A2E]/60 py-8 text-center">Loading statements…</div>
  }
  if (error) {
    return <div className="text-[13px] text-red-600 py-8 text-center">{error}</div>
  }
  if (!statements.length) {
    return (
      <div className="bg-white border border-[#E8E8E4] rounded-xl p-10 text-center shadow-sm">
        <Receipt size={28} className="text-[#aeaeb2] mx-auto mb-3" />
        <div className="text-[13px] text-[#1A1A2E]">{emptyLabel}</div>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {statements.map(stmt => (
        <StatementCard key={stmt.id} stmt={stmt} showPatientName={showPatientName} />
      ))}
    </div>
  )
}

function StatementCard({ stmt, showPatientName }: { stmt: BillingStatement; showPatientName: boolean }) {
  const [expanded, setExpanded] = useState(false)
  const badge = STATUS_BADGE[stmt.status] ?? STATUS_BADGE.sent
  const Icon = badge.icon
  const isUnpaid = stmt.status === 'sent'
  const patientName = [stmt.patient_first_name, stmt.patient_last_name].filter(Boolean).join(' ').trim() || '—'
  const cpts: any[] = Array.isArray(stmt.cpt_codes) ? stmt.cpt_codes : []

  // Financial rows — only render lines that have a value. Parents will
  // see just what applies to their statement, no zero-line clutter.
  const finRows: { label: string; value: any; emphasize?: boolean }[] = [
    { label: 'Amount billed', value: stmt.amount_billed },
    { label: 'Insurance payment', value: stmt.insurance_payment },
    { label: 'Contractual adjustment', value: stmt.contractual_adjustment },
    { label: 'Copay', value: stmt.patient_copay },
    { label: 'Deductible', value: stmt.patient_deductible },
    { label: 'Coinsurance', value: stmt.patient_coinsurance },
    { label: 'Non-covered services', value: stmt.patient_non_covered },
    { label: 'Prior balance', value: stmt.prior_balance },
    { label: 'Remaining balance', value: stmt.remaining_balance },
  ].filter(r => r.value != null && String(r.value).trim() !== '' && parseFloat(String(r.value)) !== 0)

  return (
    <div className="bg-white border border-[#E8E8E4] rounded-xl shadow-sm overflow-hidden">
      {/* Summary row — clickable to expand */}
      <button
        onClick={() => setExpanded(v => !v)}
        className="w-full text-left px-4 py-4 hover:bg-[#FAFAF8] transition-colors">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              {showPatientName && (
                <span className="font-display text-[14px] font-medium text-[#1A1A2E]">{patientName}</span>
              )}
              <span className="font-display text-[14px] font-medium text-[#1A1A2E]">
                {stmt.visit_type || 'Visit'}
              </span>
              <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium ${badge.cls}`}>
                <Icon size={11} />
                {badge.label}
              </span>
            </div>
            <div className="flex items-center gap-3 mt-1 text-[12px] text-[#555] flex-wrap">
              <span>Date of service: {fmtDate(stmt.service_date)}</span>
              {stmt.payer_name && <span>· {stmt.payer_name}</span>}
              {stmt.provider_name && <span>· {stmt.provider_name}</span>}
            </div>
            {stmt.status === 'paid' && stmt.paid_at && (
              <div className="text-[11px] text-[#1D9E75] mt-1 font-medium">
                Paid {fmtDate(stmt.paid_at)}
                {stmt.paid_amount_cents ? ` · $${(stmt.paid_amount_cents / 100).toFixed(2)}` : ''}
              </div>
            )}
            {stmt.status === 'sent' && stmt.sent_at && (
              <div className="text-[11px] text-[#1A1A2E]/60 mt-1">Sent {fmtDate(stmt.sent_at)}</div>
            )}
          </div>
          <div className="flex flex-col items-end gap-2 flex-shrink-0">
            <div className="font-display text-lg font-semibold text-[#1A1A2E] tabular-nums">
              {fmtMoney(stmt.total_amount_due)}
            </div>
            {isUnpaid && stmt.square_payment_url && (
              <a
                href={stmt.square_payment_url}
                target="_blank"
                rel="noopener noreferrer"
                onClick={e => e.stopPropagation()}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-[#1D9E75] text-white text-[12px] font-medium rounded-lg hover:bg-[#178860] transition-colors">
                <ExternalLink size={12} /> Pay now
              </a>
            )}
            <div className="flex items-center gap-1 text-[11px] text-[#7F77DD] font-medium">
              {expanded ? 'Hide details' : 'View full statement'}
              <ChevronDown size={12} className={`transition-transform ${expanded ? 'rotate-180' : ''}`} />
            </div>
          </div>
        </div>
      </button>

      {/* Expanded detail */}
      {expanded && (
        <div className="border-t border-[#E8E8E4] bg-[#FAFAF8] px-4 py-4 space-y-5">
          {/* Encounter details */}
          <div>
            <div className="text-[10px] font-semibold text-[#1A1A2E] uppercase tracking-wider mb-2">Encounter</div>
            <div className="bg-white border border-[#E8E8E4] rounded-lg p-3 space-y-2">
              <div className="grid grid-cols-3 gap-3 text-[12px]">
                <div>
                  <div className="text-[10px] text-[#1A1A2E]/60 uppercase mb-0.5">Patient</div>
                  <div className="text-[#1A1A2E] font-medium">{patientName}</div>
                </div>
                <div>
                  <div className="text-[10px] text-[#1A1A2E]/60 uppercase mb-0.5">DOB</div>
                  <div className="text-[#1A1A2E]">{fmtDate(stmt.patient_dob)}</div>
                </div>
                <div>
                  <div className="text-[10px] text-[#1A1A2E]/60 uppercase mb-0.5">Date of Service</div>
                  <div className="text-[#1A1A2E]">{fmtDate(stmt.service_date)}</div>
                </div>
              </div>
              {cpts.length > 0 && (
                <div className="pt-2 border-t border-[#E8E8E4]">
                  <div className="text-[10px] text-[#1A1A2E]/60 uppercase mb-1.5">Services Provided</div>
                  <div className="space-y-1">
                    {cpts.map((c: any, i: number) => (
                      <div key={c.code ?? i} className="flex items-center gap-2 text-[12px]">
                        <span className="font-semibold text-[#7F77DD] w-14 flex-shrink-0">{c.code}</span>
                        <span className="text-[#555] flex-1">{c.description || '—'}</span>
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

          {/* Financial breakdown */}
          <div>
            <div className="text-[10px] font-semibold text-[#1A1A2E] uppercase tracking-wider mb-2">Financial Summary</div>
            <div className="bg-white border border-[#E8E8E4] rounded-lg p-3 space-y-1.5 text-[12px]">
              {finRows.length === 0 ? (
                <div className="text-[#1A1A2E]/60">No breakdown available.</div>
              ) : (
                finRows.map(row => (
                  <div key={row.label} className="flex items-center justify-between">
                    <span className="text-[#555]">{row.label}</span>
                    <span className="text-[#1A1A2E] tabular-nums">{fmtMoney(row.value)}</span>
                  </div>
                ))
              )}
              <div className="border-t border-[#E8E8E4] pt-2 mt-2 flex items-center justify-between">
                <span className="font-semibold text-[#1A1A2E]">Total amount due</span>
                <span className="font-display text-[15px] font-semibold text-[#1A1A2E] tabular-nums">
                  {fmtMoney(stmt.total_amount_due)}
                </span>
              </div>
              {stmt.status === 'paid' && stmt.paid_amount_cents ? (
                <div className="border-t border-[#E8E8E4] pt-2 flex items-center justify-between">
                  <span className="text-[#1D9E75] font-semibold">Paid {fmtDate(stmt.paid_at)}</span>
                  <span className="text-[#1D9E75] font-semibold tabular-nums">
                    ${(stmt.paid_amount_cents / 100).toFixed(2)}
                  </span>
                </div>
              ) : null}
            </div>
          </div>

          {isUnpaid && stmt.square_payment_url && (
            <div className="flex justify-end">
              <a
                href={stmt.square_payment_url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 px-4 py-2 bg-[#1D9E75] text-white text-[13px] font-medium rounded-lg hover:bg-[#178860] transition-colors">
                <ExternalLink size={13} /> Pay this statement now
              </a>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
