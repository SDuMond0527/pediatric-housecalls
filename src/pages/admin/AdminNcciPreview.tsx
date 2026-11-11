import { useState } from 'react'
import { AlertCircle, AlertOctagon, X, Sparkles } from 'lucide-react'

// Demo page for the NCCI PTP violations modal. Super-admin only — lets
// Sara see the exact same modal Pam will see when the scrubber blocks
// a submit, without needing to find a real claim with a conflict (and
// she has very few in her history, which is good for her coding but
// bad for demos). Sara 2026-11-11.
//
// This page mirrors the modal inside src/pages/admin/AdminClaims.tsx
// — same JSX, same styling, same copy. If the real one changes, update
// this one too to keep the demo honest.

type Violation = {
  severity: 'error' | 'warning'
  primary_code: string
  bundled_code: string
  modifier_indicator: number
  effective_date: string | null
  rationale: string | null
  suggestion: string
}

const SCENARIOS: Record<string, { label: string; violations: Violation[]; forceAllowed: boolean }> = {
  nebulizer: {
    label: 'Sick visit with nebulizer treatment (classic pediatric)',
    forceAllowed: true,
    violations: [{
      severity: 'warning',
      primary_code: '94640',
      bundled_code: '99214',
      modifier_indicator: 1,
      effective_date: '2020-10-01',
      rationale: 'CPT Manual or CMS manual coding instruction',
      suggestion: 'NCCI PTP: 94640 and 99214 are a bundled pair. Attach modifier 25 (separately identifiable E/M) or 59/XE/XS/XP/XU (distinct procedural service) to the appropriate code — or remove one — to avoid a denial.',
    }],
  },
  multi: {
    label: 'Visit with multiple soft warnings',
    forceAllowed: true,
    violations: [
      {
        severity: 'warning', primary_code: '94640', bundled_code: '99214',
        modifier_indicator: 1, effective_date: '2020-10-01',
        rationale: 'CPT Manual or CMS manual coding instruction',
        suggestion: 'NCCI PTP: 94640 and 99214 are a bundled pair. Attach modifier 25 to the appropriate code — or remove one — to avoid a denial.',
      },
      {
        severity: 'warning', primary_code: '36415', bundled_code: '99214',
        modifier_indicator: 1, effective_date: '2001-10-01',
        rationale: 'CPT Manual or CMS manual coding instruction',
        suggestion: 'NCCI PTP: 36415 and 99214 are a bundled pair. Attach modifier 25 (separately identifiable E/M) or 59/XE/XS/XP/XU to the appropriate code — or remove one — to avoid a denial.',
      },
    ],
  },
  hard: {
    label: 'Mutually exclusive pair (hard block — rare in your practice)',
    forceAllowed: false,
    violations: [{
      severity: 'error',
      primary_code: '00620',
      bundled_code: '99347',
      modifier_indicator: 0,
      effective_date: '2017-01-01',
      rationale: 'Standard preparation/monitoring services for anesthesia',
      suggestion: 'NCCI PTP: 00620 and 99347 cannot be billed together on the same date of service (no modifier override allowed). Remove one code or split the visits.',
    }],
  },
  mixed: {
    label: 'Mixed — hard block + soft warning',
    forceAllowed: false,
    violations: [
      {
        severity: 'error', primary_code: '87081', bundled_code: '87880',
        modifier_indicator: 0, effective_date: '2015-04-01',
        rationale: 'Mutually exclusive procedures',
        suggestion: 'NCCI PTP: 87081 and 87880 cannot be billed together on the same date of service (no modifier override allowed). Remove one code or split the visits.',
      },
      {
        severity: 'warning', primary_code: '94640', bundled_code: '99214',
        modifier_indicator: 1, effective_date: '2020-10-01',
        rationale: 'CPT Manual or CMS manual coding instruction',
        suggestion: 'NCCI PTP: 94640 and 99214 are a bundled pair. Attach modifier 25 to the appropriate code — or remove one — to avoid a denial.',
      },
    ],
  },
}

