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

export default async function handler(req: VercelRequest, res: VercelResponse) {
  let sub: string
  try { sub = await verifyToken(req.headers.authorization) }
  catch { return res.status(401).json({ error: 'Unauthorized' }) }

  const sql = neon(process.env.DATABASE_URL!)
  const [provider] = await sql`SELECT practice_id, is_admin FROM providers WHERE cognito_sub = ${sub} LIMIT 1`
  if (!provider)              return res.status(403).json({ error: 'Provider not found' })
  if (!provider.is_admin)     return res.status(403).json({ error: 'Admin only' })

  const id = String(req.query.id ?? '')
  if (!id) return res.status(400).json({ error: 'id required' })

  if (req.method === 'PATCH') {
    const b = (req.body ?? {}) as any
    const [row] = await sql`
      UPDATE stud_options SET
        name       = COALESCE(${b.name ?? null}, name),
        photo_url  = COALESCE(${b.photo_url ?? null}, photo_url),
        price      = COALESCE(${b.price ?? null}, price),
        is_active  = COALESCE(${b.is_active ?? null}, is_active),
        sort_order = COALESCE(${b.sort_order ?? null}, sort_order),
        updated_at = NOW()
      WHERE id = ${id}::uuid AND practice_id = ${provider.practice_id}::uuid
      RETURNING *`
    if (!row) return res.status(404).json({ error: 'Not found' })
    return res.json(row)
  }

  if (req.method === 'DELETE') {
    await sql`UPDATE stud_options SET is_active = false, updated_at = NOW() WHERE id = ${id}::uuid AND practice_id = ${provider.practice_id}::uuid`
    return res.status(204).end()
  }

  return res.status(405).json({ error: 'Method not allowed' })
}
