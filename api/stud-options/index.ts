import type { VercelRequest, VercelResponse } from '@vercel/node'
import { neon } from '@neondatabase/serverless'
import { createRemoteJWKSet, jwtVerify } from 'jose'

const PRACTICE_NAME = process.env.PRACTICE_NAME || 'Pediatric Housecalls'

async function verifyToken(authHeader: string | undefined): Promise<string> {
  if (!authHeader?.startsWith('Bearer ')) throw new Error('Missing token')
  const token = authHeader.slice(7)
  const region = process.env.VITE_AWS_REGION || 'us-east-2'
  const poolId = process.env.VITE_AWS_USER_POOL_ID || ''
  const JWKS = createRemoteJWKSet(new URL(`https://cognito-idp.${region}.amazonaws.com/${poolId}/.well-known/jwks.json`))
  const { payload } = await jwtVerify(token, JWKS, { issuer: `https://cognito-idp.${region}.amazonaws.com/${poolId}` })
  if (!payload.sub) throw new Error('No sub')
  return payload.sub as string
}

/**
 * GET  /api/stud-options?public=1  — list active options for a practice (no auth)
 * GET  /api/stud-options            — admin list (all options including inactive)
 * POST /api/stud-options            — admin create
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const sql = neon(process.env.DATABASE_URL!)

  try { await sql`
    CREATE TABLE IF NOT EXISTS stud_options (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      practice_id uuid NOT NULL,
      name text NOT NULL,
      photo_url text NOT NULL,
      price numeric(10,2) NOT NULL DEFAULT 100.00,
      is_active boolean NOT NULL DEFAULT true,
      sort_order int NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT NOW(),
      updated_at timestamptz NOT NULL DEFAULT NOW()
    )` } catch {}

  // Public GET — resolves to the main practice. Used by the family booking
  // flow to render the "extra studs" photo grid.
  if (req.method === 'GET' && req.query.public === '1') {
    const [byName] = await sql`SELECT id FROM practices WHERE LOWER(name) = LOWER(${PRACTICE_NAME}) ORDER BY created_at LIMIT 1`
    const [fallback] = byName ? [byName] : await sql`SELECT id FROM practices ORDER BY created_at LIMIT 1`
    const practice = byName ?? fallback
    if (!practice) return res.status(500).json({ error: 'Practice not configured' })
    const rows = await sql`
      SELECT id, name, photo_url, price
      FROM stud_options
      WHERE practice_id = ${practice.id}::uuid AND is_active = true
      ORDER BY sort_order, name`
    return res.json(rows)
  }

  // Everything else is authed.
  let sub: string
  try { sub = await verifyToken(req.headers.authorization) }
  catch { return res.status(401).json({ error: 'Unauthorized' }) }
  const [provider] = await sql`SELECT practice_id, is_admin FROM providers WHERE cognito_sub = ${sub} LIMIT 1`
  if (!provider) return res.status(403).json({ error: 'Provider not found' })

  if (req.method === 'GET') {
    const rows = await sql`
      SELECT * FROM stud_options
      WHERE practice_id = ${provider.practice_id}::uuid
      ORDER BY sort_order, name`
    return res.json(rows)
  }

  if (req.method === 'POST') {
    if (!provider.is_admin) return res.status(403).json({ error: 'Admin only' })
    const b = (req.body ?? {}) as any
    if (!b.name?.trim())    return res.status(400).json({ error: 'name required' })
    if (!b.photo_url)       return res.status(400).json({ error: 'photo_url required' })
    const [row] = await sql`
      INSERT INTO stud_options (practice_id, name, photo_url, price, is_active, sort_order)
      VALUES (${provider.practice_id}::uuid, ${b.name.trim()}, ${b.photo_url},
              ${b.price ?? 100.00}, ${b.is_active ?? true}, ${b.sort_order ?? 0})
      RETURNING *`
    return res.status(201).json(row)
  }

  return res.status(405).json({ error: 'Method not allowed' })
}
