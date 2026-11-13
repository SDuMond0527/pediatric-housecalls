import type { VercelRequest, VercelResponse } from '@vercel/node'

// CARC/RARC → Review Queue action proposer. Stage 2 of the billing
// agent build (Sara approved the 8-code scope 2026-11-13 after
// scanning actual denial history).
//
// Runs after an ERA populates claims.denial_codes. For each
// actionable denial, writes ONE review_queue_items row with a
// structured proposal (write off, resubmit-with-fix, appeal, etc.)
// for Sara/Andrea to approve. Never auto-executes — every action
// still goes through the Review Queue.
//
// What counts as "actionable" — the 8 codes the agent proposes for:
//   CO-B13   → write off (duplicate claim)
//   CO-16    → resubmit with missing info (RARC tells us what)
//   CO-97    → review bundled (often modifier 25/59)
//   CO-246   → write off (non-payable code)
//   CO-252   → resubmit with attachment
//   CO-96 / PR-96 → non-covered — write off or appeal
//   PR-31    → data fix (demographics on claim)
//   PR-55    → appeal candidate (experimental / not medically necessary)
//
// What does NOT get proposed (passive codes — normal flow handles):
//   CO-45    → contractual adjustment (payer paying contracted rate)
//   PR-1     → patient deductible
//   PR-2     → patient coinsurance
//   PR-3     → patient copay
//   Anything else unknown → defer to human. We don't want a half-
//   confident proposal to look authoritative.

type DenialCode = { group_code?: string; reason_code?: string; amount?: number }

type ProposalKind =
  | 'write_off'                 // Non-payable, duplicate, or non-covered → drop off AR
  | 'resubmit_fix_missing'      // CO-16 — ask what's missing (RARC usually says)
  | 'resubmit_fix_demographics' // PR-31 — member ID / DOB / name mismatch
  | 'resubmit_with_attachment'  // CO-252 — records missing
  | 'review_bundled'            // CO-97 — modifier 25/59 review
  | 'appeal'                    // PR-55 / medical-necessity denials

interface Proposal {
  kind: ProposalKind
  summary: string               // one-sentence plain-English for the queue list
  priority: number              // lower = higher priority; appeals/data fixes get bumped up
  item_type: 'denial_fix' | 'appeal_draft'
  work_category: 'denials'
  reasoning: {
    primary_code: string            // e.g. "CO-B13"
    primary_code_description: string
    all_denial_codes: DenialCode[]
    remark_codes: string[]
    rationale: string               // why we picked this action
    confidence: 'high' | 'medium' | 'low'
  }
  proposed_change: Record<string, unknown>
}

// Codes we deliberately don't propose for — they're either normal
// (contractual) or they're already handled by downstream flows
// (patient-responsibility codes drive statements).
const PASSIVE_CODES = new Set([
  'CO-45',
  'PR-1', 'PR-2', 'PR-3',
])

// CARC descriptions used in the reasoning payload. Mirrors the shorter
// map in api/webhooks/stedi-era.ts (describeDenialCodes). Keep both in
// sync if we ever add a code the UI should name.
const CARC_DESCRIPTIONS: Record<string, string> = {
  'CO-B13':  'Previously paid — duplicate claim submitted',
  'CO-16':   'Claim/service lacks information needed for adjudication',
  'CO-97':   'Benefit included in payment for another service (bundled)',
  'CO-246':  'Non-payable code',
  'CO-252':  'Attachment missing from the claim',
  'CO-96':   'Non-covered charges',
  'PR-96':   'Non-covered charges — patient responsibility',
  'PR-31':   'Patient cannot be identified as the insured',
  'PR-55':   'Procedure/treatment deemed experimental or not medically necessary',
  'CO-50':   'Service not deemed medically necessary',
  'CO-29':   'Timely filing limit exceeded',
}

