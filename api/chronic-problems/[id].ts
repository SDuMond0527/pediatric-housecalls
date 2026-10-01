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
 * /api/chronic-problems/[id]
 *   PATCH  { resolved_reason? } — mark resolved (soft-delete)
 *   DELETE                      — hard-delete (data-entry mistakes)
 *
 * Marking resolved preserves history (shown on chart under
 * "Resolved problems" with the reason + who resolved). Hard-delete is
 * for genuine mistakes only.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  let sub: string
  try { sub = await verifyToken(req.headers.authorization) }
  catch { return res.status(401).json({ error: 'Unauthorized' }) }

  const sql = neon(process.env.DATABASE_URL!)
  const [provider] = await sql`SELECT id, name, practice_id FROM providers WHERE cognito_sub = ${sub} LIMIT 1`
  if (!provider) return res.status(403).json({ error: 'Provider not found' })
  const practiceId = provider.practice_id as string

  const id = req.query.id as string
  if (!id) return res.status(400).json({ error: 'id required' })

  if (req.method === 'PATCH') {
    const { resolved_reason } = req.body ?? {}
    const [row] = await sql`
      UPDATE chronic_problems SET
        resolved_at      = COALESCE(resolved_at, NOW()),
        resolved_by      = COALESCE(resolved_by, ${provider.id}::uuid),
        resolved_by_name = COALESCE(resolved_by_name, ${provider.name ?? 'Unknown'}),
        resolved_reason  = ${resolved_reason ?? null}
      WHERE id = ${id}::uuid AND practice_id = ${practiceId}::uuid
      RETURNING *`
    if (!row) return res.status(404).json({ error: 'Problem not found' })
    return res.status(200).json(row)
  }

  if (req.method === 'DELETE') {
    const rows = await sql`
      DELETE FROM chronic_problems
      WHERE id = ${id}::uuid AND practice_id = ${practiceId}::uuid
      RETURNING id`
    if (!rows.length) return res.status(404).json({ error: 'Problem not found' })
    return res.status(200).json({ ok: true })
  }

  return res.status(405).json({ error: 'Method not allowed' })
}
