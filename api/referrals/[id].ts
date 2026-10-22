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
 * GET  /api/referrals/[id] — load a referral row
 * PATCH /api/referrals/[id] — update status / append activity entry
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  let sub: string
  try { sub = await verifyToken(req.headers.authorization) }
  catch { return res.status(401).json({ error: 'Unauthorized' }) }

  const sql = neon(process.env.DATABASE_URL!)
  const [provider] = await sql`SELECT id, name, practice_id, is_admin FROM providers WHERE cognito_sub = ${sub} LIMIT 1`
  if (!provider)          return res.status(403).json({ error: 'Provider not found' })
  if (!provider.is_admin) return res.status(403).json({ error: 'Admin only' })

  const id = String(req.query.id ?? '')
  if (!id) return res.status(400).json({ error: 'id required' })

  if (req.method === 'GET') {
    const [row] = await sql`SELECT * FROM referrals_in WHERE id = ${id}::uuid AND practice_id = ${provider.practice_id}::uuid LIMIT 1`
    if (!row) return res.status(404).json({ error: 'Referral not found' })
    return res.json(row)
  }

  if (req.method === 'PATCH') {
    const { status, note, appointment_id } = (req.body ?? {}) as { status?: string; note?: string; appointment_id?: string | null }

    const allowed = new Set(['new', 'contacted', 'scheduled', 'declined', 'closed'])
    if (status && !allowed.has(status)) return res.status(400).json({ error: 'Invalid status' })

    const activityEntry = {
      at: new Date().toISOString(),
      by: provider.name,
      status: status ?? null,
      note: (note ?? '').trim() || null,
    }

    const [updated] = await sql`
      UPDATE referrals_in SET
        status            = COALESCE(${status ?? null}, status),
        status_updated_at = CASE WHEN ${status ?? null}::text IS NOT NULL THEN NOW() ELSE status_updated_at END,
        status_updated_by = CASE WHEN ${status ?? null}::text IS NOT NULL THEN ${provider.name} ELSE status_updated_by END,
        appointment_id    = COALESCE(${appointment_id ?? null}::uuid, appointment_id),
        activity_log      = COALESCE(activity_log, '[]'::jsonb) || ${JSON.stringify([activityEntry])}::jsonb,
        updated_at        = NOW()
      WHERE id = ${id}::uuid AND practice_id = ${provider.practice_id}::uuid
      RETURNING *`
    if (!updated) return res.status(404).json({ error: 'Referral not found' })
    return res.json(updated)
  }

  return res.status(405).json({ error: 'Method not allowed' })
}
