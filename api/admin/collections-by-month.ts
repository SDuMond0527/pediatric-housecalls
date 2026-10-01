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
 * GET /api/admin/collections-by-month?payer=&provider_id=
 *
 * Groups every visit by the month of its DATE OF SERVICE. Each
 * payment (insurance ERA or paid patient-statement) is credited
 * back to the visit it paid for, never to the month the money
 * arrived. Returns 12 months, newest first.
 *
 * Per month:
 *   visits, billed, allowed_known (from ERAs received so far),
 *   allowed_pending (count of claims in that month still without
 *   an ERA), collected total, and three "within day N" rolling
 *   collection rates (30 / 60 / 90).
 *
 * Day-N status for each month:
 *   "not_yet"     — not enough time has passed for any visit in
 *                   this month to have reached day N yet
 *   "filling_in"  — some visits have reached day N, others
 *                   haven't — number is still partial
 *   "complete"    — every visit in this month has reached day N
 *
 * Headline tiles:
 *   - net_collection_rate_90: day-90 net % for the most recent
 *     month whose day-90 window has fully elapsed
 *   - allowed_per_visit, collected_per_visit_90 (from that same
 *     reference month)
 *   - avg_days_to_final_payment: avg of (last payment date −
 *     service date) across every visit that has a final payment
 *
 * Multi-tenant: scoped to caller's practice_id. Sara 2026-10-01.
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

  const payerFilter    = String(req.query.payer       ?? '').trim()
  const providerFilter = String(req.query.provider_id ?? '').trim()

  // Build base claims rows for the window — 12 months back from today.
  const rows = await sql`
    SELECT
      cl.id,
      cl.service_date::text          AS service_date,
      cl.payer_name,
      cl.provider_id,
      p.name                         AS provider_name,
      COALESCE(cl.total_charge, 0)::numeric      AS billed,
      cl.era_received_at,
      CASE WHEN cl.era_received_at IS NOT NULL THEN
        COALESCE(cl.amount_billed_era, cl.total_charge, 0)::numeric
          - COALESCE(cl.contractual_adjustment_era, 0)::numeric
      END                            AS allowed,
      COALESCE(cl.insurance_payment_era, 0)::numeric AS insurance_paid,
      cl.era_received_at::date       AS insurance_paid_date
    FROM claims cl
    LEFT JOIN providers p ON p.id = cl.provider_id
    WHERE cl.practice_id = ${practiceId}::uuid
      AND cl.status != 'written_off'
      AND cl.service_date >= DATE_TRUNC('month', CURRENT_DATE - INTERVAL '11 months')
      AND (${payerFilter}    = '' OR cl.payer_name ILIKE ${'%' + payerFilter + '%'})
      AND (${providerFilter} = '' OR cl.provider_id = ${providerFilter || null}::uuid)
    ORDER BY cl.service_date ASC`

  // Pull every paid patient_statement for those claims. For the
  // "collected within N days of DOS" calculation we need the per-
  // payment date, not just the per-claim total.
  const claimIds = (rows as any[]).map(r => r.id)
  const stmtRows = claimIds.length ? await sql`
    SELECT claim_id, paid_at::date AS paid_date, paid_amount_cents
    FROM patient_statements
    WHERE claim_id = ANY(${claimIds}::uuid[])
      AND status = 'paid'
      AND paid_at IS NOT NULL` : [] as any[]
  const stmtByClaim: Record<string, Array<{ paid_date: string; amount: number }>> = {}
  for (const s of stmtRows as any[]) {
    const arr = stmtByClaim[s.claim_id] ?? (stmtByClaim[s.claim_id] = [])
    arr.push({ paid_date: s.paid_date, amount: Number(s.paid_amount_cents ?? 0) / 100 })
  }

  const today = new Date()
  function daysBetween(aIso: string | null | undefined, bIso: string | null | undefined): number | null {
    if (!aIso || !bIso) return null
    const a = new Date(aIso)
    const b = new Date(bIso)
    if (isNaN(a.getTime()) || isNaN(b.getTime())) return null
    return Math.floor((b.getTime() - a.getTime()) / 86_400_000)
  }

  // Build 12 month buckets, newest first.
  type MonthBucket = {
    month: string                 // YYYY-MM
    label: string                 // "September 2026"
    visits: number
    billed: number
    allowed_known: number         // sum of allowed on ERA'd claims
    allowed_pending_count: number // claims in month with no ERA yet
    collected_total: number
    collected_30: number
    collected_60: number
    collected_90: number
    monthStart: Date
    monthEnd: Date
  }
  const buckets: Record<string, MonthBucket> = {}
  const monthKey = (iso: string) => iso.slice(0, 7)
  for (let i = 0; i < 12; i++) {
    const dt = new Date(today.getFullYear(), today.getMonth() - i, 1)
    const monthStart = new Date(dt.getFullYear(), dt.getMonth(), 1)
    const monthEnd   = new Date(dt.getFullYear(), dt.getMonth() + 1, 0) // last day of month
    const key = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`
    buckets[key] = {
      month: key,
      label: dt.toLocaleString('en-US', { month: 'long', year: 'numeric' }),
      visits: 0,
      billed: 0,
      allowed_known: 0,
      allowed_pending_count: 0,
      collected_total: 0,
      collected_30: 0,
      collected_60: 0,
      collected_90: 0,
      monthStart,
      monthEnd,
    }
  }

  // Walk every claim + apply its payments to the bucket matching its DOS.
  type PaymentEvent = { date: string; amount: number }
  const paymentEventsForFinal: Record<string, Array<{ dos: string; lastPayment: string }>> = {}
  const avgDaysSamples: number[] = []

  for (const r of rows as any[]) {
    const key = monthKey(r.service_date)
    const bucket = buckets[key]
    if (!bucket) continue // outside 12-month window

    bucket.visits += 1
    bucket.billed += Number(r.billed)
    if (r.era_received_at) {
      bucket.allowed_known += Number(r.allowed ?? 0)
    } else {
      bucket.allowed_pending_count += 1
    }

    const events: PaymentEvent[] = []
    if (r.era_received_at && Number(r.insurance_paid) > 0) {
      events.push({ date: r.insurance_paid_date, amount: Number(r.insurance_paid) })
    }
    for (const s of stmtByClaim[r.id] ?? []) {
      events.push({ date: s.paid_date, amount: s.amount })
    }

    for (const e of events) {
      bucket.collected_total += e.amount
      const days = daysBetween(r.service_date, e.date)
      if (days != null) {
        if (days <= 30) bucket.collected_30 += e.amount
        if (days <= 60) bucket.collected_60 += e.amount
        if (days <= 90) bucket.collected_90 += e.amount
      }
    }

    // Avg days to final payment — only count visits where every ERA
    // + statement has arrived. "Final" here = latest payment date.
    if (events.length > 0) {
      const latest = events.reduce((m, e) => e.date > m ? e.date : m, events[0].date)
      const d = daysBetween(r.service_date, latest)
      if (d != null && d >= 0) avgDaysSamples.push(d)
    }
  }

  function dayStatus(monthStart: Date, monthEnd: Date, threshold: number): 'not_yet' | 'filling_in' | 'complete' {
    const earliestVisitMatures = new Date(monthStart); earliestVisitMatures.setDate(monthStart.getDate() + threshold)
    const latestVisitMatures   = new Date(monthEnd);   latestVisitMatures.setDate(monthEnd.getDate() + threshold)
    if (today < earliestVisitMatures) return 'not_yet'
    if (today < latestVisitMatures)   return 'filling_in'
    return 'complete'
  }

  const monthsOut = Object.values(buckets)
    .sort((a, b) => b.month.localeCompare(a.month))
    .map(b => ({
      month: b.month,
      label: b.label,
      visits: b.visits,
      billed: b.billed,
      allowed_known: b.allowed_known,
      allowed_pending_count: b.allowed_pending_count,
      collected_total: b.collected_total,
      collected_30: b.collected_30,
      collected_60: b.collected_60,
      collected_90: b.collected_90,
      status_30: dayStatus(b.monthStart, b.monthEnd, 30),
      status_60: dayStatus(b.monthStart, b.monthEnd, 60),
      status_90: dayStatus(b.monthStart, b.monthEnd, 90),
    }))

  // Headline tiles. Reference month = most recent month that's reached
  // day 90 fully (status_90 === 'complete') AND has at least one visit.
  const referenceMonth = monthsOut.find(m => m.status_90 === 'complete' && m.visits > 0)
  const netRate90 = referenceMonth && referenceMonth.allowed_known > 0
    ? (referenceMonth.collected_90 / referenceMonth.allowed_known) * 100
    : null
  const avgDaysToFinalPayment = avgDaysSamples.length
    ? Math.round(avgDaysSamples.reduce((s, v) => s + v, 0) / avgDaysSamples.length)
    : null

  // Payer + provider dropdown options.
  const payerOptions = Array.from(new Set((rows as any[]).map(r => r.payer_name).filter(Boolean))).sort()
  const providerOptions = Array.from(
    new Map(
      (rows as any[])
        .filter(r => r.provider_id && r.provider_name)
        .map(r => [r.provider_id, { id: r.provider_id, name: r.provider_name }])
    ).values()
  ).sort((a, b) => a.name.localeCompare(b.name))

  return res.status(200).json({
    months: monthsOut,
    headline: {
      reference_month: referenceMonth?.label ?? null,
      net_collection_rate_90: netRate90,
      allowed_per_visit: referenceMonth && referenceMonth.visits > 0
        ? referenceMonth.allowed_known / referenceMonth.visits : null,
      collected_per_visit_90: referenceMonth && referenceMonth.visits > 0
        ? referenceMonth.collected_90 / referenceMonth.visits : null,
      avg_days_to_final_payment: avgDaysToFinalPayment,
    },
    filters_applied: {
      payer: payerFilter || null,
      provider_id: providerFilter || null,
    },
    options: {
      payers: payerOptions,
      providers: providerOptions,
    },
  })
}
