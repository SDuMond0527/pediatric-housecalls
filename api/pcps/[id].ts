import type { VercelRequest, VercelResponse } from '@vercel/node'
import { neon } from '@neondatabase/serverless'
import { createRemoteJWKSet, jwtVerify } from 'jose'

async function verifyToken(authHeader: string | undefined): Promise<string> {
  if (!authHeader?.startsWith('Bearer ')) throw new Error('Missing token')
  const token = authHeader.slice(7)
  const region     = process.env.VITE_AWS_REGION || 'us-east-2'
  const userPoolId = process.env.VITE_AWS_USER_POOL_ID || ''
  const JWKS = createRemoteJWKSet(new URL(`https://cognito-idp.${region}.amazonaws.com/${userPoolId}/.well-known/jwks.json`))
  const { payload } = await jwtVerify(token, JWKS, { issuer: `https://cognito-idp.${region}.amazonaws.com/${userPoolId}` })
  if (!payload.sub) throw new Error('No sub in token')
  return payload.sub
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try { await verifyToken(req.headers.authorization) } catch {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const sql = neon(process.env.DATABASE_URL!)
  const { id } = req.query as { id: string }

  if (req.method === 'PATCH') {
    const { name, fax_number, aliases, state, is_active } = req.body ?? {}
    const [row] = await sql`
      UPDATE pcps SET
        name       = COALESCE(${name       ?? null}, name),
        fax_number = COALESCE(${fax_number ?? null}, fax_number),
        aliases    = COALESCE(${aliases    != null ? JSON.stringify(aliases) : null}::text[], aliases),
        state      = COALESCE(${state      ?? null}, state),
        is_active  = COALESCE(${is_active  ?? null}, is_active),
        updated_at = now()
      WHERE id = ${id}::uuid
      RETURNING *`
    if (!row) return res.status(404).json({ error: 'Not found' })
    return res.json(row)
  }

  if (req.method === 'DELETE') {
    await sql`UPDATE pcps SET is_active = false WHERE id = ${id}::uuid`
    return res.status(204).end()
  }

  return res.status(405).json({ error: 'Method not allowed' })
}
