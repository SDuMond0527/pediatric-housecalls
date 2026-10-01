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
 * POST /api/claims/[id]/provider-reply
 *
 * Provider answers a biller question. The reply is auto-logged to
 * claim_activity_log (kind='provider_response') and the claim status
 * flips back to 'pending_review' so it re-enters the biller's active
 * queue.
 *
 * Any authenticated provider on the same practice can reply — usually
 * the rendering provider, but a colleague could also weigh in. The
 * activity log carries the responder's name so history is clear.
 *
 * Andrea 2026-09-30 asked for the closed-loop workflow.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  let sub: string
  try { sub = await verifyToken(req.headers.authorization) }
  catch { return res.status(401).json({ error: 'Unauthorized' }) }

  const sql = neon(process.env.DATABASE_URL!)
  const [provider] = await sql`SELECT id, name, practice_id FROM providers WHERE cognito_sub = ${sub} LIMIT 1`
  if (!provider) return res.status(403).json({ error: 'Provider not found' })

  const claimId = req.query.id as string
  if (!claimId) return res.status(400).json({ error: 'id required' })

  const { body: replyBody } = req.body ?? {}
  if (!replyBody || !String(replyBody).trim()) return res.status(400).json({ error: 'Reply body required' })

  // Verify claim exists + belongs to this practice.
  const [claim] = await sql`
    SELECT id, status FROM claims
    WHERE id = ${claimId}::uuid AND practice_id = ${provider.practice_id}::uuid
    LIMIT 1`
  if (!claim) return res.status(404).json({ error: 'Claim not found' })

  try {
    await sql`
      CREATE TABLE IF NOT EXISTS claim_activity_log (
        id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        claim_id        uuid NOT NULL,
        created_at      timestamptz NOT NULL DEFAULT NOW(),
        created_by      uuid,
        created_by_name text,
        kind            text NOT NULL DEFAULT 'note',
        body            text NOT NULL
      )`
    await sql`
      INSERT INTO claim_activity_log (claim_id, created_by, created_by_name, kind, body)
      VALUES (${claimId}::uuid, ${provider.id}::uuid, ${provider.name ?? 'Provider'}, 'provider_response', ${String(replyBody).trim()})`

    // Flip the claim back to pending_review only if it's currently in
    // pending_provider_response — don't clobber if the biller has since
    // moved it elsewhere.
    await sql`
      UPDATE claims
      SET status = 'pending_review', updated_at = NOW()
      WHERE id = ${claimId}::uuid
        AND status = 'pending_provider_response'`

    return res.status(200).json({ ok: true })
  } catch (e: any) {
    console.error('claims/[id]/provider-reply error:', e)
    return res.status(500).json({ error: e?.message ?? 'Internal server error' })
  }
}
