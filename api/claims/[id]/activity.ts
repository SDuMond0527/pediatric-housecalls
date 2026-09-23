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
 * Claim activity log — running thread of biller/provider notes on a
 * specific claim. Replaces the previous "Mark handled" flows (which
 * conflated acknowledgment with resolution — a claim that Andrea
 * marked "handled" could still be actively being worked, which was
 * confusing). Now the tab a claim lives in expresses its state, and
 * this log expresses what's happened / been done to it.
 *
 * Rendered on every expanded claim card. Primary workflow is on the
 * Rework tab, but keeps a full audit trail across the claim lifecycle.
 *
 * GET  /api/claims/[id]/activity → { entries: [{ id, created_at, created_by_name, body, kind }] }
 * POST /api/claims/[id]/activity  Body { body: string } → creates a new note
 *
 * `kind` is 'note' for user-authored entries. Reserved for future
 * system-authored entries ('rejection_received', 'reopened', etc.)
 * without a schema change — for MVP everything is 'note'.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  let sub: string
  try { sub = await verifyToken(req.headers.authorization) }
  catch { return res.status(401).json({ error: 'Unauthorized' }) }

  const sql = neon(process.env.DATABASE_URL!)
  const [provider] = await sql`SELECT id, name, practice_id FROM providers WHERE cognito_sub = ${sub} LIMIT 1`
  if (!provider) return res.status(403).json({ error: 'Provider not found' })

  const claimId = req.query.id as string
  if (!claimId) return res.status(400).json({ error: 'id required' })

  // Idempotent table bootstrap — Vercel has no migration story so
  // every endpoint that reads/writes a table also declares it.
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
    await sql`CREATE INDEX IF NOT EXISTS claim_activity_log_claim_id_idx ON claim_activity_log (claim_id, created_at DESC)`
  } catch {}

  // Scope to the caller's practice — never leak activity across
  // practices even if a caller guesses another practice's claim id.
  const [claim] = await sql`
    SELECT id FROM claims WHERE id = ${claimId}::uuid AND practice_id = ${provider.practice_id}::uuid LIMIT 1
  `
  if (!claim) return res.status(404).json({ error: 'Claim not found' })

  if (req.method === 'GET') {
    const entries = await sql`
      SELECT id, created_at, created_by, created_by_name, kind, body
        FROM claim_activity_log
       WHERE claim_id = ${claimId}::uuid
       ORDER BY created_at DESC`

    // Surface legacy notes captured by the retired "Mark handled"
    // flows so nothing gets lost in the migration. Presented as
    // pseudo-entries at the appropriate timestamp.
    const legacy = await sql`
      SELECT
        denial_handled_at, denial_handled_by_name, denial_handling_notes,
        claim_rejection_handled_at, claim_rejection_handled_by_name, claim_rejection_handling_notes
      FROM claims
      WHERE id = ${claimId}::uuid AND practice_id = ${provider.practice_id}::uuid
      LIMIT 1
    `
    const legacyRows: any[] = []
    if (legacy[0]?.denial_handled_at && legacy[0]?.denial_handling_notes) {
      legacyRows.push({
        id: `legacy-denial-${claimId}`,
        created_at: legacy[0].denial_handled_at,
        created_by: null,
        created_by_name: legacy[0].denial_handled_by_name ?? 'Biller',
        kind: 'legacy_denial_handled',
        body: legacy[0].denial_handling_notes,
      })
    }
    if (legacy[0]?.claim_rejection_handled_at && legacy[0]?.claim_rejection_handling_notes) {
      legacyRows.push({
        id: `legacy-rejection-${claimId}`,
        created_at: legacy[0].claim_rejection_handled_at,
        created_by: null,
        created_by_name: legacy[0].claim_rejection_handled_by_name ?? 'Biller',
        kind: 'legacy_rejection_handled',
        body: legacy[0].claim_rejection_handling_notes,
      })
    }

    const merged = [...entries, ...legacyRows]
      .sort((a: any, b: any) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())

    return res.status(200).json({ entries: merged })
  }

  if (req.method === 'POST') {
    const { body } = req.body ?? {}
    const bodyStr = String(body ?? '').trim()
    if (!bodyStr) return res.status(400).json({ error: 'body required' })

    const [inserted] = await sql`
      INSERT INTO claim_activity_log (claim_id, created_by, created_by_name, kind, body)
      VALUES (${claimId}::uuid, ${provider.id}::uuid, ${provider.name ?? null}, 'note', ${bodyStr})
      RETURNING id, created_at, created_by, created_by_name, kind, body`

    return res.status(200).json({ entry: inserted })
  }

  return res.status(405).json({ error: 'Method not allowed' })
}
