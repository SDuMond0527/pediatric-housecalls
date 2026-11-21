// Preview-env test for the eligibility-payer override.
//
// Seeds a child with claims-side payer "Medcost" and an eligibility
// override pointing at IMS (87765). Confirms:
//   - column bootstrap adds insurance_eligibility_payer_{id,name}
//   - UPDATE accepts the fields
//   - SELECT returns them
//   - clearing via explicit NULL works
//
// Does NOT exercise Stedi — the eligibility endpoint composes the
// trading-partner ID from these fields, verified by reading code.
//
//   node --env-file=.env.local scripts/test-eligibility-payer-override.mjs
//
// Sara 2026-11-20.

import { neon } from '@neondatabase/serverless'

const sql = neon(process.env.DATABASE_URL)
const PRACTICE_ID = '00000000-0000-0000-0000-000000000ee1'
const CHILD_ID    = '00000000-0000-0000-0000-000000000ee2'

let pass = 0, fail = 0
try {
  // Seed practice + minimal child shell.
  await sql`DELETE FROM children  WHERE id = ${CHILD_ID}::uuid`
  await sql`DELETE FROM practices WHERE id = ${PRACTICE_ID}::uuid`
  await sql`INSERT INTO practices (id, name, slug) VALUES (${PRACTICE_ID}::uuid, 'Eligibility Override Test', 'eligibility-override-test')`
  await sql`
    INSERT INTO children (id, practice_id, first_name, last_name, display_label, date_of_birth,
                          insurance_provider, insurance_member_id)
    VALUES (${CHILD_ID}::uuid, ${PRACTICE_ID}::uuid, 'Ella', 'TestGidaly', 'Ella TestGidaly',
            '2018-02-28', 'Medcost', 'NCDS11291')`

  // Bootstrap mirror (same ALTERs as the endpoints).
  await sql`ALTER TABLE children ADD COLUMN IF NOT EXISTS insurance_eligibility_payer_id text`
  await sql`ALTER TABLE children ADD COLUMN IF NOT EXISTS insurance_eligibility_payer_name text`
  console.log('✓ bootstrap ALTER TABLE IF NOT EXISTS succeeded')
  pass++

  // Set override.
  await sql`
    UPDATE children
    SET insurance_eligibility_payer_id   = '87765',
        insurance_eligibility_payer_name = 'Interactive Medical Systems'
    WHERE id = ${CHILD_ID}::uuid`
  const [row] = await sql`SELECT insurance_provider, insurance_eligibility_payer_id, insurance_eligibility_payer_name FROM children WHERE id = ${CHILD_ID}::uuid`
  if (row.insurance_provider !== 'Medcost') throw new Error(`claims-side payer changed: ${row.insurance_provider}`)
  if (row.insurance_eligibility_payer_id !== '87765') throw new Error(`override id wrong: ${row.insurance_eligibility_payer_id}`)
  if (row.insurance_eligibility_payer_name !== 'Interactive Medical Systems') throw new Error(`override name wrong: ${row.insurance_eligibility_payer_name}`)
  console.log('✓ override set — Medcost (claims) + IMS 87765 (eligibility) coexist')
  pass++

  // Clear the override.
  await sql`UPDATE children SET insurance_eligibility_payer_id = NULL, insurance_eligibility_payer_name = NULL WHERE id = ${CHILD_ID}::uuid`
  const [after] = await sql`SELECT insurance_eligibility_payer_id, insurance_eligibility_payer_name FROM children WHERE id = ${CHILD_ID}::uuid`
  if (after.insurance_eligibility_payer_id !== null || after.insurance_eligibility_payer_name !== null) {
    throw new Error(`clear didn't null: ${JSON.stringify(after)}`)
  }
  console.log('✓ override cleared cleanly')
  pass++

} catch (e) {
  console.log(`✗ ${e.message}`)
  fail++
} finally {
  await sql`DELETE FROM children  WHERE id = ${CHILD_ID}::uuid`
  await sql`DELETE FROM practices WHERE id = ${PRACTICE_ID}::uuid`
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
