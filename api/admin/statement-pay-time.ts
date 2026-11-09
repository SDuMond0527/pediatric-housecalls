// Average days from patient statement sent to paid.
// "How long do families take to pay once we send the bill."
//
// Scope: patient_statements where sent_at + paid_at are both set,
// paid_at >= sent_at, voided statements excluded. Date range filters
// on sent_at (we count by WHEN the bill went out, not when it got
// paid). Statements sent but still unpaid returned separately as
// context — not averaged in.
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

  // Overall
  const [overall] = await sql`
    SELECT
      COUNT(*)::int AS n,
      COALESCE(ROUND(AVG(EXTRACT(EPOCH FROM (paid_at - sent_at)) / 86400)::numeric, 1), 0)::float AS avg_days,
      COALESCE(ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (paid_at - sent_at)) / 86400)::numeric, 1), 0)::float AS median_days,
      COALESCE(ROUND(MIN(EXTRACT(EPOCH FROM (paid_at - sent_at)) / 86400)::numeric, 1), 0)::float AS min_days,
      COALESCE(ROUND(MAX(EXTRACT(EPOCH FROM (paid_at - sent_at)) / 86400)::numeric, 1), 0)::float AS max_days
    FROM patient_statements
    WHERE practice_id = ${practiceId}::uuid
      AND sent_at IS NOT NULL
      AND paid_at IS NOT NULL
      AND paid_at >= sent_at
      AND voided_at IS NULL
      AND sent_at::date BETWEEN ${start}::date AND ${end}::date`

  // By month sent
  const byMonth = await sql`
    SELECT
      TO_CHAR(sent_at, 'YYYY-MM') AS month,
      COUNT(*)::int AS n,
      ROUND(AVG(EXTRACT(EPOCH FROM (paid_at - sent_at)) / 86400)::numeric, 1)::float AS avg_days,
      ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (paid_at - sent_at)) / 86400)::numeric, 1)::float AS median_days
    FROM patient_statements
    WHERE practice_id = ${practiceId}::uuid
      AND sent_at IS NOT NULL
      AND paid_at IS NOT NULL
      AND paid_at >= sent_at
      AND voided_at IS NULL
      AND sent_at::date BETWEEN ${start}::date AND ${end}::date
    GROUP BY month
    ORDER BY month`

  // Distribution buckets
  const [dist] = await sql`
    SELECT
      COUNT(*) FILTER (WHERE EXTRACT(EPOCH FROM (paid_at - sent_at))/86400 <= 7)::int  AS d0_7,
      COUNT(*) FILTER (WHERE EXTRACT(EPOCH FROM (paid_at - sent_at))/86400 > 7  AND EXTRACT(EPOCH FROM (paid_at - sent_at))/86400 <= 14)::int AS d8_14,
      COUNT(*) FILTER (WHERE EXTRACT(EPOCH FROM (paid_at - sent_at))/86400 > 14 AND EXTRACT(EPOCH FROM (paid_at - sent_at))/86400 <= 30)::int AS d15_30,
      COUNT(*) FILTER (WHERE EXTRACT(EPOCH FROM (paid_at - sent_at))/86400 > 30)::int AS d31_plus
    FROM patient_statements
    WHERE practice_id = ${practiceId}::uuid
      AND sent_at IS NOT NULL AND paid_at IS NOT NULL AND paid_at >= sent_at AND voided_at IS NULL
      AND sent_at::date BETWEEN ${start}::date AND ${end}::date`

  // Context — unpaid sent-in-window
  const [unpaidCtx] = await sql`
    SELECT COUNT(*)::int AS n
    FROM patient_statements
    WHERE practice_id = ${practiceId}::uuid
      AND sent_at IS NOT NULL AND paid_at IS NULL AND voided_at IS NULL
      AND sent_at::date BETWEEN ${start}::date AND ${end}::date`

  return res.json({ start, end, overall, by_month: byMonth, distribution: dist, unpaid_in_window: unpaidCtx.n })
}
