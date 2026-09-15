// Tests the NEW Claims Lifecycle response parser against the Neon
// preview DB. Runs the applyEraPaymentToClaim logic with mocked
// ClaimPaymentInformationSummary data (as if it came from Stedi's
// new endpoint) and verifies the correct patient_statements row is
// created with derived contractual_adjustment.
//
// Run with: node --env-file=.env.local test-lifecycle-parser.mjs

import { neon } from '@neondatabase/serverless'

const sql = neon(process.env.DATABASE_URL)
const CLEANUP_TAG = `TEST_LIFECYCLE_${Date.now()}`

function parseLifecyclePayment(claimPaymentInformation) {
  // Emulates what the real endpoint will do — extracts every relevant
  // field from a Stedi ClaimPaymentInformationSummary, computes the
  // implicit contractual_adjustment (billed - paid - patient resp).
  const billed = parseFloat(claimPaymentInformation.totalClaimChargeAmount ?? '0')
  const paid   = parseFloat(claimPaymentInformation.claimPaymentAmount ?? '0')
  const patResp = claimPaymentInformation.patientResponsibilityAmount != null
    ? parseFloat(claimPaymentInformation.patientResponsibilityAmount)
    : null
  const contractual = patResp != null
    ? +(billed - paid - patResp).toFixed(2)
    : null
  return {
    amount_billed:            Number.isFinite(billed) ? billed : null,
    insurance_payment:        Number.isFinite(paid) ? paid : null,
    patient_responsibility:   patResp,
    contractual_adjustment:   contractual,
    // Categorization stays null until biller enters manually or Stedi
    // exposes a per-CAS-code endpoint.
    patient_deductible:       null,
    patient_coinsurance:      null,
    patient_copay:            null,
    patient_non_covered:      null,
  }
}

async function pickPracticeAndProvider() {
  const [row] = await sql`
    SELECT p.id AS provider_id, p.practice_id
    FROM providers p
    WHERE p.is_active = true
    LIMIT 1`
  if (!row) throw new Error('No active provider in preview DB')
  return row
}

async function cleanup(practiceId) {
  await sql`
    DELETE FROM patient_statements WHERE practice_id = ${practiceId}::uuid AND patient_first_name = ${'TEST_' + CLEANUP_TAG}`
  await sql`
    DELETE FROM claims WHERE practice_id = ${practiceId}::uuid AND patient_first_name = ${'TEST_' + CLEANUP_TAG}`
}

async function bootstrap() {
  // Idempotent — same statement the endpoint runs on every request.
  try { await sql`ALTER TABLE claims ADD COLUMN IF NOT EXISTS patient_responsibility_era numeric(10,2)` } catch {}
}

async function insertTestClaim(practiceId, providerId) {
  const [row] = await sql`
    INSERT INTO claims (
      practice_id, provider_id,
      patient_first_name, patient_last_name,
      status, service_date, cpt_codes
    ) VALUES (
      ${practiceId}::uuid, ${providerId}::uuid,
      ${'TEST_' + CLEANUP_TAG}, ${'PATIENT'},
      'submitted', ${new Date().toISOString().slice(0, 10)}::date,
      ${'[]'}::jsonb
    ) RETURNING id`
  return row.id
}

async function applyEraPayment(sql, claim, parsed, rawEvent) {
  // Simplified — mirror the logic that would ship in the real cron.
  await sql`
    UPDATE claims SET
      era_received_at            = COALESCE(era_received_at, NOW()),
      era_raw                    = ${JSON.stringify(rawEvent)}::jsonb,
      amount_billed_era          = ${parsed.amount_billed},
      insurance_payment_era      = ${parsed.insurance_payment},
      contractual_adjustment_era = ${parsed.contractual_adjustment},
      patient_deductible_era     = ${parsed.patient_deductible},
      patient_coinsurance_era    = ${parsed.patient_coinsurance},
      patient_copay_era          = ${parsed.patient_copay},
      patient_non_covered_era    = ${parsed.patient_non_covered},
      patient_responsibility_era = ${parsed.patient_responsibility},
      updated_at                 = NOW()
    WHERE id = ${claim.id}`

  const patientResp = parsed.patient_responsibility ?? 0
  const remaining = (parsed.amount_billed ?? 0) - (parsed.insurance_payment ?? 0) - (parsed.contractual_adjustment ?? 0)

  await sql`
    INSERT INTO patient_statements (
      practice_id, claim_id,
      patient_first_name, patient_last_name,
      date_of_service, cpt_codes,
      amount_billed, insurance_payment, contractual_adjustment,
      patient_copay, patient_deductible, patient_coinsurance, patient_non_covered,
      remaining_balance, prior_balance, total_amount_due, total_amount_due_text,
      status, created_at, updated_at
    ) VALUES (
      ${claim.practice_id}::uuid, ${claim.id},
      ${claim.patient_first_name}, ${claim.patient_last_name},
      ${claim.service_date}, ${JSON.stringify(claim.cpt_codes ?? [])}::jsonb,
      ${parsed.amount_billed}, ${parsed.insurance_payment}, ${parsed.contractual_adjustment},
      ${parsed.patient_copay}, ${parsed.patient_deductible}, ${parsed.patient_coinsurance}, ${parsed.patient_non_covered},
      ${remaining}, 0, ${patientResp}, ${String(patientResp)},
      'draft', NOW(), NOW()
    )`
}