// Action dispatch table. Key is `${group_code}-${reason_code}` — the
// group matters for PR vs CO (patient vs payer obligation) but the
// action for the same reason_code is usually the same regardless.
// Lower priority number = sorts higher in the Review Queue.
const ACTION_BY_CODE: Record<string, {
  kind: ProposalKind
  item_type: 'denial_fix' | 'appeal_draft'
  priority: number
  summary: (desc: string) => string
  rationale: string
}> = {
  'CO-B13': {
    kind: 'write_off',
    item_type: 'denial_fix',
    priority: 90,
    summary: () => 'Duplicate claim — payer already paid an earlier submission. Recommended: write off.',
    rationale: 'Duplicate denials are terminal — the payer will reject any resubmission. Writing off drops the claim from AR.',
  },
  'CO-16': {
    kind: 'resubmit_fix_missing',
    item_type: 'denial_fix',
    priority: 65,
    summary: () => 'Claim is missing required information — check the remark code for what to add, then resubmit.',
    rationale: 'CO-16 is a correctable denial. The attached RARC (remark code) tells us what field is missing; fix the claim and resubmit through Stedi.',
  },
  'CO-97': {
    kind: 'review_bundled',
    item_type: 'denial_fix',
    priority: 75,
    summary: () => 'Service bundled into another on the same visit. May need modifier 25 or 59 for distinct service.',
    rationale: 'CO-97 means the payer rolled this service into another code\'s payment. If the two were genuinely separate services (distinct E/M vs. procedure), modifier 25 (E/M) or 59 (procedure) typically unbundles.',
  },
  'CO-246': {
    kind: 'write_off',
    item_type: 'denial_fix',
    priority: 90,
    summary: () => 'Non-payable code — payer does not reimburse this CPT at all. Recommended: write off or recode.',
    rationale: 'CO-246 means the submitted CPT is on the payer\'s non-payable list. Either write off or substitute a reimbursable code — but code substitution is a clinical decision for the provider.',
  },
  'CO-252': {
    kind: 'resubmit_with_attachment',
    item_type: 'denial_fix',
    priority: 65,
    summary: () => 'Attachment missing — payer needs supporting records (encounter note, labs, imaging). Resubmit with records.',
    rationale: 'CO-252 is correctable by resubmitting with the clinical documentation attached. The RARC may specify which records.',
  },
  'CO-96': {
    kind: 'write_off',
    item_type: 'denial_fix',
    priority: 85,
    summary: () => 'Non-covered service per payer. Recommended: write off or appeal if coverage dispute.',
    rationale: 'CO-96 is non-covered under the patient\'s plan. Often terminal; if the denial reflects a payer error (coverage WAS in place for this service), an appeal makes sense.',
  },
  'PR-96': {
    kind: 'write_off',
    item_type: 'denial_fix',
    priority: 85,
    summary: () => 'Non-covered — patient responsibility per payer. Recommended: convert to patient statement.',
    rationale: 'PR-96 pushes the charge to the patient. Typically handled by converting to a patient statement rather than an insurance resubmit.',
  },
  'PR-31': {
    kind: 'resubmit_fix_demographics',
    item_type: 'denial_fix',
    priority: 55,
    summary: () => 'Patient can\'t be identified — member ID, DOB, or name on claim doesn\'t match payer records.',
    rationale: 'PR-31 is a data-mismatch denial. Fix the claim\'s demographics (member ID / DOB / subscriber name) to match the chart, then resubmit. Do NOT auto-fix the chart — if the chart is wrong, that\'s a separate update Sara approves.',
  },
  'PR-55': {
    kind: 'appeal',
    item_type: 'appeal_draft',
    priority: 50,
    summary: () => 'Deemed experimental / not medically necessary — appeal candidate. Agent will draft the letter.',
    rationale: 'PR-55 is a medical-necessity denial. These are appealable when the service was clinically indicated — provider documentation from the encounter note supports the appeal.',
  },
  'CO-50': {
    kind: 'appeal',
    item_type: 'appeal_draft',
    priority: 50,
    summary: () => 'Not medically necessary per payer — appeal candidate. Agent will draft the letter.',
    rationale: 'CO-50 mirrors PR-55 (medical necessity). Appealable with provider documentation.',
  },
  'CO-29': {
    kind: 'write_off',
    item_type: 'denial_fix',
    priority: 90,
    summary: () => 'Timely filing limit exceeded. Payer will not accept resubmission. Recommended: write off.',
    rationale: 'CO-29 is terminal unless there\'s a provable payer error (transmission log showing earlier submission). Default is write off.',
  },
}

/**
 * Pick ONE action proposal for a set of denial codes. Returns null if
 * the codes are all passive (CO-45 / PR-1/2/3) or unknown — the agent
 * does NOT propose for codes it can't confidently action.
 */
export function pickActionForDenialCodes(
  denialCodes: DenialCode[],
  remarkCodes: string[],
): Proposal | null {
  if (!Array.isArray(denialCodes) || denialCodes.length === 0) return null

  // Normalize + filter.
  const normalized = denialCodes
    .map(c => ({
      key: `${String(c?.group_code ?? '').trim()}-${String(c?.reason_code ?? '').trim()}`,
      amount: Number(c?.amount ?? 0),
      raw: c,
    }))
    .filter(c => c.key && c.key !== '-' && !PASSIVE_CODES.has(c.key))

  if (normalized.length === 0) return null

  // Pick the actionable code with the lowest action priority (lower
  // sort number first). If no code has an entry in ACTION_BY_CODE,
  // return null — don't propose for codes we don't know.
  let bestKey: string | null = null
  let bestPrio = Infinity
  for (const c of normalized) {
    const entry = ACTION_BY_CODE[c.key]
    if (!entry) continue
    if (entry.priority < bestPrio) {
      bestPrio = entry.priority
      bestKey = c.key
    }
  }
  if (!bestKey) return null

  const entry = ACTION_BY_CODE[bestKey]
  const desc = CARC_DESCRIPTIONS[bestKey] ?? bestKey

  return {
    kind: entry.kind,
    item_type: entry.item_type,
    work_category: 'denials',
    priority: entry.priority,
    summary: entry.summary(desc),
    reasoning: {
      primary_code: bestKey,
      primary_code_description: desc,
      all_denial_codes: denialCodes,
      remark_codes: Array.isArray(remarkCodes) ? remarkCodes : [],
      rationale: entry.rationale,
      // Confidence is high when the RARC/remark aligns with the CARC
      // story (e.g. CO-16 + a specific "N" remark naming the missing
      // field). When remarks are sparse we drop to medium. There's no
      // low-confidence proposal in this phase — if we're unsure, we
      // return null above instead of proposing weakly.
      confidence: (Array.isArray(remarkCodes) && remarkCodes.length > 0) ? 'high' : 'medium',
    },
    proposed_change: buildProposedChange(entry.kind, denialCodes, remarkCodes),
  }
}

