import { useState } from 'react'
import { AlertTriangle, Check, X, Loader2 } from 'lucide-react'
import { agentAuthorizeProposal } from '../lib/api'

// Confirmation modal for agent write proposals (Phase 1).
//
// The agent STAGES a proposal via prepare_prescription (or in future
// phases prepare_lab_order, prepare_follow_up, etc.). This modal is
// the clinician's authorization gate — it renders the structured
// proposal payload exactly, side-steps any AI prose so the clinician
// is reading machine-stable data not a model summary, and routes the
// Authorize / Cancel click to /api/agent/authorize/[id].
//
// Why structured rendering, not a free-text summary: Sara's rule in
// the Phase 1 plan is that dose/med data must be unambiguous.
// Repeating a dose in prose lets Claude paraphrase it ("one teaspoon"
// vs "5 mL") — this surface shows the raw fields the authorizer will
// send, so there's no translation layer.

type Proposal = { id: string; kind: string; payload: any }

export function AgentActionConfirmModal({
  proposal,
  onClose,
  onDecided,
}: {
  proposal: Proposal
  onClose: () => void
  onDecided: (result: { authorized: boolean; message: string }) => void
}) {
  const [busy, setBusy] = useState<null | 'authorize' | 'cancel'>(null)
  const [err, setErr] = useState('')

  async function decide(action: 'authorize' | 'cancel') {
    if (busy) return
    setBusy(action)
    setErr('')
    try {
      const r = await agentAuthorizeProposal(proposal.id, action)
      onDecided({ authorized: action === 'authorize', message: r.message })
    } catch (e: any) {
      setErr(e?.message ?? 'Authorization failed')
      setBusy(null)
    }
  }

  const title = proposal.kind === 'prescription' ? 'Authorize prescription' : `Authorize ${proposal.kind}`

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        onClick={e => e.stopPropagation()}
        className="w-full max-w-lg bg-white rounded-2xl shadow-2xl flex flex-col max-h-[90vh]"
      >
        {/* Header */}
        <div className="px-5 py-4 border-b border-[#E8E8E4] flex items-start justify-between">
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-wide text-[#7F77DD]">AI agent proposal</div>
            <div className="text-[17px] font-display font-semibold text-[#1A1A2E] mt-0.5">{title}</div>
          </div>
          <button onClick={onClose} className="text-[#1A1A2E]/60 hover:text-[#1A1A2E]"><X size={18} /></button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {proposal.kind === 'prescription' ? (
            <PrescriptionProposalBody payload={proposal.payload} />
          ) : (
            <pre className="text-[11px] font-mono bg-[#FAFAF8] border border-[#E8E8E4] rounded-lg p-3 overflow-x-auto">
              {JSON.stringify(proposal.payload, null, 2)}
            </pre>
          )}
        </div>

        {err && (
          <div className="px-5 pb-2 text-[12px] text-[#991B1B]">{err}</div>
        )}

        {/* Footer */}
        <div className="px-5 py-3 border-t border-[#E8E8E4] flex items-center justify-between bg-[#FAFAF8] rounded-b-2xl">
          <div className="text-[11px] text-[#1A1A2E]/60">
            Nothing is sent until you click Authorize.
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => decide('cancel')}
              disabled={busy !== null}
              className="px-3 py-1.5 rounded-lg border border-[#E8E8E4] text-[12px] text-[#1A1A2E] hover:bg-[#F1EFE8] disabled:opacity-50"
            >
              {busy === 'cancel' ? <Loader2 size={12} className="animate-spin" /> : 'Cancel'}
            </button>
            <button
              onClick={() => decide('authorize')}
              disabled={busy !== null}
              className="px-3 py-1.5 rounded-lg bg-[#7F77DD] text-white text-[12px] font-medium hover:bg-[#6B64C8] disabled:opacity-50 inline-flex items-center gap-1.5"
            >
              {busy === 'authorize' ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
              Authorize
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3 py-1">
      <div className="text-[10px] uppercase tracking-wide text-[#1A1A2E]/55 w-28 flex-shrink-0 pt-0.5">{label}</div>
      <div className="text-[13px] text-[#1A1A2E] flex-1 break-words">{value}</div>
    </div>
  )
}

