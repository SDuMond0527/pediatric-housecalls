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
 * POST /api/claims/[id]/mark-denial-handled
 *
 * Biller acknowledges an ERA rejection / documentation-request banner and
 * records what she's doing (or has done) about it. Body:
 *   { notes: string }
 *
 * Effect: sets denial_handled_at + denial_handled_by_name +
 * denial_handling_notes on the claim. The UI hides the flashing red /
 * amber banner and replaces it with a muted "handled" strip showing
 * who did what and when. Anyone with claim access can click to see
 * the notes.
 *
 * Idempotent — biller can call this multiple times to update her notes
 * as she works the resolution.
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

    try { await sql`ALTER TABLE claims ADD COLUMN IF NOT EXISTS denial_handled_at timestamptz` } catch {}
    try { await sql`ALTER TABLE claims ADD COLUMN IF NOT EXISTS denial_handled_by_name text` } catch {}
    try { await sql`ALTER TABLE claims ADD COLUMN IF NOT EXISTS denial_handling_notes text` } catch {}

    const { notes } = req.body ?? {}
    const notesStr = String(notes ?? '').trim()
    if (!notesStr) {
      return res.status(400).json({ error: 'notes required — describe what you did or are doing about the denial.' })
    }

    const [existing] = await sql`
      SELECT id FROM claims
      WHERE id = ${claimId}::uuid AND practice_id = ${provider.practice_id}::uuid
      LIMIT 1
    `
    if (!existing) return res.status(404).json({ error: 'Claim not found' })

    const [updated] = await sql`
      UPDATE claims SET
        denial_handled_at      = NOW(),
        denial_handled_by_name = ${provider.name ?? 'Biller'},
        denial_handling_notes  = ${notesStr},
        updated_at             = NOW()
      WHERE id = ${claimId}::uuid AND practice_id = ${provider.practice_id}::uuid
      RETURNING *
    `
    return res.status(200).json(updated)
  } catch (e: any) {
    console.error('claims/[id]/mark-denial-handled error:', e)
    return res.status(500).json({ error: e.message ?? 'Internal server error' })
  }
}
