// CARC (Claim Adjustment Reason Codes) and RARC (Remittance Advice
// Remark Codes) — a curated subset of the most common codes a
// pediatric practice sees on ERAs. Not exhaustive; add codes as
// they show up in the wild.
//
// Verified against the real Aetna ERA for Carson Yates on 2026-09-16
// which used CO-252 + M127 + MA63 + N393/395/457/461/N791.

export type CarcCategory = 'contractual' | 'denial' | 'documentation_needed' | 'patient_responsibility' | 'other'

export const CARC_CODES: Record<string, { description: string; category: CarcCategory }> = {
  // ── Contractual (normal, not a denial) ─────────────────────────────
  '45':  { description: 'Charges exceed the fee schedule / maximum allowable.', category: 'contractual' },
  '97':  { description: 'Payment adjusted per contract (bundled service).', category: 'contractual' },
  '24':  { description: 'Charges are covered under a capitation agreement.', category: 'contractual' },
  '131': { description: 'Claim was already included on primary payer\'s remittance.', category: 'contractual' },
  '137': { description: 'Regulatory surcharge, assessment, or health-related tax.', category: 'contractual' },

  // ── Documentation needed (payer wants records to reprocess) ────────
  '17':  { description: 'Requested information was not provided.', category: 'documentation_needed' },
  '19':  { description: 'This is a work-related injury — file with worker\'s comp carrier.', category: 'documentation_needed' },
  '20':  { description: 'This injury/illness is covered by liability carrier.', category: 'documentation_needed' },
  '107': { description: 'Related or qualifying claim/service was not identified.', category: 'documentation_needed' },
  '226': { description: 'Information requested from billing provider was not received.', category: 'documentation_needed' },
  '227': { description: 'Information requested from patient/insured was not received.', category: 'documentation_needed' },
  '251': { description: 'Attachment / other documentation referenced was not received.', category: 'documentation_needed' },
  '252': { description: 'An attachment / other documentation is required to adjudicate this claim.', category: 'documentation_needed' },

  // ── Denials (payer said no, needs biller action) ───────────────────
  '11':  { description: 'Diagnosis is inconsistent with the procedure.', category: 'denial' },
  '16':  { description: 'Claim / service lacks information or has submission / billing errors.', category: 'denial' },
  '18':  { description: 'Exact duplicate claim / service.', category: 'denial' },
  '22':  { description: 'Care may be covered by another payer per COB.', category: 'denial' },
  '27':  { description: 'Expenses incurred after coverage terminated.', category: 'denial' },
  '29':  { description: 'Time limit for filing has expired.', category: 'denial' },
  '31':  { description: 'Patient cannot be identified as our insured.', category: 'denial' },
  '39':  { description: 'Services denied at the time authorization / precertification was requested.', category: 'denial' },
  '50':  { description: 'These services are non-covered — not deemed medically necessary by the payer.', category: 'denial' },
  '96':  { description: 'Non-covered charges.', category: 'denial' },
  '109': { description: 'Claim not covered by this payer / contractor. Send to correct payer.', category: 'denial' },
  '119': { description: 'Benefit maximum for this time period / occurrence has been reached.', category: 'denial' },
  '167': { description: 'Diagnosis is not covered.', category: 'denial' },
  '197': { description: 'Precertification / authorization / notification absent.', category: 'denial' },
  '198': { description: 'Precertification / authorization exceeded.', category: 'denial' },
  '204': { description: 'Not covered under patient\'s current benefit plan.', category: 'denial' },

  // ── Patient responsibility ─────────────────────────────────────────
  '1':  { description: 'Deductible amount.', category: 'patient_responsibility' },
  '2':  { description: 'Coinsurance amount.', category: 'patient_responsibility' },
  '3':  { description: 'Copayment amount.', category: 'patient_responsibility' },
  'PR-96': { description: 'Non-covered charge — patient responsibility.', category: 'patient_responsibility' },
}

