import { useEffect, useMemo, useState } from 'react'
import { format } from 'date-fns'
import { Check, Undo2, Edit3, Save, X, AlertOctagon, Link as LinkIcon, Clock } from 'lucide-react'
import { getConvenienceFeeCharges, updateConvenienceFeeCharge, triggerCvAutoCharge, type ConvenienceFeeCharge } from '../../lib/api'
import { Zap } from 'lucide-react'

type StatusFilter = 'all' | ConvenienceFeeCharge['status']

const STATUS_LABEL: Record<ConvenienceFeeCharge['status'], string> = {
  pending:           'Pending',
  auto_charged:      'Auto-charged',
  link_sent:         'Link sent',
  paid_via_link:     'Paid (link)',
  failed:            'Failed',
  manually_charged:  'Charged manually',
  reversed:          'Reversed',
}

function fmtDollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`
}
function fmtDate(s: string | null): string {
  if (!s) return '—'
  try { return format(new Date(s), 'MMM d, yyyy') } catch { return s }
}
function fmtTimestamp(s: string | null): string {
  if (!s) return '—'
  try { return format(new Date(s), 'MMM d, yyyy · h:mm a') } catch { return s }
}

export function AdminConvenienceFees() {
  const [rows, setRows] = useState<ConvenienceFeeCharge[]>([])
  const [loading, setLoading] = useState(true)
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [savingId, setSavingId] = useState<string | null>(null)
  const [editingNotesId, setEditingNotesId] = useState<string | null>(null)
  const [notesDraft, setNotesDraft] = useState('')

  async function load() {
    setLoading(true)
    try {
      const data = await getConvenienceFeeCharges()
      setRows(data)
    } catch (e: any) {
      console.error('[AdminConvenienceFees] load failed:', e?.message)
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { load() }, [])

  const filtered = useMemo(() => {
    if (statusFilter === 'all') return rows
    return rows.filter(r => r.status === statusFilter)
  }, [rows, statusFilter])

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: rows.length }
    for (const r of rows) c[r.status] = (c[r.status] ?? 0) + 1
    return c
  }, [rows])

  async function markCharged(id: string) {
    setSavingId(id)
    // optimistic
    setRows(prev => prev.map(r => r.id === id ? { ...r, status: 'manually_charged', charged_at: new Date().toISOString() } : r))
    try { await updateConvenienceFeeCharge(id, { status: 'manually_charged' }) }
    catch (e: any) {
      console.error('[AdminConvenienceFees] markCharged failed:', e?.message)
      await load() // reload on failure
    } finally { setSavingId(null) }
  }

  async function undoChargedToPending(id: string) {
    setSavingId(id)
    setRows(prev => prev.map(r => r.id === id ? { ...r, status: 'pending', charged_at: null } : r))
    try { await updateConvenienceFeeCharge(id, { status: 'pending' }) }
    catch { await load() }
    finally { setSavingId(null) }
  }

  async function saveNotes(id: string) {
    setSavingId(id)
    try {
      const updated = await updateConvenienceFeeCharge(id, { pam_notes: notesDraft })
      setRows(prev => prev.map(r => r.id === id ? updated : r))
      setEditingNotesId(null)
    } catch (e: any) {
      console.error('[AdminConvenienceFees] saveNotes failed:', e?.message)
    } finally { setSavingId(null) }
  }

  return (
    <div className="max-w-6xl mx-auto px-4 py-6">
      <div className="mb-5">
        <h1 className="font-display text-[24px] font-medium text-[#1A1A2E]">Convenience Fees</h1>
        <p className="text-[13px] text-[#555] mt-1">
          One row per visit's convenience fee. Automation starts 2026-10-07 — pre-cutover
          visits don't appear here. Tick <strong>Mark charged</strong> once you've run the
          charge in Square. Notes save per row.
        </p>
      </div>

      {/* Status filter tabs */}
      <div className="flex items-center gap-2 flex-wrap mb-5 border-b border-[#E8E8E4] pb-3">
        {(['all', 'pending', 'manually_charged', 'auto_charged', 'link_sent', 'paid_via_link', 'failed', 'reversed'] as StatusFilter[]).map(s => (
          <button key={s}
            onClick={() => setStatusFilter(s)}
            className={`px-3 py-1.5 text-[12px] font-medium rounded-full border transition-colors ${statusFilter === s ? 'bg-[#1A1A2E] text-white border-[#1A1A2E]' : 'bg-white border-[#E8E8E4] text-[#1A1A2E] hover:border-[#AFA9EC]'}`}>
            {s === 'all' ? 'All' : STATUS_LABEL[s as ConvenienceFeeCharge['status']]}
            <span className="ml-1.5 opacity-70">({counts[s] ?? 0})</span>
          </button>
        ))}
      </div>

      {loading && <div className="text-center py-12 text-[#1A1A2E] text-[13px]">Loading…</div>}

      {!loading && filtered.length === 0 && (
        <div className="text-center py-16 bg-[#FAFAF8] border border-[#E8E8E4] rounded-xl">
          <div className="text-[14px] text-[#1A1A2E] font-medium mb-1">No convenience fees to show</div>
          <div className="text-[12px] text-[#555]">
            {statusFilter === 'all'
              ? 'Rows will appear here as visits with DOS ≥ 2026-10-07 are signed.'
              : `No rows with status "${STATUS_LABEL[statusFilter as ConvenienceFeeCharge['status']] ?? statusFilter}".`}
          </div>
        </div>
      )}

      <div className="space-y-2">
        {filtered.map(r => {
          const isPending = r.status === 'pending'
          const isCharged = r.status === 'manually_charged' || r.status === 'auto_charged' || r.status === 'paid_via_link'
          const isLink    = r.status === 'link_sent'
          const isFailed  = r.status === 'failed'
          const isReversed = r.status === 'reversed'
          const statusBg = isPending ? 'bg-[#FEF3E8] text-[#633806] border-[#F9C784]'
                        : isCharged ? 'bg-[#E1F5EE] text-[#085041] border-[#5DCAA5]'
                        : isLink    ? 'bg-[#EEEDFE] text-[#3C3489] border-[#AFA9EC]'
                        : isFailed  ? 'bg-[#FEE4E2] text-[#791F1F] border-[#D97373]'
                        : isReversed ? 'bg-[#F3F4F6] text-[#555] border-[#E8E8E4]'
                        : 'bg-[#F3F4F6] text-[#555] border-[#E8E8E4]'
          return (
            <div key={r.id} className="bg-white border border-[#E8E8E4] rounded-xl p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap mb-1">
                    <div className="font-display text-[15px] font-medium text-[#1A1A2E]">{r.patient_name ?? '(no name)'}</div>
                    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[10px] font-semibold ${statusBg}`}>
                      {isPending && <Clock size={10} />}
                      {isCharged && <Check size={10} />}
                      {isLink && <LinkIcon size={10} />}
                      {isFailed && <AlertOctagon size={10} />}
                      {isReversed && <Undo2 size={10} />}
                      {STATUS_LABEL[r.status]}
                    </span>
                  </div>
                  <div className="text-[12px] text-[#555]">
                    DOS {fmtDate(r.service_date)} · {r.provider_name ?? '(no provider)'} · <strong>{r.cv_code}</strong> {fmtDollars(r.amount_cents)}
                  </div>
                  {r.charged_at && <div className="text-[11px] text-[#085041] mt-1">Charged {fmtTimestamp(r.charged_at)}</div>}
                  {r.link_sent_at && <div className="text-[11px] text-[#3C3489] mt-1">Link sent {fmtTimestamp(r.link_sent_at)}</div>}
                  {r.paid_at && <div className="text-[11px] text-[#085041] mt-1">Paid {fmtTimestamp(r.paid_at)}</div>}
                  {r.failed_at && <div className="text-[11px] text-[#791F1F] mt-1">Failed {fmtTimestamp(r.failed_at)}{r.failure_reason ? ` · ${r.failure_reason}` : ''}</div>}
                  {r.reversed_at && <div className="text-[11px] text-[#555] mt-1">Reversed {fmtTimestamp(r.reversed_at)} by {r.reversed_by ?? '—'}{r.reversal_reason ? ` · ${r.reversal_reason}` : ''}</div>}
                </div>

                <div className="flex items-center gap-2 flex-shrink-0">
                  {isPending && (
                    <button
                      onClick={async () => {
                        if (!window.confirm(`Charge the family's card on file $${(r.amount_cents/100).toFixed(2)} for this convenience fee?\n\nUses Square direct charge. Card must be on file; otherwise this will fail and you can run it manually in Square.`)) return
                        setSavingId(r.id)
                        try {
                          const result = await triggerCvAutoCharge(r.id)
                          if (result.ok) {
                            setRows(prev => prev.map(x => x.id === r.id ? { ...x, status: 'auto_charged', charged_at: new Date().toISOString(), square_payment_id: result.square_payment_id ?? null } : x))
                          } else {
                            alert('Charge failed: ' + (result.error ?? 'unknown'))
                            await load()
                          }
                        } catch (e: any) {
                          alert('Charge failed: ' + (e?.message ?? String(e)))
                          await load()
                        } finally {
                          setSavingId(null)
                        }
                      }}
                      disabled={savingId === r.id}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[12px] font-semibold bg-[#7F77DD] text-white hover:bg-[#534AB7] transition-colors disabled:opacity-50"
                      title="Charge the card on file for this fee via Square.">
                      <Zap size={12} /> Charge card now
                    </button>
                  )}
                  {isPending && (
                    <button
                      onClick={() => markCharged(r.id)}
                      disabled={savingId === r.id}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[12px] font-semibold bg-[#1D9E75] text-white hover:bg-[#167a5b] transition-colors disabled:opacity-50"
                      title="Mark this fee as charged manually in Square">
                      <Check size={12} /> Mark charged
                    </button>
                  )}
                  {(r.status === 'manually_charged') && (
                    <button
                      onClick={() => undoChargedToPending(r.id)}
                      disabled={savingId === r.id}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[12px] font-medium bg-white border border-[#E8E8E4] text-[#555] hover:border-[#D0D0CC] transition-colors disabled:opacity-50"
                      title="Undo — put back in pending">
                      <Undo2 size={12} /> Undo
                    </button>
                  )}
                </div>
              </div>

              {/* Notes */}
              <div className="mt-3 pt-3 border-t border-[#F3F4F6]">
                {editingNotesId === r.id ? (
                  <div className="flex items-start gap-2">
                    <textarea
                      value={notesDraft}
                      onChange={e => setNotesDraft(e.target.value)}
                      rows={3}
                      placeholder="Add a note about this convenience fee…"
                      className="flex-1 px-3 py-2 border border-[#AFA9EC] rounded-lg text-[13px] outline-none focus:border-[#7F77DD]" />
                    <div className="flex flex-col gap-1 flex-shrink-0">
                      <button
                        onClick={() => saveNotes(r.id)}
                        disabled={savingId === r.id}
                        className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-[12px] font-semibold bg-[#7F77DD] text-white hover:bg-[#534AB7] transition-colors disabled:opacity-50">
                        <Save size={12} /> Save
                      </button>
                      <button
                        onClick={() => { setEditingNotesId(null); setNotesDraft('') }}
                        className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-[12px] text-[#555] border border-[#E8E8E4] bg-white hover:border-[#D0D0CC] transition-colors">
                        <X size={12} /> Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1 text-[12px] text-[#1A1A2E] whitespace-pre-wrap">
                      {r.pam_notes ? (
                        <>
                          {r.pam_notes}
                          {r.pam_notes_updated_at && (
                            <div className="text-[10px] text-[#aaa] mt-1">— {r.pam_notes_updated_by ?? '—'}, {fmtTimestamp(r.pam_notes_updated_at)}</div>
                          )}
                        </>
                      ) : (
                        <span className="text-[#aaa] italic">No notes yet</span>
                      )}
                    </div>
                    <button
                      onClick={() => { setEditingNotesId(r.id); setNotesDraft(r.pam_notes ?? '') }}
                      className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-medium bg-white border border-[#E8E8E4] text-[#555] hover:border-[#AFA9EC] transition-colors flex-shrink-0">
                      <Edit3 size={11} /> {r.pam_notes ? 'Edit' : 'Add note'}
                    </button>
                  </div>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
