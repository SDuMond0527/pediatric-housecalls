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

  // ─── Step 0: find orphan claims and create missing CV rows ──────────
  // Scans for claims that have a CV CPT code on them but no corresponding
  // convenience_fee_charges row. This recovers the case where the inline
  // sign-time path threw BEFORE the INSERT (the Ramsay Schrum failure
  // mode 2026-10-08). Caps at 50 orphans per minute to bound work.
  const orphans = await sql`
    SELECT c.id              AS claim_id,
           c.practice_id,
           c.appointment_id,
           c.service_date,
           c.patient_first_name,
           c.patient_last_name,
           c.cpt_codes,
           p.name            AS provider_name
    FROM claims c
    LEFT JOIN providers p ON p.id = c.provider_id
    WHERE c.service_date >= '2026-10-07'
      AND c.cpt_codes IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM jsonb_array_elements(c.cpt_codes) AS line
        WHERE line->>'category' = 'Non-Covered Services'
          AND (line->>'code' LIKE 'CV%' OR line->>'code' LIKE 'VACV%')
      )
      AND NOT EXISTS (
        SELECT 1 FROM convenience_fee_charges cv WHERE cv.claim_id = c.id
      )
    ORDER BY c.service_date DESC, c.created_at DESC
    LIMIT 50
  `
  const orphanCreated: Array<{ claim_id: string; cv_id: string; cv_code: string; amount_cents: number }> = []
  for (const row of orphans) {
    const claimId   = (row as any).claim_id as string
    const practiceId = (row as any).practice_id as string
    const apptId   = (row as any).appointment_id as string | null
    const serviceDate = String((row as any).service_date).slice(0, 10)
    const patientName = [(row as any).patient_first_name, (row as any).patient_last_name].filter(Boolean).join(' ') || null
    const providerName = (row as any).provider_name as string | null
    const cpts: any[] = Array.isArray((row as any).cpt_codes) ? (row as any).cpt_codes : []
    const cvLine = cpts.find((l: any) => l?.category === 'Non-Covered Services' && (String(l?.code ?? '').startsWith('CV') || String(l?.code ?? '').startsWith('VACV')))
    if (!cvLine) continue
    const code = String(cvLine.code)
    const chargeDollars = parseFloat(String(cvLine.charge_amount ?? '0')) || 0
    const amountCents = Math.round(chargeDollars * 100) || 5000 // $50 CV1 fallback
    try {
      const [ins] = await sql`
        INSERT INTO convenience_fee_charges (
          practice_id, appointment_id, claim_id,
          patient_name, provider_name, service_date,
          cv_code, amount_cents, status
        ) VALUES (
          ${practiceId}::uuid, ${apptId ? apptId : null}::uuid, ${claimId}::uuid,
          ${patientName}, ${providerName}, ${serviceDate}::date,
          ${code}, ${amountCents}, 'pending'
        )
        RETURNING id`
      orphanCreated.push({ claim_id: claimId, cv_id: (ins as any).id, cv_code: code, amount_cents: amountCents })
    } catch (e: any) {
      console.error('[cv-cron] orphan backfill INSERT failed for claim', claimId, e?.message)
    }
  }

  // Bootstrap retry counter column so stuck-on-failed rows aren't orphaned
  // forever. 3 attempts total with a 10-minute cooldown between retries.
  // Added 2026-10-08 after Ramsay's row stayed failed until I noticed.
  try { await sql`ALTER TABLE convenience_fee_charges ADD COLUMN IF NOT EXISTS charge_attempts int NOT NULL DEFAULT 0` } catch {}
  const MAX_ATTEMPTS = 3
  const RETRY_COOLDOWN_MINUTES = 10

  // Pull the oldest N rows eligible for a charge attempt:
  //   - status='pending' with no prior failure, OR
  //   - status='pending' with a prior failure that's cooled down and
  //     still under the attempt cap.
  // Rows without a card on file are left for Pam's payment-link flow.
  const rows = await sql`
    SELECT cv.id, cv.claim_id, cv.amount_cents, cv.service_date, cv.cv_code,
           cv.patient_name, cv.practice_id, cv.charge_attempts,
           c.patient_first_name, c.patient_last_name,
           ch.family_id,
           fp.square_customer_id, fp.square_card_id, fp.email
    FROM convenience_fee_charges cv
    LEFT JOIN claims c            ON c.id = cv.claim_id
    LEFT JOIN children ch         ON ch.id = c.child_id
    LEFT JOIN family_profiles fp  ON fp.id = ch.family_id
    WHERE cv.status = 'pending'
      AND fp.square_customer_id IS NOT NULL
      AND fp.square_card_id IS NOT NULL
      AND cv.amount_cents > 0
      AND cv.amount_cents <= ${MAX_AUTO_CHARGE_CENTS}
      AND cv.charge_attempts < ${MAX_ATTEMPTS}
      AND (
        cv.failed_at IS NULL
        OR cv.failed_at < NOW() - (${RETRY_COOLDOWN_MINUTES} || ' minutes')::interval
      )
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
    // Square's /v2/payments.note has a 45-char cap — bypassed yesterday
    // on Mackenzie, caught today on Ramsay. See encounter-notes/[id].ts.
    const chargeNote = `In-home CV fee ${first} ${dosDisplay}`.slice(0, 45)

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
          SET failure_reason   = ${String(errMsg).slice(0, 500)},
              failed_at        = NOW(),
              charge_attempts  = charge_attempts + 1,
              updated_at       = NOW()
          WHERE id = ${cvId}::uuid`
        results.push({ cv_id: cvId, outcome: 'square_error', detail: errMsg })
        continue
      }
      const paymentId = payJson?.payment?.id
      if (!paymentId) {
        await sql`UPDATE convenience_fee_charges SET charge_attempts = charge_attempts + 1, updated_at = NOW() WHERE id = ${cvId}::uuid`
        results.push({ cv_id: cvId, outcome: 'no_payment_id' })
        continue
      }
      await sql`
        UPDATE convenience_fee_charges
        SET status            = 'auto_charged',
            charged_at        = NOW(),
            square_payment_id = ${paymentId},
            failed_at         = NULL,
            failure_reason    = NULL,
            charge_attempts   = charge_attempts + 1,
            updated_at        = NOW()
        WHERE id = ${cvId}::uuid`
      results.push({ cv_id: cvId, outcome: 'auto_charged', detail: paymentId })
    } catch (e: any) {
      const errMsg = e?.message ?? 'cron Square call threw'
      await sql`
        UPDATE convenience_fee_charges
        SET failure_reason   = ${String(errMsg).slice(0, 500)},
            failed_at        = NOW(),
            charge_attempts  = charge_attempts + 1,
            updated_at       = NOW()
        WHERE id = ${cvId}::uuid`
      results.push({ cv_id: cvId, outcome: 'exception', detail: errMsg })
    }
  }

  return res.status(200).json({
    ok: true,
    orphans_backfilled: orphanCreated.length,
    orphan_detail: orphanCreated,
    scanned: rows.length,
    results,
    charged: results.filter(r => r.outcome === 'auto_charged').length,
  })
}
