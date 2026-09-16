import { format } from 'date-fns'
import { CheckCircle2, Send, ExternalLink, Receipt } from 'lucide-react'

export type BillingStatement = {
  id: string
  status: string
  visit_type: string | null
  provider_name: string | null
  total_amount_due: string | null
  square_payment_url: string | null
  sent_at: string | null
  paid_at: string | null
  paid_amount_cents: number | null
  created_at: string | null
  payer_name?: string | null
  patient_first_name?: string | null
  patient_last_name?: string | null
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
  /** Show patient name column — true on the family dashboard, false on a single-child chart. */
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
      {statements.map(stmt => {
        const badge = STATUS_BADGE[stmt.status] ?? STATUS_BADGE.sent
        const Icon = badge.icon
        const isUnpaid = stmt.status === 'sent'
        const patientName = [stmt.patient_first_name, stmt.patient_last_name].filter(Boolean).join(' ').trim() || '—'
        return (
          <div key={stmt.id} className="bg-white border border-[#E8E8E4] rounded-xl p-4 shadow-sm">
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
                  <a href={stmt.square_payment_url} target="_blank" rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-[#1D9E75] text-white text-[12px] font-medium rounded-lg hover:bg-[#178860] transition-colors">
                    <ExternalLink size={12} /> Pay now
                  </a>
                )}
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}
