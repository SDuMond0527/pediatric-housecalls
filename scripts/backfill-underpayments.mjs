// One-time backfill — scan every paid claim with an ERA and queue any
// where TOTAL ALLOWED (payer payment + patient responsibility) falls
// ≥ $5 below the contracted rate in payer_contract_rates. Only single-CPT
// claims. Idempotent — skips rows with an open underpayment already.
//
// Rev 2026-11-09:
//   - Switched comparison to total allowed (not insurance_payment alone).
//     Original math was comparing payer cut to total contracted rate,
//     producing 100% false positives (every PR-3 copay looked like an
//     underpayment).
//   - Pulls denial_codes + remark_codes and translates to plain English
//     so Sara can tell real underpayments from legitimate CO-45 writes.
//
// Keep in sync with the inline flagger in api/claims/[id].ts,
// api/webhooks/stedi-era.ts, api/cron/stedi-era-poll.ts.
//
// Run: node --env-file=.env scripts/backfill-underpayments.mjs
import { neon } from '@neondatabase/serverless'
const sql = neon(process.env.DATABASE_URL)

const CARC_LABEL = {
  '1':   'Deductible amount',
  '2':   'Coinsurance amount',
  '3':   'Co-payment amount',
  '45':  'Charge exceeds fee schedule / contracted allowable',
  '50':  'Non-covered — not deemed medically necessary',
  '96':  'Non-covered charges',
  '97':  'Benefit included in payment for another service (bundled)',
  '119': 'Benefit maximum has been reached',
  '197': 'Prior authorization missing or invalid',
  '204': "Not covered under the patient's plan",
  '253': 'Sequestration — federal payment reduction',
}
const GROUP_LABEL = {
  'CO': 'Contractual Obligation (payer writes off per contract)',
  'PR': 'Patient Responsibility (family owes)',
  'OA': 'Other Adjustment',
  'PI': 'Payer Initiated reduction',
}
function describeDenialCodes(codes) {
  if (!Array.isArray(codes)) return []
  return codes.map(c => {
    const grp = String(c?.group_code ?? '')
    const rsn = String(c?.reason_code ?? '')
    const amt = Number(c?.amount ?? 0)
    const grpLabel = GROUP_LABEL[grp] ? ` [${GROUP_LABEL[grp]}]` : ''
    const rsnLabel = CARC_LABEL[rsn] ? `: ${CARC_LABEL[rsn]}` : ''
    return `${grp}-${rsn}${rsnLabel} — $${amt.toFixed(2)}${grpLabel}`
  })
}
function interpretGap(contractRateSource, denialCodes) {
  const hasCO45 = Array.isArray(denialCodes) && denialCodes.some(c =>
    String(c?.group_code) === 'CO' && String(c?.reason_code) === '45')
  if (hasCO45 && contractRateSource === 'era_median_seed') {
    return 'Payer applied CO-45 (charge exceeds fee schedule). The seeded contract rate is a median across prior ERAs for this payer × CPT, which may be noisy across plan variants. This "underpayment" may simply reflect this specific plan\'s fee schedule. Confirm against the payer contract document before escalating.'
  }
  if (hasCO45) {
    return 'Payer applied CO-45 (charge exceeds fee schedule) but your stored contract rate is from a signed contract document. Real candidate for a call to the payer — they paid below their own schedule.'
  }
  const hasBundling = Array.isArray(denialCodes) && denialCodes.some(c => String(c?.reason_code) === '97')
  if (hasBundling) {
    return 'Payer bundled this line into another service (CO-97). Confirm whether an unbundling modifier (e.g. 25, 59) belongs on the paired code.'
  }
  return 'No obvious CARC/RARC explanation for the gap — worth a direct call to the payer.'
}

const candidates = await sql`
  SELECT cl.id, cl.practice_id, cl.payer_id, cl.payer_name,
         (cl.cpt_codes -> 0 ->> 'code') AS cpt_code,
         cl.insurance_payment_era::numeric AS insurance_paid,
         (
           COALESCE(cl.patient_copay_era, 0) +
           COALESCE(cl.patient_deductible_era, 0) +
           COALESCE(cl.patient_coinsurance_era, 0) +
           COALESCE(cl.patient_non_covered_era, 0)
         )::numeric AS patient_resp,
         (
           COALESCE(cl.insurance_payment_era, 0) +
           COALESCE(cl.patient_copay_era, 0) +
           COALESCE(cl.patient_deductible_era, 0) +
           COALESCE(cl.patient_coinsurance_era, 0) +
           COALESCE(cl.patient_non_covered_era, 0)
         )::numeric AS total_allowed,
         cl.denial_codes, cl.remark_codes,
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
    AND (
      COALESCE(cl.insurance_payment_era, 0) +
      COALESCE(cl.patient_copay_era, 0) +
      COALESCE(cl.patient_deductible_era, 0) +
      COALESCE(cl.patient_coinsurance_era, 0) +
      COALESCE(cl.patient_non_covered_era, 0)
    )::numeric < r.contracted_amount - 5
  ORDER BY (r.contracted_amount - (
      COALESCE(cl.insurance_payment_era, 0) +
      COALESCE(cl.patient_copay_era, 0) +
      COALESCE(cl.patient_deductible_era, 0) +
      COALESCE(cl.patient_coinsurance_era, 0) +
      COALESCE(cl.patient_non_covered_era, 0)
    )::numeric) DESC`

console.log(`Found ${candidates.length} real underpayments (total allowed vs contracted):\n`)
let inserted = 0
let skipped = 0

for (const c of candidates) {
  const insurancePaid = parseFloat(String(c.insurance_paid))
  const patientResp = parseFloat(String(c.patient_resp))
  const totalAllowed = parseFloat(String(c.total_allowed))
  const contracted = parseFloat(String(c.contracted))
  const gap = +(contracted - totalAllowed).toFixed(2)
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
  const denialDescriptions = describeDenialCodes(c.denial_codes)
  const remarkList = Array.isArray(c.remark_codes) ? c.remark_codes.filter(r => typeof r === 'string') : []
  const interpretation = interpretGap(String(c.rate_source), c.denial_codes)
  const summary =
    `${c.payer_name ?? 'Payer'} total allowed $${totalAllowed.toFixed(2)} on CPT ${c.cpt_code} vs expected $${contracted.toFixed(2)} (gap $${gap.toFixed(2)}). ` +
    `${denialDescriptions.length > 0 ? 'Payer says: ' + denialDescriptions.slice(0, 2).join('; ') + '.' : 'No reason code supplied by payer.'}`
  const reasoning = {
    cpt_code: c.cpt_code,
    contracted_amount: contracted,
    total_allowed: totalAllowed,
    insurance_payment_era: insurancePaid,
    patient_responsibility: +patientResp.toFixed(2),
    gap_amount: gap,
    contract_source: c.rate_source,
    contract_sample_size: c.sample_size,
    confidence_note: c.rate_source === 'era_median_seed'
      ? `Seed rate from ${c.sample_size} prior ERAs — verify before escalating with the payer.`
      : 'Rate confirmed from contract document.',
    payer_reason_codes: denialDescriptions,
    payer_remark_codes: remarkList,
    interpretation,
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
  console.log(`  queued: ${patientName.padEnd(28)} ${(c.payer_name ?? '').slice(0, 22).padEnd(22)} ${c.cpt_code}  gap $${gap.toFixed(2)}`)
}

console.log(`\n✓ Inserted ${inserted} new underpayment items (${skipped} already queued).`)
