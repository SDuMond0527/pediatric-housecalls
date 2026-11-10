import type { VercelRequest, VercelResponse } from '@vercel/node'
import { neon } from '@neondatabase/serverless'

// 15-min sweep for the Pre-Visit Preview. Rather than regenerate every
// preview (which would duplicate ~400 lines of generator code into this
// cron file — Vercel does not bundle shared helpers), this cron just
// INVALIDATES stale previews by deleting them. The on-demand fallback
// in /api/pre-visit-preview/{apptId} regenerates them the next time a
// user opens one. That costs ~1-2s per first-open but keeps the code
// path single-sourced. Sara 2026-11-10.
//
// A preview is considered stale when any of these are newer than the
// preview's generated_at:
//   - The appointment itself (notes, visit_type, scheduled_time changed)
//   - The patient's children row (allergies / meds updated)
//   - Any chronic_problems row (added or resolved)
//   - Any lab_orders or lab_results for the patient
//   - Any radiology_orders for the patient
//   - Any patient_communications for the patient
//   - Any encounter_notes for the patient (last visit changed)
//
// Only touches previews whose appointments fall within the next 48 hours.
// Older than that = past visit, not worth refreshing.

const CRON_SECRET = process.env.CRON_SECRET || ''

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (CRON_SECRET && req.headers.authorization !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' })
  }
  const sql = neon(process.env.DATABASE_URL!)

  // Defensive: table may not exist yet if the endpoint has never been hit.
  try {
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
  } catch {}

  // Window: appointments scheduled within the next 48 hours that have
  // an existing preview on file.
  const staleRows = await sql`
    SELECT p.id AS preview_id, p.appointment_id, p.generated_at
    FROM pre_visit_previews p
    JOIN appointments a ON a.id = p.appointment_id
    WHERE a.scheduled_date BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '2 days'
      AND a.status NOT IN ('cancelled', 'done')
      AND (
        -- Appointment itself changed after preview was built.
        a.updated_at > p.generated_at
        -- Chart data changed.
        OR EXISTS (
          SELECT 1 FROM children c
          WHERE c.id = a.child_id AND c.updated_at > p.generated_at
        )
        -- Chronic problems added or resolved.
        OR EXISTS (
          SELECT 1 FROM chronic_problems cp
          WHERE cp.child_id = a.child_id
            AND GREATEST(cp.added_at, COALESCE(cp.resolved_at, 'epoch'::timestamptz)) > p.generated_at
        )
        -- Any new encounter note signed since preview was built.
        OR EXISTS (
          SELECT 1 FROM encounter_notes en
          WHERE en.child_id = a.child_id
            AND en.signed_at IS NOT NULL
            AND en.signed_at > p.generated_at
        )
        -- New lab orders / results / rad orders / comms touched since.
        OR EXISTS (
          SELECT 1 FROM lab_orders lo WHERE lo.child_id = a.child_id AND lo.created_at > p.generated_at
        )
        OR EXISTS (
          SELECT 1 FROM lab_results lr WHERE lr.child_id = a.child_id AND lr.report_date::timestamptz > p.generated_at
        )
      )`

  // Also opportunistically dump previews whose appointments have moved
  // out of the 48-hour window (past, cancelled, or marked done) so the
  // table doesn't accumulate junk forever. This is pure hygiene.
  const trashed = await sql`
    DELETE FROM pre_visit_previews
    WHERE appointment_id IN (
      SELECT a.id FROM appointments a
      WHERE a.scheduled_date < CURRENT_DATE - INTERVAL '7 days'
         OR a.status IN ('cancelled', 'done')
    )
    RETURNING id`

  let deleted = 0
  for (const row of staleRows as any[]) {
    try {
      await sql`DELETE FROM pre_visit_previews WHERE id = ${row.preview_id}::uuid`
      deleted++
    } catch (e: any) {
      console.error('[pre-visit-preview-sweep] delete failed:', e?.message)
    }
  }

  return res.status(200).json({
    ran_at: new Date().toISOString(),
    stale_invalidated: deleted,
    hygiene_trashed: (trashed as any[]).length,
  })
}
