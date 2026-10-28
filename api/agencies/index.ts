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
  if (!payload.sub) throw new Error('No sub')
  return payload.sub as string
}

function slugify(s: string): string {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'agency'
}

async function bootstrap(sql: any) {
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS agencies (
        id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        practice_id     uuid NOT NULL,
        slug            text NOT NULL,
        name            text NOT NULL,
        contact_name    text,
        phone           text,
        email           text,
        fax             text,
        address         text,
        is_active       boolean NOT NULL DEFAULT true,
        notes           text,
        created_at      timestamptz NOT NULL DEFAULT NOW(),
        updated_at      timestamptz NOT NULL DEFAULT NOW(),
        UNIQUE (practice_id, slug)
      )`
    await sql`CREATE INDEX IF NOT EXISTS agencies_practice_idx ON agencies(practice_id)`
    // Referrals table gets an agency link + source kind so the inbox can
    // badge the row by origin.
    await sql`ALTER TABLE referrals_in ADD COLUMN IF NOT EXISTS agency_id uuid`
    await sql`ALTER TABLE referrals_in ADD COLUMN IF NOT EXISTS referral_source_kind text`
  } catch (e: any) { console.error('agencies bootstrap failed:', e?.message) }
}

/**
 * GET  /api/agencies         — list agencies for the caller's practice
 * POST /api/agencies          — create a new agency (admin only)
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  let sub: string
  try { sub = await verifyToken(req.headers.authorization) }
  catch { return res.status(401).json({ error: 'Unauthorized' }) }

  const sql = neon(process.env.DATABASE_URL!)
  await bootstrap(sql)
  const [provider] = await sql`SELECT id, practice_id, is_admin FROM providers WHERE cognito_sub = ${sub} LIMIT 1`
  if (!provider) return res.status(403).json({ error: 'Provider not found' })

  if (req.method === 'GET') {
    const rows = await sql`
      SELECT * FROM agencies
      WHERE practice_id = ${provider.practice_id}::uuid
      ORDER BY is_active DESC, name`
    return res.json(rows)
  }

  if (req.method === 'POST') {
    if (!provider.is_admin) return res.status(403).json({ error: 'Admin only' })
    const b = (req.body ?? {}) as Record<string, any>
    if (!b.name?.trim()) return res.status(400).json({ error: 'name required' })
    const slug = (b.slug ? slugify(String(b.slug)) : slugify(String(b.name)))
    try {
      const [row] = await sql`
        INSERT INTO agencies (practice_id, slug, name, contact_name, phone, email, fax, address, notes)
        VALUES (${provider.practice_id}::uuid, ${slug}, ${b.name.trim()},
                ${b.contact_name ?? null}, ${b.phone ?? null}, ${b.email ?? null},
                ${b.fax ?? null}, ${b.address ?? null}, ${b.notes ?? null})
        RETURNING *`
      return res.status(201).json(row)
    } catch (e: any) {
      if (/duplicate|unique/i.test(e?.message ?? '')) {
        return res.status(409).json({ error: `Slug "${slug}" is already in use. Pick a different name or set a custom slug.` })
      }
      throw e
    }
  }

  return res.status(405).json({ error: 'Method not allowed' })
}
