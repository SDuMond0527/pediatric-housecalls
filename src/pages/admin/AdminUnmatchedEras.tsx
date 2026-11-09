import { useEffect, useMemo, useState } from 'react'
import { format } from 'date-fns'
import { RefreshCw, Search, Link as LinkIcon, FileText, AlertCircle, X, CheckCircle2 } from 'lucide-react'
import { inspectUnmatchedEras, attachEraToClaim, getClaims } from '../../lib/api'

// Manual-attach surface for ERAs that landed at Stedi but never joined
// to a claim in our DB. Almost always an "Andrea resubmitted outside
// GoRoam" situation — Stedi has their own join key, we have ours, they
// don't line up. Sara 2026-11-09.

type EraSubClaim = {
  patient_control_number: string | null
  payer_claim_control_number: string | null
  total_claim_charge: number | null
  insurance_payment: number | null
  patient_first: string | null
  patient_last: string | null
  service_dates: string[]
}
type UnmatchedEra = {
  transaction_id: string
  source: string
  processed_at: string
  payer_name: string | null
  claim_count: number
  claims: EraSubClaim[]
  error?: string
}

function fmtDate(d: string | null | undefined) {
  if (!d) return '—'
  try {
    const s = String(d).split('T')[0]
    const [y, m, day] = s.split('-').map(Number)
    return format(new Date(y, m - 1, day), 'MMM d, yyyy')
  } catch { return d ?? '—' }
}
function fmtMoney(n: number | null | undefined) {
  if (n == null) return '—'
  return `$${(+n).toFixed(2)}`
}

