// Re-seed payer_contract_rates using TOTAL ALLOWED, not just payer payment.
//
// Original seed script computed median of insurance_payment_era, which is
// just the payer's cut after they peel off the family's copay/deductible/
// coinsurance. That number is systematically LOWER than the actual
// contracted rate (= total allowed). The flagger was then comparing the
// payer's cut against a seed built on the payer's cut — but the LABEL was
// "contracted rate" which means total allowed. Made 100% of flagged
// underpayments false positives on the first live run. Sara caught it
// 2026-11-09 by asking about reason codes.
//
// Fix: total allowed = insurance_payment + copay + deductible + coinsurance
//                      + non_covered (= billed - contractual_adjustment).
// Re-seed every existing era_median_seed row with the correct median.
//
// Run: node --env-file=.env scripts/reseed-payer-contract-rates.mjs
import { neon } from '@neondatabase/serverless'
const sql = neon(process.env.DATABASE_URL)

// Wipe only the auto-seeded rows. Any rows Sara / Andrea have promoted
// to 'manual' or 'contract_document' stay — those are ground truth.
const deleted = await sql`
  DELETE FROM payer_contract_rates WHERE source = 'era_median_seed' RETURNING id`
console.log(`Cleared ${deleted.length} old seed rows.`)

const groups = await sql`
  WITH single_cpt AS (
    SELECT
      practice_id,
      payer_id,
      payer_name,
      (cpt_codes -> 0 ->> 'code') AS cpt_code,
      (
        COALESCE(insurance_payment_era, 0) +
        COALESCE(patient_copay_era, 0) +
        COALESCE(patient_deductible_era, 0) +
        COALESCE(patient_coinsurance_era, 0) +
        COALESCE(patient_non_covered_era, 0)
      )::numeric AS total_allowed
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
    PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY total_allowed)::numeric(10,2) AS median_allowed,
    COUNT(*)::int AS sample_size
  FROM single_cpt
  WHERE cpt_code IS NOT NULL
    AND total_allowed > 0
  GROUP BY practice_id, payer_id, cpt_code
  ORDER BY practice_id, payer_id, cpt_code`

console.log(`\nSeeding ${groups.length} (practice × payer × CPT) groups with TOTAL ALLOWED medians.`)
let inserted = 0
for (const g of groups) {
  await sql`
    INSERT INTO payer_contract_rates
      (practice_id, payer_id, payer_name, cpt_code, contracted_amount,
       source, sample_size, effective_from, notes)
    VALUES
      (${g.practice_id}::uuid, ${g.payer_id}, ${g.payer_name}, ${g.cpt_code},
       ${g.median_allowed},
       'era_median_seed', ${g.sample_size}, CURRENT_DATE,
       'Auto-seeded from the median TOTAL ALLOWED (insurance payment + patient responsibility) across the last 90 days of ERAs. Needs Andrea review before the underpayment flagger goes live for this payer × CPT.')`
  inserted++
}
console.log(`\n✓ Re-seeded ${inserted} rows.`)

console.log('\n── Top 10 by sample size (highest-confidence rates) ──')
const top = await sql`
  SELECT payer_name, cpt_code, contracted_amount, sample_size
  FROM payer_contract_rates
  WHERE source = 'era_median_seed'
  ORDER BY sample_size DESC, contracted_amount DESC
  LIMIT 10`
for (const r of top) {
  console.log(`  ${r.payer_name?.padEnd(28)} ${r.cpt_code?.padEnd(8)} $${r.contracted_amount}  (n=${r.sample_size})`)
}