function buildProposedChange(
  kind: ProposalKind,
  denialCodes: DenialCode[],
  remarkCodes: string[],
): Record<string, unknown> {
  const totalAdjusted = denialCodes.reduce((s, c) => s + Number(c?.amount ?? 0), 0)
  switch (kind) {
    case 'write_off':
      return { type: 'write_off', reason_code: 'CARC-driven', total_adjusted: totalAdjusted }
    case 'resubmit_fix_missing':
      return { type: 'resubmit', fix: 'missing_information', hint_from_remarks: remarkCodes }
    case 'resubmit_fix_demographics':
      return { type: 'resubmit', fix: 'patient_demographics', candidate_fields: ['member_id', 'subscriber_dob', 'subscriber_name', 'insurance_dependent_code'] }
    case 'resubmit_with_attachment':
      return { type: 'resubmit', fix: 'add_attachment', hint_from_remarks: remarkCodes }
    case 'review_bundled':
      return { type: 'review', fix: 'add_modifier_25_or_59', note: 'Provider decides which modifier applies — not an auto-fix.' }
    case 'appeal':
      return { type: 'appeal_draft', clinical_justification_source: 'encounter_note', target: 'generate_pdf' }
  }
}

/**
 * Write the proposal to review_queue_items. Idempotent per claim —
 * if a denial-category row already exists for this claim with
 * status 'open', OR the biller has already edited the claim after
 * the denial ERA arrived (meaning they've already acted on it and
 * resubmitted), we don't create a proposal.
 *
 * The biller_edited_at gate is what prevents the "Mackenzie Twigg
 * 2026-11-13" regression — resubmitted claims awaiting a second ERA
 * must stay in whatever tab the biller moved them to, not drop back
 * into Rework because the ORIGINAL denial still sits on the row.
 */
export async function recordProposal(
  sql: any,
  claim: {
    id: string
    practice_id: string
    patient_name?: string | null
    payer_name?: string | null
    service_date?: string | null
  },
  proposal: Proposal,
): Promise<{ created: boolean; id?: string; skipReason?: string }> {
  // Idempotency check #1: already queued (open) proposal for this claim.
  const [existing] = await sql`
    SELECT id FROM review_queue_items
    WHERE claim_id = ${claim.id}::uuid
      AND item_type IN ('denial_fix', 'appeal_draft')
      AND status = 'open'
    LIMIT 1`
  if (existing) return { created: false, id: existing.id, skipReason: 'already-queued' }

  // Idempotency check #2: biller has already acted since the ERA
  // arrived. If biller_edited_at is set AND falls after era_received_at,
  // the biller has seen this denial, fixed the claim, and (presumably)
  // resubmitted. Don't re-queue — wait for the next ERA to tell us
  // whether the resubmit worked.
  const [claimState] = await sql`
    SELECT biller_edited_at, era_received_at
    FROM claims
    WHERE id = ${claim.id}::uuid
    LIMIT 1`
  if (claimState?.biller_edited_at && claimState?.era_received_at &&
      new Date(claimState.biller_edited_at) > new Date(claimState.era_received_at)) {
    return { created: false, skipReason: 'biller-already-acted' }
  }

  const [row] = await sql`
    INSERT INTO review_queue_items (
      practice_id, item_type, work_category, claim_id,
      patient_name, payer_name, service_date,
      priority, summary, agent_reasoning, proposed_change
    ) VALUES (
      ${claim.practice_id}::uuid, ${proposal.item_type}, ${proposal.work_category}, ${claim.id}::uuid,
      ${claim.patient_name ?? null}, ${claim.payer_name ?? null}, ${claim.service_date ?? null}::date,
      ${proposal.priority}, ${proposal.summary},
      ${JSON.stringify(proposal.reasoning)}::jsonb, ${JSON.stringify(proposal.proposed_change)}::jsonb
    )
    RETURNING id`
  return { created: true, id: row?.id }
}

// Stub handler so Vercel treats this file as a real function (per
// feedback_node_esm_js_extension_required.md). Direct hits 404.
export default function handler(_req: VercelRequest, res: VercelResponse) {
  return res.status(404).json({ error: 'Not found' })
}