function PrescriptionProposalBody({ payload }: { payload: any }) {
  const p = payload?.prescription ?? {}
  const patient = payload?.patient ?? {}
  const prescriber = payload?.prescriber ?? {}
  const pharmacy = payload?.pharmacy ?? {}
  const ds = payload?.dosespot ?? {}
  const allergyFlag = String(patient?.allergies ?? '').toLowerCase().includes(String(p?.drug_name ?? '').toLowerCase().slice(0, 4))
    && String(p?.drug_name ?? '').trim().length >= 4

  return (
    <>
      {/* Allergy flag — surfaced loud. The Phase 1 rule is that the
          EMR's allergy check still fires at DoseSpot; this is a visual
          pre-check so the clinician isn't surprised when DoseSpot
          blocks it. */}
      {allergyFlag && (
        <div className="flex items-start gap-2 p-3 rounded-lg bg-[#FEF3C7] border border-[#F5B041] text-[12px] text-[#78350F]">
          <AlertTriangle size={14} className="flex-shrink-0 mt-0.5" />
          <div>
            <div className="font-semibold">Allergy string overlaps drug name.</div>
            <div className="mt-0.5">Patient allergies: <span className="font-mono">{patient.allergies}</span>. Review before authorizing.</div>
          </div>
        </div>
      )}

      {/* Patient block */}
      <div className="rounded-lg border border-[#E8E8E4] p-3">
        <div className="text-[10px] uppercase tracking-wide text-[#1A1A2E]/55 mb-1.5">Patient</div>
        <div className="text-[14px] font-medium text-[#1A1A2E]">
          {[patient.first_name, patient.last_name].filter(Boolean).join(' ') || 'Unknown'}
        </div>
        <div className="text-[11px] text-[#1A1A2E]/60">
          DOB {patient.date_of_birth ?? 'unknown'}
          {patient.allergies ? ` · Allergies: ${patient.allergies}` : ' · No allergies documented'}
        </div>
      </div>

      {/* Drug block — the critical piece. Dose shown twice intentionally. */}
      <div className="rounded-lg border-2 border-[#7F77DD] bg-[#F7F5FF] p-3 space-y-0.5">
        <div className="text-[10px] uppercase tracking-wide text-[#7F77DD] mb-1 font-semibold">Prescription</div>
        <Field label="Drug" value={<span className="font-semibold">{p.drug_name}</span>} />
        <Field label="Strength" value={<span className="font-mono">{p.strength}</span>} />
        <Field label="Form" value={p.form} />
        <Field label="Sig" value={<span className="whitespace-pre-wrap">{p.sig}</span>} />
        <Field label="Dispense" value={<span className="font-mono">{p.dispense_qty}</span>} />
        <Field label="Refills" value={<span className="font-mono">{String(p.refills)}</span>} />
        <Field label="Days supply" value={<span className="font-mono">{String(p.days_supply)}</span>} />
        {p.prn && <Field label="PRN" value="Yes" />}
        <Field label="Indication" value={p.indication} />
        {p.notes_to_pharmacist && <Field label="Pharmacist note" value={p.notes_to_pharmacist} />}
      </div>

      {/* DoseSpot match — shows the canonical name DoseSpot resolved
          our free-text drug_name to. Sara reviews this to catch any
          wrong-strength / wrong-form matches BEFORE clicking Authorize.
          Confidence 'weak' highlights that strength or form didn't
          exact-match any formulary entry. */}
      {ds?.canonical_name && (
        <div className={`rounded-lg border p-3 ${ds.match_confidence === 'weak' ? 'bg-[#FEF3C7] border-[#F5B041]' : 'bg-[#EEFBF1] border-[#A7E3B8]'}`}>
          <div className="text-[10px] uppercase tracking-wide text-[#1A1A2E]/60 mb-1">
            DoseSpot match {ds.match_confidence === 'weak' && '(review carefully)'}
          </div>
          <div className="text-[13px] font-medium text-[#1A1A2E]">
            {ds.canonical_name}
            {ds.canonical_strength && <span className="text-[#1A1A2E]/70"> · {ds.canonical_strength}</span>}
          </div>
          <div className="text-[11px] text-[#1A1A2E]/60 mt-0.5 font-mono">
            Will transmit: {ds.parsed_quantity} {ds.dispense_unit_label}
          </div>
        </div>
      )}

      {/* Pharmacy + prescriber */}
      <div className="rounded-lg border border-[#E8E8E4] p-3">
        <Field label="Prescriber" value={`${prescriber.name ?? ''}${prescriber.role ? ` (${prescriber.role})` : ''}`} />
        <Field
          label="Pharmacy"
          value={pharmacy.label ?? <span className="text-[#991B1B]">No pharmacy on file</span>}
        />
      </div>
    </>
  )
}
