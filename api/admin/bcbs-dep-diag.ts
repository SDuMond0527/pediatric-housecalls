import type { VercelRequest, VercelResponse } from '@vercel/node'
import { neon } from '@neondatabase/serverless'

/**
 * GET /api/admin/bcbs-dep-diag — service-token-gated.
 * Returns BCBS children + recent BCBS claims so we can spot where the
 * 2-digit dependent suffix is / isn't landing on the way to Stedi.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })
  const expected = process.env.INTERNAL_SERVICE_TOKEN || ''
  const provided = String(req.headers['x-internal-service-token'] ?? '')
  if (!expected || provided !== expected) return res.status(401).json({ error: 'Unauthorized' })

  const sql = neon(process.env.DATABASE_URL!)

  const q = String(req.query.q ?? '').trim().toLowerCase()
  const serviceDate = String(req.query.service_date ?? '').trim()

  if (q) {
    // Zoomed-in view for one patient / family. Returns every claim, the
    // child chart row(s), and the full activity log so I can watch dep
    // codes change across submit attempts.
    const children = await sql`
      SELECT id, first_name, last_name, date_of_birth,
             insurance_provider, insurance_member_id, insurance_dependent_code,
             LENGTH(insurance_member_id) AS mid_len,
             updated_at
      FROM children
      WHERE LOWER(last_name) LIKE ${'%' + q + '%'} OR LOWER(first_name) LIKE ${'%' + q + '%'}
      ORDER BY last_name, first_name`
    const claims = await sql`
      SELECT c.id, c.payer_id, c.member_id, c.insurance_dependent_code,
             c.patient_first_name, c.patient_last_name,
             c.status, c.submitted_at, c.service_date,
             c.submission_error, c.created_at, c.updated_at,
             LENGTH(c.member_id) AS mid_len
      FROM claims c
      WHERE (LOWER(c.patient_last_name) LIKE ${'%' + q + '%'} OR LOWER(c.patient_first_name) LIKE ${'%' + q + '%'})
        ${serviceDate ? sql`AND c.service_date = ${serviceDate}::date` : sql``}
      ORDER BY c.created_at DESC`
    const activityLog = claims.length > 0
      ? await sql`
          SELECT claim_id, created_at, kind, created_by_name, body
          FROM claim_activity_log
          WHERE claim_id = ANY(${(claims as any[]).map(c => c.id)}::uuid[])
          ORDER BY created_at`
      : []
    return res.json({ q, service_date: serviceDate || null, children, claims, activityLog })
  }

  const children = await sql`
    SELECT first_name, last_name,
           insurance_provider, insurance_member_id, insurance_dependent_code,
           LENGTH(insurance_member_id) AS mid_len
    FROM children
    WHERE insurance_provider ILIKE '%blue%' OR insurance_provider ILIKE '%bcbs%' OR insurance_provider ILIKE '%anthem%'
    ORDER BY last_name, first_name
    LIMIT 100`

  const claims = await sql`
    SELECT id, payer_id, member_id, insurance_dependent_code, patient_first_name, patient_last_name,
           status, submitted_at, stedi_response, submission_error,
           LENGTH(member_id) AS mid_len
    FROM claims
    WHERE payer_id IN ('UPICO', 'BCSNC', 'NCBCBS', 'NCBLS', 'NCPNHP')
    ORDER BY created_at DESC
    LIMIT 25`

  return res.json({
    children_count: children.length,
    children_missing_dep: (children as any[]).filter(k => !k.insurance_dependent_code).length,
    claims_missing_dep:   (claims   as any[]).filter(c => !c.insurance_dependent_code).length,
    children, claims,
  })
}
