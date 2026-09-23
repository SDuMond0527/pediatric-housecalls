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
 * POST /api/claims/[id]/resolve-rework
 *
 * Biller marks a Rework-tab claim as done — she's worked whatever the
 * rejection / denial / correction was, and it's out of her queue.
 * Common case: she worked the correction in Stedi's portal outside
 * GoRoam so our platform never saw the fix.
 *
 * Stamps rework_resolved_at + resolver info. Filter on the client
 * checks: if a NEW rework trigger arrives after this timestamp
 * (fresh rejection, fresh denial), the claim automatically re-enters
 * Rework — otherwise it stays in Completed.
 *
 * Body: { note?: string }  — optional context, appended to activity log.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  let sub: string
  try { sub = await verifyToken(req.headers.authorization) }
  catch { return res.status(401).json({ error: 'Unauthorized' }) }

  try {
    const sql = neon(process.env.DATABASE_URL!)
    const [provider] = await sql`SELECT id, name, practice_id FROM providers WHERE cognito_sub = ${sub} LIMIT 1`
    if (!provider) return res.status(403).json({ error: 'Provider not found' })

    const claimId = req.query.id as string
    if (!claimId) return res.status(400).json({ error: 'id required' })

    // Idempotent bootstraps for the resolve columns + activity log
    // table (activity insert happens inline below).
    try { await sql`ALTER TABLE claims ADD COLUMN IF NOT EXISTS rework_resolved_at timestamptz` } catch {}
    try { await sql`ALTER TABLE claims ADD COLUMN IF NOT EXISTS rework_resolved_by uuid` } catch {}
    try { await sql`ALTER TABLE claims ADD COLUMN IF NOT EXISTS rework_resolved_by_name text` } catch {}
    try { await sql`ALTER TABLE claims ADD COLUMN IF NOT EXISTS rework_resolved_note text` } catch {}
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
    } catch {}

    const { note } = req.body ?? {}
    const noteStr = note && String(note).trim() ? String(note).trim() : null

    const [existing] = await sql`
      SELECT id FROM claims
      WHERE id = ${claimId}::uuid AND practice_id = ${provider.practice_id}::uuid
      LIMIT 1
    `
    if (!existing) return res.status(404).json({ error: 'Claim not found' })

    const [updated] = await sql`
      UPDATE claims SET
        rework_resolved_at      = NOW(),
        rework_resolved_by      = ${provider.id}::uuid,
        rework_resolved_by_name = ${provider.name ?? 'Biller'},
        rework_resolved_note    = ${noteStr},
        updated_at              = NOW()
      WHERE id = ${claimId}::uuid AND practice_id = ${provider.practice_id}::uuid
      RETURNING *
    `

    // Auto-log an activity entry so the audit trail shows who marked
    // it done + why, without asking the biller to write a separate note.
    const activityBody = noteStr
      ? `Marked rework complete — moved to Completed. Note: ${noteStr}`
      : 'Marked rework complete — moved to Completed.'
    try {
      await sql`
        INSERT INTO claim_activity_log (claim_id, created_by, created_by_name, kind, body)
        VALUES (${claimId}::uuid, ${provider.id}::uuid, ${provider.name ?? 'Biller'}, 'rework_resolved', ${activityBody})`
    } catch (logErr: any) {
      console.error('resolve-rework activity log insert failed (non-fatal):', logErr?.message)
    }

    return res.status(200).json(updated)
  } catch (e: any) {
    console.error('claims/[id]/resolve-rework error:', e)
    return res.status(500).json({ error: e.message ?? 'Internal server error' })
  }
}
