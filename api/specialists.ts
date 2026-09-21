import type { VercelRequest, VercelResponse } from '@vercel/node'
import { neon } from '@neondatabase/serverless'
import { createRemoteJWKSet, jwtVerify } from 'jose'

async function verifyToken(authHeader: string | undefined): Promise<string> {
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
 * /api/specialists — practice-owned directory of specialists that
 * receive referrals via fax. Mirrors the /api/pcps pattern.
 *
 * GET     — list active (or all, ?all=true) specialists for the practice
 * POST    — admin: create
 * PATCH   — admin: update by ?id=<uuid>
 * DELETE  — admin: soft-archive by ?id=<uuid> (sets is_active=false)
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  let sub: string
  try { sub = await verifyToken(req.headers.authorization) }
  catch { return res.status(401).json({ error: 'Unauthorized' }) }

  const sql = neon(process.env.DATABASE_URL!)

  const [prov] = await sql`SELECT id, is_admin, practice_id FROM providers WHERE cognito_sub = ${sub} LIMIT 1`
  if (!prov) return res.status(403).json({ error: 'Provider not found' })
  const practiceId = prov.practice_id as string
  const isAdmin = !!prov.is_admin

  // Idempotent table bootstrap — same pattern as handbook.
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS specialists (
        id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        practice_id uuid NOT NULL REFERENCES practices(id) ON DELETE CASCADE,
        name        text NOT NULL,
        specialty   text,
        phone       text,
        fax_number  text,
        address     text,
        notes       text,
        is_active   boolean NOT NULL DEFAULT true,
        created_at  timestamptz NOT NULL DEFAULT now(),
        updated_at  timestamptz NOT NULL DEFAULT now()
      )
    `
    await sql`CREATE INDEX IF NOT EXISTS specialists_practice_idx ON specialists(practice_id)`
  } catch (e: any) { console.error('specialists bootstrap failed:', e?.message) }

  if (req.method === 'GET') {
    const all = req.query.all === 'true'
    const rows = await sql`
      SELECT id, name, specialty, phone, fax_number, address, notes, is_active, created_at, updated_at
      FROM specialists
      WHERE practice_id = ${practiceId}::uuid AND (${all} OR is_active = true)
      ORDER BY specialty NULLS LAST, name
    `
    return res.status(200).json(rows)
  }

  if (!isAdmin) return res.status(403).json({ error: 'Admin only' })

  if (req.method === 'POST') {
    const { name, specialty, phone, fax_number, address, notes } = req.body ?? {}
    if (!name?.trim()) return res.status(400).json({ error: 'name required' })
    const [row] = await sql`
      INSERT INTO specialists (practice_id, name, specialty, phone, fax_number, address, notes)
      VALUES (${practiceId}::uuid, ${name.trim()}, ${specialty ?? null}, ${phone ?? null}, ${fax_number ?? null}, ${address ?? null}, ${notes ?? null})
      RETURNING *
    `
    return res.status(200).json(row)
  }

  if (req.method === 'PATCH') {
    const id = req.query.id as string
    if (!id) return res.status(400).json({ error: 'id required' })
    const { name, specialty, phone, fax_number, address, notes, is_active } = req.body ?? {}
    const [row] = await sql`
      UPDATE specialists SET
        name       = COALESCE(${name?.trim() || null}, name),
        specialty  = COALESCE(${specialty ?? null}, specialty),
        phone      = COALESCE(${phone ?? null}, phone),
        fax_number = COALESCE(${fax_number ?? null}, fax_number),
        address    = COALESCE(${address ?? null}, address),
        notes      = COALESCE(${notes ?? null}, notes),
        is_active  = COALESCE(${typeof is_active === 'boolean' ? is_active : null}, is_active),
        updated_at = NOW()
      WHERE id = ${id}::uuid AND practice_id = ${practiceId}::uuid
      RETURNING *
    `
    if (!row) return res.status(404).json({ error: 'Not found' })
    return res.status(200).json(row)
  }

  if (req.method === 'DELETE') {
    const id = req.query.id as string
    if (!id) return res.status(400).json({ error: 'id required' })
    // Soft-archive so any historical referrals still resolve their
    // specialist_id. Set is_active=false — the GET default filter hides it.
    const [row] = await sql`
      UPDATE specialists SET is_active = false, updated_at = NOW()
      WHERE id = ${id}::uuid AND practice_id = ${practiceId}::uuid
      RETURNING id
    `
    if (!row) return res.status(404).json({ error: 'Not found' })
    return res.status(200).json({ ok: true })
  }

  return res.status(405).json({ error: 'Method not allowed' })
}
