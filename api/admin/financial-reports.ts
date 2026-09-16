import type { VercelRequest, VercelResponse } from '@vercel/node'
import { neon } from '@neondatabase/serverless'
import { createRemoteJWKSet, jwtVerify } from 'jose'

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

/**
 * GET /api/admin/financial-reports?start=YYYY-MM-DD&end=YYYY-MM-DD
 *
 * Bookkeeper Phase-1 report suite:
 *   1. AR aging — insurance
 *   2. AR aging — patient
 *   3. Cash collections
 *   4. Charges vs. collections
 *   5. Adjustments & write-offs
 *   6. Refunds / overpayments
 *
 * Admin-only. Returns everything for the given date window in one round-trip
 * so the UI can render all six sections without staggered spinners.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  let sub: string
  try { sub = await verifyProviderToken(req.headers.authorization) }
  catch { return res.status(401).json({ error: 'Unauthorized' }) }

  const q = req.query as { start?: string; end?: string }
  const endStr   = q.end   || new Date().toISOString().slice(0, 10)
  const startStr = q.start || new Date(new Date().setMonth(new Date().getMonth() - 3)).toISOString().slice(0, 10)

  try {
    const sql = neon(process.env.DATABASE_URL!)
    const [provider] = await sql`SELECT id, is_admin, practice_id FROM providers WHERE cognito_sub = ${sub} LIMIT 1`
    if (!provider) return res.status(403).json({ error: 'Provider not found' })
    if (!provider.is_admin) return res.status(403).json({ error: 'Admin access required' })

    const practiceId = provider.practice_id as string

    // ── 1. AR aging — insurance ────────────────────────────────────────────
    // Outstanding claims submitted to a payer where the payer has not yet
    // paid (no ERA received) and the claim isn't drafted / denied. Aging
    // measured from submitted_at (or created_at if the claim never went
    // out and is sitting in error).
    const arInsuranceRows = await sql`
      SELECT
        COALESCE(NULLIF(TRIM(payer_name), ''), 'Unknown payer') AS payer_name,
        SUM(CASE WHEN age_days BETWEEN 0  AND 30  THEN outstanding ELSE 0 END)::numeric(12,2) AS b_0_30,
        SUM(CASE WHEN age_days BETWEEN 31 AND 60  THEN outstanding ELSE 0 END)::numeric(12,2) AS b_31_60,
        SUM(CASE WHEN age_days BETWEEN 61 AND 90  THEN outstanding ELSE 0 END)::numeric(12,2) AS b_61_90,
        SUM(CASE WHEN age_days BETWEEN 91 AND 120 THEN outstanding ELSE 0 END)::numeric(12,2) AS b_91_120,
        SUM(CASE WHEN age_days > 120              THEN outstanding ELSE 0 END)::numeric(12,2) AS b_120_plus,
        SUM(outstanding)::numeric(12,2)                                                       AS total,
        COUNT(*)::int                                                                          AS claim_count
      FROM (
        SELECT
          cl.payer_name,
          COALESCE(cl.total_charge, 0)::numeric AS outstanding,
          EXTRACT(DAY FROM (NOW() - COALESCE(cl.submitted_at, cl.created_at)))::int AS age_days
        FROM claims cl
        WHERE cl.practice_id = ${practiceId}::uuid
          AND cl.status IN ('submitted', 'error', 'pending_review')
          AND cl.era_received_at IS NULL
          AND COALESCE(cl.total_charge, 0) > 0
      ) t
      GROUP BY payer_name
      ORDER BY total DESC
    `

    // ── 2. AR aging — patient ──────────────────────────────────────────────
    // Outstanding statements sent to families that haven't been paid or
    // voided. Aged from sent_at.
    const arPatientRows = await sql`
      SELECT
        COALESCE(NULLIF(TRIM(CONCAT(ps.patient_first_name, ' ', ps.patient_last_name)), ''), 'Unknown patient') AS patient_name,
        SUM(CASE WHEN age_days BETWEEN 0  AND 30  THEN outstanding ELSE 0 END)::numeric(12,2) AS b_0_30,
        SUM(CASE WHEN age_days BETWEEN 31 AND 60  THEN outstanding ELSE 0 END)::numeric(12,2) AS b_31_60,
        SUM(CASE WHEN age_days BETWEEN 61 AND 90  THEN outstanding ELSE 0 END)::numeric(12,2) AS b_61_90,
        SUM(CASE WHEN age_days BETWEEN 91 AND 120 THEN outstanding ELSE 0 END)::numeric(12,2) AS b_91_120,
        SUM(CASE WHEN age_days > 120              THEN outstanding ELSE 0 END)::numeric(12,2) AS b_120_plus,
        SUM(outstanding)::numeric(12,2)                                                       AS total,
        COUNT(*)::int                                                                          AS statement_count
      FROM (
        SELECT
          ps.patient_first_name,
          ps.patient_last_name,
          COALESCE(ps.total_amount_due, 0)::numeric AS outstanding,
          EXTRACT(DAY FROM (NOW() - COALESCE(ps.sent_at, ps.created_at)))::int AS age_days
        FROM patient_statements ps
        WHERE ps.practice_id = ${practiceId}::uuid
          AND ps.status = 'sent'
          AND COALESCE(ps.total_amount_due, 0) > 0
      ) ps
      GROUP BY patient_first_name, patient_last_name
      ORDER BY total DESC
    `

    // ── 3. Cash collections ────────────────────────────────────────────────
    // Payments received in the window: insurance (ERAs) + patient (paid
    // statements). Grouped by day so the UI can show a trend.
    const cashByDay = await sql`
      WITH ins AS (
        SELECT
          (era_received_at::date)::text AS day,
          SUM(COALESCE(insurance_payment_era, 0))::numeric(12,2) AS insurance_amount
        FROM claims
        WHERE practice_id = ${practiceId}::uuid
          AND era_received_at IS NOT NULL
          AND era_received_at::date BETWEEN ${startStr}::date AND ${endStr}::date
        GROUP BY day
      ),
      pat AS (
        SELECT
          (paid_at::date)::text AS day,
          SUM(COALESCE(paid_amount_cents, 0)::numeric / 100)::numeric(12,2) AS patient_amount
        FROM patient_statements
        WHERE practice_id = ${practiceId}::uuid
          AND status = 'paid'
          AND paid_at IS NOT NULL
          AND paid_at::date BETWEEN ${startStr}::date AND ${endStr}::date
        GROUP BY day
      )
      SELECT
        COALESCE(ins.day, pat.day) AS day,
        COALESCE(ins.insurance_amount, 0) AS insurance_amount,
        COALESCE(pat.patient_amount, 0)   AS patient_amount,
        (COALESCE(ins.insurance_amount, 0) + COALESCE(pat.patient_amount, 0))::numeric(12,2) AS total
      FROM ins FULL OUTER JOIN pat ON ins.day = pat.day
      ORDER BY day ASC
    `
    const cashTotals = await sql`
      SELECT
        COALESCE(SUM(COALESCE(cl.insurance_payment_era, 0)), 0)::numeric(12,2) AS insurance_total,
        (
          SELECT COALESCE(SUM(COALESCE(ps.paid_amount_cents, 0))::numeric / 100, 0)::numeric(12,2)
          FROM patient_statements ps
          WHERE ps.practice_id = ${practiceId}::uuid
            AND ps.status = 'paid'
            AND ps.paid_at IS NOT NULL
            AND ps.paid_at::date BETWEEN ${startStr}::date AND ${endStr}::date
        ) AS patient_total
      FROM claims cl
      WHERE cl.practice_id = ${practiceId}::uuid
        AND cl.era_received_at IS NOT NULL
        AND cl.era_received_at::date BETWEEN ${startStr}::date AND ${endStr}::date
    `

    // ── 4. Charges vs. collections ─────────────────────────────────────────
    // Every claim submitted in the window vs. every dollar collected in
    // the window. Ratio = collections / charges.
    const chargesVsColl = await sql`
      SELECT
        (
          SELECT COALESCE(SUM(COALESCE(total_charge, 0)), 0)::numeric(12,2)
          FROM claims
          WHERE practice_id = ${practiceId}::uuid
            AND submitted_at IS NOT NULL
            AND submitted_at::date BETWEEN ${startStr}::date AND ${endStr}::date
        ) AS charges,
        (
          SELECT COALESCE(SUM(COALESCE(insurance_payment_era, 0)), 0)::numeric(12,2)
          FROM claims
          WHERE practice_id = ${practiceId}::uuid
            AND era_received_at IS NOT NULL
            AND era_received_at::date BETWEEN ${startStr}::date AND ${endStr}::date
        ) AS insurance_collected,
        (
          SELECT COALESCE(SUM(COALESCE(paid_amount_cents, 0))::numeric / 100, 0)::numeric(12,2)
          FROM patient_statements
          WHERE practice_id = ${practiceId}::uuid
            AND status = 'paid'
            AND paid_at IS NOT NULL
            AND paid_at::date BETWEEN ${startStr}::date AND ${endStr}::date
        ) AS patient_collected
    `

    // ── 5. Adjustments & write-offs ────────────────────────────────────────
    // ERA contractual adjustments (payer discounts) + statements voided
    // with an outstanding balance (bad debt). Both are revenue leakage.
    const adjustments = await sql`
      SELECT
        (
          SELECT COALESCE(SUM(COALESCE(contractual_adjustment_era, 0)), 0)::numeric(12,2)
          FROM claims
          WHERE practice_id = ${practiceId}::uuid
            AND era_received_at IS NOT NULL
            AND era_received_at::date BETWEEN ${startStr}::date AND ${endStr}::date
        ) AS contractual_adjustments,
        (
          SELECT COALESCE(SUM(COALESCE(total_amount_due, 0)), 0)::numeric(12,2)
          FROM patient_statements
          WHERE practice_id = ${practiceId}::uuid
            AND status = 'void'
            AND updated_at::date BETWEEN ${startStr}::date AND ${endStr}::date
        ) AS write_offs,
        (
          SELECT COUNT(*)::int
          FROM patient_statements
          WHERE practice_id = ${practiceId}::uuid
            AND status = 'void'
            AND updated_at::date BETWEEN ${startStr}::date AND ${endStr}::date
        ) AS write_off_count
    `

    // Contractual adjustments broken down by payer — the biller uses this
    // to spot payers whose contracts are especially aggressive.
    const adjByPayer = await sql`
      SELECT
        COALESCE(NULLIF(TRIM(cl.payer_name), ''), 'Unknown payer') AS payer_name,
        SUM(COALESCE(cl.contractual_adjustment_era, 0))::numeric(12,2) AS contractual_adjustment,
        COUNT(*)::int AS claim_count
      FROM claims cl
      WHERE cl.practice_id = ${practiceId}::uuid
        AND cl.era_received_at IS NOT NULL
        AND cl.era_received_at::date BETWEEN ${startStr}::date AND ${endStr}::date
        AND COALESCE(cl.contractual_adjustment_era, 0) > 0
      GROUP BY payer_name
      ORDER BY contractual_adjustment DESC
    `

    // ── 6. Refunds / overpayments ──────────────────────────────────────────
    // Paid statements where the parent overpaid (paid > total_amount_due).
    // Rare but real — Square link paid a stale amount after a partial write-off.
    const refunds = await sql`
      SELECT
        ps.id                                    AS statement_id,
        ps.patient_first_name,
        ps.patient_last_name,
        ps.paid_at,
        ps.paid_amount_cents,
        ps.total_amount_due,
        ((COALESCE(ps.paid_amount_cents, 0)::numeric / 100) - COALESCE(ps.total_amount_due, 0))::numeric(12,2) AS overpayment
      FROM patient_statements ps
      WHERE ps.practice_id = ${practiceId}::uuid
        AND ps.status = 'paid'
        AND ps.paid_at IS NOT NULL
        AND ps.paid_at::date BETWEEN ${startStr}::date AND ${endStr}::date
        AND (ps.paid_amount_cents::numeric / 100) > COALESCE(ps.total_amount_due, 0)
      ORDER BY overpayment DESC
    `

    // ── 7. Payer mix ───────────────────────────────────────────────────────
    // What % of your claims (and charges) went to each payer in the window.
    // Uses service_date so a claim shows up in the month the visit actually
    // happened, regardless of when the biller submitted it.
    const payerMix = await sql`
      SELECT
        COALESCE(NULLIF(TRIM(payer_name), ''), 'Unknown / self-pay') AS payer_name,
        COUNT(*)::int AS claim_count,
        SUM(COALESCE(total_charge, 0))::numeric(12,2) AS total_charged,
        ROUND(COUNT(*)::numeric * 100 / NULLIF(SUM(COUNT(*)) OVER (), 0), 1) AS pct_of_claims,
        ROUND(SUM(COALESCE(total_charge, 0)) * 100 / NULLIF(SUM(SUM(COALESCE(total_charge, 0))) OVER (), 0), 1) AS pct_of_charges
      FROM claims
      WHERE practice_id = ${practiceId}::uuid
        AND service_date IS NOT NULL
        AND service_date BETWEEN ${startStr}::date AND ${endStr}::date
      GROUP BY payer_name
      ORDER BY claim_count DESC
    `

    // ── 8. Reimbursement by payer × visit type ─────────────────────────────
    // For claims where an ERA came back, what did each payer actually pay
    // for each visit type. The single most useful table for contract
    // negotiation — shows exactly which contracts are worst.
    const reimbByPayer = await sql`
      SELECT
        COALESCE(NULLIF(TRIM(cl.payer_name), ''), 'Unknown') AS payer_name,
        COALESCE(NULLIF(TRIM(a.visit_type), ''), 'Unspecified') AS visit_type,
        COUNT(*)::int AS claim_count,
        AVG(COALESCE(cl.total_charge, 0))::numeric(12,2) AS avg_charged,
        AVG(COALESCE(cl.insurance_payment_era, 0))::numeric(12,2) AS avg_paid,
        AVG(COALESCE(cl.contractual_adjustment_era, 0))::numeric(12,2) AS avg_adjustment,
        CASE WHEN AVG(COALESCE(cl.total_charge, 0)) > 0
             THEN ROUND(AVG(COALESCE(cl.insurance_payment_era, 0)) * 100 / AVG(COALESCE(cl.total_charge, 0)), 1)
             ELSE 0 END AS payment_pct
      FROM claims cl
      LEFT JOIN appointments a ON a.id = cl.appointment_id
      WHERE cl.practice_id = ${practiceId}::uuid
        AND cl.era_received_at IS NOT NULL
        AND cl.era_received_at::date BETWEEN ${startStr}::date AND ${endStr}::date
      GROUP BY payer_name, visit_type
      ORDER BY payer_name ASC, claim_count DESC
    `

    // ── 9. Denial / rejection rate by payer ────────────────────────────────
    // How often each payer denies or errors out a claim. Uses submission
    // date so a claim submitted in the window counts here even if the ERA
    // comes back later.
    const denialByPayer = await sql`
      SELECT
        COALESCE(NULLIF(TRIM(payer_name), ''), 'Unknown') AS payer_name,
        COUNT(*)::int AS total_submitted,
        SUM(CASE WHEN status = 'error'           THEN 1 ELSE 0 END)::int AS error_count,
        SUM(CASE WHEN status = 'denied'          THEN 1 ELSE 0 END)::int AS denied_count,
        SUM(CASE WHEN era_received_at IS NOT NULL
                  AND COALESCE(insurance_payment_era, 0) = 0
                  AND COALESCE(contractual_adjustment_era, 0) = 0
                 THEN 1 ELSE 0 END)::int AS zero_pay_count,
        SUM(CASE WHEN status = 'paid'
                   OR (era_received_at IS NOT NULL AND COALESCE(insurance_payment_era, 0) > 0)
                 THEN 1 ELSE 0 END)::int AS paid_count,
        ROUND(
          (SUM(CASE WHEN status IN ('error', 'denied') THEN 1 ELSE 0 END) +
           SUM(CASE WHEN era_received_at IS NOT NULL
                     AND COALESCE(insurance_payment_era, 0) = 0
                     AND COALESCE(contractual_adjustment_era, 0) = 0
                    THEN 1 ELSE 0 END))::numeric * 100 / NULLIF(COUNT(*), 0),
          1
        ) AS denial_rate_pct
      FROM claims
      WHERE practice_id = ${practiceId}::uuid
        AND submitted_at IS NOT NULL
        AND submitted_at::date BETWEEN ${startStr}::date AND ${endStr}::date
      GROUP BY payer_name
      ORDER BY total_submitted DESC
    `

    return res.status(200).json({
      window: { start: startStr, end: endStr },
      ar_insurance: arInsuranceRows,
      ar_patient: arPatientRows,
      cash_by_day: cashByDay,
      cash_totals: cashTotals[0] ?? { insurance_total: 0, patient_total: 0 },
      charges_vs_collections: chargesVsColl[0] ?? { charges: 0, insurance_collected: 0, patient_collected: 0 },
      adjustments: adjustments[0] ?? { contractual_adjustments: 0, write_offs: 0, write_off_count: 0 },
      adjustments_by_payer: adjByPayer,
      refunds,
      payer_mix: payerMix,
      reimbursement_by_payer: reimbByPayer,
      denials_by_payer: denialByPayer,
    })
  } catch (e: any) {
    console.error('admin/financial-reports error:', e)
    return res.status(500).json({ error: e.message ?? 'Internal server error' })
  }
}
