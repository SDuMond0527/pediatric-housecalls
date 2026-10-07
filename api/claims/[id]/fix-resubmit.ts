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
 * POST /api/claims/[id]/fix-resubmit
 *
 * One-click resubmission path from the Rework tab, shipped 2026-10-06
 * after Sara asked for a dedicated resubmit button on every Rework card.
 * Replaces the "Reopen for correction" modal → tab-flip → edit → submit
 * dance with a direct hand-off into Ready for Biller.
 *
 * Semantics vs. /reopen:
 *   /reopen        — status back to pending_review, keeps rework triggers
 *                    set so the claim STAYS in Rework while Andrea works it.
 *                    Clears ready_for_biller_at.
 *   /fix-resubmit  — status back to pending_review, CLEARS every rework
 *                    trigger (denial_codes, claim_rejection_at, 277 x12,
 *                    submission_error) so the claim leaves Rework. SETS
 *                    ready_for_biller_at so it appears on the Ready tab
 *                    with the full editor. Andrea edits + submits from
 *                    there; a successful Stedi send moves it to Submitted.
 *   isInRework also special-cases this: a reopened pending_review claim
 *   with ready_for_biller_at set is NOT in Rework. See
 *   src/pages/admin/AdminClaims.tsx isInRework.
 *
 * Body: { note?: string }
 *   - Optional short note describing the correction (e.g.,
 *     "corrected modifier 25 after CO-97 denial"). Appended to the
 *     claims.resubmission_log jsonb array with timestamp + author.
 *     Shown on the Rework/Ready card for history.
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

    const { note } = req.body ?? {}
    const noteStr = String(note ?? '').trim()

    // Bootstrap columns the Rework/Ready renderers depend on.
    try { await sql`ALTER TABLE claims ADD COLUMN IF NOT EXISTS reopened_at timestamptz` } catch {}
    try { await sql`ALTER TABLE claims ADD COLUMN IF NOT EXISTS reopened_by uuid` } catch {}
    try { await sql`ALTER TABLE claims ADD COLUMN IF NOT EXISTS reopen_reason text` } catch {}
    try { await sql`ALTER TABLE claims ADD COLUMN IF NOT EXISTS reopen_note text` } catch {}
    try { await sql`ALTER TABLE claims ADD COLUMN IF NOT EXISTS ready_for_biller_at timestamptz` } catch {}
    try { await sql`ALTER TABLE claims ADD COLUMN IF NOT EXISTS ready_for_biller_by text` } catch {}
    try { await sql`ALTER TABLE claims ADD COLUMN IF NOT EXISTS resubmission_log jsonb DEFAULT '[]'::jsonb` } catch {}
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

    const [existing] = await sql`
      SELECT id, status, submitted_at, claim_rejection_at, denial_codes, resubmission_log
      FROM claims
      WHERE id = ${claimId}::uuid AND practice_id = ${provider.practice_id}::uuid
      LIMIT 1
    `
    if (!existing) return res.status(404).json({ error: 'Claim not found' })
    if (!existing.submitted_at) {
      return res.status(400).json({ error: "This claim has never been submitted — there's nothing to resubmit. Edit it in Ready for Biller instead." })
    }
    if (existing.status === 'written_off') {
      return res.status(400).json({ error: 'This claim is written off. Resubmitting would resurrect a closed AR item.' })
    }

    // Append new entry to resubmission_log.
    const prevLog: any[] = Array.isArray(existing.resubmission_log) ? existing.resubmission_log : []
    const entry = {
      at: new Date().toISOString(),
      by: provider.id,
      by_name: provider.name ?? 'Biller',
      note: noteStr || null,
      prior_denial_codes: existing.denial_codes ?? null,
      prior_claim_rejection_at: existing.claim_rejection_at ?? null,
    }
    const nextLog = [...prevLog, entry]

    const [updated] = await sql`
      UPDATE claims SET
        -- Clear every rework trigger so isInRework drops this claim out
        -- of the Rework tab. A subsequent payer response (277/835) will
        -- repopulate these if it comes back dirty again. Previously tried
        -- to NULL claim_rejection_277_x12 which doesn't exist in prod —
        -- the 277 raw X12 is stored inside claim_rejection_response.rawX12
        -- (jsonb), and the whole response gets cleared below. Sara
        -- 2026-10-07 (fix after HTTP error on Prepare for resubmit).
        denial_codes             = NULL,
        claim_rejection_at       = NULL,
        claim_rejection_response = NULL,
        claim_rejection_reasons  = NULL,
        submission_error         = NULL,
        -- Reset status to pending_review so Andrea can edit + resubmit
        -- via the Ready-for-biller editor. submitted_at stays intact
        -- (history of what went out previously).
        status                  = 'pending_review',
        reopened_at             = NOW(),
        reopened_by             = ${provider.id}::uuid,
        reopen_reason           = 'payer_denied_other',
        reopen_note             = ${noteStr || 'Fix + resubmit from Rework tab'},
        -- Hand straight to Ready-for-biller (differs from /reopen which
        -- clears this). The Rework → Ready move is the whole point of
        -- this endpoint.
        ready_for_biller_at     = NOW(),
        ready_for_biller_by     = ${provider.name ?? 'Biller'},
        -- rework_resolved_at NOT set — that would send it to Completed.
        resubmission_log        = ${JSON.stringify(nextLog)}::jsonb,
        updated_at              = NOW()
      WHERE id = ${claimId}::uuid AND practice_id = ${provider.practice_id}::uuid
      RETURNING *
    `

    try {
      const body = noteStr
        ? `Fix + resubmit from Rework tab. Note: ${noteStr}`
        : 'Fix + resubmit from Rework tab. No note provided.'
      await sql`
        INSERT INTO claim_activity_log (claim_id, created_by, created_by_name, kind, body)
        VALUES (${claimId}::uuid, ${provider.id}::uuid, ${provider.name ?? 'Biller'}, 'fix_resubmit', ${body})`
    } catch (logErr: any) {
      console.error('fix-resubmit activity log insert failed (non-fatal):', logErr?.message)
    }

    return res.status(200).json(updated)
  } catch (e: any) {
    console.error('claims/[id]/fix-resubmit error:', e)
    return res.status(500).json({ error: e.message ?? 'Internal server error' })
  }
}
