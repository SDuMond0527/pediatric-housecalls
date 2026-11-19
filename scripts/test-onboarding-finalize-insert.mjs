// Focused test for the providers INSERT inside the onboarding finalize
// path. Verifies:
//   1. ALTER TABLE IF NOT EXISTS bootstraps the missing columns cleanly.
//   2. INSERT with text[] arrays + jsonb + uuid cols all succeed with
//      no type mismatch.
//   3. INSERT round-trips the data correctly.
//
//   node_modules/.bin/tsx --env-file=.env.local scripts/test-onboarding-finalize-insert.mjs
//
// Sara 2026-11-19.

import { neon } from '@neondatabase/serverless'

const sql = neon(process.env.DATABASE_URL)
const PRACTICE_ID = '00000000-0000-0000-0000-00000000bb20'
const PROVIDER_ID = '00000000-0000-0000-0000-00000000bb21'

async function setup() {
  await sql`DELETE FROM providers WHERE id = ${PROVIDER_ID}::uuid`
  await sql`DELETE FROM practices WHERE id = ${PRACTICE_ID}::uuid`
  await sql`INSERT INTO practices (id, name, slug) VALUES (${PRACTICE_ID}::uuid, 'Finalize Test Practice', 'finalize-test')`
}
async function teardown() {
  await sql`DELETE FROM providers WHERE id = ${PROVIDER_ID}::uuid`
  await sql`DELETE FROM practices WHERE id = ${PRACTICE_ID}::uuid`
}

let pass = 0, fail = 0
try {
  await setup()

  // Mirror the bootstrap in api/onboarding/provider.ts
  await sql`ALTER TABLE providers ADD COLUMN IF NOT EXISTS first_name text`
  await sql`ALTER TABLE providers ADD COLUMN IF NOT EXISTS last_name text`
  await sql`ALTER TABLE providers ADD COLUMN IF NOT EXISTS dea_number text`
  await sql`ALTER TABLE providers ADD COLUMN IF NOT EXISTS state_licenses jsonb`
  await sql`ALTER TABLE providers ADD COLUMN IF NOT EXISTS bio text`
  await sql`ALTER TABLE providers ADD COLUMN IF NOT EXISTS supervising_md_id uuid`
  console.log('✓ ALTER TABLE IF NOT EXISTS bootstrap succeeded')
  pass++

  // Perform the exact INSERT the endpoint runs.
  const statesArr = ['NC', 'SC']
  const zonesArr  = ['Rock Hill, Indianland', 'York / Lake Wylie / Clover']
  const stateLicensesJson = JSON.stringify({ NC: { number: 'MD12345', expires: '2027-01-01' } })

  const [row] = await sql`
    INSERT INTO providers (
      id, practice_id, cognito_sub, name, first_name, last_name, email,
      role, npi, taxonomy_code, dea_number, states, state_licenses,
      zones, initials, avatar_color, avatar_text_color, bio, phone,
      supervising_md_id, dosespot_clinician_id, is_active, is_admin, is_super_admin
    ) VALUES (
      ${PROVIDER_ID}::uuid, ${PRACTICE_ID}::uuid, 'test-cognito-sub-bb21',
      'Pretend Provider', 'Pretend', 'Provider', 'pretend@example.com',
      'MD', '1376653576', '208000000X', 'BD8513916',
      ${statesArr},
      ${stateLicensesJson}::jsonb,
      ${zonesArr},
      'PP', '#EEEDFE', '#3C3489', 'Short bio', '555-1234',
      NULL::uuid, NULL,
      true, false, false
    )
    RETURNING *`
  if (!row) throw new Error('INSERT returned no row')
  console.log('✓ INSERT succeeded, row id:', row.id)
  pass++

  // Verify types round-trip correctly
  if (!Array.isArray(row.states) || row.states.length !== 2) throw new Error(`states not array: ${JSON.stringify(row.states)}`)
  if (!Array.isArray(row.zones) || row.zones.length !== 2) throw new Error(`zones not array: ${JSON.stringify(row.zones)}`)
  if (row.states[0] !== 'NC' || row.states[1] !== 'SC') throw new Error(`states wrong: ${JSON.stringify(row.states)}`)
  if (!row.state_licenses?.NC) throw new Error(`state_licenses jsonb didn't round-trip: ${JSON.stringify(row.state_licenses)}`)
  console.log('✓ Arrays + jsonb round-tripped correctly')
  pass++

  // Verify UPDATE path too
  await sql`
    UPDATE providers SET
      first_name = 'Updated',
      states = ${['NC', 'SC', 'GA']},
      zones = ${['Zone X']},
      state_licenses = ${JSON.stringify({ GA: { number: 'GA999' } })}::jsonb
    WHERE id = ${PROVIDER_ID}::uuid`
  const [updated] = await sql`SELECT first_name, states, zones, state_licenses FROM providers WHERE id = ${PROVIDER_ID}::uuid`
  if (updated.first_name !== 'Updated') throw new Error('UPDATE didn\'t stick')
  if (updated.states.length !== 3) throw new Error(`UPDATE states wrong: ${JSON.stringify(updated.states)}`)
  console.log('✓ UPDATE path succeeded')
  pass++

} catch (e) {
  console.log(`✗ ${e.message}`)
  fail++
} finally {
  await teardown()
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
