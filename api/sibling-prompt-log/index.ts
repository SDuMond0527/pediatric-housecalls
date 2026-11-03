import type { VercelRequest, VercelResponse } from '@vercel/node'
import { neon } from '@neondatabase/serverless'
import { createRemoteJWKSet, jwtVerify } from 'jose'

/**
 * POST /api/sibling-prompt-log  (family-authed, writes a log row)
 * GET  /api/sibling-prompt-log  (provider admin, returns rollup summary)
 *
 * Separate ledger of "parent saw the sibling-add prompt and chose X."
 * Lives next to appointments, never writes back to them. See
 * project_feature_ground_rules_2026-11-02.md.
 */
async function verifyFamilyToken(authHeader: string | undefined): Promise<string> {
  if (!authHeader?.startsWith('Bearer ')) throw new Error('Missing token')
  const token = authHeader.slice(7)
  const region = process.env.VITE_AWS_REGION || 'us-east-2'
  const poolId = process.env.VITE_FAMILY_USER_POOL_ID || ''
  const JWKS = createRemoteJWKSet(new URL(`https://cognito-idp.${region}.amazonaws.com/${poolId}/.well-known/jwks.json`))
  const { payload } = await jwtVerify(token, JWKS, { issuer: `https://cognito-idp.${region}.amazonaws.com/${poolId}` })
  if (!payload.sub) throw new Error('No sub')
  return payload.sub as string
}

async function verifyProviderToken(authHeader: string | undefined): Promise<string> {
  if (!authHeader?.startsWith('Bearer ')) throw new Error('Missing token')
  const token = authHeader.slice(7)
  const region = process.env.VITE_AWS_REGION || 'us-east-2'
  const poolId = process.env.VITE_AWS_USER_POOL_ID || ''
  const JWKS = createRemoteJWKSet(new URL(`https://cognito-idp.${region}.amazonaws.com/${poolId}/.well-known/jwks.json`))
  const { payload } = await jwtVerify(token, JWKS, { issuer: `https://cognito-idp.${region}.amazonaws.com/${poolId}` })
  if (!payload.sub) throw new Error('No sub')
  return payload.sub as string
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const sql = neon(process.env.DATABASE_URL!)

  try {
    await sql`
      CREATE TABLE IF NOT EXISTS sibling_prompt_log (
        id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        practice_id     uuid NOT NULL,
        family_id       uuid,
        visit_type      text,
        zone            text,
        offered         boolean NOT NULL DEFAULT true,
        accepted        boolean NOT NULL DEFAULT false,
        sibling_added   boolean NOT NULL DEFAULT false,
        child_count_before int,
        child_count_after  int,
        appointment_id  uuid,
        created_at      timestamptz NOT NULL DEFAULT NOW()
      )`
    await sql`CREATE INDEX IF NOT EXISTS sibling_prompt_log_practice_idx ON sibling_prompt_log(practice_id, created_at)`
  } catch {}

  if (req.method === 'POST') {
    let sub: string
    try { sub = await verifyFamilyToken(req.headers.authorization) }
    catch { return res.status(401).json({ error: 'Unauthorized' }) }

    const [fam] = await sql`SELECT id, practice_id FROM family_profiles WHERE cognito_sub = ${sub} LIMIT 1`
    if (!fam) return res.status(403).json({ error: 'Family not found' })

    const b = (req.body ?? {}) as any
    const accepted = !!b.accepted
    const siblingAdded = !!b.sibling_added
    const childBefore = Number.isFinite(b.child_count_before) ? b.child_count_before : null
    const childAfter  = Number.isFinite(b.child_count_after)  ? b.child_count_after  : null

    const [row] = await sql`
      INSERT INTO sibling_prompt_log (
        practice_id, family_id, visit_type, zone,
        offered, accepted, sibling_added,
        child_count_before, child_count_after,
        appointment_id
      ) VALUES (
        ${fam.practice_id}::uuid, ${fam.id}::uuid,
        ${b.visit_type ?? null}, ${b.zone ?? null},
        true, ${accepted}, ${siblingAdded},
        ${childBefore}, ${childAfter},
        ${b.appointment_id ?? null}::uuid
      )
      RETURNING id, created_at`
    return res.json({ ok: true, id: (row as any).id })
  }

  if (req.method === 'GET') {
    let sub: string
    try { sub = await verifyProviderToken(req.headers.authorization) }
    catch { return res.status(401).json({ error: 'Unauthorized' }) }

    const [provider] = await sql`SELECT practice_id, is_admin FROM providers WHERE cognito_sub = ${sub} LIMIT 1`
    if (!provider || !provider.is_admin) return res.status(403).json({ error: 'Admin only' })

    const start = String(req.query.start ?? '')
    const end   = String(req.query.end ?? '')

    const [summary] = start && end
      ? await sql`
          SELECT
            COUNT(*)::int AS offered,
            SUM(CASE WHEN accepted      THEN 1 ELSE 0 END)::int AS accepted,
            SUM(CASE WHEN sibling_added THEN 1 ELSE 0 END)::int AS sibling_added
          FROM sibling_prompt_log
          WHERE practice_id = ${provider.practice_id}::uuid
            AND created_at >= ${start}::date
            AND created_at < (${end}::date + INTERVAL '1 day')`
      : await sql`
          SELECT
            COUNT(*)::int AS offered,
            SUM(CASE WHEN accepted      THEN 1 ELSE 0 END)::int AS accepted,
            SUM(CASE WHEN sibling_added THEN 1 ELSE 0 END)::int AS sibling_added
          FROM sibling_prompt_log
          WHERE practice_id = ${provider.practice_id}::uuid
            AND created_at >= NOW() - INTERVAL '30 days'`
    return res.json(summary ?? { offered: 0, accepted: 0, sibling_added: 0 })
  }

  return res.status(405).json({ error: 'Method not allowed' })
}
