// Average convenience fee per visit, year to date.
//
// Source: CV codes on signed encounter_notes.cpt_codes. This is the
// source of truth for what CV was attached to a visit at sign-time;
// it covers the full year (not just since the auto-charge pipeline
// was built). CV codes get stripped from claims before submission
// (insurance doesn't pay them) and moved to patient_statement, so
// the note's cpt_codes array is the one place they survive.
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

  // Hardcoded floor: pre-September 2026 CV data is unreliable (the CV
  // workflow in GoRoam matured in Sep; earlier months have scattered
  // ghost entries from code migrations). Clamp the window regardless
  // of what the caller passes. Sara 2026-11-08.
  const CV_FLOOR = '2026-09-01'

  // Overall stats — pulled from signed encounter_notes.cpt_codes where
  // any line item code starts with 'CV'. Each CV line counts once.
  const [overall] = await sql`
    SELECT
      COUNT(*)::int AS n,
      COALESCE(ROUND(SUM((cv_line->>'charge_amount')::numeric)::numeric, 2), 0)::float AS total,
      COALESCE(ROUND(AVG((cv_line->>'charge_amount')::numeric)::numeric, 2), 0)::float AS avg
    FROM encounter_notes en
    CROSS JOIN LATERAL jsonb_array_elements(en.cpt_codes) AS cv_line
    WHERE en.practice_id = ${practiceId}::uuid
      AND en.is_signed = true
      AND en.signed_at >= ${CV_FLOOR}::date
      AND en.signed_at::date BETWEEN ${start}::date AND ${end}::date
      AND cv_line->>'code' LIKE 'CV%'`

  // By month
  const byMonth = await sql`
    SELECT
      TO_CHAR(en.signed_at, 'YYYY-MM') AS month,
      COUNT(*)::int AS n,
      ROUND(SUM((cv_line->>'charge_amount')::numeric)::numeric, 2)::float AS total,
      ROUND(AVG((cv_line->>'charge_amount')::numeric)::numeric, 2)::float AS avg
    FROM encounter_notes en
    CROSS JOIN LATERAL jsonb_array_elements(en.cpt_codes) AS cv_line
    WHERE en.practice_id = ${practiceId}::uuid
      AND en.is_signed = true
      AND en.signed_at >= ${CV_FLOOR}::date
      AND en.signed_at::date BETWEEN ${start}::date AND ${end}::date
      AND cv_line->>'code' LIKE 'CV%'
    GROUP BY month
    ORDER BY month`

  return res.json({
    start, end,
    overall,
    by_month: byMonth,
  })
}
