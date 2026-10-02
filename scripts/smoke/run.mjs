#!/usr/bin/env node
/**
 * Smoke tests — run before every push. Each check replays a
 * representative SQL query from an API handler against the preview
 * branch (not prod). Any SQL error = fail = block the push.
 *
 * Catches schema-vs-code mismatches like the "text ≤ time without
 * time zone" cast error that silently 500'd every CMA+tele booking
 * attempt before Keaira hit it on 2026-10-01.
 *
 * Usage:
 *   npm run smoke
 *
 * Env: expects .env.local → DATABASE_URL (preview branch).
 */
import { neon } from '@neondatabase/serverless'

const url = process.env.DATABASE_URL
if (!url) {
  console.error('✗ DATABASE_URL not set — add it to .env.local then run `node --env-file=.env.local scripts/smoke/run.mjs`')
  process.exit(1)
}
const sql = neon(url)

/**
 * Each check is { name, run: async () => void }.
 * Throwing anywhere in run() = fail.
 */
const CHECKS = [
  {
    name: 'on-call MD lookup (api/appointments/index.ts, api/notifications.ts)',
    run: async () => {
      // The exact SQL that 500'd on 2026-10-01. Must work regardless
      // of whether start_time/end_time are TEXT or TIME.
      const [sampleProv] = await sql`SELECT practice_id FROM providers WHERE is_active = true LIMIT 1`
      if (!sampleProv) throw new Error('no active provider to test against')
      await sql`
        SELECT oc.provider_id, p.name AS provider_name
        FROM on_call_schedule oc
        JOIN providers p ON p.id = oc.provider_id
        WHERE oc.practice_id = ${sampleProv.practice_id}::uuid
          AND oc.date = CURRENT_DATE
          AND oc.state = 'NC'
          AND (oc.start_time IS NULL OR oc.start_time::time <= '10:00'::time)
          AND (oc.end_time   IS NULL OR oc.end_time::time   >  '10:00'::time)
        LIMIT 1`
    },
  },
  {
    name: 'appointments POST — overlap check SQL',
    run: async () => {
      const [p] = await sql`SELECT id, practice_id FROM providers WHERE is_active = true LIMIT 1`
      await sql`
        SELECT scheduled_time, COALESCE(duration_minutes, 60) AS duration_minutes
        FROM appointments
        WHERE provider_id = ${p.id}::uuid AND practice_id = ${p.practice_id}::uuid
          AND scheduled_date = CURRENT_DATE AND status != 'cancelled'`
    },
  },
  {
    name: 'appointments GET — date range (admin week view)',
    run: async () => {
      const [p] = await sql`SELECT practice_id FROM providers WHERE is_active = true LIMIT 1`
      await sql`
        SELECT a.*, pr.name as provider_name, c.previously_seen_by_phc
        FROM appointments a
        LEFT JOIN providers pr ON pr.id = a.provider_id
        LEFT JOIN children c ON c.id = a.child_id
        WHERE a.scheduled_date >= CURRENT_DATE::date
          AND a.scheduled_date <= (CURRENT_DATE + INTERVAL '7 days')::date
          AND a.practice_id = ${p.practice_id}::uuid`
    },
  },
  {
    name: 'waitlist entries GET (admin view, with open_broadcast join)',
    run: async () => {
      const [p] = await sql`SELECT practice_id FROM providers WHERE is_active = true LIMIT 1`
      await sql`
        SELECT we.*,
          (SELECT id FROM broadcasts WHERE waitlist_entry_id = we.id AND is_open = true LIMIT 1) AS open_broadcast_id
        FROM waitlist_entries we
        WHERE we.status = 'waiting'
          AND (we.practice_id = ${p.practice_id}::uuid OR we.practice_id IS NULL)
        LIMIT 50`
    },
  },
  {
    name: 'claims badge count (sidebar)',
    run: async () => {
      const [p] = await sql`SELECT practice_id FROM providers WHERE is_active = true LIMIT 1`
      await sql`
        SELECT COUNT(*)::int AS count
        FROM claims cl
        WHERE cl.practice_id = ${p.practice_id}::uuid
          AND cl.status != 'written_off'
          AND cl.status != 'pending_provider_response'
          AND cl.rework_resolved_at IS NULL
          AND NOT (cl.status = 'submitted' AND cl.era_received_at IS NOT NULL)
          AND NOT EXISTS (
            SELECT 1 FROM patient_statements ps
            WHERE ps.claim_id = cl.id AND ps.status IN ('draft','sent','paid')
          )`
    },
  },
  {
    name: 'AR aging insurance (financial reports)',
    run: async () => {
      const [p] = await sql`SELECT practice_id FROM providers WHERE is_active = true LIMIT 1`
      await sql`
        SELECT COALESCE(NULLIF(TRIM(payer_name), ''), 'Unknown payer') AS payer_name,
               SUM(CASE WHEN age_days BETWEEN 0 AND 30 THEN outstanding ELSE 0 END)::numeric(12,2) AS b_0_30
        FROM (
          SELECT cl.payer_name,
                 COALESCE(cl.total_charge, 0)::numeric AS outstanding,
                 EXTRACT(DAY FROM (NOW() - COALESCE(cl.submitted_at, cl.created_at)))::int AS age_days
          FROM claims cl
          WHERE cl.practice_id = ${p.practice_id}::uuid
            AND cl.status IN ('submitted', 'error', 'pending_review')
            AND cl.era_received_at IS NULL
            AND COALESCE(cl.payer_name, '') NOT ILIKE '%self%pay%'
            AND NOT EXISTS (
              SELECT 1 FROM patient_statements ps
              WHERE ps.claim_id = cl.id AND ps.status IN ('sent', 'paid')
            )
        ) t
        GROUP BY payer_name`
    },
  },
  {
    name: 'claims pipeline (financials)',
    run: async () => {
      const [p] = await sql`SELECT practice_id FROM providers WHERE is_active = true LIMIT 1`
      await sql`
        SELECT cl.id, cl.service_date::text AS service_date,
               cl.submitted_at, cl.era_received_at, cl.claim_rejection_at,
               cl.denial_codes, cl.status, COALESCE(cl.total_charge, 0)::numeric AS billed,
               COALESCE(cl.insurance_payment_era, 0)::numeric AS ins_paid
        FROM claims cl
        WHERE cl.practice_id = ${p.practice_id}::uuid
          AND cl.service_date >= DATE_TRUNC('month', CURRENT_DATE)
          AND cl.status != 'written_off'`
    },
  },
  {
    name: 'collections by visit month',
    run: async () => {
      const [p] = await sql`SELECT practice_id FROM providers WHERE is_active = true LIMIT 1`
      await sql`
        SELECT cl.id, cl.service_date::text AS service_date,
               cl.payer_name, cl.provider_id,
               COALESCE(cl.total_charge, 0)::numeric AS billed,
               cl.era_received_at,
               CASE WHEN cl.era_received_at IS NOT NULL THEN
                 COALESCE(cl.amount_billed_era, cl.total_charge, 0)::numeric
                   - COALESCE(cl.contractual_adjustment_era, 0)::numeric
               END AS allowed
        FROM claims cl
        WHERE cl.practice_id = ${p.practice_id}::uuid
          AND cl.status != 'written_off'
          AND cl.service_date >= DATE_TRUNC('month', CURRENT_DATE - INTERVAL '11 months')
        LIMIT 500`
    },
  },
  {
    name: 'broadcasts POST (every column referenced must exist)',
    run: async () => {
      // Don't actually insert — just verify every column reference parses.
      // Using LIMIT 0 so Postgres plans the query but returns nothing.
      await sql`
        SELECT practice_id, patient_first_name, patient_last_name, patient_dob,
               patient_address, family_phone, family_email, zone, state,
               visit_type, request_type, complaint, is_urgent, is_open,
               created_by, created_by_name, related_appointment_id,
               pairing_initiator_id, pairing_initiator_name, pairing_role_needed,
               scheduled_date, scheduled_time, waitlist_entry_id
        FROM broadcasts LIMIT 0`
    },
  },
  {
    name: 'chronic_problems bootstrap + GET',
    run: async () => {
      const [p] = await sql`SELECT practice_id FROM providers WHERE is_active = true LIMIT 1`
      await sql`
        SELECT * FROM chronic_problems
        WHERE practice_id = ${p.practice_id}::uuid
          AND resolved_at IS NULL
        LIMIT 10`
    },
  },
  {
    name: 'patient-billing-log join (chart billing tab)',
    run: async () => {
      const [p] = await sql`SELECT practice_id FROM providers WHERE is_active = true LIMIT 1`
      const [c] = await sql`SELECT id FROM children WHERE practice_id = ${p.practice_id}::uuid LIMIT 1`
      if (!c) return // nothing to test against — not a bug
      await sql`
        SELECT cl.id AS claim_id, cl.status AS claim_status,
               cl.service_date::text AS service_date, cl.payer_name,
               cl.era_received_at, cl.submitted_at, cl.rework_resolved_at,
               ps.status AS statement_status
        FROM claims cl
        LEFT JOIN patient_statements ps ON ps.claim_id = cl.id
        WHERE cl.practice_id = ${p.practice_id}::uuid
          AND COALESCE(cl.child_id, (SELECT child_id FROM appointments WHERE id = cl.appointment_id LIMIT 1)) = ${c.id}::uuid
        LIMIT 5`
    },
  },
  {
    name: 'patient_reports bootstrap + GET (lab + radiology report uploads)',
    run: async () => {
      await sql`
        CREATE TABLE IF NOT EXISTS patient_reports (
          id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          child_id          uuid NOT NULL REFERENCES children(id) ON DELETE CASCADE,
          practice_id       uuid NOT NULL REFERENCES practices(id),
          kind              text NOT NULL CHECK (kind IN ('lab','radiology')),
          title             text NOT NULL,
          blob_url          text NOT NULL,
          filename          text NOT NULL,
          mime_type         text,
          size_bytes        bigint,
          uploaded_by_type  text NOT NULL CHECK (uploaded_by_type IN ('provider','family')),
          uploaded_by_id    uuid,
          uploaded_by_name  text NOT NULL,
          uploaded_at       timestamptz NOT NULL DEFAULT NOW()
        )`
      const [p] = await sql`SELECT practice_id FROM providers WHERE is_active = true LIMIT 1`
      const [c] = await sql`SELECT id FROM children WHERE practice_id = ${p.practice_id}::uuid LIMIT 1`
      if (!c) return
      // Replay the GET SELECT for each kind so we catch any column rename.
      for (const kind of ['lab', 'radiology']) {
        await sql`
          SELECT id, child_id, kind, title, blob_url, filename, mime_type, size_bytes,
                 uploaded_by_type, uploaded_by_name, uploaded_at
          FROM patient_reports
          WHERE child_id = ${c.id}::uuid AND kind = ${kind} AND practice_id = ${p.practice_id}::uuid
          ORDER BY uploaded_at DESC
          LIMIT 10`
      }
    },
  },
  {
    name: 'radiology_orders bootstrap + GET',
    run: async () => {
      // Mirrors the SELECT in api/radiology/results.ts. Also makes sure
      // the table (and its FK to children/providers) exists.
      await sql`
        CREATE TABLE IF NOT EXISTS radiology_orders (
          id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          child_id        uuid NOT NULL REFERENCES children(id)   ON DELETE CASCADE,
          provider_id     uuid NOT NULL REFERENCES providers(id),
          appointment_id  uuid,
          tests           jsonb NOT NULL DEFAULT '[]'::jsonb,
          diagnoses       text[] NOT NULL DEFAULT '{}',
          priority        text   NOT NULL DEFAULT 'routine',
          notes           text,
          status          text   NOT NULL DEFAULT 'pending',
          created_at      timestamptz NOT NULL DEFAULT NOW()
        )`
      const [c] = await sql`SELECT id FROM children LIMIT 1`
      if (!c) return
      await sql`
        SELECT o.id, o.tests, o.diagnoses, o.priority, o.status, o.notes, o.created_at,
               p.name AS provider_name
        FROM radiology_orders o
        JOIN providers p ON p.id = o.provider_id
        WHERE o.child_id = ${c.id}::uuid
        ORDER BY o.created_at DESC
        LIMIT 10`
    },
  },
  {
    name: 'cma-schedule availability_overrides lookup',
    run: async () => {
      const [p] = await sql`SELECT practice_id FROM providers WHERE is_active = true LIMIT 1`
      const cmas = await sql`
        SELECT id FROM providers
        WHERE practice_id = ${p.practice_id}::uuid AND role IN ('CMA', 'RN') AND is_active = true`
      if (!cmas.length) return
      const ids = cmas.map(c => c.id)
      await sql`
        SELECT provider_id, date, is_available, start_time, end_time
        FROM availability_overrides
        WHERE provider_id = ANY(${ids}::uuid[])
          AND date >= CURRENT_DATE
          AND date <= CURRENT_DATE + INTERVAL '13 days'
          AND is_available = true
          AND start_time IS NOT NULL
          AND end_time IS NOT NULL`
    },
  },
]

async function main() {
  console.log(`\nRunning ${CHECKS.length} smoke tests against ${new URL(url).host}\n`)
  const results = []
  for (const c of CHECKS) {
    const start = Date.now()
    try {
      await c.run()
      const ms = Date.now() - start
      console.log(`  ✓  ${c.name}  (${ms}ms)`)
      results.push({ name: c.name, pass: true })
    } catch (e) {
      console.error(`  ✗  ${c.name}`)
      console.error(`     ${e.message}`)
      results.push({ name: c.name, pass: false, err: e.message })
    }
  }
  const failed = results.filter(r => !r.pass)
  console.log()
  if (failed.length) {
    console.error(`✗ ${failed.length} / ${results.length} smoke tests FAILED. DO NOT push.`)
    process.exit(1)
  }
  console.log(`✓ all ${results.length} smoke tests passed`)
}
main().catch(e => { console.error(e); process.exit(1) })
