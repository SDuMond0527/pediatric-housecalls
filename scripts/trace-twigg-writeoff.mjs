// Trace Mackenzie Twigg DOS 2026-10-06 — both claims, all statements,
// any write-off activity. Who did it, when, how.
import { neon } from '@neondatabase/serverless'
const sql = neon(process.env.DATABASE_URL)

const claims = await sql`
  SELECT cl.*, c.first_name, c.last_name, c.chart_number,
         en.id AS note_id, en.signed_at, en.provider_id AS note_provider_id,
         p.name AS note_provider
  FROM claims cl
  LEFT JOIN children c ON c.id = cl.child_id
  LEFT JOIN encounter_notes en ON en.id = cl.encounter_note_id
  LEFT JOIN providers p ON p.id = en.provider_id
  WHERE LOWER(c.first_name) LIKE '%mackenzie%'
    AND LOWER(c.last_name)  LIKE '%twigg%'
    AND cl.service_date = '2026-10-06'::date
  ORDER BY cl.created_at`

for (const cl of claims) {
  console.log('\n' + '='.repeat(70))
  console.log(`Claim: ${cl.id}`)
  console.log(`Note provider: ${cl.note_provider}`)
  console.log(`Status: ${cl.status}`)
  console.log(`Payer: ${cl.payer_name ?? '—'} (${cl.payer_id ?? '—'})`)
  console.log(`Total charge: $${cl.total_charge}`)
  console.log(`Insurance paid: $${cl.insurance_payment_era ?? 0}`)
  console.log(`CPTs: ${JSON.stringify(cl.cpt_codes?.map(c => c.code))}`)
  console.log(`Created:      ${cl.created_at}`)
  console.log(`Submitted:    ${cl.submitted_at ?? '—'}`)
  console.log(`Written off:  ${cl.written_off_at ?? '—'}`)
  console.log(`Write-off reason: ${cl.write_off_reason ?? '—'}`)
  console.log(`Write-off by: ${cl.written_off_by_name ?? '—'}`)
  console.log(`Pending WO review: ${cl.pending_write_off_review_at ?? '—'}`)

  const stmts = await sql`SELECT * FROM patient_statements WHERE claim_id = ${cl.id}::uuid ORDER BY created_at`
  console.log(`\n  Patient statements (${stmts.length}):`)
  for (const s of stmts) {
    console.log(`    stmt ${s.id}  status=${s.status}  total=$${s.total_amount_due}  paid=${s.paid_amount_cents ? '$' + (s.paid_amount_cents/100).toFixed(2) : '—'}`)
    console.log(`      created: ${s.created_at}`)
    console.log(`      sent:    ${s.sent_at ?? '—'}`)
    console.log(`      paid:    ${s.paid_at ?? '—'}`)
    console.log(`      voided:  ${s.voided_at ?? '—'}  reason: ${s.void_reason ?? '—'}  by: ${s.voided_by_name ?? '—'}`)
    console.log(`      written_off: ${s.written_off_at ?? '—'}  reason: ${s.write_off_reason ?? '—'}  by: ${s.written_off_by_name ?? '—'}`)
  }

  const activity = await sql`
    SELECT created_at, created_by_name, kind, body FROM claim_activity_log
    WHERE claim_id = ${cl.id}::uuid ORDER BY created_at`
  console.log(`\n  claim_activity_log (${activity.length}):`)
  for (const a of activity) console.log(`    ${a.created_at}  [${a.kind}] by ${a.created_by_name}: ${(a.body ?? '').slice(0,160)}`)
}
