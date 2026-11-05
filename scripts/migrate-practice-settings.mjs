// Phase 1 migration: add practice settings infrastructure.
//
// Idempotent — safe to re-run. Each statement uses IF NOT EXISTS so
// a partial failure doesn't block a retry.
//
// Run order:
//   1. Preview first:    node --env-file=.env.local scripts/migrate-practice-settings.mjs
//   2. Verify (below)
//   3. Prod only after preview passes: node --env-file=.env scripts/migrate-practice-settings.mjs
//
// This script does NOT seed data (PHC, Crestview, Sara Cash blobs).
// That's Task #4 in a separate script.

import { neon } from '@neondatabase/serverless'
const sql = neon(process.env.DATABASE_URL)

console.log('Starting migration on endpoint:', process.env.DATABASE_URL?.match(/ep-[a-z0-9-]+/)?.[0] ?? '(unknown)')

// 1. Add settings jsonb column on practices.
//    Default '{}' so rows added before this migration have a valid blob.
//    Zod parser treats {} as "all PHC defaults" so behavior is unchanged.
await sql`ALTER TABLE practices ADD COLUMN IF NOT EXISTS settings jsonb NOT NULL DEFAULT '{}'::jsonb`
console.log('✓ practices.settings column ensured')

// 2. Audit log for every settings change. Immutable by convention —
//    no UPDATE / DELETE endpoints will touch this table.
await sql`
  CREATE TABLE IF NOT EXISTS practice_settings_audit (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    practice_id uuid NOT NULL REFERENCES practices(id) ON DELETE CASCADE,
    changed_by_provider_id uuid REFERENCES providers(id) ON DELETE SET NULL,
    changed_by_name text,
    field_path text NOT NULL,
    old_value jsonb,
    new_value jsonb,
    changed_at timestamptz NOT NULL DEFAULT now()
  )`
console.log('✓ practice_settings_audit table ensured')

await sql`CREATE INDEX IF NOT EXISTS practice_settings_audit_practice_idx ON practice_settings_audit(practice_id, changed_at DESC)`
await sql`CREATE INDEX IF NOT EXISTS practice_settings_audit_changed_at_idx ON practice_settings_audit(changed_at DESC)`
console.log('✓ practice_settings_audit indexes ensured')

// 3. Verify.
const [{ settings_col }] = await sql`
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'practices' AND column_name = 'settings'
  ) AS settings_col`
const [{ audit_table }] = await sql`
  SELECT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_name = 'practice_settings_audit'
  ) AS audit_table`

console.log('')
console.log('=== Verification ===')
console.log(`practices.settings column exists:    ${settings_col}`)
console.log(`practice_settings_audit table exists: ${audit_table}`)

if (!settings_col || !audit_table) {
  console.error('MIGRATION INCOMPLETE — do not proceed to prod')
  process.exit(1)
}

const rows = await sql`SELECT id, name, settings FROM practices ORDER BY created_at`
console.log('')
console.log('=== Current practice blobs ===')
for (const r of rows) {
  const keyCount = Object.keys(r.settings ?? {}).length
  console.log(`  ${r.name.padEnd(30)}  settings keys: ${keyCount}`)
}

console.log('')
console.log('Migration complete. No data was seeded — run migrate-seed-settings.mjs next.')
