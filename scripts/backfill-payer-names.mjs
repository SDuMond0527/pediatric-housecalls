// One-time backfill: normalize claims.payer_name from payer_id using
// the canonical map Sara approved 2026-11-13.
//
// Dry-run by default — prints the change set. Pass --apply to write.
//   node --env-file=.env scripts/backfill-payer-names.mjs
//   node --env-file=.env scripts/backfill-payer-names.mjs --apply
//
// Map lives in api/claims/payers.ts; mirrored here because scripts/
// don't share bundles with api/. Keep in sync if the canonical list changes.

import { neon } from '@neondatabase/serverless'

const CANONICAL_BY_PAYER_ID = {
  'UPICO': 'BCBS of NC',
  'VABLS': 'Anthem BCBS of VA',
  '87726': 'United Healthcare',
  '62308': 'Cigna',
  '60054': 'Aetna',
  '39026': 'UMR',
  '98798': 'Bright Health',
  '56162': 'Medcost',
  '41124': 'Meritain',
  'PP':    'Self Pay',
}

const apply = process.argv.includes('--apply')
const sql = neon(process.env.DATABASE_URL)

// Preview: every row where current payer_name differs from canonical for its payer_id.
const preview = await sql`
  SELECT payer_id, payer_name AS current_name, COUNT(*) AS n
  FROM claims
  WHERE payer_id IS NOT NULL
  GROUP BY payer_id, payer_name
  ORDER BY payer_id, n DESC`

let total = 0
let touched = 0
const perPayer = {}

console.log(apply ? '=== APPLY MODE — writing changes ===' : '=== DRY RUN — no changes written (use --apply to commit) ===\n')
console.log('payer_id\tcount\tcurrent_name                            \t→ canonical')
console.log('-'.repeat(100))
for (const row of preview) {
  const current = row.current_name ?? '(null)'
  const canonical = CANONICAL_BY_PAYER_ID[row.payer_id] ?? null
  total += Number(row.n)
  if (canonical && canonical !== row.current_name) {
    touched += Number(row.n)
    perPayer[canonical] = (perPayer[canonical] ?? 0) + Number(row.n)
    console.log(`${row.payer_id.padEnd(8)}\t${String(row.n).padStart(4)}\t${current.padEnd(40)}\t→ ${canonical}`)
  } else if (!canonical) {
    console.log(`${row.payer_id.padEnd(8)}\t${String(row.n).padStart(4)}\t${current.padEnd(40)}\t  (no canonical — left alone)`)
  }
}

console.log('\nSummary:')
console.log(`  ${total} total claim rows scanned`)
console.log(`  ${touched} rows would be updated`)
console.log('  Rows per canonical target:')
for (const [name, n] of Object.entries(perPayer).sort((a, b) => b[1] - a[1])) {
  console.log(`    ${name.padEnd(28)} ${n}`)
}

if (!apply) {
  console.log('\nDry run complete. Re-run with --apply to write the normalization to claims.payer_name.')
  process.exit(0)
}

// Apply: one UPDATE per canonical name, keyed by payer_id. Each update
// is its own autocommit — but all are idempotent, so partial failures
// are safe.
console.log('\nApplying…')
let updated = 0
for (const [payerId, canonical] of Object.entries(CANONICAL_BY_PAYER_ID)) {
  const r = await sql`
    UPDATE claims
    SET payer_name = ${canonical}
    WHERE payer_id = ${payerId} AND (payer_name IS DISTINCT FROM ${canonical})
    RETURNING id`
  console.log(`  ${payerId.padEnd(8)} → ${canonical.padEnd(28)} : ${r.length} rows updated`)
  updated += r.length
}
console.log(`\nDone. ${updated} rows updated.`)
