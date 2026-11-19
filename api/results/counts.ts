// Lightweight count endpoint used by the sidebar to badge the
// Pathology inbox / Labs inbox / Patient callbacks nav items.
// Separate from /api/results so we don't ship full rows just to show
// a number. Sara 2026-11-17.
//
// GET /api/results/counts
//   → { pathology_pending, pathology_signed, labs_pending, labs_signed }

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
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  let sub: string
  try { sub = await verifyToken(req.headers.authorization) }
  catch { return res.status(401).json({ error: 'Unauthorized' }) }

  const sql = neon(process.env.DATABASE_URL!)
  const [provider] = await sql`SELECT practice_id FROM providers WHERE cognito_sub = ${sub} LIMIT 1`
  if (!provider) return res.status(403).json({ error: 'Provider not found' })
  const practiceId = provider.practice_id as string

  // Grab results counts + supply-requests pending in one round trip.
  // Each query wrapped so one table's absence doesn't hide the other.
  const payload = {
    pathology_pending: 0, pathology_signed: 0,
    labs_pending: 0, labs_signed: 0,
    supply_requests_pending: 0,
  }
  try {
    const [row] = await sql`
      SELECT
        COUNT(*) FILTER (WHERE type = 'pathology' AND status = 'pending_review')::int AS pathology_pending,
        COUNT(*) FILTER (WHERE type = 'pathology' AND status = 'signed')::int        AS pathology_signed,
        COUNT(*) FILTER (WHERE type = 'lab'       AND status = 'pending_review')::int AS labs_pending,
        COUNT(*) FILTER (WHERE type = 'lab'       AND status = 'signed')::int        AS labs_signed
      FROM results
      WHERE practice_id = ${practiceId}::uuid`
    payload.pathology_pending = row?.pathology_pending ?? 0
    payload.pathology_signed  = row?.pathology_signed  ?? 0
    payload.labs_pending      = row?.labs_pending      ?? 0
    payload.labs_signed       = row?.labs_signed       ?? 0
  } catch {}
  try {
    const [row] = await sql`
      SELECT COUNT(*)::int AS pending
      FROM supply_requests
      WHERE practice_id = ${practiceId}::uuid
        AND status NOT IN ('received','cancelled')`
    payload.supply_requests_pending = row?.pending ?? 0
  } catch {}
  return res.status(200).json(payload)
}
