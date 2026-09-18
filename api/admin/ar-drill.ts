import type { VercelRequest, VercelResponse } from '@vercel/node'
import { neon } from '@neondatabase/serverless'
import { createRemoteJWKSet, jwtVerify } from 'jose'

async function verifyProviderToken(authHeader: string | undefined): Promise<string> {
  if (!authHeader?.startsWith('Bearer ')) throw new Error('Missing token')
  const token = authHeader.slice(7)
  const region = process.env.VITE_AWS_REGION || 'us-east-2'
  const poolId = process.env.VITE_AWS_USER_POOL_ID || ''
  const JWKS = createRemoteJWKSet(new URL(`https://cognito-idp.${region}.amazonaws.com/${poolId}/.well-known/jwks.json`))
  const { payload } = await jwtVerify(token, JWKS, { issuer: `https://cognito-idp.${region}.amazonaws.com/${poolId}` })
  if (!payload.sub) throw new Error('No sub in token')
  return payload.sub as string
}

/**
 * GET /api/admin/ar-drill
 *   ?type=insurance|patient
 *   &group=<payer_name>|<patient_full_name>|__all__
 *   &bucket=0_30|31_60|61_90|91_120|120_plus|all
 *
 * Drill-down for the AR aging tables on the Financial Reports page.
 * Same filters as the aggregate query in financial-reports.ts so the
 * numbers reconcile — sum(total_charge) here for a (group, bucket)
 * always equals the aggregate cell.
 *
 * Admin-only. Returns the underlying rows so the biller can click a
 * cell and go work the individual claims / statements behind it.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  let sub: string
  try { sub = await verifyProviderToken(req.headers.authorization) }
  catch { return res.status(401).json({ error: 'Unauthorized' }) }

  const type   = String(req.query.type ?? '')
  const group  = String(req.query.group ?? '__all__')
  const bucket = String(req.query.bucket ?? 'all')

  if (type !== 'insurance' && type !== 'patient') {
    return res.status(400).json({ error: 'type must be insurance or patient' })
  }
  const allowedBuckets = new Set(['0_30', '31_60', '61_90', '91_120', '120_plus', 'all'])
  if (!allowedBuckets.has(bucket)) {
    return res.status(400).json({ error: 'invalid bucket' })
  }

  try {
    const sql = neon(process.env.DATABASE_URL!)
    const [provider] = await sql`SELECT id, is_admin, practice_id FROM providers WHERE cognito_sub = ${sub} LIMIT 1`
    if (!provider) return res.status(403).json({ error: 'Provider not found' })
    if (!provider.is_admin) return res.status(403).json({ error: 'Admin access required' })
    const practiceId = provider.practice_id as string

    if (type === 'insurance') {
      // Mirrors the AR aging insurance filters in financial-reports.ts —
      // outstanding claims where the payer still owes us money.
      const rows = await sql`
        WITH aged AS (
          SELECT
            cl.id,
            cl.patient_first_name,
            cl.patient_last_name,
            cl.service_date,
            cl.submitted_at,
            cl.created_at,
            COALESCE(cl.total_charge, 0)::numeric(12,2) AS total_charge,
            cl.status,
            COALESCE(NULLIF(TRIM(cl.payer_name), ''), 'Unknown payer') AS payer_name,
            cl.era_received_at,
            cl.era_seen_at,
            cl.submission_error,
            ch.chart_number,
            EXTRACT(DAY FROM (NOW() - COALESCE(cl.submitted_at, cl.created_at)))::int AS age_days
          FROM claims cl
          LEFT JOIN children ch ON ch.id = cl.child_id
          WHERE cl.practice_id = ${practiceId}::uuid
            AND cl.status IN ('submitted', 'error', 'pending_review')
            AND cl.era_received_at IS NULL
            AND COALESCE(cl.total_charge, 0) > 0
        )
        SELECT * FROM aged
        WHERE (${group} = '__all__' OR payer_name = ${group})
          AND (
            ${bucket} = 'all'
            OR (${bucket} = '0_30'      AND age_days BETWEEN 0 AND 30)
            OR (${bucket} = '31_60'     AND age_days BETWEEN 31 AND 60)
            OR (${bucket} = '61_90'     AND age_days BETWEEN 61 AND 90)
            OR (${bucket} = '91_120'    AND age_days BETWEEN 91 AND 120)
            OR (${bucket} = '120_plus'  AND age_days > 120)
          )
        ORDER BY age_days DESC, total_charge DESC
      `
      return res.status(200).json({ rows })
    }

    // type === 'patient' — outstanding sent statements grouped by patient.
    // Group key is the same full-name concat as the aggregate query.
    const rows = await sql`
      WITH aged AS (
        SELECT
          ps.id,
          ps.claim_id,
          ps.patient_first_name,
          ps.patient_last_name,
          ps.date_of_service,
          ps.sent_at,
          ps.created_at,
          COALESCE(ps.total_amount_due, 0)::numeric(12,2) AS total_amount_due,
          ps.status,
          ch.chart_number,
          COALESCE(NULLIF(TRIM(CONCAT(ps.patient_first_name, ' ', ps.patient_last_name)), ''), 'Unknown patient') AS patient_name,
          EXTRACT(DAY FROM (NOW() - COALESCE(ps.sent_at, ps.created_at)))::int AS age_days
        FROM patient_statements ps
        LEFT JOIN claims cl ON cl.id = ps.claim_id
        LEFT JOIN children ch ON ch.id = COALESCE(
          cl.child_id,
          (SELECT child_id FROM appointments WHERE id = cl.appointment_id LIMIT 1)
        )
        WHERE ps.practice_id = ${practiceId}::uuid
          AND ps.status = 'sent'
          AND COALESCE(ps.total_amount_due, 0) > 0
      )
      SELECT * FROM aged
      WHERE (${group} = '__all__' OR patient_name = ${group})
        AND (
          ${bucket} = 'all'
          OR (${bucket} = '0_30'      AND age_days BETWEEN 0 AND 30)
          OR (${bucket} = '31_60'     AND age_days BETWEEN 31 AND 60)
          OR (${bucket} = '61_90'     AND age_days BETWEEN 61 AND 90)
          OR (${bucket} = '91_120'    AND age_days BETWEEN 91 AND 120)
          OR (${bucket} = '120_plus'  AND age_days > 120)
        )
      ORDER BY age_days DESC, total_amount_due DESC
    `
    return res.status(200).json({ rows })
  } catch (e: any) {
    console.error('admin/ar-drill error:', e)
    return res.status(500).json({ error: e.message ?? 'Internal server error' })
  }
}
