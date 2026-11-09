// Average days from claim submission to ERA receipt, by payer.
// Shorthand: "how long till we get paid."
//
// Scope: claims with both submitted_at AND era_received_at populated,
// where era_received_at >= submitted_at (sanity check against clock
// skew / data entry). Self-pay excluded (no insurance pipeline).
//
// Payer grouping matches the reimbursement report's bucketing so the
// two reports can be read side by side: Anthem stays separate from
// BCBS NC, UMR separate from UHC, etc. Keep the CASE expression in
// sync with api/admin/reimbursement-by-visit-payer.ts.
//
// Admin-authed, practice-scoped, inlined per Vercel bundling lesson.
// Sara 2026-11-08.

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

  const rows = await sql`
    SELECT
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
      END AS payer,
      COUNT(*)::int AS n,
      ROUND(AVG(EXTRACT(EPOCH FROM (cl.era_received_at - cl.submitted_at)) / 86400)::numeric, 1)::float AS avg_days,
      ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (cl.era_received_at - cl.submitted_at)) / 86400)::numeric, 1)::float AS median_days,
      ROUND(MIN(EXTRACT(EPOCH FROM (cl.era_received_at - cl.submitted_at)) / 86400)::numeric, 1)::float AS min_days,
      ROUND(MAX(EXTRACT(EPOCH FROM (cl.era_received_at - cl.submitted_at)) / 86400)::numeric, 1)::float AS max_days
    FROM claims cl
    WHERE cl.practice_id = ${practiceId}::uuid
      AND cl.submitted_at IS NOT NULL
      AND cl.era_received_at IS NOT NULL
      AND cl.era_received_at >= cl.submitted_at
      AND cl.service_date BETWEEN ${start}::date AND ${end}::date
      AND cl.payer_id <> 'PP'
      AND cl.payer_name IS NOT NULL
    GROUP BY payer
    ORDER BY avg_days`

  // Also compute a grand summary across all payers
  const [overall] = await sql`
    SELECT
      COUNT(*)::int AS n,
      ROUND(AVG(EXTRACT(EPOCH FROM (cl.era_received_at - cl.submitted_at)) / 86400)::numeric, 1)::float AS avg_days,
      ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (cl.era_received_at - cl.submitted_at)) / 86400)::numeric, 1)::float AS median_days
    FROM claims cl
    WHERE cl.practice_id = ${practiceId}::uuid
      AND cl.submitted_at IS NOT NULL
      AND cl.era_received_at IS NOT NULL
      AND cl.era_received_at >= cl.submitted_at
      AND cl.service_date BETWEEN ${start}::date AND ${end}::date
      AND cl.payer_id <> 'PP'
      AND cl.payer_name IS NOT NULL`

  return res.json({ start, end, rows, overall })
}
