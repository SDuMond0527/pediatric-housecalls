import { useEffect, useState } from 'react'
import { X, ExternalLink, FileText, AlertCircle, CheckCircle, Clock, Download } from 'lucide-react'
import { getClaim, downloadClaim1500Pdf, downloadClaimEraPdf, markClaimDenialHandled } from '../../lib/api'
import { detectErraOutcome, outcomeLabel } from '../../lib/carcCodes'
import { ChartNumberPill } from '../../components/ChartNumberPill'
import { Button } from '../../components/ui/Button'

function fmtMoney(n: any) {
  const v = parseFloat(String(n ?? 0))
  return isNaN(v) ? '$0.00' : `$${v.toFixed(2)}`
}
function fmtDate(d: any) {
  if (!d) return null
  try {
    const dt = new Date(d)
    if (isNaN(dt.getTime())) return String(d).split('T')[0] || null
    return dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
  } catch { return String(d).split('T')[0] || null }
}
function ageDays(from: any): number | null {
  if (!from) return null
  const ms = Date.now() - new Date(from).getTime()
  if (!isFinite(ms)) return null
  return Math.max(0, Math.floor(ms / 86_400_000))
}
function extractStediErrorSummary(details: any): string | null {
  if (!details) return null
  if (typeof details === 'string') { try { return extractStediErrorSummary(JSON.parse(details)) ?? details } catch { return details } }
  if (Array.isArray(details?.errors) && details.errors.length) {
    return details.errors.map((e: any) => e.description || e.message || e.code || JSON.stringify(e)).join(' | ')
  }
  if (Array.isArray(details?.issues) && details.issues.length) {
    return details.issues.map((i: any) => `${i.path ?? ''}: ${i.message ?? JSON.stringify(i)}`).join(' | ')
  }
  if (details && typeof details === 'object' && !Array.isArray(details) && !details.status) {
    const entries = Object.entries(details)
    if (entries.length && entries.every(([, v]) => Array.isArray(v))) {
      return entries.map(([k, v]) => `${k}: ${(v as string[]).join(' ')}`).join(' | ')
    }
  }
  return details?.message ?? null
}

