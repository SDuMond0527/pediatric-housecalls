// One-time backfill — scan every paid claim with an ERA and queue any
// that fall ≥ $5 below the contracted rate stored in payer_contract_rates.
// Only single-CPT claims (ERA total isn't line-split in our schema).
// Idempotent: existing open underpayment items are not duplicated.
//
// Run: node --env-file=.env scripts/backfill-underpayments.mjs
import { neon } from '@neondatabase/serverless'
const sql = neon(process.env.DATABASE_URL)

const candidates = await sql`
  SELECT cl.id, cl.practice_id, cl.payer_id, cl.payer_name,
         (cl.cpt_codes -> 0 ->> 'code') AS cpt_code,
         cl.insurance_payment_era::numeric AS paid,
         r.contracted_amount AS contracted,
         r.source AS rate_source,
         r.sample_size,
         cl.patient_first_name, cl.patient_last_name,
         cl.service_date::text AS service_date,
         cl.stedi_claim_id, cl.payer_control_number
  FROM claims cl
  JOIN payer_contract_rates r
    ON r.practice_id = cl.practice_id
   AND r.payer_id    = cl.payer_id
   AND r.cpt_code    = (cl.cpt_codes -> 0 ->> 'code')
   AND r.effective_from <= CURRENT_DATE
   AND (r.effective_to IS NULL OR r.effective_to >= CURRENT_DATE)
  WHERE cl.era_received_at IS NOT NULL
    AND cl.payer_id != 'PP'
    AND jsonb_array_length(cl.cpt_codes) = 1
    AND cl.insurance_payment_era > 0
    AND cl.insurance_payment_era::numeric < r.contracted_amount - 5
  ORDER BY (r.contracted_amount - cl.insurance_payment_era::numeric) DESC`

console.log(`Found ${candidates.length} underpayments to backfill:\n`)
let inserted = 0
let skipped = 0

for (const c of candidates) {
  const gap = +(parseFloat(String(c.contracted)) - parseFloat(String(c.paid))).toFixed(2)
  const paid = parseFloat(String(c.paid))
  const contracted = parseFloat(String(c.contracted))
  const [existing] = await sql`
    SELECT id FROM review_queue_items
    WHERE practice_id = ${c.practice_id}::uuid
      AND claim_id    = ${c.id}::uuid
      AND item_type   = 'underpayment'
      AND status      = 'open'
    LIMIT 1`
  if (existing) { skipped++; continue }

  const priority = gap > 100 ? 10 : gap > 25 ? 50 : 100
  const patientName = [c.patient_first_name, c.patient_last_name].filter(Boolean).join(' ') || 'Unknown patient'
  const summary =
    `${c.payer_name ?? 'Payer'} underpaid CPT ${c.cpt_code} by $${gap.toFixed(2)}. ` +
    `Contracted $${contracted.toFixed(2)}, received $${paid.toFixed(2)}.`
  const reasoning = {
    cpt_code: c.cpt_code,
    contracted_amount: contracted,
    insurance_payment_era: paid,
    gap_amount: gap,
    contract_source: c.rate_source,
    contract_sample_size: c.sample_size,
    confidence_note: c.rate_source === 'era_median_seed'
      ? `Seed rate from ${c.sample_size} prior ERAs — verify before escalating with the payer.`
      : 'Rate confirmed from contract document.',
    stedi_claim_id: c.stedi_claim_id,
    payer_control_number: c.payer_control_number,
    source: 'underpayment-flagger (backfill)',
  }
  await sql`
    INSERT INTO review_queue_items
      (practice_id, item_type, work_category, claim_id, patient_name,
       payer_name, service_date, priority, summary, agent_reasoning)
    VALUES
      (${c.practice_id}::uuid, 'underpayment', 'denials', ${c.id}::uuid,
       ${patientName}, ${c.payer_name ?? null}, ${c.service_date ?? null}::date,
       ${priority}, ${summary}, ${JSON.stringify(reasoning)}::jsonb)`
  inserted++
  console.log(`  queued: ${patientName.padEnd(28)} ${c.payer_name?.slice(0, 22).padEnd(22)} ${c.cpt_code}  gap $${gap.toFixed(2)}`)
}

console.log(`\n✓ Inserted ${inserted} new underpayment items (${skipped} already queued).`)
