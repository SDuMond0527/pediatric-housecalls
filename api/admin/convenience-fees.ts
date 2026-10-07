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

  // POST /api/admin/convenience-fees?id=<cv_row_id>&action=auto-charge
  //
  // Fires a Square direct charge against the family's card on file for
  // a specific convenience_fee_charges row. Mirrors the sign-time
  // auto-charge path in api/encounter-notes/[id].ts, exposed on demand
  // for pre-cutover rows and retry-after-failure cases. Idempotent via
  // Square's idempotency_key = `cv_charge_${rowId}`.
  //
  // Lives on this file (not a nested /auto-charge.ts) because Vercel's
  // file-based routing collides when both api/admin/convenience-fees.ts
  // and api/admin/convenience-fees/[id]/*.ts exist. The .ts file wins
  // and returns 405 for POST on nested paths. Sara 2026-10-07.
  if (req.method === 'POST') {
    const { id, action } = req.query as Record<string, string>
    if (action !== 'auto-charge') {
      return res.status(400).json({ error: 'Supported action: auto-charge' })
    }
    if (!id) return res.status(400).json({ error: 'id required' })

    const SQUARE_ACCESS_TOKEN = process.env.SQUARE_ACCESS_TOKEN || ''
    if (!SQUARE_ACCESS_TOKEN) return res.status(500).json({ error: 'SQUARE_ACCESS_TOKEN not configured' })

    const SQUARE_ENV = (process.env.SQUARE_ENVIRONMENT || 'production').toLowerCase()
    const SQUARE_API_BASE = SQUARE_ENV === 'sandbox'
      ? 'https://connect.squareupsandbox.com'
      : 'https://connect.squareup.com'
    const MAX_AUTO_CHARGE_CENTS = 30000

    const [actor] = await sql`SELECT name, is_admin FROM providers WHERE cognito_sub = ${sub} LIMIT 1`
    if (!(actor as any)?.is_admin) return res.status(403).json({ error: 'Admin only' })

    const [row] = await sql`
      SELECT cv.id, cv.claim_id, cv.amount_cents, cv.status, cv.service_date,
             cv.cv_code, cv.patient_name,
             c.patient_first_name,
             ch.family_id,
             fp.square_customer_id, fp.square_card_id, fp.email
      FROM convenience_fee_charges cv
      LEFT JOIN claims c ON c.id = cv.claim_id
      LEFT JOIN children ch ON ch.id = c.child_id
      LEFT JOIN family_profiles fp ON fp.id = ch.family_id
      WHERE cv.id = ${id}::uuid AND cv.practice_id = ${practiceId}::uuid
      LIMIT 1`
    if (!row) return res.status(404).json({ error: 'Convenience fee row not found' })

    if (['auto_charged', 'manually_charged', 'paid_via_link'].includes((row as any).status)) {
      return res.status(409).json({ error: `Already ${(row as any).status}.` })
    }
    if ((row as any).status === 'reversed') {
      return res.status(409).json({ error: 'This fee has been reversed.' })
    }
    const amt = Number((row as any).amount_cents)
    if (!amt || amt <= 0) return res.status(400).json({ error: 'Invalid amount on row.' })
    if (amt > MAX_AUTO_CHARGE_CENTS) {
      return res.status(400).json({ error: `Amount $${(amt/100).toFixed(2)} exceeds safety cap of $${(MAX_AUTO_CHARGE_CENTS/100).toFixed(0)}. Charge manually in Square and click "Mark charged".` })
    }
    if (!(row as any).square_customer_id || !(row as any).square_card_id) {
      return res.status(400).json({ error: 'No Square card on file for this family. Charge manually in Square and click "Mark charged".' })
    }

    const first = String((row as any).patient_first_name ?? '').trim() || 'your child'
    const dosStr = String((row as any).service_date).slice(0, 10)
    const dosDisplay = (() => { try { const d = new Date(dosStr); return `${d.getMonth()+1}/${d.getDate()}/${d.getFullYear()}` } catch { return dosStr } })()
    const practiceName = process.env.PRACTICE_NAME || 'Pediatric House Calls'
    const chargeNote = `${practiceName} — in-home visit convenience fee for ${first} on ${dosDisplay}. Thank you so much for allowing us to care for your child!`

    try {
      const payRes = await fetch(`${SQUARE_API_BASE}/v2/payments`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${SQUARE_ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
          'Square-Version': '2024-10-17',
        },
        body: JSON.stringify({
          idempotency_key: `cv_charge_${(row as any).id}`,
          amount_money: { amount: amt, currency: 'USD' },
          source_id: (row as any).square_card_id,
          customer_id: (row as any).square_customer_id,
          buyer_email_address: (row as any).email ?? undefined,
          note: chargeNote,
        }),
      })
      const payText = await payRes.text()
      let payJson: any
      try { payJson = JSON.parse(payText) } catch { payJson = { raw: payText } }
      if (!payRes.ok) {
        const errMsg = payJson?.errors?.[0]?.detail ?? payJson?.message ?? `Square HTTP ${payRes.status}`
        await sql`
          UPDATE convenience_fee_charges
          SET failure_reason = ${errMsg}, failed_at = NOW(), updated_at = NOW()
          WHERE id = ${(row as any).id}::uuid`
        return res.status(500).json({ error: errMsg })
      }
      const paymentId = payJson?.payment?.id
      if (!paymentId) {
        return res.status(500).json({ error: 'Square accepted but no payment id returned', body: payJson })
      }
      await sql`
        UPDATE convenience_fee_charges
        SET status = 'auto_charged',
            charged_at = NOW(),
            square_payment_id = ${paymentId},
            updated_at = NOW()
        WHERE id = ${(row as any).id}::uuid`
      return res.status(200).json({ ok: true, square_payment_id: paymentId, amount_cents: amt })
    } catch (e: any) {
      const errMsg = e?.message ?? 'Square charge threw'
      await sql`
        UPDATE convenience_fee_charges
        SET failure_reason = ${errMsg}, failed_at = NOW(), updated_at = NOW()
        WHERE id = ${(row as any).id}::uuid`
      return res.status(500).json({ error: errMsg })
    }
  }

  return res.status(405).json({ error: 'Method not allowed' })
}
