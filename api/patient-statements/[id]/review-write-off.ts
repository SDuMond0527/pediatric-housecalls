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
 * POST /api/patient-statements/[id]/review-write-off
 *
 * Owner (super_admin) approves or denies a pending write-off request.
 * Body: { approved: boolean, review_note?: string }
 *
 * Approved → commits the write-off (status='void', voided_at, voided_by=owner).
 * Denied → clears the pending flag + preserves the biller's reason/note under
 *   void_note so the biller has a trail.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  let sub: string
  try { sub = await verifyToken(req.headers.authorization) }
  catch { return res.status(401).json({ error: 'Unauthorized' }) }

  try {
    const sql = neon(process.env.DATABASE_URL!)
    const [provider] = await sql`SELECT id, is_super_admin, practice_id FROM providers WHERE cognito_sub = ${sub} LIMIT 1`
    if (!provider) return res.status(403).json({ error: 'Provider not found' })
    if (!provider.is_super_admin) return res.status(403).json({ error: 'Only the practice owner can review write-off requests.' })

    const practiceId = provider.practice_id as string
    const ownerId    = provider.id as string
    const statementId = req.query.id as string
    if (!statementId) return res.status(400).json({ error: 'id required' })

    try { await sql`ALTER TABLE patient_statements ADD COLUMN IF NOT EXISTS write_off_denied_at timestamptz` } catch {}
    try { await sql`ALTER TABLE patient_statements ADD COLUMN IF NOT EXISTS write_off_denied_by uuid` } catch {}
    try { await sql`ALTER TABLE patient_statements ADD COLUMN IF NOT EXISTS write_off_denied_note text` } catch {}
    // These are read in the SELECT below; bootstrap so a review that
    // arrives before the first write-off (which normally bootstraps
    // them) doesn't 500.
    try { await sql`ALTER TABLE patient_statements ADD COLUMN IF NOT EXISTS void_note text` } catch {}
    try { await sql`ALTER TABLE patient_statements ADD COLUMN IF NOT EXISTS void_reason text` } catch {}

    const { approved, review_note } = req.body ?? {}
    if (typeof approved !== 'boolean') return res.status(400).json({ error: 'approved (boolean) required' })

    const [existing] = await sql`
      SELECT id, status, write_off_pending, void_reason, void_note
      FROM patient_statements
      WHERE id = ${statementId} AND practice_id = ${practiceId}::uuid
      LIMIT 1
    `
    if (!existing) return res.status(404).json({ error: 'Statement not found' })
    if (!existing.write_off_pending) return res.status(409).json({ error: 'No pending write-off request on this statement.' })

    const noteStr = review_note && String(review_note).trim() ? String(review_note).trim() : null

    if (approved) {
      const [updated] = await sql`
        UPDATE patient_statements SET
          status            = 'void',
          voided_at         = NOW(),
          voided_by         = ${ownerId}::uuid,
          write_off_pending = FALSE,
          updated_at        = NOW()
        WHERE id = ${statementId} AND practice_id = ${practiceId}::uuid
        RETURNING *
      `
      return res.status(200).json({ action: 'approved', statement: updated })
    }

    // Denied — clear pending + record who denied + why.
    const [updated] = await sql`
      UPDATE patient_statements SET
        write_off_pending      = FALSE,
        write_off_denied_at    = NOW(),
        write_off_denied_by    = ${ownerId}::uuid,
        write_off_denied_note  = ${noteStr},
        updated_at             = NOW()
      WHERE id = ${statementId} AND practice_id = ${practiceId}::uuid
      RETURNING *
    `
    return res.status(200).json({ action: 'denied', statement: updated })
  } catch (e: any) {
    console.error('patient-statements/[id]/review-write-off error:', e)
    return res.status(500).json({ error: e.message ?? 'Internal server error' })
  }
}
