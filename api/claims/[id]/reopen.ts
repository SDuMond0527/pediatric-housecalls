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

// Whitelist — must match the client dropdown in AdminClaims.tsx.
// If someone POSTs a reason not in this list we reject rather than
// silently save unknown text so reporting stays sane.
const REOPEN_REASONS = new Set([
  'payer_denied_cpt_dx',
  'payer_denied_member_info',
  'payer_denied_other',
  'other_correction',
])

const MIN_NOTE_LEN = 20

/**
 * POST /api/claims/[id]/reopen
 *
 * Moves a submitted claim back to 'pending_review' so the biller can
 * correct fields and resubmit. Replaces the old one-click Reopen button
 * that was too easy to trigger accidentally — Andrea was hitting it
 * just to VIEW claims, silently mutating state and losing track of
 * denied claims like Olive Dings / Rhett Richmond / Carson Yates.
 *
 * Body: { reason: string, note: string }
 *   - reason must be in REOPEN_REASONS (categorized for reporting)
 *   - note must be at least MIN_NOTE_LEN chars (forces intent — no
 *     accidental reopens)
 *
 * Effect on the claim row:
 *   status         = 'pending_review'
 *   reopened_at    = NOW()
 *   reopened_by    = provider.id
 *   reopen_reason  = <the reason code>
 *   reopen_note    = <the biller's note>
 *
 * submitted_at and stedi_response are left intact — those are the
 * record of what actually went out to the payer and must not be lost.
 * The 'reopened_at' timestamp is how the UI knows to render the
 * "Reopened — [reason]" badge on the Pending Review card so a rework
 * doesn't drown in the brand-new-claim queue.
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

    // Bootstrap on every read/write path per the "bootstrap on every
    // read path" rule — the reader (api/claims/index.ts) needs these
    // columns to render the badge, so declare them here too.
    try { await sql`ALTER TABLE claims ADD COLUMN IF NOT EXISTS reopened_at timestamptz` } catch {}
    try { await sql`ALTER TABLE claims ADD COLUMN IF NOT EXISTS reopened_by uuid` } catch {}
    try { await sql`ALTER TABLE claims ADD COLUMN IF NOT EXISTS reopen_reason text` } catch {}
    try { await sql`ALTER TABLE claims ADD COLUMN IF NOT EXISTS reopen_note text` } catch {}

    const { reason, note } = req.body ?? {}
    const reasonStr = String(reason ?? '').trim()
    const noteStr   = String(note ?? '').trim()

    if (!REOPEN_REASONS.has(reasonStr)) {
      return res.status(400).json({ error: 'reason must be one of: ' + [...REOPEN_REASONS].join(', ') })
    }
    if (noteStr.length < MIN_NOTE_LEN) {
      return res.status(400).json({ error: `note must be at least ${MIN_NOTE_LEN} characters — describe the correction you're making.` })
    }

    const [existing] = await sql`
      SELECT id, status, submitted_at
      FROM claims
      WHERE id = ${claimId}::uuid AND practice_id = ${provider.practice_id}::uuid
      LIMIT 1
    `
    if (!existing) return res.status(404).json({ error: 'Claim not found' })
    if (!existing.submitted_at) {
      return res.status(400).json({ error: "This claim has never been submitted — there's nothing to reopen. Edit it in Pending Review instead." })
    }
    if (existing.status === 'written_off') {
      return res.status(400).json({ error: 'This claim is written off. Reopening it would resurrect a closed AR item.' })
    }

    const [updated] = await sql`
      UPDATE claims SET
        status         = 'pending_review',
        reopened_at    = NOW(),
        reopened_by    = ${provider.id}::uuid,
        reopen_reason  = ${reasonStr},
        reopen_note    = ${noteStr},
        updated_at     = NOW()
      WHERE id = ${claimId}::uuid AND practice_id = ${provider.practice_id}::uuid
      RETURNING *
    `
    return res.status(200).json(updated)
  } catch (e: any) {
    console.error('claims/[id]/reopen error:', e)
    return res.status(500).json({ error: e.message ?? 'Internal server error' })
  }
}