async function run() {
  const { provider_id, practice_id } = await pickPracticeAndProvider()
  await cleanup(practice_id)
  await bootstrap()

  // ── Case 1: normal ERA — insurance paid partial, patient owes partial
  console.log('[test] Case 1: partial insurance payment, some patient responsibility')
  const claim1Id = await insertTestClaim(practice_id, provider_id)
  const [claim1] = await sql`SELECT * FROM claims WHERE id = ${claim1Id}::uuid`
  const event1 = {
    id: 'clp_TEST_1',
    statusCode: 'PROCESSED_AS_PRIMARY',
    totalClaimChargeAmount: '495.00',
    claimPaymentAmount: '145.12',
    patientResponsibilityAmount: '50.00',
  }
  const parsed1 = parseLifecyclePayment(event1)
  await applyEraPayment(sql, claim1, parsed1, event1)
  const [stmt1] = await sql`SELECT * FROM patient_statements WHERE claim_id = ${claim1.id}`
  if (parseFloat(stmt1.amount_billed) !== 495) throw new Error(`Case 1 billed wrong: ${stmt1.amount_billed}`)
  if (parseFloat(stmt1.insurance_payment) !== 145.12) throw new Error(`Case 1 paid wrong: ${stmt1.insurance_payment}`)
  if (Math.abs(parseFloat(stmt1.contractual_adjustment) - 299.88) > 0.01) throw new Error(`Case 1 contractual wrong: expected 299.88, got ${stmt1.contractual_adjustment}`)
  if (parseFloat(stmt1.total_amount_due) !== 50) throw new Error(`Case 1 total due wrong: ${stmt1.total_amount_due}`)
  console.log('[test]   ✓ billed=495, paid=145.12, contractual=299.88 (derived), patient owes 50')

  // ── Case 2: $0 paid, everything goes to patient (the deductible case)
  console.log('[test] Case 2: $0 insurance payment, full amount to patient (deductible-only ERA)')
  const claim2Id = await insertTestClaim(practice_id, provider_id)
  const [claim2] = await sql`SELECT * FROM claims WHERE id = ${claim2Id}::uuid`
  const event2 = {
    id: 'clp_TEST_2',
    statusCode: 'PROCESSED_AS_PRIMARY',
    totalClaimChargeAmount: '495.00',
    claimPaymentAmount: '0.00',
    patientResponsibilityAmount: '495.00',
  }
  const parsed2 = parseLifecyclePayment(event2)
  await applyEraPayment(sql, claim2, parsed2, event2)
  const [stmt2] = await sql`SELECT * FROM patient_statements WHERE claim_id = ${claim2.id}`
  if (parseFloat(stmt2.insurance_payment) !== 0) throw new Error(`Case 2 paid wrong`)
  if (parseFloat(stmt2.contractual_adjustment) !== 0) throw new Error(`Case 2 contractual wrong: ${stmt2.contractual_adjustment}`)
  if (parseFloat(stmt2.total_amount_due) !== 495) throw new Error(`Case 2 total due wrong: ${stmt2.total_amount_due}`)
  console.log('[test]   ✓ billed=495, paid=0, contractual=0, patient owes full 495 (deductible case handled)')

  // ── Case 3: contractual write-off consumes everything, patient owes nothing
  console.log('[test] Case 3: full contractual adjustment, patient owes nothing')
  const claim3Id = await insertTestClaim(practice_id, provider_id)
  const [claim3] = await sql`SELECT * FROM claims WHERE id = ${claim3Id}::uuid`
  const event3 = {
    id: 'clp_TEST_3',
    statusCode: 'PROCESSED_AS_PRIMARY',
    totalClaimChargeAmount: '495.00',
    claimPaymentAmount: '145.12',
    patientResponsibilityAmount: '0.00',
  }
  const parsed3 = parseLifecyclePayment(event3)
  await applyEraPayment(sql, claim3, parsed3, event3)
  const [stmt3] = await sql`SELECT * FROM patient_statements WHERE claim_id = ${claim3.id}`
  if (Math.abs(parseFloat(stmt3.contractual_adjustment) - 349.88) > 0.01) throw new Error(`Case 3 contractual wrong: ${stmt3.contractual_adjustment}`)
  if (parseFloat(stmt3.total_amount_due) !== 0) throw new Error(`Case 3 total due wrong: ${stmt3.total_amount_due}`)
  console.log('[test]   ✓ billed=495, paid=145.12, contractual=349.88, patient owes 0 (Parker Martirano case)')

  await cleanup(practice_id)
  console.log('[test] PASS — all 3 lifecycle-parser assertions succeeded')
}

run().catch(e => {
  console.error('[test] FAIL:', e.message)
  process.exit(1)
})