export function AdminUnmatchedEras() {
  const [eras, setEras] = useState<UnmatchedEra[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')
  const [attachTarget, setAttachTarget] = useState<{
    era: UnmatchedEra
    subClaim: EraSubClaim
    subClaimIndex: number
  } | null>(null)

  async function load() {
    setLoading(true)
    setErr('')
    try {
      const r = await inspectUnmatchedEras(120)
      // Keep only genuine 835 ERAs (the "webhook" source). The 277
      // acknowledgment transactions are routing receipts, not payments.
      const filtered = (r.results as UnmatchedEra[]).filter(e => e.source === 'webhook' && !e.error && e.claim_count > 0)
      setEras(filtered)
    } catch (e: any) {
      setErr(e?.message ?? 'Failed to load unmatched ERAs')
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { void load() }, [])

  return (
    <div className="max-w-6xl mx-auto px-6 py-6">
      <div className="flex items-start justify-between mb-5 gap-4">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <LinkIcon size={20} className="text-[#7F77DD]" />
            <h1 className="text-[24px] font-display font-medium text-[#1A1A2E] leading-tight">Unmatched ERAs</h1>
          </div>
          <p className="text-[13px] text-[#555] leading-snug max-w-2xl">
            Payer remittances that landed at Stedi but couldn't be matched to a claim in GoRoam — usually because the claim was resubmitted outside the platform. Attach each one to its real claim to post the payment and keep the AR clean.
          </p>
        </div>
        <button onClick={() => void load()} disabled={loading}
          className="inline-flex items-center gap-1.5 text-[12px] text-[#555] hover:text-[#1A1A2E] border border-[#E8E8E4] rounded-lg px-3 py-1.5 bg-white hover:bg-[#F1EFE8] disabled:opacity-50">
          <RefreshCw size={12} className={loading ? 'animate-spin' : ''} /> Refresh
        </button>
      </div>

      {err && (
        <div className="mb-4 rounded-lg border border-[#DC2626] bg-[#FEE2E2] text-[#7F1D1D] px-3 py-2 text-[12px]">
          {err}
        </div>
      )}

      {loading && eras.length === 0 && (
        <div className="text-[13px] text-[#555] py-16 text-center">Loading from Stedi…</div>
      )}

      {!loading && eras.length === 0 && !err && (
        <div className="rounded-xl border border-dashed border-[#E8E8E4] bg-[#FAFAF8] px-6 py-10 text-center">
          <CheckCircle2 size={32} className="mx-auto text-[#1D9E75] mb-2 opacity-70" />
          <div className="text-[14px] font-medium text-[#1A1A2E] mb-1">All ERAs are matched.</div>
          <p className="text-[12px] text-[#555]">Nothing waiting for attention.</p>
        </div>
      )}

      <div className="space-y-3">
        {eras.map(era => (
          <div key={era.transaction_id} className="bg-white border border-[#E8E8E4] rounded-xl overflow-hidden">
            <div className="px-4 py-3 border-b border-[#F1EFE8] bg-[#FAFAF8] flex items-center justify-between gap-3">
              <div>
                <div className="text-[13px] font-medium text-[#1A1A2E]">
                  {era.payer_name ?? 'Unknown payer'}
                  <span className="text-[11px] text-[#777] font-normal ml-2">· Arrived at Stedi {fmtDate(era.processed_at)}</span>
                </div>
                <div className="text-[11px] text-[#777] mt-0.5 font-mono">Stedi transaction: {era.transaction_id.slice(0, 16)}…</div>
              </div>
              <div className="text-[11px] text-[#777]">
                {era.claim_count} claim{era.claim_count === 1 ? '' : 's'} in this ERA
              </div>
            </div>
            <div className="divide-y divide-[#F1EFE8]">
              {era.claims.map((sub, i) => {
                const patientName = [sub.patient_first, sub.patient_last].filter(Boolean).join(' ') || 'Unknown patient'
                return (
                  <div key={i} className="px-4 py-3 flex items-start justify-between gap-4">
                    <div className="flex-1 min-w-0">
                      <div className="text-[13px] font-medium text-[#1A1A2E]">{patientName}</div>
                      <div className="text-[11px] text-[#555] mt-0.5">
                        PCN sent to payer: <span className="font-mono">{sub.patient_control_number ?? '—'}</span>
                        {sub.payer_claim_control_number && <> · Payer ref: <span className="font-mono">{sub.payer_claim_control_number}</span></>}
                      </div>
                      <div className="text-[11px] text-[#555]">
                        {sub.service_dates.length > 0 && <>Service date(s): {sub.service_dates.map(d => fmtDate(d)).join(', ')} · </>}
                        Billed <span className="font-semibold text-[#1A1A2E]">{fmtMoney(sub.total_claim_charge)}</span> ·
                        Insurance paid <span className="font-semibold text-[#1D9E75]">{fmtMoney(sub.insurance_payment)}</span>
                      </div>
                    </div>
                    <button onClick={() => setAttachTarget({ era, subClaim: sub, subClaimIndex: i })}
                      className="inline-flex items-center gap-1.5 text-[12px] font-medium text-white bg-[#7F77DD] hover:bg-[#6B64C8] rounded-lg px-3 py-1.5">
                      <LinkIcon size={12} /> Attach to claim…
                    </button>
                  </div>
                )
              })}
            </div>
          </div>
        ))}
      </div>

      {attachTarget && (
        <AttachModal
          target={attachTarget}
          onClose={() => setAttachTarget(null)}
          onAttached={() => { setAttachTarget(null); void load() }}
        />
      )}
    </div>
  )
}

function AttachModal({
  target, onClose, onAttached,
}: {
  target: { era: UnmatchedEra; subClaim: EraSubClaim; subClaimIndex: number }
  onClose: () => void
  onAttached: () => void
}) {
  const [allClaims, setAllClaims] = useState<any[]>([])
  const [loadingClaims, setLoadingClaims] = useState(true)
  const [query, setQuery] = useState(
    [target.subClaim.patient_first, target.subClaim.patient_last].filter(Boolean).join(' ')
  )
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [attaching, setAttaching] = useState(false)
  const [err, setErr] = useState('')

  useEffect(() => {
    (async () => {
      setLoadingClaims(true)
      try {
        // Fetch a wide set — the picker filters client-side. Anything the
        // biller might want to attach an ERA to lives in 'submitted' or
        // 'pending_review' or 'error'. Exclude self-pay since ERAs don't
        // apply to those.
        const results = await Promise.all([
          getClaims('submitted'),
          getClaims('pending_review'),
          getClaims('error'),
        ])
        const merged = ([] as any[]).concat(...results)
        setAllClaims(merged)
      } catch (e: any) {
        setErr(e?.message ?? 'Failed to load claims')
      } finally {
        setLoadingClaims(false)
      }
    })()
  }, [])

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return allClaims.slice(0, 20)
    const scored = allClaims.map((c: any) => {
      const name = [c.patient_first_name, c.patient_last_name].filter(Boolean).join(' ').toLowerCase()
      const pcn = String(c.payer_control_number ?? '').toLowerCase()
      const stedi = String(c.stedi_claim_id ?? '').toLowerCase()
      let score = 0
      if (name.includes(q)) score += 10
      if (pcn.includes(q)) score += 5
      if (stedi.includes(q)) score += 5
      return { c, score }
    }).filter(x => x.score > 0)
    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, 20).map(x => x.c)
  }, [allClaims, query])

  async function doAttach() {
    if (!selectedId) return
    if (!window.confirm(
      `Attach this ERA to the selected claim? The payment amounts from the 835 will overwrite any current ERA fields. This can't be undone through the UI.`,
    )) return
    setAttaching(true)
    setErr('')
    try {
      await attachEraToClaim(target.era.transaction_id, selectedId, target.subClaimIndex)
      onAttached()
    } catch (e: any) {
      setErr(e?.message ?? 'Attach failed')
    } finally {
      setAttaching(false)
    }
  }

  const patientName = [target.subClaim.patient_first, target.subClaim.patient_last].filter(Boolean).join(' ') || 'Unknown patient'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4"
         onClick={onClose}>
      <div className="bg-white rounded-xl shadow-2xl max-w-2xl w-full max-h-[90vh] overflow-hidden flex flex-col"
           onClick={e => e.stopPropagation()}>
        <div className="px-5 py-3 border-b border-[#E8E8E4] flex items-center justify-between">
          <div className="font-display text-[15px] font-medium text-[#1A1A2E]">Attach ERA to claim</div>
          <button onClick={onClose} className="text-[#777] hover:text-[#1A1A2E]"><X size={16} /></button>
        </div>
        <div className="px-5 py-3 bg-[#FAFAF8] border-b border-[#E8E8E4]">
          <div className="text-[11px] text-[#777] uppercase tracking-wider mb-1">ERA from Stedi</div>
          <div className="text-[13px] font-medium text-[#1A1A2E]">{patientName} — {target.era.payer_name ?? 'Unknown payer'}</div>
          <div className="text-[11px] text-[#555] mt-0.5">
            {target.subClaim.service_dates.length > 0 && <>Service: {target.subClaim.service_dates.map(d => fmtDate(d)).join(', ')} · </>}
            Billed {fmtMoney(target.subClaim.total_claim_charge)} · Paid {fmtMoney(target.subClaim.insurance_payment)}
          </div>
        </div>

        <div className="px-5 py-3 border-b border-[#F1EFE8]">
          <div className="relative">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#777]" />
            <input type="text" placeholder="Search claim by patient name, PCN, or Stedi ID…"
              value={query} onChange={e => { setQuery(e.target.value); setSelectedId(null) }}
              className="w-full pl-9 pr-3 py-2 border border-[#E8E8E4] rounded-lg text-[13px] outline-none focus:border-[#7F77DD]" />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto">
          {loadingClaims && <div className="px-5 py-6 text-[13px] text-[#555] text-center">Loading claims…</div>}
          {!loadingClaims && matches.length === 0 && (
            <div className="px-5 py-6 text-[13px] text-[#555] text-center">
              {query ? `No open claims match "${query}".` : 'Type a patient name or Stedi ID to search.'}
            </div>
          )}
          {matches.map((c: any) => {
            const name = [c.patient_first_name, c.patient_last_name].filter(Boolean).join(' ') || 'Unknown'
            const isSelected = selectedId === c.id
            return (
              <button key={c.id} onClick={() => setSelectedId(c.id)}
                className={`w-full text-left px-5 py-3 border-b border-[#F1EFE8] transition-colors ${
                  isSelected ? 'bg-[#EEEDFE]' : 'hover:bg-[#FAFAF8]'
                }`}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-[13px] font-medium text-[#1A1A2E]">{name}</div>
                    <div className="text-[11px] text-[#555] mt-0.5">
                      {c.payer_name ?? 'Unknown payer'} · DOS {fmtDate(c.service_date)} · {c.status}
                      {c.era_received_at && (
                        <span className="ml-2 text-[#B45309]"> · already has ERA — attaching will fail</span>
                      )}
                    </div>
                    <div className="text-[10px] text-[#777] mt-0.5 font-mono">
                      PCN {c.payer_control_number ?? '—'} · Stedi {c.stedi_claim_id ? c.stedi_claim_id.slice(0, 12) + '…' : '—'}
                    </div>
                  </div>
                  {isSelected && <CheckCircle2 size={16} className="text-[#7F77DD] flex-shrink-0 mt-0.5" />}
                </div>
              </button>
            )
          })}
        </div>

        {err && (
          <div className="px-5 py-2 bg-[#FEE2E2] text-[#7F1D1D] text-[12px] border-t border-[#DC2626] flex items-start gap-2">
            <AlertCircle size={13} className="flex-shrink-0 mt-0.5" /> {err}
          </div>
        )}

        <div className="px-5 py-3 border-t border-[#E8E8E4] bg-[#FAFAF8] flex items-center justify-end gap-2">
          <button onClick={onClose} className="text-[13px] text-[#555] hover:text-[#1A1A2E] px-3 py-1.5">Cancel</button>
          <button onClick={() => void doAttach()}
            disabled={!selectedId || attaching}
            className="inline-flex items-center gap-1.5 text-[13px] font-medium text-white bg-[#7F77DD] hover:bg-[#6B64C8] rounded-lg px-4 py-1.5 disabled:opacity-50 disabled:cursor-not-allowed">
            <FileText size={12} /> {attaching ? 'Attaching…' : 'Attach ERA'}
          </button>
        </div>
      </div>
    </div>
  )
}
