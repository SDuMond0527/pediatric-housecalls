// Average allowable per (visit_type × payer) grid.
//
// "Allowable" here = COALESCE(amount_billed_era, total_charge)
//                  - COALESCE(contractual_adjustment_era, 0)
// which equals insurance_payment + patient_responsibility per the 835
// identity. Matches the "contracted rate" view Sara asked for 2026-11-08.
//
// Only counts claims with era_received_at IS NOT NULL — fully paid or
// patient-responsibility-only lines. Self-pay (payer_id='PP') excluded
// because there is no insurance allowable to average.
//
// Payer grouping is BUSINESS-LEVEL, not routing: Anthem stays separate
// from BCBS of NC even when it shares the UPICO payer_id for submission
// mechanics. See memory project_anthem_payer_id_normalization.md
// (2026-11-08 correction). Keep CASE expression + buildPayerBucket()
// client-side helper in sync.
//
// Admin-authed only. Scoped by caller's practice. Zero cross-imports —
// Cognito verify inlined per the Vercel bundling lesson.

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

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  let sub: string
  try { sub = await verifyProviderToken(req.headers.authorization) }
  catch { return res.status(401).json({ error: 'Unauthorized' }) }

  const sql = neon(process.env.DATABASE_URL!)
  const [provider] = await sql`
    SELECT id, practice_id, is_admin, is_super_admin
    FROM providers WHERE cognito_sub = ${sub} LIMIT 1`
  if (!provider) return res.status(403).json({ error: 'Provider not found' })
  if (!provider.is_admin && !provider.is_super_admin) return res.status(403).json({ error: 'Admin only' })

  const practiceId = provider.practice_id as string
  const now = new Date()
  const jan1 = `${now.getUTCFullYear()}-01-01`
  const start = String(req.query.start ?? jan1)
  const end   = String(req.query.end   ?? now.toISOString().slice(0, 10))

  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
    return res.status(400).json({ error: 'start and end must be YYYY-MM-DD' })
  }

  // One query. Joins through encounter_notes → appointments for visit
  // type. LEFT JOIN so claims with a broken chain still appear (bucketed
  // as "Unknown visit type"). The payer_group CASE encodes the business-
  // level bucket per memory.
  const rows = await sql`
    SELECT
      COALESCE(a.visit_type, 'Unknown visit type') AS visit_type,
      CASE
        WHEN cl.payer_name ~* '\\manthem\\M' AND cl.payer_name ~* '\\mva\\M|virginia' THEN 'Anthem BCBS of Virginia'
        WHEN cl.payer_name ~* '\\manthem\\M' THEN 'Anthem'
        WHEN cl.payer_name ~* 'bcbs|blue\\s*cross|blue\\s*shield' THEN 'BCBS of NC'
        WHEN cl.payer_name ~* '\\mumr\\M' THEN 'UMR'
        WHEN cl.payer_name ~* 'united|\\muhc\\M' THEN 'UHC'
        WHEN cl.payer_name ~* 'cigna' THEN 'Cigna'
        WHEN cl.payer_name ~* 'aetna' THEN 'Aetna'
        WHEN cl.payer_name ~* 'meritain' THEN 'Meritain'
        WHEN cl.payer_name ~* 'medcost|healthgram' THEN 'Medcost'
        WHEN cl.payer_name ~* 'bright\\s*health' THEN 'Bright Health'
        WHEN cl.payer_name ~* 'humana' THEN 'Humana'
        WHEN cl.payer_name ~* 'phcs|multiplan' THEN 'PHCS / Multiplan'
        WHEN cl.payer_name ~* 'coventry' THEN 'Coventry'
        WHEN cl.payer_name ~* 'select\\s*health' THEN 'Select Health'
        ELSE TRIM(cl.payer_name)
      END AS payer_bucket,
      COUNT(*)::int AS n_claims,
      -- Allowable = insurance paid + patient responsibility.
      -- Equivalent to amount_billed - contractual_adjustment for clean
      -- ERAs, but correct even when the ERA contains "other adjustments"
      -- (denials coded CO/50, CO/197, etc.) that are neither
      -- contractual-write-off nor patient-responsibility. Sara 2026-11-08.
      ROUND(
        AVG(
          COALESCE(cl.insurance_payment_era,   0)::numeric
          + COALESCE(cl.patient_deductible_era,  0)::numeric
          + COALESCE(cl.patient_coinsurance_era, 0)::numeric
          + COALESCE(cl.patient_copay_era,       0)::numeric
          + COALESCE(cl.patient_non_covered_era, 0)::numeric
        )::numeric,
        2
      )::float AS avg_allowable,
      ROUND(
        SUM(
          COALESCE(cl.insurance_payment_era,   0)::numeric
          + COALESCE(cl.patient_deductible_era,  0)::numeric
          + COALESCE(cl.patient_coinsurance_era, 0)::numeric
          + COALESCE(cl.patient_copay_era,       0)::numeric
          + COALESCE(cl.patient_non_covered_era, 0)::numeric
        )::numeric,
        2
      )::float AS total_allowable
    FROM claims cl
    LEFT JOIN encounter_notes en ON en.id = cl.encounter_note_id
    LEFT JOIN appointments     a  ON a.id  = en.appointment_id
    WHERE cl.practice_id       = ${practiceId}::uuid
      AND cl.era_received_at   IS NOT NULL
      AND cl.service_date      BETWEEN ${start}::date AND ${end}::date
      AND cl.payer_id          <> 'PP'               -- exclude self-pay
      AND cl.payer_name        IS NOT NULL
    GROUP BY visit_type, payer_bucket
    ORDER BY visit_type, payer_bucket`

  // Pivot into a shape the client can render directly: unique axis lists
  // + a map from (visit, payer) → cell. Also compute row/column totals.
  const visitTypes = Array.from(new Set(rows.map((r: any) => r.visit_type as string))).sort()
  const payers     = Array.from(new Set(rows.map((r: any) => r.payer_bucket as string))).sort()

  const cells: Record<string, Record<string, { n: number; avg_allowable: number; total_allowable: number }>> = {}
  for (const v of visitTypes) cells[v] = {}
  for (const r of rows as any[]) {
    cells[r.visit_type][r.payer_bucket] = {
      n: r.n_claims,
      avg_allowable: r.avg_allowable,
      total_allowable: r.total_allowable,
    }
  }

  const payerTotals: Record<string, { n: number; avg_allowable: number; total_allowable: number }> = {}
  const visitTypeTotals: Record<string, { n: number; avg_allowable: number; total_allowable: number }> = {}
  let grandN = 0
  let grandTotal = 0
  for (const r of rows as any[]) {
    grandN += r.n_claims
    grandTotal += r.total_allowable
    payerTotals[r.payer_bucket] ??= { n: 0, avg_allowable: 0, total_allowable: 0 }
    payerTotals[r.payer_bucket].n              += r.n_claims
    payerTotals[r.payer_bucket].total_allowable += r.total_allowable
    visitTypeTotals[r.visit_type] ??= { n: 0, avg_allowable: 0, total_allowable: 0 }
    visitTypeTotals[r.visit_type].n              += r.n_claims
    visitTypeTotals[r.visit_type].total_allowable += r.total_allowable
  }
  for (const k of Object.keys(payerTotals))     payerTotals[k].avg_allowable     = payerTotals[k].n     ? +(payerTotals[k].total_allowable / payerTotals[k].n).toFixed(2)     : 0
  for (const k of Object.keys(visitTypeTotals)) visitTypeTotals[k].avg_allowable = visitTypeTotals[k].n ? +(visitTypeTotals[k].total_allowable / visitTypeTotals[k].n).toFixed(2) : 0

  return res.json({
    start, end,
    visit_types: visitTypes,
    payers,
    cells,
    payer_totals: payerTotals,
    visit_type_totals: visitTypeTotals,
    grand: {
      n: grandN,
      avg_allowable: grandN ? +(grandTotal / grandN).toFixed(2) : 0,
      total_allowable: +grandTotal.toFixed(2),
    },
  })
}
