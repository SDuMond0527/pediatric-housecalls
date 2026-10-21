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
 * Admin bell-icon badge: unread provider replies to Andrea's biller
 * questions. Andrea is the only one who sends biller messages, so
 * single-row read state on providers.last_provider_reply_seen_at is
 * enough — no per-user table needed.
 *
 *   GET /api/provider-reply-badge         → { count, items[] }
 *   POST /api/provider-reply-badge        → marks all current replies seen
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  let sub: string
  try { sub = await verifyToken(req.headers.authorization) }
  catch { return res.status(401).json({ error: 'Unauthorized' }) }

  const sql = neon(process.env.DATABASE_URL!)
  try { await sql`ALTER TABLE providers ADD COLUMN IF NOT EXISTS last_provider_reply_seen_at timestamptz` } catch {}

  const [provider] = await sql`SELECT id, practice_id, is_admin, last_provider_reply_seen_at FROM providers WHERE cognito_sub = ${sub} LIMIT 1`
  if (!provider) return res.status(403).json({ error: 'Provider not found' })
  if (!provider.is_admin) return res.status(403).json({ error: 'Admin only' })

  if (req.method === 'POST') {
    await sql`UPDATE providers SET last_provider_reply_seen_at = NOW() WHERE id = ${provider.id}::uuid`
    return res.json({ ok: true })
  }

  if (req.method === 'GET') {
    const lastSeen = provider.last_provider_reply_seen_at ?? new Date(0)
    const items = await sql`
      SELECT cal.id, cal.claim_id, cal.created_at,
             cal.created_by_name AS provider_name, cal.body,
             c.patient_first_name, c.patient_last_name
      FROM claim_activity_log cal
      JOIN claims c ON c.id = cal.claim_id
      WHERE cal.kind = 'provider_response'
        AND c.practice_id = ${provider.practice_id}::uuid
        AND cal.created_at > ${lastSeen}
      ORDER BY cal.created_at DESC
      LIMIT 20`
    return res.json({ count: items.length, items })
  }

  return res.status(405).json({ error: 'Method not allowed' })
}
