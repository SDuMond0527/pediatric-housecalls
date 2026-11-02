import type { VercelRequest, VercelResponse } from '@vercel/node'
import { neon } from '@neondatabase/serverless'

/**
 * GET /api/admin/avi-demo-fetch-note
 * Service-token-gated. Returns a recent signed encounter note with
 * everything the after-visit-instructions AI would need as input.
 * One-off demo helper for Sara.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })
  const expected = process.env.INTERNAL_SERVICE_TOKEN || ''
  const provided = String(req.headers['x-internal-service-token'] ?? '')
  if (!expected || provided !== expected) return res.status(401).json({ error: 'Unauthorized' })

  const sql = neon(process.env.DATABASE_URL!)

  const noteId = String(req.query.note_id ?? '').trim()

  // Default: find a recent signed sick-visit note so the AVI demo is
  // realistic (sick visits have the most actionable instructions).
  const [note] = noteId
    ? await sql`
        SELECT en.*, ch.first_name AS child_first_name, ch.last_name AS child_last_name,
               ch.date_of_birth AS child_dob, ch.gender AS child_gender,
               ch.allergies AS child_allergies, ch.current_medications AS child_meds,
               p.name AS provider_name, p.role AS provider_role,
               a.visit_type, a.scheduled_date
        FROM encounter_notes en
        LEFT JOIN children ch ON ch.id = en.child_id
        LEFT JOIN providers p ON p.id = en.provider_id
        LEFT JOIN appointments a ON a.id = en.appointment_id
        WHERE en.id = ${noteId}::uuid`
    : await sql`
        SELECT en.*, ch.first_name AS child_first_name, ch.last_name AS child_last_name,
               ch.date_of_birth AS child_dob, ch.gender AS child_gender,
               ch.allergies AS child_allergies, ch.current_medications AS child_meds,
               p.name AS provider_name, p.role AS provider_role,
               a.visit_type, a.scheduled_date
        FROM encounter_notes en
        LEFT JOIN children ch ON ch.id = en.child_id
        LEFT JOIN providers p ON p.id = en.provider_id
        LEFT JOIN appointments a ON a.id = en.appointment_id
        WHERE en.is_signed = true
          AND LENGTH(COALESCE(en.plan, '')) > 50
          AND LENGTH(COALESCE(en.assessment, '')) > 20
          AND (a.visit_type ILIKE '%sick%' OR a.visit_type ILIKE '%tele%')
        ORDER BY en.signed_at DESC
        LIMIT 1`

  if (!note) return res.status(404).json({ error: 'No matching note found' })
  return res.json(note)
}
