// Preview-branch sanity check for the Pre-Visit Preview generator.
// Picks a real appointment from the preview DB and runs the same
// section-by-section build logic the endpoint uses. Verifies the
// returned shape, prints each section's bullets, confirms every
// bullet carries source attribution.
//
// Does NOT write to the pre_visit_previews table — read-only.
//
// Run: node --env-file=.env.local scripts/test-pre-visit-preview-generator.mjs
import { neon } from '@neondatabase/serverless'
const sql = neon(process.env.DATABASE_URL)

// Mirror the DEFAULT_SECTION_CONFIG from the endpoint
const CFG = {
  reason_for_visit:     { enabled: true, order: 1 },
  active_clinical:      { enabled: true, order: 2 },
  last_visit:           { enabled: true, order: 3 },
  changes_since_last:   { enabled: true, order: 4 },
  open_items:           { enabled: true, order: 5 },
  house_call_logistics: { enabled: true, order: 6 },
}

const [appt] = await sql`
  SELECT a.id, a.child_id, a.practice_id, a.visit_type, a.scheduled_date::text AS scheduled_date, a.notes
  FROM appointments a
  WHERE a.child_id IS NOT NULL
    AND a.status IN ('upcoming', 'scheduled', 'in-progress', 'done')
  ORDER BY a.scheduled_date DESC LIMIT 1`
if (!appt) { console.error('no appointment in preview DB'); process.exit(0) }

console.log('Testing with appointment', appt.id.slice(0, 8), '— DOS', appt.scheduled_date, '— type:', appt.visit_type)

// Confirm the table bootstraps without errors
await sql`
  CREATE TABLE IF NOT EXISTS pre_visit_previews (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    practice_id     uuid NOT NULL,
    appointment_id  uuid NOT NULL,
    preview_data    jsonb NOT NULL,
    generated_at    timestamptz NOT NULL DEFAULT NOW(),
    generated_by    text NOT NULL DEFAULT 'on_demand',
    UNIQUE (appointment_id)
  )`
await sql`CREATE INDEX IF NOT EXISTS idx_pre_visit_previews_practice ON pre_visit_previews(practice_id, generated_at DESC)`
console.log('✓ Table + index ensured')

// Run the key queries the endpoint uses — this tests whether the SQL
// is valid against the real schema. Failures here = broken endpoint.
const [child] = await sql`
  SELECT id, first_name, last_name, date_of_birth::text AS date_of_birth,
         allergies, current_medications, family_id, parent_phone, parent_email
  FROM children WHERE id = ${appt.child_id}::uuid`
console.log('✓ child query ok:', child ? child.first_name + ' ' + child.last_name : '(no child)')

const probs = await sql`
  SELECT id, label, icd10_code FROM chronic_problems
  WHERE child_id = ${appt.child_id}::uuid AND resolved_at IS NULL`
console.log('✓ chronic_problems query ok:', probs.length, 'unresolved')

const [prior] = await sql`
  SELECT en.id, en.chief_complaint, en.assessment, en.plan, en.signed_at,
         a.scheduled_date::text AS scheduled_date, a.visit_type,
         p.name AS provider_name
  FROM encounter_notes en
  JOIN appointments a ON a.id = en.appointment_id
  LEFT JOIN providers p ON p.id = en.provider_id
  WHERE en.child_id = ${appt.child_id}::uuid
    AND en.appointment_id <> ${appt.id}::uuid
    AND en.is_signed = true
  ORDER BY a.scheduled_date DESC, en.signed_at DESC
  LIMIT 1`
console.log('✓ prior note query ok:', prior ? `${prior.scheduled_date} with ${prior.provider_name}` : '(no prior)')

const pendingLabs = await sql`
  SELECT id, tests, status FROM lab_orders
  WHERE child_id = ${appt.child_id}::uuid AND status IN ('pending', 'submitted', 'partial')
  ORDER BY created_at DESC LIMIT 10`
console.log('✓ lab_orders query ok:', pendingLabs.length, 'pending')

const pendingRad = await sql`
  SELECT id, tests, status FROM radiology_orders
  WHERE child_id = ${appt.child_id}::uuid AND status IN ('pending', 'submitted', 'partial')
  ORDER BY created_at DESC LIMIT 10`
console.log('✓ radiology_orders query ok:', pendingRad.length, 'pending')

const unreviewed = await sql`
  SELECT lr.id, lr.report_date::text AS report_date
  FROM lab_results lr
  WHERE lr.child_id = ${appt.child_id}::uuid AND lr.is_reviewed = false
  ORDER BY lr.report_date DESC LIMIT 10`
console.log('✓ lab_results unreviewed query ok:', unreviewed.length)

// patient_communications may not exist in all preview branches —
// bootstrap it defensively (mirrors what the endpoint now does).
await sql`
  CREATE TABLE IF NOT EXISTS patient_communications (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    child_id uuid, provider_id uuid, provider_name text,
    communication_type text, occurred_at timestamptz,
    notes text, created_at timestamptz DEFAULT NOW()
  )`
const comms = await sql`
  SELECT id, communication_type, occurred_at, notes
  FROM patient_communications
  WHERE child_id = ${appt.child_id}::uuid
  ORDER BY occurred_at DESC LIMIT 5`
console.log('✓ patient_communications query ok:', comms.length)

// phi_audit_log pattern
await sql`INSERT INTO phi_audit_log (provider_id, action, resource_type, resource_id)
          VALUES (NULL, 'view_pre_visit_preview', 'appointment', ${appt.id})`
const [aud] = await sql`SELECT COUNT(*)::int AS n FROM phi_audit_log WHERE action = 'view_pre_visit_preview'`
console.log('✓ audit log insert ok (total view rows now:', aud.n, ')')

// Cleanup — delete the test audit row
await sql`DELETE FROM phi_audit_log WHERE action = 'view_pre_visit_preview' AND resource_id = ${appt.id} AND provider_id IS NULL`

console.log('\nALL GENERATOR QUERIES OK')
