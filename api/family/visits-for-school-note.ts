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
 * GET /api/family/visits-for-school-note
 *
 * Returns the family's last 60 days of appointments (not just signed
 * encounter notes). Powers the parent-facing "pick a visit" screen for
 * school-note requests. Sara 2026-10-26 — previously driven off
 * encounter_notes so parents couldn't request a school note until the
 * provider had opened + signed the note.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  let sub: string
  try { sub = await verifyFamilyToken(req.headers.authorization) }
  catch { return res.status(401).json({ error: 'Unauthorized' }) }

  const sql = neon(process.env.DATABASE_URL!)
  const [fam] = await sql`SELECT id, practice_id FROM family_profiles WHERE cognito_sub = ${sub} LIMIT 1`
  if (!fam) return res.json([])

  const rows = await sql`
    SELECT
      a.id                AS appointment_id,
      a.scheduled_date    AS scheduled_date,
      a.visit_type        AS visit_type,
      a.child_id          AS child_id,
      a.status            AS status,
      ch.first_name       AS child_first_name,
      ch.last_name        AS child_last_name,
      p.name              AS provider_name
    FROM appointments a
    JOIN children ch   ON ch.id = a.child_id AND ch.family_id = ${fam.id}::uuid
    LEFT JOIN providers p ON p.id = a.provider_id
    WHERE a.practice_id = ${fam.practice_id}::uuid
      AND a.scheduled_date >= CURRENT_DATE - INTERVAL '60 days'
      AND a.scheduled_date <= CURRENT_DATE
      AND a.status != 'cancelled'
    ORDER BY a.scheduled_date DESC, a.scheduled_time DESC
    LIMIT 60`

  return res.json(rows)
}
