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
 * GET  /api/admin/reports-schedule       → last-reviewed timestamps per report_key + reviewer
 * POST /api/admin/reports-schedule       → body { report_key } inserts a new review row
 *
 * Report definitions (labels, frequencies, links) live on the client so
 * they can be edited without a deploy. The server just persists WHEN a
 * report was reviewed and BY WHOM.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  let sub: string
  try { sub = await verifyToken(req.headers.authorization) }
  catch { return res.status(401).json({ error: 'Unauthorized' }) }

  const sql = neon(process.env.DATABASE_URL!)
  const [provider] = await sql`SELECT id, is_admin, practice_id FROM providers WHERE cognito_sub = ${sub} LIMIT 1`
  if (!provider) return res.status(403).json({ error: 'Provider not found' })
  if (!provider.is_admin) return res.status(403).json({ error: 'Admin access required' })

  // Idempotent bootstrap.
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS report_reviews (
        id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        practice_id   uuid NOT NULL,
        provider_id   uuid NOT NULL,
        report_key    text NOT NULL,
        reviewed_at   timestamptz NOT NULL DEFAULT NOW()
      )
    `
    await sql`CREATE INDEX IF NOT EXISTS report_reviews_practice_key_idx ON report_reviews (practice_id, report_key, reviewed_at DESC)`
  } catch {}

  const practiceId = provider.practice_id as string

  if (req.method === 'GET') {
    // Latest review per report_key across the whole practice, plus who
    // did it. The UI shows both "you last reviewed" and "someone else
    // last reviewed" so co-admins don't step on each other.
    const rows = await sql`
      SELECT DISTINCT ON (r.report_key)
        r.report_key,
        r.reviewed_at,
        p.name AS reviewed_by_name
      FROM report_reviews r
      LEFT JOIN providers p ON p.id = r.provider_id
      WHERE r.practice_id = ${practiceId}::uuid
      ORDER BY r.report_key, r.reviewed_at DESC
    `
    return res.status(200).json({ reviews: rows })
  }

  if (req.method === 'POST') {
    const { report_key } = req.body ?? {}
    const key = String(report_key ?? '').trim()
    if (!key) return res.status(400).json({ error: 'report_key required' })
    if (key.length > 100) return res.status(400).json({ error: 'report_key too long' })

    const [row] = await sql`
      INSERT INTO report_reviews (practice_id, provider_id, report_key)
      VALUES (${practiceId}::uuid, ${provider.id}::uuid, ${key})
      RETURNING id, reviewed_at
    `
    return res.status(200).json(row)
  }

  return res.status(405).json({ error: 'Method not allowed' })
}
