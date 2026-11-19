import type { VercelRequest, VercelResponse } from '@vercel/node'
import { neon } from '@neondatabase/serverless'
import { createRemoteJWKSet, jwtVerify } from 'jose'

// PATCH /api/supplies/[id] — edit catalog row (admin only).
// DELETE /api/supplies/[id] — soft-archive (is_active=false).
// Both scoped to the admin's practice_id.
//
// Sara 2026-11-19.

async function verifyProviderToken(authHeader: string | undefined): Promise<string> {
  if (!authHeader?.startsWith('Bearer ')) throw new Error('Missing token')
  const token = authHeader.slice(7)
  const region = process.env.VITE_AWS_REGION || 'us-east-2'
  const poolId = process.env.VITE_AWS_USER_POOL_ID || ''
  const JWKS = createRemoteJWKSet(new URL(`https://cognito-idp.${region}.amazonaws.com/${poolId}/.well-known/jwks.json`))
  const { payload } = await jwtVerify(token, JWKS, { issuer: `https://cognito-idp.${region}.amazonaws.com/${poolId}` })
  if (!payload.sub) throw new Error('No sub in token')
  return payload.sub as string
}

const ALLOWED = new Set(['name','unit_label','description','default_quantity','associated_cpt_code','units_per_box','sort_order','is_active'])

export default async function handler(req: VercelRequest, res: VercelResponse) {
  let sub: string
  try { sub = await verifyProviderToken(req.headers.authorization) }
  catch { return res.status(401).json({ error: 'Unauthorized' }) }

  const sql = neon(process.env.DATABASE_URL!)
  const [provider] = await sql`SELECT id, practice_id, is_admin, is_super_admin FROM providers WHERE cognito_sub = ${sub} LIMIT 1`
  if (!provider) return res.status(403).json({ error: 'Provider not found' })
  if (!provider.is_admin && !provider.is_super_admin) return res.status(403).json({ error: 'Admin only' })

  const id = req.query.id as string
  if (!id) return res.status(400).json({ error: 'id required' })

  if (req.method === 'PATCH') {
    const b = req.body ?? {}
    const sets: string[] = []
    const vals: any[] = []
    for (const k of Object.keys(b)) {
      if (!ALLOWED.has(k)) continue
      vals.push(b[k])
      sets.push(`${k} = $${vals.length}`)
    }
    if (sets.length === 0) return res.status(400).json({ error: 'nothing to update' })
    vals.push(id)
    vals.push(provider.practice_id)
    const text = `UPDATE supplies_catalog SET ${sets.join(', ')}, updated_at = NOW()
                  WHERE id = $${vals.length - 1}::uuid AND practice_id = $${vals.length}::uuid
                  RETURNING *`
    const result: any = await sql.query(text, vals)
    const rows = Array.isArray(result) ? result : (result?.rows ?? [])
    if (rows.length === 0) return res.status(404).json({ error: 'Not found' })
    return res.status(200).json(rows[0])
  }

  if (req.method === 'DELETE') {
    // Soft-archive — keeps historical supply_request_items.supply_id refs intact.
    const [row] = await sql`
      UPDATE supplies_catalog SET is_active = false, updated_at = NOW()
      WHERE id = ${id}::uuid AND practice_id = ${provider.practice_id}::uuid
      RETURNING id`
    if (!row) return res.status(404).json({ error: 'Not found' })
    return res.status(200).json({ ok: true })
  }

  return res.status(405).json({ error: 'Method not allowed' })
}
