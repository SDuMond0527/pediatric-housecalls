// Phase 4A migration — creates the patient_profiles table.
//
// Zero touch to any existing PHC table. Idempotent (IF NOT EXISTS
// everywhere), safe to re-run.
//
// Run order:
//   1. Preview first: node --env-file=.env.local scripts/migrate-patient-profiles.mjs
//   2. Verify (prints column + index inventory below)
//   3. Prod after preview passes: node --env-file=.env scripts/migrate-patient-profiles.mjs
//
// Sara 2026-11-06.

import { neon } from '@neondatabase/serverless'
const sql = neon(process.env.DATABASE_URL)

const endpoint = process.env.DATABASE_URL?.match(/ep-[a-z0-9-]+/)?.[0] ?? '(unknown)'
console.log('Running on endpoint:', endpoint)

// ─── 1. Create the table ─────────────────────────────────────────────────
await sql`
  CREATE TABLE IF NOT EXISTS patient_profiles (
    id                              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    practice_id                     uuid NOT NULL REFERENCES practices(id) ON DELETE CASCADE,
    cognito_sub                     text,

    -- Core demographics
    first_name                      text NOT NULL,
    last_name                       text NOT NULL,
    date_of_birth                   date NOT NULL,
    gender                          text,

    -- Contact
    email                           text,
    phone                           text,
    address_line1                   text,
    address_line2                   text,
    city                            text,
    state                           text,
    zip                             text,

    -- Medical
    allergies                       text NOT NULL DEFAULT '',
    medications                     text NOT NULL DEFAULT '',
    medical_history                 text NOT NULL DEFAULT '',
    primary_care_provider           text,

    -- Pharmacy
    preferred_pharmacy              text,
    dosespot_pharmacy_id            integer,
    dosespot_pharmacy_source_text   text,

    -- Insurance (all nullable — Sarah Cash is cash-pay; future adult
    -- practices that take insurance can populate these). No claims
    -- pipeline attached in Phase 4 — these are storage only.
    self_pay                        boolean NOT NULL DEFAULT true,
    insurance_provider              text,
    insurance_member_id             text,
    insurance_group_number          text,
    insurance_dependent_code        text,
    insurance_subscriber_name       text,
    insurance_subscriber_dob        date,
    insurance_subscriber_gender     text,
    insurance_subscriber_relationship text,
    insurance_card_front_url        text,
    insurance_card_back_url         text,

    -- Admin
    chart_number                    text,
    archived                        boolean NOT NULL DEFAULT false,
    archived_at                     timestamptz,
    archived_reason                 text,

    created_at                      timestamptz NOT NULL DEFAULT now(),
    updated_at                      timestamptz NOT NULL DEFAULT now()
  )`
console.log('✓ patient_profiles table ensured')

// ─── 2. Indexes ───────────────────────────────────────────────────────────
// Lookup by practice (used in list queries)
await sql`CREATE INDEX IF NOT EXISTS patient_profiles_practice_idx ON patient_profiles(practice_id)`
// Self-account lookup (used in Phase 4E auth)
await sql`CREATE UNIQUE INDEX IF NOT EXISTS patient_profiles_cognito_sub_idx ON patient_profiles(cognito_sub) WHERE cognito_sub IS NOT NULL`
// Chart number must be unique per practice when present
await sql`CREATE UNIQUE INDEX IF NOT EXISTS patient_profiles_chart_number_idx ON patient_profiles(practice_id, chart_number) WHERE chart_number IS NOT NULL`
// Name search support (basic)
await sql`CREATE INDEX IF NOT EXISTS patient_profiles_name_idx ON patient_profiles(practice_id, last_name, first_name) WHERE archived = false`
console.log('✓ indexes ensured')

// ─── 3. Verification ──────────────────────────────────────────────────────
const cols = await sql`
  SELECT column_name, data_type, is_nullable
  FROM information_schema.columns
  WHERE table_name = 'patient_profiles'
  ORDER BY ordinal_position`
console.log(`\npatient_profiles columns (${cols.length}):`)
for (const c of cols) console.log(`  ${c.column_name.padEnd(35)} ${c.data_type.padEnd(25)} ${c.is_nullable === 'NO' ? 'NOT NULL' : 'NULL'}`)

const idx = await sql`
  SELECT indexname FROM pg_indexes WHERE tablename = 'patient_profiles' ORDER BY indexname`
console.log(`\nindexes (${idx.length}):`)
for (const i of idx) console.log('  ' + i.indexname)

// ─── 4. Confirm PHC tables are untouched ─────────────────────────────────
const phcTables = ['children', 'family_profiles', 'appointments', 'claims', 'patient_statements', 'encounter_notes']
console.log(`\nPHC table row counts (sanity check — should match pre-migration):`)
for (const t of phcTables) {
  try {
    const [row] = await sql.query(`SELECT COUNT(*)::int AS n FROM ${t}`)
    console.log(`  ${t.padEnd(22)} ${row.n}`)
  } catch (e) {
    console.log(`  ${t.padEnd(22)} ERROR: ${e.message}`)
  }
}

const [newCount] = await sql`SELECT COUNT(*)::int AS n FROM patient_profiles`
console.log(`\npatient_profiles rows (should be 0 for brand-new install): ${newCount.n}`)

console.log('\nMigration complete.')
