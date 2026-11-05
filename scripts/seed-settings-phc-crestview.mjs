// Phase 1 Task #4: seed explicit all-ON blobs for PHC + Crestview.
//
// Why seed if empty blobs already parse to PHC defaults via Zod?
// Two reasons:
// 1. Explicit is clearer than implicit — a raw DB inspection shows
//    the concrete state these practices are in.
// 2. Future audit entries compare old → new. Starting from an explicit
//    baseline makes those diffs concrete instead of "undefined → true."
//
// Sarah Cash is NOT seeded here — she stays with the empty blob until
// Phase 4 when we onboard her with skeletonCashPayOfficeSettings().
// Her practice has 0 providers so nobody logs in as her yet.
//
// Idempotent: if a blob already has keys, we skip (don't overwrite
// deliberate changes).
//
// Run: node --env-file=.env.local scripts/seed-settings-phc-crestview.mjs
// Then: node --env-file=.env     scripts/seed-settings-phc-crestview.mjs

import { neon } from '@neondatabase/serverless'
import { practiceSettingsSchema } from '../src/lib/practiceSettings.ts'

const sql = neon(process.env.DATABASE_URL)

const PHC_ID       = '6b5a893f-f56c-4786-9912-59148a5e9aba'
const CRESTVIEW_ID = 'de000000-0000-4000-8000-000000000001'

// Build an explicit all-defaults blob via Zod parse of empty input.
// Picks up every key defined in the schema with its PHC-default value.
const defaultBlob = practiceSettingsSchema.parse({})

console.log('Seeding on endpoint:', process.env.DATABASE_URL?.match(/ep-[a-z0-9-]+/)?.[0])
console.log('Keys in default blob:', Object.keys(defaultBlob).length)
console.log('')

for (const [label, id] of [['PHC', PHC_ID], ['Crestview', CRESTVIEW_ID]]) {
  const [existing] = await sql`SELECT id, name, settings FROM practices WHERE id = ${id}::uuid`
  if (!existing) {
    console.log(`  ⚠ ${label} (${id}) not found — skipping`)
    continue
  }
  const existingKeys = Object.keys(existing.settings ?? {}).length
  if (existingKeys > 0) {
    console.log(`  • ${label} already has ${existingKeys} settings keys — skipping (idempotent)`)
    continue
  }

  await sql`
    UPDATE practices
    SET settings = ${JSON.stringify(defaultBlob)}::jsonb
    WHERE id = ${id}::uuid`

  // One audit row per seed, distinguishable via field_path='_seed'.
  await sql`
    INSERT INTO practice_settings_audit
      (practice_id, changed_by_provider_id, changed_by_name, field_path, old_value, new_value)
    VALUES
      (${id}::uuid, NULL, 'System (Phase 1 seed)', '_seed', ${JSON.stringify({})}::jsonb, ${JSON.stringify(defaultBlob)}::jsonb)`

  console.log(`  ✓ ${label} seeded (${Object.keys(defaultBlob).length} keys)`)
}

console.log('')
console.log('=== Current state ===')
const rows = await sql`SELECT name, jsonb_object_keys(settings) AS k FROM practices ORDER BY name`
const perPractice = {}
for (const r of rows) {
  perPractice[r.name] = (perPractice[r.name] ?? 0) + 1
}
for (const [name, n] of Object.entries(perPractice)) {
  console.log(`  ${name.padEnd(30)}  settings keys: ${n}`)
}
const emptyRows = await sql`SELECT name FROM practices WHERE settings = '{}'::jsonb ORDER BY name`
for (const r of emptyRows) {
  console.log(`  ${r.name.padEnd(30)}  settings keys: 0  (unseeded — intentional for Sarah Cash)`)
}
