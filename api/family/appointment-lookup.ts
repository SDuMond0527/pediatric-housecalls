import type { VercelRequest, VercelResponse } from '@vercel/node'
import { neon } from '@neondatabase/serverless'
import { createRemoteJWKSet, jwtVerify } from 'jose'

async function verifyFamilyToken(authHeader: string | undefined): Promise<string> {
  if (!authHeader?.startsWith('Bearer ')) throw new Error('Missing token')
  const token = authHeader.slice(7)
  const region = process.env.VITE_AWS_REGION || 'us-east-2'
  const poolId = process.env.VITE_FAMILY_USER_POOL_ID || ''
  const JWKS = createRemoteJWKSet(new URL(`https://cognito-idp.${region}.amazonaws.com/${poolId}/.well-known/jwks.json`))
  const { payload } = await jwtVerify(token, JWKS, { issuer: `https://cognito-idp.${region}.amazonaws.com/${poolId}` })
  if (!payload.sub) throw new Error('No sub')
  return payload.sub as string
}

/**
 * GET /api/family/appointment-lookup?id=<appointment_id>
 *
 * Returns the appointment + child + rendering provider for a single
 * appointment belonging to the authenticated family. Primary data source
 * for FamilySchoolExcuseRequest after a parent reported 2026-10-06 that
 * same-day visits were missing because her provider hadn't signed the
 * encounter note yet. Previously that page queried encounter_notes +
 * booking_requests — both can be empty on a provider-added appointment
 * before signing, so the lookup fell through.
 *
 * Hitting appointments.scheduled_date directly means every visit — self-
 * booked, waitlist-accepted, provider manual-add, signed or unsigned — is
 * findable from the second it exists in the schedule.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  let sub: string
  try { sub = await verifyFamilyToken(req.headers.authorization) }
  catch { return res.status(401).json({ error: 'Unauthorized' }) }

  const appointmentId = String(req.query.id ?? '').trim()
  if (!appointmentId) return res.status(400).json({ error: 'id required' })

  try {
    const sql = neon(process.env.DATABASE_URL!)
    const [fam] = await sql`SELECT id FROM family_profiles WHERE cognito_sub = ${sub} LIMIT 1`
    if (!fam) return res.status(403).json({ error: 'Family not found' })

    const [row] = await sql`
      SELECT
        a.id              AS appointment_id,
        a.scheduled_date,
        a.visit_type,
        a.status          AS appointment_status,
        c.id              AS child_id,
        c.first_name      AS child_first_name,
        c.last_name       AS child_last_name,
        c.date_of_birth   AS child_dob,
        p.id              AS provider_id,
        p.name            AS provider_name,
        p.role            AS provider_role
      FROM appointments a
      LEFT JOIN children c  ON c.id = a.child_id
      LEFT JOIN providers p ON p.id = a.provider_id
      WHERE a.id = ${appointmentId}::uuid
        AND c.family_id = ${fam.id}::uuid
      LIMIT 1
    `
    if (!row) return res.status(404).json({ error: 'Visit not found for this family.' })
    return res.status(200).json(row)
  } catch (e: any) {
    console.error('family/appointment-lookup error:', e)
    return res.status(500).json({ error: e?.message ?? 'Internal server error' })
  }
}
