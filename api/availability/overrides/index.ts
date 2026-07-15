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
  let sub: string
  try {
    sub = await verifyToken(req.headers.authorization)
  } catch {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const sql = neon(process.env.DATABASE_URL!)

  const providerRows = await sql`SELECT id, role, practice_id FROM providers WHERE cognito_sub = ${sub} LIMIT 1`
  if (!providerRows.length) return res.status(403).json({ error: 'Provider not found' })
  const { id: callerId, role: callerRole, practice_id: practiceId } = providerRows[0] as { id: string; role: string; practice_id: string }

  const { provider_id, date, is_available, start_time, end_time, note } = req.body

  if (callerRole !== 'admin' && callerId !== provider_id) {
    return res.status(403).json({ error: 'Forbidden' })
  }
  const [row] = await sql`
    INSERT INTO availability_overrides (practice_id, provider_id, date, is_available, start_time, end_time, note)
    VALUES (${practiceId}::uuid, ${provider_id}::uuid, ${date}::date, ${is_available}, ${start_time ?? null}, ${end_time ?? null}, ${note ?? null})
    ON CONFLICT (provider_id, date) DO UPDATE
    SET is_available=EXCLUDED.is_available, start_time=EXCLUDED.start_time, end_time=EXCLUDED.end_time, note=EXCLUDED.note
    RETURNING *`
  res.json(row)
}
