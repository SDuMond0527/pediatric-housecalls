import type { VercelRequest, VercelResponse } from '@vercel/node'
import { neon } from '@neondatabase/serverless'
import { createRemoteJWKSet, jwtVerify } from 'jose'

// GET  /api/admin/convenience-fees          → list all CV charge rows
// GET  /api/admin/convenience-fees?status=X → filter by status
// PATCH /api/admin/convenience-fees?id=X    → update row (Pam marks charged,
//                                             edits notes, reverses, etc.)
//
// Phase 1 (ships 2026-10-07): populated by claim-gen hook, no Square calls
// yet. Pam uses this page to tick off manually-charged rows + leave notes.
// Phase 2 adds auto-charge pipeline (direct card / payment link).

async function verifyAdminToken(authHeader: string | undefined): Promise<string> {
  if (!authHeader?.startsWith('Bearer ')) throw new Error('Missing token')
  const token = authHeader.slice(7)
  const region = process.env.VITE_AWS_REGION || 'us-east-2'
  const userPoolId = process.env.VITE_AWS_USER_POOL_ID || ''
  const JWKS = createRemoteJWKSet(new URL(`https://cognito-idp.${region}.amazonaws.com/${userPoolId}/.well-known/jwks.json`))
  const { payload } = await jwtVerify(token, JWKS, { issuer: `https://cognito-idp.${region}.amazonaws.com/${userPoolId}` })
  if (!payload.sub) throw new Error('No sub')
  return payload.sub as string
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  let sub: string
  try { sub = await verifyAdminToken(req.headers.authorization) }
  catch (e: any) { return res.status(401).json({ error: e?.message || 'Unauthorized' }) }

  const sql = neon(process.env.DATABASE_URL!)

  // Resolve the admin's practice. Mirror of other admin endpoints.
  const [profile] = await sql`SELECT practice_id FROM providers WHERE cognito_sub = ${sub} LIMIT 1`
  const practiceId = (profile as any)?.practice_id
  if (!practiceId) return res.status(403).json({ error: 'No practice associated with this account' })

  if (req.method === 'GET') {
    const { status, from, to } = req.query as Record<string, string>
    try {
      let rows: any[]
      if (status && from && to) {
        rows = await sql`
          SELECT * FROM convenience_fee_charges
          WHERE practice_id = ${practiceId}::uuid
            AND status = ${status}
            AND service_date >= ${from}::date
            AND service_date <= ${to}::date
          ORDER BY service_date DESC, created_at DESC`
      } else if (status) {
        rows = await sql`
          SELECT * FROM convenience_fee_charges
          WHERE practice_id = ${practiceId}::uuid
            AND status = ${status}
          ORDER BY service_date DESC, created_at DESC`
      } else {
        rows = await sql`
          SELECT * FROM convenience_fee_charges
          WHERE practice_id = ${practiceId}::uuid
          ORDER BY service_date DESC, created_at DESC`
      }
      return res.json(rows)
    } catch (e: any) {
      console.error('[convenience-fees GET] error:', e?.message)
      return res.status(500).json({ error: e?.message ?? 'Failed to load CV charges' })
    }
  }

  if (req.method === 'PATCH') {
    const { id } = req.query as Record<string, string>
    if (!id) return res.status(400).json({ error: 'id required' })
    const fields = (req.body ?? {}) as Record<string, any>

    // Who's taking the action? Snapshot their name for the audit log.
    const [actor] = await sql`SELECT name FROM providers WHERE cognito_sub = ${sub} LIMIT 1`
    const actorName = (actor as any)?.name ?? 'admin'

    try {
      // Pam-editable fields:
      // - status: 'manually_charged' | 'reversed'  (she can mark done or undo)
      // - pam_notes: free text, timestamped on save
      // - reversed_by / reversal_reason: set together with status=reversed
      const allowedStatuses = new Set(['pending', 'manually_charged', 'reversed'])

      if (fields.status != null) {
        if (!allowedStatuses.has(fields.status)) {
          return res.status(400).json({ error: `status must be one of ${[...allowedStatuses].join(', ')}` })
        }
        if (fields.status === 'manually_charged') {
          await sql`
            UPDATE convenience_fee_charges
            SET status = 'manually_charged',
                charged_at = COALESCE(charged_at, NOW()),
                updated_at = NOW()
            WHERE id = ${id}::uuid AND practice_id = ${practiceId}::uuid`
        } else if (fields.status === 'reversed') {
          await sql`
            UPDATE convenience_fee_charges
            SET status = 'reversed',
                reversed_at = NOW(),
                reversed_by = ${actorName},
                reversal_reason = ${fields.reversal_reason ?? null},
                updated_at = NOW()
            WHERE id = ${id}::uuid AND practice_id = ${practiceId}::uuid`
        } else {
          // Revert to pending (undo a manual mark)
          await sql`
            UPDATE convenience_fee_charges
            SET status = 'pending',
                charged_at = NULL,
                updated_at = NOW()
            WHERE id = ${id}::uuid AND practice_id = ${practiceId}::uuid`
        }
      }

      if (fields.pam_notes != null) {
        await sql`
          UPDATE convenience_fee_charges
          SET pam_notes = ${fields.pam_notes},
              pam_notes_updated_at = NOW(),
              pam_notes_updated_by = ${actorName},
              updated_at = NOW()
          WHERE id = ${id}::uuid AND practice_id = ${practiceId}::uuid`
      }

      const [updated] = await sql`SELECT * FROM convenience_fee_charges WHERE id = ${id}::uuid AND practice_id = ${practiceId}::uuid`
      return res.json(updated)
    } catch (e: any) {
      console.error('[convenience-fees PATCH] error:', e?.message)
      return res.status(500).json({ error: e?.message ?? 'Failed to update CV charge' })
    }
  }

  return res.status(405).json({ error: 'Method not allowed' })
}
