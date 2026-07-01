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

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const sql = neon(process.env.DATABASE_URL!)

  // ── GET: public, no auth required ──────────────────────────────────────────
  if (req.method === 'GET') {
    const practiceId = (req.query.practice_id as string | undefined) || process.env.VITE_PRACTICE_ID
    if (!practiceId) return res.status(400).json({ error: 'practice_id required' })
    const rows = await sql`
      SELECT * FROM practice_zones
      WHERE practice_id = ${practiceId}::uuid
      ORDER BY sort_order, zone_name`
    return res.json(rows)
  }

  // ── Auth required for POST and DELETE ──────────────────────────────────────
  let sub: string
  try {
    sub = await verifyToken(req.headers.authorization)
  } catch {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const [caller] = await sql`
    SELECT is_super_admin, is_admin, practice_id
    FROM providers WHERE cognito_sub = ${sub} LIMIT 1`
  if (!caller) return res.status(403).json({ error: 'Provider not found' })
  if (!caller.is_admin && !caller.is_super_admin) return res.status(403).json({ error: 'Admin access required' })

  // ── POST: upsert a zone ───────────────────────────────────────────────────
  if (req.method === 'POST') {
    const { zone_name, state, zips, is_waitlist_only, sort_order, practice_id } = req.body ?? {}
    if (!zone_name) return res.status(400).json({ error: 'zone_name required' })

    const targetPracticeId: string = practice_id || caller.practice_id
    if (!targetPracticeId) return res.status(400).json({ error: 'practice_id required' })

    // Non-super-admin can only manage their own practice
    if (!caller.is_super_admin && targetPracticeId !== caller.practice_id) {
      return res.status(403).json({ error: 'Cannot manage zones for another practice' })
    }

    const [row] = await sql`
      INSERT INTO practice_zones (practice_id, zone_name, state, zips, is_waitlist_only, sort_order)
      VALUES (
        ${targetPracticeId}::uuid,
        ${zone_name},
        ${state ?? null},
        ${zips ?? []}::text[],
        ${is_waitlist_only ?? false},
        ${sort_order ?? 0}
      )
      ON CONFLICT (practice_id, zone_name) DO UPDATE SET
        zips = EXCLUDED.zips,
        state = EXCLUDED.state,
        is_waitlist_only = EXCLUDED.is_waitlist_only,
        sort_order = EXCLUDED.sort_order
      RETURNING *`
    return res.status(201).json(row)
  }

  // ── PATCH: update a zone by id ────────────────────────────────────────────
  if (req.method === 'PATCH') {
    const id = req.query.id as string | undefined
    if (!id) return res.status(400).json({ error: 'id required' })

    const [zone] = await sql`SELECT practice_id FROM practice_zones WHERE id = ${id}::uuid LIMIT 1`
    if (!zone) return res.status(404).json({ error: 'Zone not found' })

    if (!caller.is_super_admin && zone.practice_id !== caller.practice_id) {
      return res.status(403).json({ error: 'Cannot manage zones for another practice' })
    }

    const { zone_name, state, zips, is_waitlist_only, sort_order } = req.body ?? {}
    const [row] = await sql`
      UPDATE practice_zones SET
        zone_name        = COALESCE(${zone_name ?? null}, zone_name),
        state            = ${state ?? null},
        zips             = ${zips ?? []}::text[],
        is_waitlist_only = ${is_waitlist_only ?? false},
        sort_order       = COALESCE(${sort_order ?? null}, sort_order)
      WHERE id = ${id}::uuid
      RETURNING *`
    return res.json(row)
  }

  // ── DELETE: remove a zone ─────────────────────────────────────────────────
  if (req.method === 'DELETE') {
    const id = req.query.id as string | undefined
    if (!id) return res.status(400).json({ error: 'id required' })

    const [zone] = await sql`SELECT practice_id FROM practice_zones WHERE id = ${id}::uuid LIMIT 1`
    if (!zone) return res.status(404).json({ error: 'Zone not found' })

    if (!caller.is_super_admin && zone.practice_id !== caller.practice_id) {
      return res.status(403).json({ error: 'Cannot delete zones for another practice' })
    }

    await sql`DELETE FROM practice_zones WHERE id = ${id}::uuid`
    return res.json({ ok: true })
  }

  return res.status(405).json({ error: 'Method not allowed' })
}
