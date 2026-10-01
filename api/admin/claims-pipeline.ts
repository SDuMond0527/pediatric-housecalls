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
 * GET /api/admin/claims-pipeline?range=this_month|last_90|last_6mo
 *
 * One row per claim with a derived pipeline status. Scoped to the
 * caller's practice_id so a PHC admin never sees GoRoam claims
 * (and vice-versa). Filtered by DATE OF SERVICE (service_date), not
 * payment date, per Sara's spec.
 *
 * Derived status (one of):
 *   not_yet_sent  — no submitted_at (visit charged but claim not out yet)
 *   rejected      — claim_rejection_at set (277 CA from clearinghouse)
 *   sent_waiting  — submitted_at set, no ERA, no 277 rejection
 *   paid          — ERA back, insurance_payment > 0, no actionable denial
 *   denied        — ERA back AND (insurance_payment = 0 OR actionable denial)
 *
 * The "accepted" status in Sara's spec (payer ack'd, not paid) is folded
 * into sent_waiting for v1 — we don't yet parse 277 CA ACK payloads
 * distinctly from rejections.
 *
 * Returns everything needed for the three UI sections:
 *   follow_the_money  — practice-wide totals
 *   by_status         — one row per status with totals + oldest age
 *   aging_buckets     — for unpaid-insurance claims only
 *   action_items      — individual claims the biller needs to touch
 *
 * Sara 2026-10-01.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  let sub: string
  try { sub = await verifyProviderToken(req.headers.authorization) }
  catch { return res.status(401).json({ error: 'Unauthorized' }) }

  const sql = neon(process.env.DATABASE_URL!)
  const [provider] = await sql`SELECT id, is_admin, practice_id FROM providers WHERE cognito_sub = ${sub} LIMIT 1`
  if (!provider) return res.status(403).json({ error: 'Provider not found' })
  if (!provider.is_admin) return res.status(403).json({ error: 'Admin only' })
  const practiceId = provider.practice_id as string

  const range = String(req.query.range ?? 'this_month') as 'this_month' | 'last_90' | 'last_6mo'
  // All ranges are computed relative to today. Date math in SQL so DST
  // / timezone issues don't drift the boundary.
  const rangeClause = range === 'last_90'
    ? sql`AND cl.service_date >= (CURRENT_DATE - INTERVAL '90 days')`
    : range === 'last_6mo'
      ? sql`AND cl.service_date >= (CURRENT_DATE - INTERVAL '6 months')`
      : sql`AND cl.service_date >= DATE_TRUNC('month', CURRENT_DATE)`

  // Pull every claim in the window with the derivation fields + sum of
  // paid patient-statement cents (what families have actually paid us).
  const rows = await sql`
    SELECT
      cl.id,
      cl.service_date::text AS service_date,
      cl.submitted_at,
      cl.era_received_at,
      cl.claim_rejection_at,
      cl.claim_rejection_reasons,
      cl.denial_codes,
      cl.status                                     AS db_status,
      COALESCE(cl.total_charge, 0)::numeric        AS billed,
      COALESCE(cl.insurance_payment_era, 0)::numeric AS insurance_paid,
      COALESCE(cl.patient_deductible_era, 0)::numeric
        + COALESCE(cl.patient_coinsurance_era, 0)::numeric
        + COALESCE(cl.patient_copay_era, 0)::numeric
        + COALESCE(cl.patient_non_covered_era, 0)::numeric AS patient_responsibility,
      cl.patient_first_name,
      cl.patient_last_name,
      cl.payer_name,
      COALESCE(p.name, '—') AS rendering_provider_name,
      ps.paid_cents                                 AS statement_paid_cents,
      ps.total_due                                  AS statement_total_due,
      ps.statement_status                           AS statement_status
    FROM claims cl
    LEFT JOIN providers p ON p.id = cl.provider_id
    LEFT JOIN LATERAL (
      SELECT
        SUM(COALESCE(paid_amount_cents, 0)) AS paid_cents,
        SUM(COALESCE(total_amount_due, 0))  AS total_due,
        MAX(status)                          AS statement_status
      FROM patient_statements WHERE claim_id = cl.id
    ) ps ON true
    WHERE cl.practice_id = ${practiceId}::uuid
      AND cl.status != 'written_off'
      ${rangeClause}
    ORDER BY cl.service_date ASC, cl.created_at ASC`

  type ClaimRow = {
    id: string
    service_date: string
    submitted_at: string | null
    era_received_at: string | null
    claim_rejection_at: string | null
    claim_rejection_reasons: any
    denial_codes: any
    db_status: string
    billed: string
    insurance_paid: string
    patient_responsibility: string
    patient_first_name: string | null
    patient_last_name: string | null
    payer_name: string | null
    rendering_provider_name: string
    statement_paid_cents: string | null
    statement_total_due: string | null
    statement_status: string | null
  }

  // Known-actionable CARC reason codes — see src/lib/carcCodes.ts
  // category: 'denial'. Trimmed to the ones we actually track; a code
  // not on this list might still be a denial but we treat it as "paid"
  // if insurance_paid > 0, which is the common healthy case.
  const DENIAL_CARC = new Set([
    '11','16','18','22','27','29','31','39','50','96','109','119','167','197','198','204',
  ])
  function hasActionableDenial(denialCodes: any): boolean {
    if (!Array.isArray(denialCodes)) return false
    return denialCodes.some((d: any) => DENIAL_CARC.has(String(d?.reason_code ?? '')))
  }

  function derivePipelineStatus(r: ClaimRow): string {
    if (r.claim_rejection_at) return 'rejected'
    if (!r.submitted_at) return 'not_yet_sent'
    if (!r.era_received_at) return 'sent_waiting'
    if (hasActionableDenial(r.denial_codes)) return 'denied'
    if (Number(r.insurance_paid) > 0) return 'paid'
    // ERA back but $0 and no actionable denial — treat as denied
    // (payer applied everything to patient without paying).
    return 'denied'
  }

  // Plain-English reason: for rejected pull from claim_rejection_reasons;
  // for denied pull the first denial code + CARC description.
  const CARC_DESC: Record<string, string> = {
    '11': 'Diagnosis inconsistent with procedure',
    '16': 'Claim lacks information / billing errors',
    '18': 'Duplicate claim',
    '22': 'Covered by another payer (COB)',
    '27': 'Expenses incurred after coverage terminated',
    '29': 'Timely filing expired',
    '31': 'Patient not our insured',
    '39': 'Services denied at auth / precert request',
    '50': 'Not medically necessary per payer',
    '96': 'Non-covered charges',
    '109': 'Claim not covered by this payer — send to correct payer',
    '119': 'Benefit maximum reached',
    '167': 'Diagnosis not covered',
    '197': 'Precertification / authorization absent',
    '198': 'Precertification / authorization exceeded',
    '204': 'Not covered under patient’s current benefit plan',
    '45': 'Charges exceed fee schedule',
    '252': 'Attachment / documentation required',
    '1':  'Patient deductible',
    '2':  'Patient coinsurance',
    '3':  'Patient copay',
  }
  function derivePlainReason(r: ClaimRow, status: string): { code: string | null; label: string | null } {
    if (status === 'rejected' && Array.isArray(r.claim_rejection_reasons) && r.claim_rejection_reasons.length) {
      const first = r.claim_rejection_reasons[0]
      return { code: String(first?.code ?? ''), label: String(first?.description ?? first?.reason ?? '') || null }
    }
    if (status === 'denied' && Array.isArray(r.denial_codes) && r.denial_codes.length) {
      const action = r.denial_codes.find((d: any) => DENIAL_CARC.has(String(d?.reason_code ?? ''))) ?? r.denial_codes[0]
      const code = String(action?.reason_code ?? '')
      return { code, label: CARC_DESC[code] ?? `CARC ${code}` }
    }
    return { code: null, label: null }
  }

  const today = new Date()
  function daysSince(iso: string | null | undefined): number {
    if (!iso) return 0
    const d = new Date(iso)
    if (isNaN(d.getTime())) return 0
    return Math.max(0, Math.floor((today.getTime() - d.getTime()) / 86_400_000))
  }

  // Enrich each row with derived status + reason + ages.
  const enriched = (rows as ClaimRow[]).map(r => {
    const status = derivePipelineStatus(r)
    const { code: reasonCode, label: reasonLabel } = derivePlainReason(r, status)
    const familyBalanceCents = Number(r.statement_total_due ?? 0) * 100 - Number(r.statement_paid_cents ?? 0)
    const familyOwes = Math.max(0, familyBalanceCents / 100)
    const familyPaid = Number(r.statement_paid_cents ?? 0) / 100
    const daysSinceSubmit = daysSince(r.submitted_at)
    const daysSinceDOS = daysSince(r.service_date)
    return {
      id: r.id,
      service_date: r.service_date,
      patient_name: [r.patient_first_name, r.patient_last_name].filter(Boolean).join(' ') || 'Unknown',
      payer_name: r.payer_name,
      rendering_provider: r.rendering_provider_name,
      billed: Number(r.billed),
      insurance_paid: Number(r.insurance_paid),
      patient_responsibility: Number(r.patient_responsibility),
      family_paid: familyPaid,
      family_owes: familyOwes,
      statement_status: r.statement_status,
      submitted_at: r.submitted_at,
      era_received_at: r.era_received_at,
      status,
      reason_code: reasonCode,
      reason_label: reasonLabel,
      days_waiting: daysSinceSubmit,
      days_since_dos: daysSinceDOS,
    }
  })

  // ── Section 1: Follow the money ───────────────────────────────────────
  const totalBilled           = enriched.reduce((s, r) => s + r.billed, 0)
  const totalInsuranceCollected = enriched.reduce((s, r) => s + r.insurance_paid, 0)
  const totalFamilyCollected    = enriched.reduce((s, r) => s + r.family_paid, 0)
  const totalCollected          = totalInsuranceCollected + totalFamilyCollected
  const totalFamilyOwes         = enriched.reduce((s, r) => s + r.family_owes, 0)
  const totalWaitingOnInsurance = Math.max(0, totalBilled - totalCollected - totalFamilyOwes)

  // ── Section 2: By-status cards ────────────────────────────────────────
  const STATUSES = ['not_yet_sent', 'rejected', 'sent_waiting', 'paid', 'denied'] as const
  const byStatus = STATUSES.map(st => {
    const rowsOfStatus = enriched.filter(r => r.status === st)
    const total = rowsOfStatus.reduce((s, r) => s + r.billed, 0)
    const oldestAge = rowsOfStatus.reduce((m, r) => Math.max(m, r.days_since_dos), 0)
    return { status: st, dollar_total: total, claim_count: rowsOfStatus.length, oldest_age_days: oldestAge }
  })

  // Aging buckets — unpaid insurance claims (sent_waiting + accepted),
  // bucketed by days since submission.
  const unpaidWaiting = enriched.filter(r => r.status === 'sent_waiting')
  const bucket = (days: number): string =>
    days <= 30 ? 'b_0_30' : days <= 60 ? 'b_31_60' : days <= 90 ? 'b_61_90' : 'b_90_plus'
  const agingBuckets: Record<string, { total: number; count: number }> = {
    b_0_30: { total: 0, count: 0 }, b_31_60: { total: 0, count: 0 },
    b_61_90: { total: 0, count: 0 }, b_90_plus: { total: 0, count: 0 },
  }
  for (const r of unpaidWaiting) {
    const b = bucket(r.days_waiting)
    agingBuckets[b].total += r.billed
    agingBuckets[b].count += 1
  }

  // ── Section 3: Action items ───────────────────────────────────────────
  const actionItems = enriched
    .filter(r =>
      r.status === 'not_yet_sent' ||
      r.status === 'rejected' ||
      r.status === 'denied' ||
      (r.status === 'sent_waiting' && r.days_waiting > 30)
    )
    .sort((a, b) => b.days_since_dos - a.days_since_dos) // oldest first

  return res.status(200).json({
    range,
    follow_the_money: {
      billed: totalBilled,
      insurance_collected: totalInsuranceCollected,
      family_collected: totalFamilyCollected,
      total_collected: totalCollected,
      family_balance: totalFamilyOwes,
      waiting_on_insurance: totalWaitingOnInsurance,
    },
    by_status: byStatus,
    aging_buckets: agingBuckets,
    action_items: actionItems,
  })
}
