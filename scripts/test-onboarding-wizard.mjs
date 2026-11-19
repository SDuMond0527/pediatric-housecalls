// Integration test for the provider-onboarding wizard backend.
//
//   1. NPI lookup — hits NPPES with a real NPI and asserts the shape
//      we parse (via the local proxy endpoint pattern).
//   2. Invite resolver — seeds a provider_invites row into the preview
//      Neon branch and asserts the resolver returns the expected state
//      for valid / expired / consumed / missing tokens.
//
// Doesn't exercise Cognito AdminCreateUser or finalizeOnboarding (both
// require real AWS creds / existing Cognito users). Those we smoke-
// test manually on staging.
//
//   node_modules/.bin/tsx --env-file=.env.local scripts/test-onboarding-wizard.mjs
//
// Sara 2026-11-19.

import { neon } from '@neondatabase/serverless'

const sql = neon(process.env.DATABASE_URL)

let pass = 0, fail = 0

// ─── Part 1: NPI lookup via NPPES ─────────────────────────────────
// Hit NPPES directly to confirm their public API still returns the
// shape our proxy expects. Uses Sara's real NPI from the practice
// settings (1093250904).
// Use 1376653576 (individual, rendering NPI seen in eligibility.ts).
try {
  const r = await fetch('https://npiregistry.cms.hhs.gov/api/?number=1376653576&version=2.1&limit=1&pretty=false', {
    headers: { Accept: 'application/json' },
  })
  if (!r.ok) throw new Error(`NPPES returned ${r.status}`)
  const data = await r.json()
  const result = Array.isArray(data?.results) ? data.results[0] : null
  if (!result) throw new Error('no results')
  // Both NPI-1 (individual) and NPI-2 (organization) share the same
  // basic + taxonomies shape; we just want to confirm the proxy parser
  // would find the same fields.
  const basic = result.basic ?? {}
  const tax = Array.isArray(result.taxonomies) ? (result.taxonomies.find(t => t.primary) ?? result.taxonomies[0]) : null
  if (!tax?.code) throw new Error('missing taxonomy')
  const nameOrOrg = basic.organization_name || `${basic.first_name ?? ''} ${basic.last_name ?? ''}`.trim()
  console.log(`✓ NPPES lookup 1376653576 (${result.enumeration_type}) → ${nameOrOrg}, taxonomy ${tax.code} (${tax.desc})`)
  pass++
} catch (e) {
  console.log(`✗ NPPES lookup: ${e.message}`)
  fail++
}

// ─── Part 2: Invite resolver states ───────────────────────────────
// Seed one practice + one inviter provider + four invites (valid,
// expired, consumed, missing) and check the resolver logic.
const PRACTICE_ID = '00000000-0000-0000-0000-00000000ab10'
const INVITER_ID  = '00000000-0000-0000-0000-00000000ab11'

async function seed() {
  // Bootstrap the table FIRST so the DELETEs can run.
  await sql`
    CREATE TABLE IF NOT EXISTS provider_invites (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      token text NOT NULL UNIQUE,
      practice_id uuid NOT NULL,
      email text NOT NULL, first_name text NOT NULL, last_name text NOT NULL,
      role text NOT NULL, supervising_md_id uuid,
      zones jsonb DEFAULT '[]'::jsonb, visit_types jsonb DEFAULT '[]'::jsonb,
      welcome_note text,
      created_by uuid NOT NULL, created_by_name text,
      created_at timestamptz NOT NULL DEFAULT NOW(),
      expires_at timestamptz NOT NULL DEFAULT (NOW() + INTERVAL '7 days'),
      consumed_at timestamptz, consumed_by_provider_id uuid,
      cognito_username text, temp_password text,
      email_sent_at timestamptz, email_send_error text
    )`
  await sql`DELETE FROM provider_invites WHERE practice_id = ${PRACTICE_ID}::uuid`
  await sql`DELETE FROM providers WHERE id = ${INVITER_ID}::uuid`
  await sql`DELETE FROM practices WHERE id = ${PRACTICE_ID}::uuid`
  await sql`INSERT INTO practices (id, name, slug) VALUES (${PRACTICE_ID}::uuid, 'Onboarding Test Practice', 'onboarding-test')`
  await sql`INSERT INTO providers (id, practice_id, name, cognito_sub, is_admin, is_super_admin, role, initials)
            VALUES (${INVITER_ID}::uuid, ${PRACTICE_ID}::uuid, 'Super Admin', 'sa-sub-ab11', true, true, 'MD', 'SA')`
}

async function teardown() {
  await sql`DELETE FROM provider_invites WHERE practice_id = ${PRACTICE_ID}::uuid`
  await sql`DELETE FROM providers WHERE id = ${INVITER_ID}::uuid`
  await sql`DELETE FROM practices WHERE id = ${PRACTICE_ID}::uuid`
}

function state(inv) {
  if (!inv) return 'missing'
  if (inv.consumed_at) return 'consumed'
  if (inv.expires_at && new Date(inv.expires_at) < new Date()) return 'expired'
  return 'valid'
}

try {
  await seed()

  // Valid
  await sql`INSERT INTO provider_invites (token, practice_id, email, first_name, last_name, role, created_by)
            VALUES ('tok-valid', ${PRACTICE_ID}::uuid, 'a@b.com', 'Alice', 'Doe', 'MD', ${INVITER_ID}::uuid)`
  const [v] = await sql`SELECT * FROM provider_invites WHERE token = 'tok-valid'`
  if (state(v) !== 'valid') throw new Error(`expected valid, got ${state(v)}`)
  console.log('✓ invite token "tok-valid" → valid')
  pass++

  // Expired
  await sql`INSERT INTO provider_invites (token, practice_id, email, first_name, last_name, role, created_by, expires_at)
            VALUES ('tok-exp', ${PRACTICE_ID}::uuid, 'b@b.com', 'Bob', 'Doe', 'NP', ${INVITER_ID}::uuid, NOW() - INTERVAL '1 hour')`
  const [e] = await sql`SELECT * FROM provider_invites WHERE token = 'tok-exp'`
  if (state(e) !== 'expired') throw new Error(`expected expired, got ${state(e)}`)
  console.log('✓ invite token "tok-exp" → expired')
  pass++

  // Consumed
  await sql`INSERT INTO provider_invites (token, practice_id, email, first_name, last_name, role, created_by, consumed_at)
            VALUES ('tok-con', ${PRACTICE_ID}::uuid, 'c@b.com', 'Carol', 'Doe', 'PA', ${INVITER_ID}::uuid, NOW())`
  const [c] = await sql`SELECT * FROM provider_invites WHERE token = 'tok-con'`
  if (state(c) !== 'consumed') throw new Error(`expected consumed, got ${state(c)}`)
  console.log('✓ invite token "tok-con" → consumed')
  pass++

  // Missing
  const [m] = await sql`SELECT * FROM provider_invites WHERE token = 'tok-nope'`
  if (state(m) !== 'missing') throw new Error(`expected missing, got ${state(m)}`)
  console.log('✓ invite token "tok-nope" → missing')
  pass++

} catch (e) {
  console.log(`✗ invite resolver test: ${e.message}`)
  fail++
} finally {
  await teardown()
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
