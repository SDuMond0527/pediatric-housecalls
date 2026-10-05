import type { VercelRequest, VercelResponse } from '@vercel/node'
import { neon } from '@neondatabase/serverless'
import { createRemoteJWKSet, jwtVerify } from 'jose'

async function verifyToken(authHeader: string | undefined): Promise<string> {
  if (!authHeader?.startsWith('Bearer ')) throw new Error('Missing token')
  const token = authHeader.slice(7)
  const region = process.env.VITE_AWS_REGION || 'us-east-2'
  const userPoolId = process.env.VITE_AWS_USER_POOL_ID || ''
  const JWKS = createRemoteJWKSet(new URL(`https://cognito-idp.${region}.amazonaws.com/${userPoolId}/.well-known/jwks.json`))
  const { payload } = await jwtVerify(token, JWKS, { issuer: `https://cognito-idp.${region}.amazonaws.com/${userPoolId}` })
  if (!payload.sub) throw new Error('No sub in token')
  return payload.sub
}

/**
 * GET /api/admin/school-notes — audit list of every automated school
 * note sent out. Scoped to the caller's practice. Any authenticated
 * provider can read (same policy as other admin-tab endpoints).
 *
 * No status filter yet — returns everything, newest first, so Pam /
 * Sara can scan from the top. Add pagination if the list ever gets
 * big enough that this hurts.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  let sub: string
  try { sub = await verifyToken(req.headers.authorization) }
  catch { return res.status(401).json({ error: 'Unauthorized' }) }

  const sql = neon(process.env.DATABASE_URL!)
  const [prov] = await sql`SELECT practice_id FROM providers WHERE cognito_sub = ${sub} LIMIT 1`
  if (!prov) return res.status(403).json({ error: 'Provider not found' })

  // Bootstrap on every read path — matches the feedback_bootstrap_columns rule.
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS school_notes (
        id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        practice_id            uuid NOT NULL REFERENCES practices(id),
        child_id               uuid NOT NULL REFERENCES children(id) ON DELETE CASCADE,
        appointment_id         uuid REFERENCES appointments(id),
        requested_by_family_id uuid REFERENCES family_profiles(id),
        requested_by_name      text,
        excuse_dates_text      text NOT NULL,
        parent_additional_notes text,
        rendering_provider_id  uuid REFERENCES providers(id),
        rendering_provider_name text,
        rendering_provider_npi text,
        blob_url               text NOT NULL,
        filename               text NOT NULL,
        sent_to_email          text,
        sent_at                timestamptz,
        status                 text NOT NULL DEFAULT 'generated',
        created_at             timestamptz NOT NULL DEFAULT NOW()
      )`
  } catch (e: any) { console.error('school_notes bootstrap failed:', e?.message) }

  const rows = await sql`
    SELECT
      sn.id,
      sn.excuse_dates_text,
      sn.parent_additional_notes,
      sn.rendering_provider_name,
      sn.rendering_provider_npi,
      sn.blob_url,
      sn.filename,
      sn.sent_to_email,
      sn.sent_at,
      sn.status,
      sn.created_at,
      sn.requested_by_name,
      c.id          AS child_id,
      c.first_name  AS child_first_name,
      c.last_name   AS child_last_name,
      c.date_of_birth AS child_dob,
      c.chart_number,
      a.scheduled_date AS visit_date,
      a.visit_type
    FROM school_notes sn
    JOIN children c ON c.id = sn.child_id
    LEFT JOIN appointments a ON a.id = sn.appointment_id
    WHERE sn.practice_id = ${prov.practice_id}::uuid
    ORDER BY sn.created_at DESC
    LIMIT 500
  `

  return res.status(200).json(rows)
}
