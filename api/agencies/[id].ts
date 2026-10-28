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

/**
 * GET    /api/agencies/[id] — fetch one
 * PATCH  /api/agencies/[id] — update (admin only)
 * DELETE /api/agencies/[id] — deactivate (admin only, soft via is_active=false)
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  let sub: string
  try { sub = await verifyToken(req.headers.authorization) }
  catch { return res.status(401).json({ error: 'Unauthorized' }) }

  const sql = neon(process.env.DATABASE_URL!)
  const [provider] = await sql`SELECT practice_id, is_admin FROM providers WHERE cognito_sub = ${sub} LIMIT 1`
  if (!provider) return res.status(403).json({ error: 'Provider not found' })

  const id = String(req.query.id ?? '')
  if (!id) return res.status(400).json({ error: 'id required' })

  const [row] = await sql`SELECT * FROM agencies WHERE id = ${id}::uuid AND practice_id = ${provider.practice_id}::uuid LIMIT 1`
  if (!row) return res.status(404).json({ error: 'Agency not found' })

  if (req.method === 'GET') return res.json(row)

  if (req.method === 'PATCH') {
    if (!provider.is_admin) return res.status(403).json({ error: 'Admin only' })
    const b = (req.body ?? {}) as Record<string, any>
    const [updated] = await sql`
      UPDATE agencies SET
        name         = COALESCE(${b.name ?? null},         name),
        contact_name = COALESCE(${b.contact_name ?? null}, contact_name),
        phone        = COALESCE(${b.phone ?? null},        phone),
        email        = COALESCE(${b.email ?? null},        email),
        fax          = COALESCE(${b.fax ?? null},          fax),
        address      = COALESCE(${b.address ?? null},      address),
        notes        = COALESCE(${b.notes ?? null},        notes),
        is_active    = COALESCE(${b.is_active ?? null},    is_active),
        updated_at   = NOW()
      WHERE id = ${id}::uuid AND practice_id = ${provider.practice_id}::uuid
      RETURNING *`
    return res.json(updated)
  }

  if (req.method === 'DELETE') {
    if (!provider.is_admin) return res.status(403).json({ error: 'Admin only' })
    // Soft-delete: keep the row so historical referrals still carry a
    // readable agency name, but drop it off the active list.
    await sql`UPDATE agencies SET is_active = false, updated_at = NOW() WHERE id = ${id}::uuid AND practice_id = ${provider.practice_id}::uuid`
    return res.status(204).end()
  }

  return res.status(405).json({ error: 'Method not allowed' })
}
