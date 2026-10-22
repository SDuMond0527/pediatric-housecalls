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

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  let sub: string
  try { sub = await verifyToken(req.headers.authorization) }
  catch { return res.status(401).json({ error: 'Unauthorized' }) }

  const sql = neon(process.env.DATABASE_URL!)
  const [provider] = await sql`SELECT practice_id, is_admin FROM providers WHERE cognito_sub = ${sub} LIMIT 1`
  if (!provider)          return res.status(403).json({ error: 'Provider not found' })
  if (!provider.is_admin) return res.status(403).json({ error: 'Admin only' })

  try { await sql`CREATE TABLE IF NOT EXISTS referrals_in (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), practice_id uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT NOW())` } catch {}

  const rows = await sql`
    SELECT * FROM referrals_in
    WHERE practice_id = ${provider.practice_id}::uuid
    ORDER BY
      CASE status WHEN 'new' THEN 0 WHEN 'contacted' THEN 1 WHEN 'scheduled' THEN 2 WHEN 'declined' THEN 3 WHEN 'closed' THEN 4 ELSE 5 END,
      created_at DESC
    LIMIT 200`
  return res.json(rows)
}
