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

    // Idempotent bootstrap — commit columns + approval-workflow columns.
    try { await sql`ALTER TABLE patient_statements ADD COLUMN IF NOT EXISTS voided_at timestamptz` } catch {}
    try { await sql`ALTER TABLE patient_statements ADD COLUMN IF NOT EXISTS void_reason text` } catch {}
    try { await sql`ALTER TABLE patient_statements ADD COLUMN IF NOT EXISTS voided_by uuid` } catch {}
    try { await sql`ALTER TABLE patient_statements ADD COLUMN IF NOT EXISTS void_note text` } catch {}
    try { await sql`ALTER TABLE patient_statements ADD COLUMN IF NOT EXISTS write_off_pending boolean` } catch {}
    try { await sql`ALTER TABLE patient_statements ADD COLUMN IF NOT EXISTS write_off_requested_by uuid` } catch {}
    try { await sql`ALTER TABLE patient_statements ADD COLUMN IF NOT EXISTS write_off_requested_at timestamptz` } catch {}

    const { reason, note } = req.body ?? {}
    const reasonStr = String(reason ?? '').trim()
    if (!VALID_REASONS.has(reasonStr)) {
      return res.status(400).json({
        error: `Invalid reason. Must be one of: ${Array.from(VALID_REASONS).join(', ')}`,
      })
    }

    // Owner-approval workflow: only super_admin (practice owner) can
    // commit a write-off directly. Every other admin (Pam / Andrea /
    // billing staff) creates a pending request that the owner reviews.
    const [me] = await sql`SELECT is_super_admin FROM providers WHERE id = ${providerId}::uuid LIMIT 1`
    const isOwner = Boolean(me?.is_super_admin)

    const [existing] = await sql`
      SELECT id, status, write_off_pending FROM patient_statements
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
    if (existing.write_off_pending) {
      return res.status(409).json({ error: 'A write-off request is already pending for this statement. The owner needs to approve or deny it first.' })
    }

    const noteStr = note && String(note).trim() ? String(note).trim() : null

    if (isOwner) {
      // Direct commit — owner is the final approver so no queue needed.
      const [updated] = await sql`
        UPDATE patient_statements SET
          status       = 'void',
          voided_at    = NOW(),
          void_reason  = ${reasonStr},
          voided_by    = ${providerId}::uuid,
          void_note    = ${noteStr},
          write_off_pending      = FALSE,
          write_off_requested_by = ${providerId}::uuid,
          write_off_requested_at = NOW(),
          updated_at   = NOW()
        WHERE id = ${statementId} AND practice_id = ${practiceId}::uuid
        RETURNING *
      `
      return res.status(200).json({ action: 'committed', statement: updated })
    }

    // Non-owner: create a pending request. Reason + note captured on
    // the row itself so the owner sees the full context in the queue.
    const [updated] = await sql`
      UPDATE patient_statements SET
        write_off_pending      = TRUE,
        write_off_requested_by = ${providerId}::uuid,
        write_off_requested_at = NOW(),
        void_reason            = ${reasonStr},
        void_note              = ${noteStr},
        updated_at             = NOW()
      WHERE id = ${statementId} AND practice_id = ${practiceId}::uuid
      RETURNING *
    `
    return res.status(200).json({ action: 'pending', statement: updated })
  } catch (e: any) {
    console.error('patient-statements/[id]/write-off error:', e)
    return res.status(500).json({ error: e.message ?? 'Internal server error' })
  }
}
