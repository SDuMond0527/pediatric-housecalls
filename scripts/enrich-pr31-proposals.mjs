// Enrich open PR-31 proposals with the demographics diff. Idempotent —
// skips any row that already has demographics_diff in proposed_change.
//
//   node --env-file=.env scripts/enrich-pr31-proposals.mjs
//   node --env-file=.env scripts/enrich-pr31-proposals.mjs --apply
//
// Mirror of detectDemographicsDiff in api/claims/carc-proposer.ts.

import { neon } from '@neondatabase/serverless'

const apply = process.argv.includes('--apply')
const sql = neon(process.env.DATABASE_URL)

const open = await sql`
  SELECT r.id AS rq_id, r.claim_id, r.proposed_change,
         c.member_id, c.subscriber_name,
         c.subscriber_dob::text AS subscriber_dob,
         c.subscriber_gender, c.subscriber_relationship,
         c.group_number, c.insurance_dependent_code,
         ch.insurance_member_id, ch.insurance_group_number,
         ch.insurance_dependent_code AS chart_dependent_code,
         ch.insurance_subscriber_name AS chart_subscriber_name,
         ch.insurance_subscriber_dob::text AS chart_subscriber_dob,
         ch.insurance_subscriber_gender AS chart_subscriber_gender,
         ch.insurance_subscriber_relationship AS chart_subscriber_relationship,
         (SELECT first_name || ' ' || last_name FROM children WHERE id = c.child_id) AS patient_name
  FROM review_queue_items r
  JOIN claims c ON c.id = r.claim_id
  LEFT JOIN children ch ON ch.id = c.child_id
  WHERE r.item_type = 'denial_fix'
    AND r.status = 'open'
    AND r.agent_reasoning->>'primary_code' = 'PR-31'`

const norm = (s) => String(s ?? '').trim().toLowerCase()

let updated = 0, skipped = 0
for (const row of open) {
  if (row.proposed_change?.demographics_diff) { skipped++; continue }

  const pairs = [
    ['Member ID',             row.member_id,                row.insurance_member_id],
    ['Subscriber name',       row.subscriber_name,          row.chart_subscriber_name],
    ['Subscriber DOB',        row.subscriber_dob,           row.chart_subscriber_dob],
    ['Subscriber gender',     row.subscriber_gender,        row.chart_subscriber_gender],
    ['Subscriber relationship', row.subscriber_relationship, row.chart_subscriber_relationship],
    ['Group number',          row.group_number,             row.insurance_group_number],
    ['Dependent code',        row.insurance_dependent_code, row.chart_dependent_code],
  ]
  const diffs = []
  for (const [field, claimVal, chartVal] of pairs) {
    if (norm(claimVal) !== norm(chartVal)) {
      diffs.push({
        field,
        claim_value: claimVal != null ? String(claimVal) : null,
        chart_value: chartVal != null ? String(chartVal) : null,
      })
    }
  }
  const all_match = diffs.length === 0
  const summary = all_match
    ? "Claim data matches the chart exactly. The payer still couldn't ID the patient — possible causes: (1) missing/wrong dependent code on both claim AND chart, (2) typo on the insurance card the chart was built from, (3) patient has a new policy the chart hasn't been updated for. Pull the current insurance card and verify member ID + DOB + dep code."
    : `${diffs.length} field${diffs.length > 1 ? 's' : ''} differ between claim and chart: ${diffs.map(d => d.field).join(', ')}. Update the claim to match chart, then resubmit.`
  const enriched = { ...row.proposed_change, demographics_diff: { diffs, all_match, fields_checked: pairs.map(p => p[0]), summary } }

  console.log(`[${apply ? 'APPLY' : 'DRY RUN'}] ${row.patient_name} (claim ${row.claim_id}): ${all_match ? 'all fields match (surface "check card" guidance)' : `${diffs.length} mismatch(es): ${diffs.map(d => d.field).join(', ')}`}`)
  if (apply) {
    await sql`UPDATE review_queue_items SET proposed_change = ${JSON.stringify(enriched)}::jsonb WHERE id = ${row.rq_id}::uuid`
  }
  updated++
}

console.log(`\n${apply ? 'Updated' : 'Would update'}: ${updated}  (skipped: ${skipped} already enriched)`)
if (!apply) console.log('Re-run with --apply to write.')