export const RARC_CODES: Record<string, string> = {
  // Alert codes (informational)
  'MA15':  'Alert: Your claim has been separated to expedite handling. You will receive a separate notice for other services.',
  'MA07':  'Alert: The claim information also was forwarded to Medicaid for review.',
  'MA18':  'Alert: The claim information is also being forwarded to the patient\'s supplemental insurer.',

  // Missing documentation
  'MA63':  'Missing / incomplete / invalid principal diagnosis.',
  'M127':  'Missing patient medical record for this service.',
  'M144':  'Pre-/post-operative care payment is included in the allowance for the surgery / procedure.',
  'N393':  'Missing progress notes / report.',
  'N395':  'Missing laboratory report.',
  'N457':  'Missing diagnostic report.',
  'N461':  'Missing nursing notes.',
  'N791':  'Missing history & physical report.',

  // Common auth / eligibility
  'N30':   'Patient ineligible for this service.',
  'N54':   'Claim information is inconsistent with pre-certified / authorized services.',
  'N130':  'Consult plan benefit documents / guidelines for information about restrictions.',
  'N185':  'Do not resubmit this claim / service.',
  'N286':  'Missing / incomplete / invalid referring provider primary identifier.',
  'N290':  'Missing / incomplete / invalid rendering provider primary identifier.',
  'N522':  'Duplicate of a claim processed or in process as a crossover claim.',
  'N657':  'This is a duplicate service that was previously billed.',
}

// ── Derived state ──────────────────────────────────────────────────────

export type DenialCode = { group_code: string; reason_code: string; amount: number }

/** What kind of ERA outcome did the payer send? */
export type ErraOutcome =
  | { status: 'clean' }                       // Nothing unusual (pure contractual or full payment)
  | { status: 'documentation_needed'; codes: string[] }
  | { status: 'denied'; codes: string[] }
  | { status: 'partial_denial'; codes: string[] }

/**
 * Decide the "outcome" of an ERA from its CARC entries. Splits real
 * contractual write-downs (CO-45 etc.) from actual denials (CO-16,
 * CO-197, CO-252 etc.) — which the old bucketing quietly ignored.
 */
export function detectErraOutcome(denialCodes: DenialCode[] | null | undefined): ErraOutcome {
  if (!denialCodes || denialCodes.length === 0) return { status: 'clean' }

  const seen = new Set<string>()
  const contractualCoCodes = new Set(['45', '97', '24', '131', '137'])

  let anyDocumentation = false
  let anyDenial = false
  let anyContractual = false

  for (const c of denialCodes) {
    const key = `${c.group_code}-${c.reason_code}`
    seen.add(key)

    if (c.group_code === 'CO') {
      const meta = CARC_CODES[c.reason_code]
      if (meta?.category === 'documentation_needed') { anyDocumentation = true; continue }
      if (contractualCoCodes.has(c.reason_code) || meta?.category === 'contractual') { anyContractual = true; continue }
      // Any other CO code is a denial
      anyDenial = true
    } else if (c.group_code === 'PR') {
      // Patient responsibility isn't a denial — it's part of normal
      // adjudication. Skip.
      continue
    } else if (c.group_code === 'OA' || c.group_code === 'PI') {
      // OA/PI amounts don't reduce billed for the family; they're
      // usually informational or payer-initiated adjustments. Treat
      // as denials if reason is not a known contractual code.
      if (!contractualCoCodes.has(c.reason_code)) anyDenial = true
    }
  }

  const codes = Array.from(seen)
  if (anyDocumentation) return { status: 'documentation_needed', codes }
  if (anyDenial && anyContractual) return { status: 'partial_denial', codes }
  if (anyDenial) return { status: 'denied', codes }
  return { status: 'clean' }
}

/** Human-readable label for the outcome. */
export function outcomeLabel(status: ErraOutcome['status']): string {
  switch (status) {
    case 'documentation_needed': return 'Documentation Required'
    case 'denied':               return 'Rejected by Payer'
    case 'partial_denial':       return 'Partially Denied'
    case 'clean':                return ''
  }
}
