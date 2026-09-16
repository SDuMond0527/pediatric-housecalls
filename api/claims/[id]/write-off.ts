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

const VALID_REASONS = new Set(['bad_debt', 'small_balance', 'hardship', 'billing_error', 'timely_filing', 'other'])

/**
 * POST /api/claims/[id]/write-off
 *
 * Marks a claim as written off with a reason. Prevents stuck claims
 * (submitted / error) from sitting in AR forever and inflating the
 * insurance aging report. Captures who did it + optional note.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  let sub: string
  try { sub = await verifyToken(req.headers.authorization) }
  catch { return res.status(401).json({ error: 'Unauthorized' }) }

  try {
    const sql = neon(process.env.DATABASE_URL!)
    const [provider] = await sql`SELECT id, practice_id FROM providers WHERE cognito_sub = ${sub} LIMIT 1`
    if (!provider) return res.status(403).json({ error: 'Provider not found' })
    const practiceId = provider.practice_id as string
    const providerId = provider.id as string

    const claimId = req.query.id as string
    if (!claimId) return res.status(400).json({ error: 'id required' })

    try { await sql`ALTER TABLE claims ADD COLUMN IF NOT EXISTS written_off_at timestamptz` } catch {}
    try { await sql`ALTER TABLE claims ADD COLUMN IF NOT EXISTS write_off_reason text` } catch {}
    try { await sql`ALTER TABLE claims ADD COLUMN IF NOT EXISTS written_off_by uuid` } catch {}
    try { await sql`ALTER TABLE claims ADD COLUMN IF NOT EXISTS write_off_note text` } catch {}

    const { reason, note } = req.body ?? {}
    const reasonStr = String(reason ?? '').trim()
    if (!VALID_REASONS.has(reasonStr)) {
      return res.status(400).json({
        error: `Invalid reason. Must be one of: ${Array.from(VALID_REASONS).join(', ')}`,
      })
    }

    const [existing] = await sql`
      SELECT id, status FROM claims
      WHERE id = ${claimId}::uuid AND practice_id = ${practiceId}::uuid
      LIMIT 1
    `
    if (!existing) return res.status(404).json({ error: 'Claim not found' })
    if (existing.status === 'written_off') {
      return res.status(409).json({ error: 'Claim is already written off. Refresh to see the latest state.' })
    }
    if (existing.status === 'paid') {
      return res.status(400).json({ error: 'Paid claims cannot be written off.' })
    }

    const noteStr = note && String(note).trim() ? String(note).trim() : null

    const [updated] = await sql`
      UPDATE claims SET
        status            = 'written_off',
        written_off_at    = NOW(),
        write_off_reason  = ${reasonStr},
        written_off_by    = ${providerId}::uuid,
        write_off_note    = ${noteStr},
        updated_at        = NOW()
      WHERE id = ${claimId}::uuid AND practice_id = ${practiceId}::uuid
      RETURNING *
    `
    return res.status(200).json(updated)
  } catch (e: any) {
    console.error('claims/[id]/write-off error:', e)
    return res.status(500).json({ error: e.message ?? 'Internal server error' })
  }
}
