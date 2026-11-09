// Average convenience fee per visit, year to date.
//
// Scope: only CV charges that successfully billed (status in
// 'auto_charged' or 'manually_charged'). `link_sent` and `failed` /
// `reversed` statuses excluded — those are either not yet collected
// or explicitly failed.
//
// Shape: overall headline (n, avg, total) plus a monthly breakdown
// so the trend over YTD is visible.
//
// Admin-authed, practice-scoped, inlined per the Vercel bundling
// lesson. Sara 2026-11-08.

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

  // Overall stats
  const [overall] = await sql`
    SELECT
      COUNT(*)::int AS n,
      COALESCE(ROUND((SUM(amount_cents) / 100.0)::numeric, 2), 0)::float AS total,
      COALESCE(ROUND((AVG(amount_cents) / 100.0)::numeric, 2), 0)::float AS avg
    FROM convenience_fee_charges
    WHERE practice_id = ${practiceId}::uuid
      AND service_date BETWEEN ${start}::date AND ${end}::date
      AND status IN ('auto_charged', 'manually_charged')`

  // By month
  const byMonth = await sql`
    SELECT
      TO_CHAR(service_date, 'YYYY-MM') AS month,
      COUNT(*)::int AS n,
      ROUND((SUM(amount_cents) / 100.0)::numeric, 2)::float AS total,
      ROUND((AVG(amount_cents) / 100.0)::numeric, 2)::float AS avg
    FROM convenience_fee_charges
    WHERE practice_id = ${practiceId}::uuid
      AND service_date BETWEEN ${start}::date AND ${end}::date
      AND status IN ('auto_charged', 'manually_charged')
    GROUP BY month
    ORDER BY month`

  return res.json({
    start, end,
    overall,
    by_month: byMonth,
  })
}
