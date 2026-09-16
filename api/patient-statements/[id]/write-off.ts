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
 * POST /api/patient-statements/[id]/write-off
 *
 * Marks a sent statement as void with a REASON. Replaces the generic
 * "void" action so financial reports can distinguish bad debt vs. small
 * balance vs. hardship vs. billing error. Every write-off captures who
 * did it (voided_by) and an optional note for the audit trail.
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

    const statementId = req.query.id as string
    if (!statementId) return res.status(400).json({ error: 'id required' })

    // Idempotent bootstrap — add the four columns the first time a
    // write-off is ever recorded so we don't need a separate migration.
    try { await sql`ALTER TABLE patient_statements ADD COLUMN IF NOT EXISTS voided_at timestamptz` } catch {}
    try { await sql`ALTER TABLE patient_statements ADD COLUMN IF NOT EXISTS void_reason text` } catch {}
    try { await sql`ALTER TABLE patient_statements ADD COLUMN IF NOT EXISTS voided_by uuid` } catch {}
    try { await sql`ALTER TABLE patient_statements ADD COLUMN IF NOT EXISTS void_note text` } catch {}

    const { reason, note } = req.body ?? {}
    const reasonStr = String(reason ?? '').trim()
    if (!VALID_REASONS.has(reasonStr)) {
      return res.status(400).json({
        error: `Invalid reason. Must be one of: ${Array.from(VALID_REASONS).join(', ')}`,
      })
    }

    const [existing] = await sql`
      SELECT id, status FROM patient_statements
      WHERE id = ${statementId} AND practice_id = ${practiceId}::uuid
      LIMIT 1
    `
    if (!existing) return res.status(404).json({ error: 'Statement not found' })
    if (existing.status === 'void') {
      return res.status(409).json({ error: 'Statement is already written off. Refresh to see the latest state.' })
    }
    if (existing.status === 'paid') {
      return res.status(400).json({ error: 'Paid statements cannot be written off. Refund the family instead if the amount was in error.' })
    }

    const noteStr = note && String(note).trim() ? String(note).trim() : null

    const [updated] = await sql`
      UPDATE patient_statements SET
        status       = 'void',
        voided_at    = NOW(),
        void_reason  = ${reasonStr},
        voided_by    = ${providerId}::uuid,
        void_note    = ${noteStr},
        updated_at   = NOW()
      WHERE id = ${statementId} AND practice_id = ${practiceId}::uuid
      RETURNING *
    `
    return res.status(200).json(updated)
  } catch (e: any) {
    console.error('patient-statements/[id]/write-off error:', e)
    return res.status(500).json({ error: e.message ?? 'Internal server error' })
  }
}
