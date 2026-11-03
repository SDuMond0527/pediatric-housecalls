import type { VercelRequest, VercelResponse } from '@vercel/node'
import { neon } from '@neondatabase/serverless'

/**
 * GET /api/admin/avi-fire-check?date=YYYY-MM-DD
 * Service-token-gated. Lists today's text visits with whether a signed
 * encounter note is linked and whether that note has assessment/plan
 * populated — the minimum conditions for the AVI auto-draft to fire.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })
  const expected = process.env.INTERNAL_SERVICE_TOKEN || ''
  const provided = String(req.headers['x-internal-service-token'] ?? '')
  if (!expected || provided !== expected) return res.status(401).json({ error: 'Unauthorized' })

  const sql = neon(process.env.DATABASE_URL!)
  const date = String(req.query.date ?? new Date().toISOString().slice(0, 10))

  const rows = await sql`
    SELECT
      a.id              AS appointment_id,
      a.scheduled_date::text AS scheduled_date,
      a.scheduled_time,
      a.visit_type,
      a.status,
      a.zone,
      p.name            AS provider_name,
      en.id             AS encounter_note_id,
      en.signed_at,
      en.chief_complaint,
      LENGTH(COALESCE(en.assessment, '')) AS assessment_len,
      LENGTH(COALESCE(en.plan, ''))       AS plan_len
    FROM appointments a
    LEFT JOIN providers p ON p.id = a.provider_id
    LEFT JOIN encounter_notes en ON en.appointment_id = a.id
    WHERE a.scheduled_date BETWEEN (${date}::date - INTERVAL '1 day') AND (${date}::date + INTERVAL '1 day')
    ORDER BY a.scheduled_date DESC, a.scheduled_time DESC
    LIMIT 40`

  return res.json({ date, rows })
}
