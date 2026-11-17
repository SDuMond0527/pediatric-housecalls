import type { VercelRequest, VercelResponse } from '@vercel/node'
import { neon } from '@neondatabase/serverless'
import { createRemoteJWKSet, jwtVerify } from 'jose'

// Single-item decision endpoint. Approve / Edit / Reject.
// Edit stores the biller's modified payload on the item row so downstream
// jobs (when the agent-logic ships) can commit the edited version rather
// than the agent's original proposal.

async function verifyProviderToken(authHeader: string | undefined): Promise<string> {
  if (!authHeader?.startsWith('Bearer ')) throw new Error('Missing token')
  const token = authHeader.slice(7)
  const region = process.env.VITE_AWS_REGION || 'us-east-2'
  const poolId = process.env.VITE_AWS_USER_POOL_ID || ''
  const JWKS = createRemoteJWKSet(new URL(`https://cognito-idp.${region}.amazonaws.com/${poolId}/.well-known/jwks.json`))
  const { payload } = await jwtVerify(token, JWKS, { issuer: `https://cognito-idp.${region}.amazonaws.com/${poolId}` })
  if (!payload.sub) throw new Error('No sub in token')
  return payload.sub as string
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
  let sub: string
  try { sub = await verifyProviderToken(req.headers.authorization) }
  catch { return res.status(401).json({ error: 'Unauthorized' }) }

  const sql = neon(process.env.DATABASE_URL!)
  // Super-admin only until Sara widens visibility. 2026-11-09.
  const [provider] = await sql`SELECT id, name, practice_id, is_super_admin FROM providers WHERE cognito_sub = ${sub} LIMIT 1`
  if (!provider) return res.status(403).json({ error: 'Provider not found' })
  if (!provider.is_super_admin) return res.status(403).json({ error: 'Not available' })
  const practiceId = provider.practice_id as string
  const { id } = req.query as { id: string }
  if (!id) return res.status(400).json({ error: 'id required' })

  const body = req.body as { action?: string; note?: string; edited_payload?: unknown }
  const action = String(body?.action ?? '')
  const note = typeof body?.note === 'string' ? body.note.trim() || null : null

  if (action === 'approve') {
    // Side effect for 'payer_never_received': approve doubles as a
    // Fix+Resubmit on the underlying claim — same column writes as the
    // claims/[id].ts fix_resubmit path. The biller then sees the claim
    // under Ready for Biller and clicks Submit when ready. Sara 2026-11-17.
    const [item] = await sql`
      SELECT item_type, claim_id FROM review_queue_items
      WHERE id = ${id}::uuid AND practice_id = ${practiceId}::uuid AND status = 'open'
      LIMIT 1`
    if (item?.item_type === 'payer_never_received' && item?.claim_id) {
      try { await sql`ALTER TABLE claims ADD COLUMN IF NOT EXISTS reopened_at timestamptz` } catch {}
      try { await sql`ALTER TABLE claims ADD COLUMN IF NOT EXISTS reopened_by uuid` } catch {}
      try { await sql`ALTER TABLE claims ADD COLUMN IF NOT EXISTS reopen_reason text` } catch {}
      try { await sql`ALTER TABLE claims ADD COLUMN IF NOT EXISTS reopen_note text` } catch {}
      try { await sql`ALTER TABLE claims ADD COLUMN IF NOT EXISTS ready_for_biller_at timestamptz` } catch {}
      try { await sql`ALTER TABLE claims ADD COLUMN IF NOT EXISTS ready_for_biller_by text` } catch {}
      try { await sql`ALTER TABLE claims ADD COLUMN IF NOT EXISTS resubmission_log jsonb DEFAULT '[]'::jsonb` } catch {}

      const [existing] = await sql`
        SELECT resubmission_log, denial_codes, claim_rejection_at
        FROM claims WHERE id = ${item.claim_id}::uuid AND practice_id = ${practiceId}::uuid LIMIT 1`
      if (existing) {
        const prevLog: any[] = Array.isArray(existing.resubmission_log) ? existing.resubmission_log : []
        const entry = {
          at: new Date().toISOString(),
          by: provider.id,
          by_name: provider.name ?? 'Admin',
          note: note ?? 'Approved via billing agent — payer reported never received.',
          prior_denial_codes: existing.denial_codes ?? null,
          prior_claim_rejection_at: existing.claim_rejection_at ?? null,
          source: 'billing-agent-payer-never-received',
        }
        const nextLog = [...prevLog, entry]
        await sql`
          UPDATE claims SET
            denial_codes             = NULL,
            claim_rejection_at       = NULL,
            claim_rejection_response = NULL,
            claim_rejection_reasons  = NULL,
            submission_error         = NULL,
            status                   = 'pending_review',
            reopened_at              = NOW(),
            reopened_by              = ${provider.id}::uuid,
            reopen_reason            = 'payer_never_received',
            reopen_note              = ${note ?? 'Payer reported never received — resubmitting.'},
            ready_for_biller_at      = NOW(),
            ready_for_biller_by      = ${provider.name ?? 'Biller'},
            resubmission_log         = ${JSON.stringify(nextLog)}::jsonb,
            payer_status_bucket      = NULL,
            payer_status_category    = NULL,
            payer_status_code        = NULL,
            payer_status_message     = NULL,
            updated_at               = NOW()
          WHERE id = ${item.claim_id}::uuid AND practice_id = ${practiceId}::uuid`
      }
    }
    await sql`
      UPDATE review_queue_items
      SET status = 'approved', decided_at = NOW(),
          decided_by = ${provider.id}::uuid, decided_by_name = ${provider.name ?? 'Admin'},
          decision_note = ${note}
      WHERE id = ${id}::uuid AND practice_id = ${practiceId}::uuid AND status = 'open'`
    return res.status(200).json({ ok: true })
  }

  if (action === 'reject') {
    await sql`
      UPDATE review_queue_items
      SET status = 'rejected', decided_at = NOW(),
          decided_by = ${provider.id}::uuid, decided_by_name = ${provider.name ?? 'Admin'},
          decision_note = ${note}
      WHERE id = ${id}::uuid AND practice_id = ${practiceId}::uuid AND status = 'open'`
    return res.status(200).json({ ok: true })
  }

  if (action === 'edit') {
    // Store the biller's modified payload under proposed_change so a later
    // commit job can pick up the edited version instead of the original.
    const edited = body?.edited_payload
    if (edited == null) return res.status(400).json({ error: 'edited_payload required for edit action' })
    await sql`
      UPDATE review_queue_items
      SET status = 'edited', decided_at = NOW(),
          decided_by = ${provider.id}::uuid, decided_by_name = ${provider.name ?? 'Admin'},
          decision_note = ${note},
          proposed_change = ${JSON.stringify(edited)}::jsonb
      WHERE id = ${id}::uuid AND practice_id = ${practiceId}::uuid AND status = 'open'`
    return res.status(200).json({ ok: true })
  }

  return res.status(400).json({ error: 'action must be approve, edit, or reject' })
}
