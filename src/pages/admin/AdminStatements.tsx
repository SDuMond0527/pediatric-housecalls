import { useEffect, useState } from 'react'
import { format } from 'date-fns'
import { Receipt, CheckCircle2, Clock, Send, ExternalLink, RefreshCw } from 'lucide-react'
import { getAllPatientStatements } from '../../lib/api'
import { PatientStatementModal } from './PatientStatementModal'

type StatusFilter = 'all' | 'draft' | 'sent' | 'paid'

const STATUS_BADGE: Record<string, { label: string; cls: string; icon: any }> = {
  draft: { label: 'Draft',  cls: 'bg-[#F1EFE8] text-[#777]',         icon: Clock },
  sent:  { label: 'Sent',   cls: 'bg-[#EEF6FB] text-[#2D7BA6]',      icon: Send },
  paid:  { label: 'Paid',   cls: 'bg-[#E6F6F2] text-[#1A7D5A]',      icon: CheckCircle2 },
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

function fmtDateTime(d: string | null | undefined) {
  if (!d) return '—'
  try { return format(new Date(d), 'MMM d, yyyy h:mm a') }
  catch { return d ?? '—' }
}

export function AdminStatements() {
  const [statements, setStatements] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<StatusFilter>('all')
  const [statementClaim, setStatementClaim] = useState<any>(null)

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const data = await getAllPatientStatements(filter === 'all' ? undefined : filter)
      setStatements(data ?? [])
    } catch (e: any) {
      setError(e.message || 'Failed to load statements')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [filter])

  const totalOutstanding = statements
    .filter(s => s.status === 'sent')
    .reduce((sum, s) => sum + (parseFloat(s.total_amount_due ?? 0) || 0), 0)

  const totalPaid = statements
    .filter(s => s.status === 'paid')
    .reduce((sum, s) => sum + ((s.paid_amount_cents ?? 0) / 100), 0)

  const FILTERS: { key: StatusFilter; label: string }[] = [
    { key: 'all',   label: 'All' },
    { key: 'sent',  label: 'Sent / Unpaid' },
    { key: 'paid',  label: 'Paid' },
    { key: 'draft', label: 'Draft' },
  ]

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-[#7F77DD]/10 flex items-center justify-center">
            <Receipt size={18} className="text-[#7F77DD]" />
          </div>
          <div>
            <h1 className="font-display text-xl font-semibold text-[#1A1A2E]">Patient Statements</h1>
            <p className="text-[12px] text-[#999] mt-0.5">Track sent statements and payments</p>
          </div>
        </div>
        <button onClick={load} disabled={loading}
          className="flex items-center gap-1.5 px-3 py-2 text-[12px] font-medium text-[#666] border border-[#E8E8E4] rounded-lg bg-white hover:bg-[#F1EFE8] transition-all disabled:opacity-50">
          <RefreshCw size={13} className={loading ? 'animate-spin' : ''} /> Refresh
        </button>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-3 gap-4 mb-6">
        <div className="bg-white border border-[#E8E8E4] rounded-xl p-4 shadow-sm">
          <div className="text-[11px] font-semibold text-[#999] uppercase tracking-wide mb-1">Outstanding</div>
          <div className="font-display text-2xl font-semibold text-[#EF9F27]">${totalOutstanding.toFixed(2)}</div>
          <div className="text-[11px] text-[#999] mt-0.5">{statements.filter(s => s.status === 'sent').length} statement{statements.filter(s => s.status === 'sent').length !== 1 ? 's' : ''} sent</div>
        </div>
        <div className="bg-white border border-[#E8E8E4] rounded-xl p-4 shadow-sm">
          <div className="text-[11px] font-semibold text-[#999] uppercase tracking-wide mb-1">Collected</div>
          <div className="font-display text-2xl font-semibold text-[#1D9E75]">${totalPaid.toFixed(2)}</div>
          <div className="text-[11px] text-[#999] mt-0.5">{statements.filter(s => s.status === 'paid').length} payment{statements.filter(s => s.status === 'paid').length !== 1 ? 's' : ''} received</div>
        </div>
        <div className="bg-white border border-[#E8E8E4] rounded-xl p-4 shadow-sm">
          <div className="text-[11px] font-semibold text-[#999] uppercase tracking-wide mb-1">Drafts</div>
          <div className="font-display text-2xl font-semibold text-[#1A1A2E]">{statements.filter(s => s.status === 'draft').length}</div>
          <div className="text-[11px] text-[#999] mt-0.5">Not yet sent</div>
        </div>
      </div>

      {/* Filter tabs */}
      <div className="flex rounded-lg border border-[#E8E8E4] overflow-hidden bg-white mb-4 w-fit">
        {FILTERS.map(f => (
          <button key={f.key} onClick={() => setFilter(f.key)}
            className={`px-4 py-2 text-[12px] font-medium transition-all ${filter === f.key ? 'bg-[#7F77DD] text-white' : 'text-[#666] hover:bg-[#F1EFE8]'}`}>
            {f.label}
          </button>
        ))}
      </div>

      {/* Table */}
      <div className="bg-white border border-[#E8E8E4] rounded-xl overflow-hidden shadow-sm">
        {loading ? (
          <div className="flex items-center justify-center h-48 text-[13px] text-[#999]">Loading…</div>
        ) : error ? (
          <div className="flex items-center justify-center h-48 text-[13px] text-red-500">{error}</div>
        ) : statements.length === 0 ? (
          <div className="flex items-center justify-center h-48 text-[13px] text-[#999]">No statements found</div>
        ) : (
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-b border-[#E8E8E4] bg-[#FAFAF8]">
                <th className="text-left px-4 py-3 text-[11px] font-semibold text-[#999] uppercase tracking-wide">Patient</th>
                <th className="text-left px-4 py-3 text-[11px] font-semibold text-[#999] uppercase tracking-wide">DOS</th>
                <th className="text-left px-4 py-3 text-[11px] font-semibold text-[#999] uppercase tracking-wide">Payer</th>
                <th className="text-right px-4 py-3 text-[11px] font-semibold text-[#999] uppercase tracking-wide">Amount Due</th>
                <th className="text-left px-4 py-3 text-[11px] font-semibold text-[#999] uppercase tracking-wide">Status</th>
                <th className="text-left px-4 py-3 text-[11px] font-semibold text-[#999] uppercase tracking-wide">Sent</th>
                <th className="text-left px-4 py-3 text-[11px] font-semibold text-[#999] uppercase tracking-wide">Paid</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#F1EFE8]">
              {statements.map(stmt => {
                const badge = STATUS_BADGE[stmt.status] ?? STATUS_BADGE.draft
                const Icon = badge.icon
                return (
                  <tr key={stmt.id} className="hover:bg-[#FAFAF8] transition-colors">
                    <td className="px-4 py-3">
                      <div className="font-medium text-[#1A1A2E]">
                        {[stmt.patient_first_name, stmt.patient_last_name].filter(Boolean).join(' ') || '—'}
                      </div>
                      {stmt.patient_email && <div className="text-[11px] text-[#999] mt-0.5">{stmt.patient_email}</div>}
                    </td>
                    <td className="px-4 py-3 text-[#555] tabular-nums">{fmtDate(stmt.date_of_service)}</td>
                    <td className="px-4 py-3 text-[#555]">{stmt.payer_name ?? '—'}</td>
                    <td className="px-4 py-3 text-right font-semibold text-[#1A1A2E] tabular-nums">
                      {fmtMoney(stmt.total_amount_due)}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium ${badge.cls}`}>
                        <Icon size={11} />
                        {badge.label}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-[#999] text-[12px]">{fmtDateTime(stmt.sent_at)}</td>
                    <td className="px-4 py-3 text-[12px]">
                      {stmt.paid_at ? (
                        <div>
                          <div className="text-[#1D9E75] font-medium">{fmtDateTime(stmt.paid_at)}</div>
                          {stmt.paid_amount_cents && (
                            <div className="text-[11px] text-[#999]">${(stmt.paid_amount_cents / 100).toFixed(2)}</div>
                          )}
                        </div>
                      ) : '—'}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2 justify-end">
                        {stmt.square_payment_url && (
                          <a href={stmt.square_payment_url} target="_blank" rel="noopener noreferrer"
                            className="text-[#7F77DD] hover:text-[#6C64C8]" title="View payment link">
                            <ExternalLink size={14} />
                          </a>
                        )}
                        {stmt.claim_id && (
                          <button
                            onClick={() => setStatementClaim({ id: stmt.claim_id, payer_name: stmt.payer_name })}
                            className="text-[11px] text-[#666] border border-[#E8E8E4] px-2 py-1 rounded hover:bg-[#F1EFE8] transition-colors">
                            Edit
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>

      {statementClaim && (
        <PatientStatementModal
          claim={statementClaim}
          onClose={() => setStatementClaim(null)}
          onSent={() => { setStatementClaim(null); load() }}
        />
      )}
    </div>
  )
}