export function ClaimReviewModal({
  claimId,
  onClose,
  onOpenFullEditor,
}: {
  claimId: string
  onClose: () => void
  onOpenFullEditor: (id: string) => void
}) {
  const [claim, setClaim] = useState<any | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [downloadingPdf, setDownloadingPdf] = useState<'1500' | 'era' | null>(null)
  const [handling, setHandling] = useState(false)
  const [handlingNotes, setHandlingNotes] = useState('')
  const [handlingOpen, setHandlingOpen] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true); setError(null)
    getClaim(claimId)
      .then(c => { if (!cancelled) setClaim(c) })
      .catch(e => { if (!cancelled) setError(e?.message ?? 'Failed to load claim') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [claimId])

  async function handleDownload1500() {
    if (!claim) return
    setDownloadingPdf('1500')
    try {
      await downloadClaim1500Pdf(claim.id)
    } catch (e: any) {
      setError(e?.message ?? 'Failed to download 1500 PDF')
    } finally {
      setDownloadingPdf(null)
    }
  }
  async function handleDownloadEra() {
    if (!claim) return
    setDownloadingPdf('era')
    try {
      await downloadClaimEraPdf(claim.id)
    } catch (e: any) {
      setError(e?.message ?? 'Failed to download ERA PDF')
    } finally {
      setDownloadingPdf(null)
    }
  }
  async function submitHandled() {
    if (!claim || !handlingNotes.trim()) return
    setHandling(true)
    try {
      const updated = await markClaimDenialHandled(claim.id, handlingNotes.trim())
      setClaim({ ...claim, ...updated })
      setHandlingOpen(false)
      setHandlingNotes('')
    } catch (e: any) {
      setError(e?.message ?? 'Failed to save handling note')
    } finally {
      setHandling(false)
    }
  }

  const patientName = claim
    ? [claim.child_first_name ?? claim.patient_first_name, claim.child_last_name ?? claim.patient_last_name].filter(Boolean).join(' ') || 'Unknown patient'
    : ''

  const outcome = claim?.era_received_at
    ? detectErraOutcome(claim.era_denial_codes ?? claim.era_raw_835?.cas ?? null)
    : null

  const patientResp =
    (parseFloat(claim?.patient_deductible_era ?? 0) || 0) +
    (parseFloat(claim?.patient_coinsurance_era ?? 0) || 0) +
    (parseFloat(claim?.patient_copay_era ?? 0) || 0) +
    (parseFloat(claim?.patient_non_covered_era ?? 0) || 0)

  const submittedAge = ageDays(claim?.submitted_at)
  const stediErr = extractStediErrorSummary(claim?.submission_error)

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        className="bg-white rounded-2xl shadow-xl max-w-3xl w-full max-h-[90vh] flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-start justify-between px-5 py-4 border-b border-[#E8E8E4]">
          <div className="min-w-0">
            <div className="text-[11px] uppercase tracking-wide text-[#1A1A2E]/60">Claim review</div>
            {claim && (
              <h2 className="font-display text-[17px] font-semibold text-[#1A1A2E] mt-0.5 inline-flex items-center gap-2 flex-wrap">
                <span>{patientName}</span>
                <ChartNumberPill value={claim.chart_number} size="sm" />
              </h2>
            )}
            {claim && (
              <div className="text-[12px] text-[#1A1A2E]/70 mt-0.5">
                {claim.payer_name || 'Unknown payer'} · DOS {fmtDate(claim.service_date) || '—'} · {fmtMoney(claim.total_charge)}
              </div>
            )}
          </div>
          <button onClick={onClose} className="text-[#1A1A2E]/60 hover:text-[#1A1A2E] p-1 -mr-1">
            <X size={18} />
          </button>
        </div>

        <div className="overflow-auto flex-1 p-5 space-y-4">
          {loading && <div className="py-8 text-center text-[13px] text-[#1A1A2E]/60">Loading claim…</div>}
          {error && (
            <div className="flex items-start gap-2 text-[13px] text-[#991B1B] bg-[#FCEBEB] border border-[#F5C6C6] px-3 py-2 rounded-lg">
              <AlertCircle size={14} className="mt-0.5 flex-shrink-0" /> <span>{error}</span>
            </div>
          )}

          {claim && !loading && (
            <>
              {/* Why hasn't it paid? — diagnostic banner. Renders one of
                  the branches below based on where the claim is in its
                  lifecycle. Ordered by "what a biller needs to know
                  first" — errors are loudest, ERA-back-and-handled is
                  quietest. */}
              {claim.status === 'pending_review' && (
                <div className="flex items-start gap-2 text-[13px] text-[#8A4B00] bg-[#FFF4E5] border border-[#F5D5A6] px-3 py-2.5 rounded-lg">
                  <Clock size={14} className="mt-0.5 flex-shrink-0" />
                  <div>
                    <div className="font-semibold">Not yet submitted</div>
                    <div className="text-[12px] mt-0.5">Sitting in the pending-review queue. Submit from the Claims page when ready.</div>
                  </div>
                </div>
              )}
              {claim.status === 'error' && (
                <div className="flex items-start gap-2 text-[13px] text-[#991B1B] bg-[#FCEBEB] border border-[#F5C6C6] px-3 py-2.5 rounded-lg">
                  <AlertCircle size={14} className="mt-0.5 flex-shrink-0" />
                  <div className="min-w-0">
                    <div className="font-semibold">Rejected — needs fix</div>
                    {stediErr && <div className="text-[12px] mt-0.5 break-words">{stediErr}</div>}
                  </div>
                </div>
              )}
              {claim.status === 'submitted' && !claim.era_received_at && (
                <div className={`flex items-start gap-2 text-[13px] px-3 py-2.5 rounded-lg border ${
                  submittedAge != null && submittedAge > 30
                    ? 'text-[#8A4B00] bg-[#FFF4E5] border-[#F5D5A6]'
                    : 'text-[#31447A] bg-[#EEF1F8] border-[#CBD5E1]'
                }`}>
                  <Clock size={14} className="mt-0.5 flex-shrink-0" />
                  <div>
                    <div className="font-semibold">
                      {submittedAge != null && submittedAge > 30
                        ? `Waiting on payer — ${submittedAge} days out`
                        : 'Submitted to payer, awaiting ERA'}
                    </div>
                    <div className="text-[12px] mt-0.5">
                      {submittedAge != null && submittedAge > 30
                        ? 'Past 30 days without a payer response is worth a phone call.'
                        : 'Payers typically return an ERA within 14–30 days.'}
                    </div>
                  </div>
                </div>
              )}
              {claim.era_received_at && outcome?.status === 'denied' && (
                <div className="flex items-start gap-2 text-[13px] text-[#991B1B] bg-[#FCEBEB] border border-[#F5C6C6] px-3 py-2.5 rounded-lg">
                  <AlertCircle size={14} className="mt-0.5 flex-shrink-0" />
                  <div className="min-w-0">
                    <div className="font-semibold">{outcomeLabel(outcome.status)}</div>
                    {outcome.codes.length > 0 && (
                      <div className="text-[12px] mt-0.5">CARC codes: {outcome.codes.join(', ')}</div>
                    )}
                  </div>
                </div>
              )}
              {claim.era_received_at && outcome?.status === 'partial_denial' && (
                <div className="flex items-start gap-2 text-[13px] text-[#8A4B00] bg-[#FFF4E5] border border-[#F5D5A6] px-3 py-2.5 rounded-lg">
                  <AlertCircle size={14} className="mt-0.5 flex-shrink-0" />
                  <div className="min-w-0">
                    <div className="font-semibold">{outcomeLabel(outcome.status)}</div>
                    <div className="text-[12px] mt-0.5">Some lines paid, some denied. CARC: {outcome.codes.join(', ')}</div>
                  </div>
                </div>
              )}
              {claim.era_received_at && outcome?.status === 'clean' && (
                <div className="flex items-start gap-2 text-[13px] text-[#085041] bg-[#E1F5EE] border border-[#8FD8BE] px-3 py-2.5 rounded-lg">
                  <CheckCircle size={14} className="mt-0.5 flex-shrink-0" />
                  <div>
                    <div className="font-semibold">ERA received — clean adjudication</div>
                    <div className="text-[12px] mt-0.5">
                      Payer paid {fmtMoney(claim.insurance_payment_era)} · Patient owes {fmtMoney(patientResp)}
                    </div>
                  </div>
                </div>
              )}
              {claim.denial_handled_at && (
                <div className="flex items-start gap-2 text-[13px] text-[#085041] bg-[#E1F5EE] border border-[#8FD8BE] px-3 py-2.5 rounded-lg">
                  <CheckCircle size={14} className="mt-0.5 flex-shrink-0" />
                  <div className="min-w-0">
                    <div className="font-semibold">Handled by {claim.denial_handled_by_name ?? 'biller'} on {fmtDate(claim.denial_handled_at)}</div>
                    {claim.denial_handling_notes && <div className="text-[12px] mt-0.5 break-words">“{claim.denial_handling_notes}”</div>}
                  </div>
                </div>
              )}

              {/* Financial snapshot — only shows meaningful fields */}
              <div className="border border-[#E8E8E4] rounded-lg px-4 py-3">
                <div className="text-[11px] uppercase tracking-wide text-[#1A1A2E]/60 mb-2">Financials</div>
                <div className="grid grid-cols-2 gap-y-1.5 gap-x-6 text-[13px]">
                  <div className="text-[#1A1A2E]/70">Billed</div>
                  <div className="text-right tabular-nums">{fmtMoney(claim.amount_billed_era ?? claim.total_charge)}</div>
                  {claim.era_received_at && (
                    <>
                      <div className="text-[#1A1A2E]/70">Insurance paid</div>
                      <div className="text-right tabular-nums">{fmtMoney(claim.insurance_payment_era)}</div>
                      <div className="text-[#1A1A2E]/70">Contractual adjustment</div>
                      <div className="text-right tabular-nums">{fmtMoney(claim.contractual_adjustment_era)}</div>
                      <div className="text-[#1A1A2E]/70">Patient responsibility</div>
                      <div className="text-right tabular-nums font-semibold">{fmtMoney(patientResp)}</div>
                    </>
                  )}
                </div>
              </div>

              {/* Timeline */}
              <div className="border border-[#E8E8E4] rounded-lg px-4 py-3">
                <div className="text-[11px] uppercase tracking-wide text-[#1A1A2E]/60 mb-2">Timeline</div>
                <div className="space-y-1 text-[13px]">
                  <div className="flex justify-between">
                    <span className="text-[#1A1A2E]/70">Created</span>
                    <span>{fmtDate(claim.created_at) ?? '—'}</span>
                  </div>
                  {claim.submitted_at && (
                    <div className="flex justify-between">
                      <span className="text-[#1A1A2E]/70">Submitted</span>
                      <span>{fmtDate(claim.submitted_at)}{submittedAge != null ? ` (${submittedAge}d ago)` : ''}</span>
                    </div>
                  )}
                  {claim.era_received_at && (
                    <div className="flex justify-between">
                      <span className="text-[#1A1A2E]/70">ERA received</span>
                      <span>{fmtDate(claim.era_received_at)}</span>
                    </div>
                  )}
                  {claim.denial_handled_at && (
                    <div className="flex justify-between">
                      <span className="text-[#1A1A2E]/70">Denial handled</span>
                      <span>{fmtDate(claim.denial_handled_at)}</span>
                    </div>
                  )}
                </div>
              </div>

              {/* Handle-denial inline form (biller acknowledges + notes what
                  she did about the denial). Only for ERA'd claims with a
                  denial that hasn't been handled yet. */}
              {claim.era_received_at
                && (outcome?.status === 'denied' || outcome?.status === 'partial_denial' || outcome?.status === 'documentation_needed')
                && !claim.denial_handled_at && (
                <div className="border border-[#F5D5A6] rounded-lg px-4 py-3 bg-[#FFFAF0]">
                  {!handlingOpen ? (
                    <Button size="sm" variant="secondary" onClick={() => setHandlingOpen(true)}>
                      Mark denial handled
                    </Button>
                  ) : (
                    <div className="space-y-2">
                      <label className="text-[12px] font-medium text-[#1A1A2E] block">
                        What did you do about this denial?
                      </label>
                      <textarea
                        value={handlingNotes}
                        onChange={e => setHandlingNotes(e.target.value)}
                        rows={3}
                        placeholder="e.g. Called payer, refiled with corrected code…"
                        className="w-full px-2.5 py-1.5 border border-[#E8E8E4] rounded-lg text-[13px] bg-white outline-none focus:border-[#7F77DD]"
                      />
                      <div className="flex gap-2">
                        <Button size="sm" variant="teal" loading={handling} disabled={!handlingNotes.trim()} onClick={submitHandled}>
                          Save
                        </Button>
                        <Button size="sm" variant="secondary" onClick={() => { setHandlingOpen(false); setHandlingNotes('') }}>
                          Cancel
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>

        {claim && !loading && (
          <div className="px-5 py-3 border-t border-[#E8E8E4] bg-[#FAFAF8] flex items-center justify-between flex-wrap gap-2">
            <div className="flex gap-2 flex-wrap">
              {claim.stedi_claim_id && (
                <button
                  onClick={handleDownload1500}
                  disabled={downloadingPdf === '1500'}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-medium text-[#1A1A2E] bg-white border border-[#E8E8E4] rounded-lg hover:bg-[#F0EEFA] disabled:opacity-50"
                >
                  <Download size={12} /> {downloadingPdf === '1500' ? 'Downloading…' : '1500 PDF'}
                </button>
              )}
              {claim.era_received_at && (
                <button
                  onClick={handleDownloadEra}
                  disabled={downloadingPdf === 'era'}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-medium text-[#1A1A2E] bg-white border border-[#E8E8E4] rounded-lg hover:bg-[#F0EEFA] disabled:opacity-50"
                >
                  <FileText size={12} /> {downloadingPdf === 'era' ? 'Downloading…' : 'ERA PDF'}
                </button>
              )}
            </div>
            <button
              onClick={() => onOpenFullEditor(claim.id)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-medium text-white bg-[#7F77DD] rounded-lg hover:bg-[#6C64C8]"
            >
              Open full editor <ExternalLink size={12} />
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