export function AdminNcciPreview() {
  const [scenarioKey, setScenarioKey] = useState<keyof typeof SCENARIOS>('nebulizer')
  const [modalOpen, setModalOpen] = useState(false)

  const scenario = SCENARIOS[scenarioKey]
  const violations = scenario.violations
  const hardErrors = violations.filter(v => v.severity === 'error')
  const softWarnings = violations.filter(v => v.severity === 'warning')

  return (
    <div className="max-w-4xl mx-auto px-6 py-6">
      <div className="mb-5">
        <div className="flex items-center gap-2 mb-1">
          <Sparkles size={20} className="text-[#7F77DD]" />
          <h1 className="text-[24px] font-display font-medium text-[#1A1A2E] leading-tight">NCCI modal preview</h1>
        </div>
        <p className="text-[13px] text-[#555] leading-snug max-w-2xl">
          Demo of what Pam will see when the scrubber blocks a claim submit for an NCCI PTP bundling conflict. Sample data below mirrors what the real modal would render against a live claim. Pick a scenario, click the button, step through the flow.
        </p>
      </div>

      <div className="bg-white border border-[#E8E8E4] rounded-xl p-5 space-y-4">
        <div>
          <label className="text-[12px] font-semibold text-[#1A1A2E] uppercase tracking-wider block mb-2">Scenario</label>
          <div className="space-y-1.5">
            {Object.entries(SCENARIOS).map(([key, s]) => (
              <label key={key} className="flex items-start gap-2 cursor-pointer p-2 rounded-lg hover:bg-[#F1EFE8]">
                <input type="radio" name="scenario" checked={scenarioKey === key} onChange={() => setScenarioKey(key as any)} className="mt-0.5" />
                <span className="text-[13px] text-[#1A1A2E]">{s.label}</span>
              </label>
            ))}
          </div>
        </div>

        <div className="pt-4 border-t border-[#F1EFE8]">
          <button
            onClick={() => setModalOpen(true)}
            className="inline-flex items-center gap-2 px-4 py-2 bg-[#7F77DD] text-white rounded-lg text-[13px] font-medium hover:bg-[#6C64C8]"
          >
            Open the modal
          </button>
          <p className="text-[11px] text-[#555] mt-2 leading-snug">
            This is a visual preview only — no claims or ERAs are touched. The real modal on the Claims page fires automatically when Pam clicks Submit on a flagged claim.
          </p>
        </div>
      </div>

      {modalOpen && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={() => setModalOpen(false)}>
          <div className="bg-white rounded-lg max-w-3xl w-full max-h-[85vh] flex flex-col" onClick={e => e.stopPropagation()}>
            <div className="p-4 border-b flex items-center justify-between">
              <div className="flex items-center gap-2">
                {hardErrors.length > 0
                  ? <AlertOctagon size={18} className="text-[#B91C1C]" />
                  : <AlertCircle size={18} className="text-[#B45309]" />}
                <h3 className="font-display text-base font-semibold text-neutral-900">
                  {hardErrors.length > 0 ? 'NCCI bundling — cannot bill together' : 'NCCI bundling warning'}
                </h3>
              </div>
              <button onClick={() => setModalOpen(false)} className="text-neutral-500 hover:text-neutral-900">
                <X size={18} />
              </button>
            </div>

            <div className="p-4 overflow-auto flex-1 space-y-2">
              <div className="text-[13px] text-[#555] leading-snug">
                Medicare's NCCI PTP edits (which most commercial payers mirror) flag these CPT pairs. The claim was NOT sent.
              </div>
              {hardErrors.map((v, i) => (
                <div key={'e' + i} className="bg-[#FEE2E2] border border-[#FCA5A5] text-[#7F1D1D] rounded p-3 text-sm">
                  <div className="font-semibold text-xs uppercase tracking-wide mb-1">Must not bill together</div>
                  <div className="font-mono text-[13px] mb-1">
                    CPT {v.primary_code} + CPT {v.bundled_code}
                  </div>
                  <div>{v.suggestion}</div>
                  {v.rationale && (
                    <div className="text-[11px] text-[#7F1D1D]/70 mt-1 italic">
                      CMS rationale: {v.rationale}
                    </div>
                  )}
                </div>
              ))}
              {softWarnings.map((v, i) => (
                <div key={'w' + i} className="bg-[#FEF3C7] border border-[#FCD34D] text-[#78350F] rounded p-3 text-sm">
                  <div className="font-semibold text-xs uppercase tracking-wide mb-1">Modifier needed</div>
                  <div className="font-mono text-[13px] mb-1">
                    CPT {v.primary_code} + CPT {v.bundled_code}
                  </div>
                  <div>{v.suggestion}</div>
                  {v.rationale && (
                    <div className="text-[11px] text-[#78350F]/70 mt-1 italic">
                      CMS rationale: {v.rationale}
                    </div>
                  )}
                </div>
              ))}
            </div>

            <div className="p-4 border-t bg-[#FAFAF8] flex items-center justify-end gap-2">
              <button
                onClick={() => setModalOpen(false)}
                className="px-3 py-2 text-[13px] text-[#555] border border-[#E8E8E4] rounded-md hover:bg-[#F1EFE8]"
              >
                {hardErrors.length > 0 ? 'Close — fix the claim' : 'Cancel'}
              </button>
              {hardErrors.length === 0 && scenario.forceAllowed && (
                <button
                  onClick={() => {
                    if (!confirm(
                      'Submit this claim anyway?\n\n' +
                      'The payer will likely deny the bundled line unless you have a documented reason. ' +
                      'Your override will be logged on the claim\'s activity log.',
                    )) return
                    setModalOpen(false)
                    alert('In the real flow this would resubmit with force_submit=true and log the override. (Preview only — no claim was changed.)')
                  }}
                  className="px-3 py-2 text-[13px] bg-[#7F77DD] text-white rounded-md hover:bg-[#6C64C8] font-medium"
                >
                  I know — submit anyway
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
