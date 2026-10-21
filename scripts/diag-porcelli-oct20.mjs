// Diagnostic: find Matthew Porcelli's 10/20/2026 visit, encounter note,
// claim, and patient statement — reveals which cpt_codes are actually
// stored where, and when each row was last updated.

import { neon } from '@neondatabase/serverless'
const sql = neon(process.env.DATABASE_URL)

const children = await sql`
  SELECT id, first_name, last_name, insurance_provider
  FROM children
  WHERE LOWER(first_name) LIKE 'matthew%' AND LOWER(last_name) LIKE 'porcelli%'
  ORDER BY last_name, first_name`
console.log(`Children matching Porcelli: ${children.length}`)
for (const c of children) console.log(` - ${c.id}  ${c.first_name} ${c.last_name}  ins=${c.insurance_provider}`)

if (children.length === 0) process.exit(0)
const childIds = children.map(c => c.id)

const notes = await sql`
  SELECT id, created_at, updated_at, signed_at, is_signed,
         cpt_codes, child_id, appointment_id
  FROM encounter_notes
  WHERE child_id = ANY(${childIds}::uuid[])
    AND (DATE(created_at AT TIME ZONE 'America/New_York') = DATE '2026-10-20'
         OR DATE(updated_at AT TIME ZONE 'America/New_York') = DATE '2026-10-20')
  ORDER BY updated_at DESC`
console.log(`\nEncounter notes on 2026-10-20: ${notes.length}`)
for (const n of notes) {
  console.log(` - note ${n.id}`)
  console.log(`     signed_at=${n.signed_at?.toISOString?.() ?? 'null'}  is_signed=${n.is_signed}`)
  console.log(`     created=${n.created_at.toISOString()}  updated=${n.updated_at.toISOString()}`)
  console.log(`     cpt_codes=${JSON.stringify(n.cpt_codes)}`)
}

const claims = await sql`
  SELECT id, status, payer_id, payer_name, cpt_codes, total_charge,
         encounter_note_id, created_at, updated_at
  FROM claims
  WHERE encounter_note_id = ANY(${notes.map(n => n.id)}::uuid[])`
console.log(`\nClaims from those notes: ${claims.length}`)
for (const c of claims) {
  console.log(` - claim ${c.id}  status=${c.status}  payer=${c.payer_id}/${c.payer_name}  total=${c.total_charge}`)
  console.log(`     updated=${c.updated_at.toISOString()}  cpt_codes=${JSON.stringify(c.cpt_codes)}`)
}

const stmts = await sql`
  SELECT id, claim_id, status, amount_billed, total_amount_due,
         cpt_codes, sent_at, created_at, updated_at
  FROM patient_statements
  WHERE claim_id = ANY(${claims.map(c => c.id)}::uuid[])`
console.log(`\nStatements from those claims: ${stmts.length}`)
for (const s of stmts) {
  console.log(` - stmt ${s.id}  status=${s.status}  billed=${s.amount_billed}  due=${s.total_amount_due}  sent=${s.sent_at?.toISOString?.() ?? 'null'}`)
  console.log(`     cpt_codes=${JSON.stringify(s.cpt_codes)}`)
}

if (claims.length > 0) {
  const activity = await sql`
    SELECT created_at, kind, created_by_name, body
    FROM claim_activity_log
    WHERE claim_id = ANY(${claims.map(c => c.id)}::uuid[])
    ORDER BY created_at`
  console.log(`\nActivity log entries: ${activity.length}`)
  for (const a of activity) {
    console.log(` - ${a.created_at.toISOString()}  ${a.kind}  by ${a.created_by_name}`)
    console.log(`     ${a.body.slice(0, 160)}`)
  }
}
