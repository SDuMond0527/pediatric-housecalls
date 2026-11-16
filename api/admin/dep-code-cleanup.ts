// One-shot cleanup for the Lucas Wells pattern (2026-11-16):
// patients where `insurance_no_dependent_code = true` but
// `insurance_dependent_code IS NOT NULL` — a contradictory state that
// means the biller previously tried to clear the dep code but the old
// COALESCE-based update silently preserved it. Eligibility checks have
// been failing silently against BCBS NC for every one of these rows.
//
// GET  /api/admin/dep-code-cleanup           → dry-run: list of affected rows
// POST /api/admin/dep-code-cleanup           → APPLIES: nulls the dep code
//
// Super-admin only. Idempotent — second POST is a no-op.

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
  let sub: string
  try { sub = await verifyToken(req.headers.authorization) }
  catch { return res.status(401).json({ error: 'Unauthorized' }) }

  const sql = neon(process.env.DATABASE_URL!)
  const [caller] = await sql`
    SELECT id, name, is_super_admin FROM providers WHERE cognito_sub = ${sub} LIMIT 1`
  if (!caller) return res.status(403).json({ error: 'Provider not found' })
  if (!caller.is_super_admin) return res.status(403).json({ error: 'Super admin access required' })

  const affected = await sql`
    SELECT id, first_name, last_name, practice_id,
           insurance_dependent_code, insurance_no_dependent_code
    FROM children
    WHERE insurance_no_dependent_code = true
      AND insurance_dependent_code IS NOT NULL
    ORDER BY last_name, first_name`

  if (req.method === 'GET') {
    return res.json({
      mode: 'dry-run',
      count: affected.length,
      rows: affected,
    })
  }

  if (req.method === 'POST') {
    if (affected.length === 0) {
      return res.json({ mode: 'apply', count: 0, message: 'Nothing to clean up.' })
    }
    const updated = await sql`
      UPDATE children
      SET insurance_dependent_code = NULL,
          updated_at = NOW()
      WHERE insurance_no_dependent_code = true
        AND insurance_dependent_code IS NOT NULL
      RETURNING id, first_name, last_name`
    return res.json({
      mode: 'apply',
      count: updated.length,
      updated,
      actor: caller.name,
    })
  }

  return res.status(405).json({ error: 'Method not allowed' })
}
