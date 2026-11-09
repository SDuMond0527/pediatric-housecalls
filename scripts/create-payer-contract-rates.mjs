// Create the payer_contract_rates table + seed from historical ERAs.
//
// Design: one row per (practice_id, payer_id, cpt_code, effective_from).
// Rates can change when contracts renegotiate — history is preserved by
// closing out the old row (set effective_to) rather than overwriting.
// Each row carries a provenance tag so Andrea knows whether the number
// came from an auto-seed (needs review) or from a real contract document
// she entered by hand.
//
// Bootstrap approach: for each (payer_id, primary CPT code), compute the
// median insurance_payment_era across single-CPT claims in the last 90
// days. Multi-CPT claims are excluded because the ERA total isn't split
// per line in our schema — we'd be dividing by the wrong denominator.
//
// Run: node --env-file=.env scripts/create-payer-contract-rates.mjs
// Preview: node --env-file=.env.local scripts/create-payer-contract-rates.mjs
import { neon } from '@neondatabase/serverless'
const sql = neon(process.env.DATABASE_URL)

await sql`
  CREATE TABLE IF NOT EXISTS payer_contract_rates (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    practice_id       uuid NOT NULL,
    payer_id          text NOT NULL,
    payer_name        text NOT NULL,
    cpt_code          text NOT NULL,
    contracted_amount numeric(10,2) NOT NULL,
    -- Provenance so Andrea can tell auto-seeded rows from contract-doc rows.
    source            text NOT NULL,         -- 'era_median_seed' | 'manual' | 'contract_document'
    sample_size       int,                   -- for era_median_seed: ERAs averaged
    effective_from    date NOT NULL DEFAULT CURRENT_DATE,
    effective_to      date,                  -- NULL = currently in force
    notes             text,
    created_at        timestamptz NOT NULL DEFAULT NOW(),
    updated_at        timestamptz NOT NULL DEFAULT NOW(),
    updated_by        uuid,
    updated_by_name   text,
    UNIQUE (practice_id, payer_id, cpt_code, effective_from)
  )`
await sql`CREATE INDEX IF NOT EXISTS idx_payer_contract_rates_lookup
          ON payer_contract_rates (practice_id, payer_id, cpt_code, effective_from DESC)`

console.log('✓ Table + index ensured')

// ── Bootstrap from last 90 days of ERAs ────────────────────────────
// Group single-CPT claims by (practice_id, payer_id, cpt_code). Only
// include rows where the ERA returned a positive insurance payment.
// Self-pay rows (payer_id = 'PP') are excluded — no contract applies.
const groups = await sql`
  WITH single_cpt AS (
    SELECT
      practice_id,
      payer_id,
      payer_name,
      (cpt_codes -> 0 ->> 'code') AS cpt_code,
      insurance_payment_era::numeric AS paid
    FROM claims
    WHERE era_received_at > NOW() - INTERVAL '90 days'
      AND jsonb_typeof(cpt_codes) = 'array'
      AND jsonb_array_length(cpt_codes) = 1
      AND insurance_payment_era > 0
      AND payer_id IS NOT NULL
      AND payer_id <> 'PP'
  )
  SELECT
    practice_id,
    payer_id,
    MAX(payer_name) AS payer_name,
    cpt_code,
    PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY paid)::numeric(10,2) AS median_paid,
    COUNT(*)::int AS sample_size
  FROM single_cpt
  WHERE cpt_code IS NOT NULL
  GROUP BY practice_id, payer_id, cpt_code
  ORDER BY practice_id, payer_id, cpt_code`

console.log(`\nFound ${groups.length} unique (practice × payer × CPT) groups to seed.`)

let inserted = 0
let skipped = 0
for (const g of groups) {
  // Skip if an open rate already exists for this combo (no effective_to set)
  const [existing] = await sql`
    SELECT id FROM payer_contract_rates
    WHERE practice_id = ${g.practice_id}::uuid
      AND payer_id    = ${g.payer_id}
      AND cpt_code    = ${g.cpt_code}
      AND effective_to IS NULL
    LIMIT 1`
  if (existing) { skipped++; continue }

  await sql`
    INSERT INTO payer_contract_rates
      (practice_id, payer_id, payer_name, cpt_code, contracted_amount,
       source, sample_size, effective_from, notes)
    VALUES
      (${g.practice_id}::uuid, ${g.payer_id}, ${g.payer_name}, ${g.cpt_code},
       ${g.median_paid},
       'era_median_seed', ${g.sample_size}, CURRENT_DATE,
       'Auto-seeded from the median insurance payment across the last 90 days of ERAs. Needs Andrea review before the underpayment flagger goes live.')`
  inserted++
}

console.log(`\n✓ Inserted ${inserted} new seed rows.`)
console.log(`  Skipped ${skipped} that already had an open rate.`)

// Report what landed, grouped by payer, to give Sara a readable summary
console.log('\n── Seeded rates by payer ──────────────────────────────')
const bypayer = await sql`
  SELECT payer_name, payer_id,
         COUNT(*)::int AS rate_count,
         SUM(sample_size)::int AS total_eras_averaged,
         AVG(sample_size)::numeric(10,1) AS avg_sample_size
  FROM payer_contract_rates
  WHERE source = 'era_median_seed'
  GROUP BY payer_name, payer_id
  ORDER BY rate_count DESC`
for (const p of bypayer) {
  console.log(`  ${p.payer_name} (${p.payer_id}): ${p.rate_count} CPT rates, ${p.total_eras_averaged} ERAs averaged (avg sample ${p.avg_sample_size})`)
}

// Show the 5 highest-sample-size rates so Sara sees what high-confidence
// seed values look like
console.log('\n── Top 10 highest-confidence seed rates (largest sample) ──')
const top = await sql`
  SELECT payer_name, cpt_code, contracted_amount, sample_size
  FROM payer_contract_rates
  WHERE source = 'era_median_seed'
  ORDER BY sample_size DESC, contracted_amount DESC
  LIMIT 10`
for (const r of top) {
  console.log(`  ${r.payer_name?.padEnd(28)} ${r.cpt_code?.padEnd(8)} $${r.contracted_amount}  (n=${r.sample_size})`)
}

console.log('\nDone.')
