import type { VercelRequest, VercelResponse } from '@vercel/node'
import { neon } from '@neondatabase/serverless'
import { createRemoteJWKSet, jwtVerify } from 'jose'

async function verifyToken(authHeader: string | undefined): Promise<string> {
  if (!authHeader?.startsWith('Bearer ')) throw new Error('Missing token')
  const token = authHeader.slice(7)
  const region = process.env.VITE_AWS_REGION || 'us-east-2'
  const poolId = process.env.VITE_AWS_USER_POOL_ID || ''
  const JWKS = createRemoteJWKSet(new URL(`https://cognito-idp.${region}.amazonaws.com/${poolId}/.well-known/jwks.json`))
  const { payload } = await jwtVerify(token, JWKS, { issuer: `https://cognito-idp.${region}.amazonaws.com/${poolId}` })
  if (!payload.sub) throw new Error('No sub in token')
  return payload.sub as string
}

export type MarketingFilters = {
  states?: Array<'NC' | 'SC' | 'VA'>
  // child age band (years, inclusive)
  age_min?: number | null
  age_max?: number | null
  // activity window — exactly one at most
  last_visit_within_days?: number | null
  last_visit_older_than_days?: number | null
  // never had a visit (prospects who signed up but didn't book)
  never_visited?: boolean
}

export async function resolveAudience(sql: any, practiceId: string, filters: MarketingFilters) {
  const states = (filters.states ?? []).filter(s => ['NC', 'SC', 'VA'].includes(s))
  const hasState = states.length > 0
  const ageMin = filters.age_min ?? null
  const ageMax = filters.age_max ?? null
  const withinDays = filters.last_visit_within_days ?? null
  const olderThanDays = filters.last_visit_older_than_days ?? null
  const neverVisited = !!filters.never_visited

  // Build the per-family last-visit date on the fly from appointments so
  // we don't need to materialize anything. "Never visited" = NULL last
  // visit; "within N" / "older than N" compare against last_visit::date.
  const rows = await sql`
    WITH last_visits AS (
      SELECT ch.family_id, MAX(a.scheduled_date) AS last_visit
      FROM appointments a
      JOIN children ch ON ch.id = a.child_id
      WHERE a.practice_id = ${practiceId}::uuid AND a.status != 'cancelled'
      GROUP BY ch.family_id
    ),
    families AS (
      SELECT DISTINCT ON (fp.id)
        fp.id, fp.email, fp.display_name, fp.state,
        lv.last_visit,
        -- min child age in years, from any child on this family
        FLOOR(
          EXTRACT(EPOCH FROM AGE(CURRENT_DATE, MIN(ch.date_of_birth))) / (365.25 * 86400)
        )::int AS oldest_child_years,
        FLOOR(
          EXTRACT(EPOCH FROM AGE(CURRENT_DATE, MAX(ch.date_of_birth))) / (365.25 * 86400)
        )::int AS youngest_child_years
      FROM family_profiles fp
      LEFT JOIN children ch ON ch.family_id = fp.id AND ch.practice_id = ${practiceId}::uuid
      LEFT JOIN last_visits lv ON lv.family_id = fp.id
      WHERE fp.practice_id = ${practiceId}::uuid
        AND fp.email IS NOT NULL AND LENGTH(TRIM(fp.email)) > 0
        AND COALESCE(fp.marketing_opt_out, false) = false
      GROUP BY fp.id, fp.email, fp.display_name, fp.state, lv.last_visit
    )
    SELECT id, email, display_name, state, last_visit, oldest_child_years, youngest_child_years
    FROM families
    WHERE
      (${hasState}::boolean = false OR state = ANY(${states}))
      AND (${ageMin}::int IS NULL OR youngest_child_years >= ${ageMin}::int)
      AND (${ageMax}::int IS NULL OR oldest_child_years <= ${ageMax}::int)
      AND (
        ${neverVisited}::boolean = true AND last_visit IS NULL
        OR ${neverVisited}::boolean = false AND (
          (${withinDays}::int IS NULL AND ${olderThanDays}::int IS NULL)
          OR (${withinDays}::int IS NOT NULL AND last_visit >= CURRENT_DATE - (${withinDays}::int || ' days')::interval)
          OR (${olderThanDays}::int IS NOT NULL AND (last_visit IS NULL OR last_visit < CURRENT_DATE - (${olderThanDays}::int || ' days')::interval))
        )
      )
    ORDER BY display_name NULLS LAST, email`
  return rows
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  let sub: string
  try { sub = await verifyToken(req.headers.authorization) }
  catch { return res.status(401).json({ error: 'Unauthorized' }) }

  const sql = neon(process.env.DATABASE_URL!)
  const [provider] = await sql`SELECT practice_id, is_admin FROM providers WHERE cognito_sub = ${sub} LIMIT 1`
  if (!provider) return res.status(403).json({ error: 'Provider not found' })
  if (!provider.is_admin) return res.status(403).json({ error: 'Admin only' })

  try { await sql`ALTER TABLE family_profiles ADD COLUMN IF NOT EXISTS marketing_opt_out boolean DEFAULT false` } catch {}
  try { await sql`ALTER TABLE family_profiles ADD COLUMN IF NOT EXISTS marketing_opt_out_at timestamptz` } catch {}

  const rows = await resolveAudience(sql, provider.practice_id, (req.body ?? {}) as MarketingFilters)
  return res.json({
    count: rows.length,
    sample: rows.slice(0, 8).map((r: any) => ({
      email: r.email,
      display_name: r.display_name,
      state: r.state,
      last_visit: r.last_visit,
    })),
  })
}
