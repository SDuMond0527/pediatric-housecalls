import type { VercelRequest, VercelResponse } from '@vercel/node'
import { neon } from '@neondatabase/serverless'

/**
 * GET /api/cron/drain-pending-cv-charges
 *
 * Runs every minute via Vercel cron. Picks up any convenience_fee_charges
 * row with status='pending' and a card on file, fires a Square direct
 * charge against it, updates status to 'auto_charged' with square_payment_id
 * (or 'failed' with failure_reason).
 *
 * This is the safety net for the inline auto-charge path in
 * api/encounter-notes/[id].ts — the inline path can silently fail
 * (Google Maps timeout, Square transient error, serverless timeout
 * before Square call completes) and the row either doesn't exist or
 * stays 'pending' forever. The cron catches both: for rows that exist
 * but never got charged, it fires here. Sara shouldn't have to click
 * "Charge card now" for every missed charge. Shipped 2026-10-08 after
 * Ramsay Schrum sign-time auto-charge went silent.
 */

const SQUARE_ACCESS_TOKEN = process.env.SQUARE_ACCESS_TOKEN || ''
const SQUARE_ENV          = (process.env.SQUARE_ENVIRONMENT || 'production').toLowerCase()
const SQUARE_API_BASE     = SQUARE_ENV === 'sandbox'
  ? 'https://connect.squareupsandbox.com'
  : 'https://connect.squareup.com'
const MAX_AUTO_CHARGE_CENTS = 30000
const BATCH_PER_RUN = 25

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Vercel cron requests include a specific authorization header. If
  // CRON_SECRET is configured, enforce it so the endpoint isn't publicly
  // triggerable. If not configured, allow any GET for backward compat
  // with other crons in this project that follow the same pattern.
  const expected = process.env.CRON_SECRET || ''
  if (expected) {
    const header = String(req.headers.authorization ?? '')
    if (header !== `Bearer ${expected}`) {
      return res.status(401).json({ error: 'Unauthorized' })
    }
  }

  if (!SQUARE_ACCESS_TOKEN) {
    return res.status(500).json({ error: 'SQUARE_ACCESS_TOKEN not configured' })
  }

  const sql = neon(process.env.DATABASE_URL!)

  // Pull the oldest N pending rows that have a card on file. Rows that
  // don't have a card are left pending for Pam to send a payment link
  // (handled by a separate link-send pipeline, not this cron).
  const rows = await sql`
    SELECT cv.id, cv.claim_id, cv.amount_cents, cv.service_date, cv.cv_code,
           cv.patient_name, cv.practice_id,
           c.patient_first_name, c.patient_last_name,
           ch.family_id,
           fp.square_customer_id, fp.square_card_id, fp.email
    FROM convenience_fee_charges cv
    LEFT JOIN claims c            ON c.id = cv.claim_id
    LEFT JOIN children ch         ON ch.id = c.child_id
    LEFT JOIN family_profiles fp  ON fp.id = ch.family_id
    WHERE cv.status = 'pending'
      AND cv.failed_at IS NULL
      AND fp.square_customer_id IS NOT NULL
      AND fp.square_card_id IS NOT NULL
      AND cv.amount_cents > 0
      AND cv.amount_cents <= ${MAX_AUTO_CHARGE_CENTS}
    ORDER BY cv.created_at ASC
    LIMIT ${BATCH_PER_RUN}
  `

  const results: Array<{ cv_id: string; outcome: string; detail?: string }> = []

  for (const row of rows) {
    const cvId = (row as any).id as string
    const amt  = Number((row as any).amount_cents)
    const first = String((row as any).patient_first_name ?? '').trim() || 'your child'
    const dosStr = String((row as any).service_date).slice(0, 10)
    const dosDisplay = (() => {
      try { const d = new Date(dosStr); return `${d.getMonth()+1}/${d.getDate()}/${d.getFullYear()}` }
      catch { return dosStr }
    })()
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
          idempotency_key: `cv_charge_${cvId}`,
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
          SET failure_reason = ${String(errMsg).slice(0, 500)},
              failed_at = NOW(),
              updated_at = NOW()
          WHERE id = ${cvId}::uuid`
        results.push({ cv_id: cvId, outcome: 'square_error', detail: errMsg })
        continue
      }
      const paymentId = payJson?.payment?.id
      if (!paymentId) {
        results.push({ cv_id: cvId, outcome: 'no_payment_id' })
        continue
      }
      await sql`
        UPDATE convenience_fee_charges
        SET status = 'auto_charged',
            charged_at = NOW(),
            square_payment_id = ${paymentId},
            updated_at = NOW()
        WHERE id = ${cvId}::uuid`
      results.push({ cv_id: cvId, outcome: 'auto_charged', detail: paymentId })
    } catch (e: any) {
      const errMsg = e?.message ?? 'cron Square call threw'
      await sql`
        UPDATE convenience_fee_charges
        SET failure_reason = ${String(errMsg).slice(0, 500)},
            failed_at = NOW(),
            updated_at = NOW()
        WHERE id = ${cvId}::uuid`
      results.push({ cv_id: cvId, outcome: 'exception', detail: errMsg })
    }
  }

  return res.status(200).json({
    ok: true,
    scanned: rows.length,
    results,
    charged: results.filter(r => r.outcome === 'auto_charged').length,
  })
}
