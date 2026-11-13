// Backfill: for every claim with denial_codes populated but no
// existing denial_fix / appeal_draft review_queue_item, run the CARC
// proposer and queue an action. Idempotent — safe to re-run.
//
//   node --env-file=.env scripts/propose-historical-denials.mjs
//   node --env-file=.env scripts/propose-historical-denials.mjs --apply
//
// Mirror of api/claims/carc-proposer.ts — scripts/ don't share
// bundles with api/. If the dispatch table changes there, update
// here too.

import { neon } from '@neondatabase/serverless'

const PASSIVE_CODES = new Set(['CO-45', 'PR-1', 'PR-2', 'PR-3'])

const CARC_DESCRIPTIONS = {
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

const ACTION_BY_CODE = {
  'CO-B13': { kind: 'write_off', item_type: 'denial_fix', priority: 90,
    summary: 'Duplicate claim — payer already paid an earlier submission. Recommended: write off.',
    rationale: 'Duplicate denials are terminal — the payer will reject any resubmission. Writing off drops the claim from AR.' },
  'CO-16': { kind: 'resubmit_fix_missing', item_type: 'denial_fix', priority: 65,
    summary: 'Claim is missing required information — check the remark code for what to add, then resubmit.',
    rationale: 'CO-16 is a correctable denial. The attached RARC (remark code) tells us what field is missing; fix the claim and resubmit through Stedi.' },
  'CO-97': { kind: 'review_bundled', item_type: 'denial_fix', priority: 75,
    summary: 'Service bundled into another on the same visit. May need modifier 25 or 59 for distinct service.',
    rationale: 'CO-97 means the payer rolled this service into another code\'s payment. If the two were genuinely separate services, modifier 25 (E/M) or 59 (procedure) typically unbundles.' },
  'CO-246': { kind: 'write_off', item_type: 'denial_fix', priority: 90,
    summary: 'Non-payable code — payer does not reimburse this CPT at all. Recommended: write off or recode.',
    rationale: 'CO-246 means the submitted CPT is on the payer\'s non-payable list. Either write off or substitute a reimbursable code — but code substitution is a clinical decision for the provider.' },
  'CO-252': { kind: 'resubmit_with_attachment', item_type: 'denial_fix', priority: 65,
    summary: 'Attachment missing — payer needs supporting records (encounter note, labs, imaging). Resubmit with records.',
    rationale: 'CO-252 is correctable by resubmitting with the clinical documentation attached.' },
  'CO-96': { kind: 'write_off', item_type: 'denial_fix', priority: 85,
    summary: 'Non-covered service per payer. Recommended: write off or appeal if coverage dispute.',
    rationale: 'CO-96 is non-covered under the patient\'s plan. Often terminal; if the denial reflects a payer error, an appeal makes sense.' },
  'PR-96': { kind: 'write_off', item_type: 'denial_fix', priority: 85,
    summary: 'Non-covered — patient responsibility per payer. Recommended: convert to patient statement.',
    rationale: 'PR-96 pushes the charge to the patient. Typically handled by converting to a patient statement rather than an insurance resubmit.' },
  'PR-31': { kind: 'resubmit_fix_demographics', item_type: 'denial_fix', priority: 55,
    summary: 'Patient can\'t be identified — member ID, DOB, or name on claim doesn\'t match payer records.',
    rationale: 'PR-31 is a data-mismatch denial. Fix the claim\'s demographics to match the chart, then resubmit. Do NOT auto-fix the chart.' },
  'PR-55': { kind: 'appeal', item_type: 'appeal_draft', priority: 50,
    summary: 'Deemed experimental / not medically necessary — appeal candidate. Agent will draft the letter.',
    rationale: 'PR-55 is a medical-necessity denial. These are appealable when the service was clinically indicated.' },
  'CO-50': { kind: 'appeal', item_type: 'appeal_draft', priority: 50,
    summary: 'Not medically necessary per payer — appeal candidate. Agent will draft the letter.',
    rationale: 'CO-50 mirrors PR-55 (medical necessity). Appealable with provider documentation.' },
  'CO-29': { kind: 'write_off', item_type: 'denial_fix', priority: 90,
    summary: 'Timely filing limit exceeded. Payer will not accept resubmission. Recommended: write off.',
    rationale: 'CO-29 is terminal unless there\'s a provable payer error. Default is write off.' },
}

function pickAction(denialCodes, remarkCodes) {
  if (!Array.isArray(denialCodes) || denialCodes.length === 0) return null
  const actionable = denialCodes
    .map(c => ({ key: `${String(c?.group_code ?? '').trim()}-${String(c?.reason_code ?? '').trim()}`, raw: c }))
    .filter(c => c.key && c.key !== '-' && !PASSIVE_CODES.has(c.key))
  if (actionable.length === 0) return null
  let bestKey = null
  let bestPrio = Infinity
  for (const c of actionable) {
    const e = ACTION_BY_CODE[c.key]
    if (!e) continue
    if (e.priority < bestPrio) { bestPrio = e.priority; bestKey = c.key }
  }
  if (!bestKey) return null
  const entry = ACTION_BY_CODE[bestKey]
  const total = denialCodes.reduce((s, c) => s + Number(c?.amount ?? 0), 0)
  const change = {
    write_off:                   { type: 'write_off', reason_code: 'CARC-driven', total_adjusted: total },
    resubmit_fix_missing:        { type: 'resubmit', fix: 'missing_information', hint_from_remarks: remarkCodes },
    resubmit_fix_demographics:   { type: 'resubmit', fix: 'patient_demographics', candidate_fields: ['member_id', 'subscriber_dob', 'subscriber_name', 'insurance_dependent_code'] },
    resubmit_with_attachment:    { type: 'resubmit', fix: 'add_attachment', hint_from_remarks: remarkCodes },
    review_bundled:              { type: 'review', fix: 'add_modifier_25_or_59', note: 'Provider decides which modifier applies — not an auto-fix.' },
    appeal:                      { type: 'appeal_draft', clinical_justification_source: 'encounter_note', target: 'generate_pdf' },
  }[entry.kind]
  return {
    kind: entry.kind,
    item_type: entry.item_type,
    priority: entry.priority,
    summary: entry.summary,
    reasoning: {
      primary_code: bestKey,
      primary_code_description: CARC_DESCRIPTIONS[bestKey] ?? bestKey,
      all_denial_codes: denialCodes,
      remark_codes: Array.isArray(remarkCodes) ? remarkCodes : [],
      rationale: entry.rationale,
      confidence: (Array.isArray(remarkCodes) && remarkCodes.length > 0) ? 'high' : 'medium',
    },
    proposed_change: change,
  }
}

const apply = process.argv.includes('--apply')
const sql = neon(process.env.DATABASE_URL)

// Find claims with denial_codes populated AND no existing open denial
// proposal AND where the biller has NOT already resubmitted. The last
// check (biller_edited_at <= era_received_at OR either is null) is what
// prevents the Mackenzie Twigg regression from 2026-11-13 — if the
// biller already fixed the denial and resubmitted, we wait for the
// next ERA rather than re-queueing the same resolved issue.
const candidates = await sql`
  SELECT c.id, c.practice_id, c.payer_name,
         c.service_date::text AS service_date,
         c.denial_codes, c.remark_codes,
         (ch.first_name || ' ' || ch.last_name) AS patient_name
  FROM claims c
  LEFT JOIN children ch ON ch.id = c.child_id
  WHERE c.denial_codes IS NOT NULL
    AND jsonb_array_length(c.denial_codes) > 0
    AND (c.biller_edited_at IS NULL OR c.era_received_at IS NULL OR c.biller_edited_at <= c.era_received_at)
    AND NOT EXISTS (
      SELECT 1 FROM review_queue_items r
      WHERE r.claim_id = c.id
        AND r.item_type IN ('denial_fix', 'appeal_draft')
        AND r.status = 'open'
    )
  ORDER BY c.service_date DESC NULLS LAST`

console.log(apply ? '=== APPLY MODE ===' : '=== DRY RUN === (re-run with --apply to write)\n')
console.log(`Found ${candidates.length} claim(s) with denial_codes but no open proposal.\n`)

const buckets = {}
let proposed = 0
let skipped = 0
for (const c of candidates) {
  const p = pickAction(c.denial_codes, Array.isArray(c.remark_codes) ? c.remark_codes : [])
  if (!p) { skipped++; continue }
  buckets[p.reasoning.primary_code] = (buckets[p.reasoning.primary_code] ?? 0) + 1
  proposed++
  if (apply) {
    await sql`
      INSERT INTO review_queue_items (
        practice_id, item_type, work_category, claim_id,
        patient_name, payer_name, service_date,
        priority, summary, agent_reasoning, proposed_change
      ) VALUES (
        ${c.practice_id}::uuid, ${p.item_type}, 'denials', ${c.id}::uuid,
        ${c.patient_name ?? null}, ${c.payer_name ?? null}, ${c.service_date ?? null}::date,
        ${p.priority}, ${p.summary},
        ${JSON.stringify(p.reasoning)}::jsonb, ${JSON.stringify(p.proposed_change)}::jsonb
      )`
  }
}

console.log(`Proposed: ${proposed}  (skipped ${skipped} — all passive codes or unknown)`)
console.log('\nBy primary code:')
for (const [code, n] of Object.entries(buckets).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${code.padEnd(10)} ${n}`)
}
if (!apply) console.log('\nDry run complete. Re-run with --apply to write.')
