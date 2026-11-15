import type { VercelRequest, VercelResponse } from '@vercel/node'
import { neon } from '@neondatabase/serverless'
import { createRemoteJWKSet, jwtVerify } from 'jose'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    const dbUrl = process.env.DATABASE_URL
    const userPoolId = process.env.VITE_AWS_USER_POOL_ID
    const region = process.env.VITE_AWS_REGION || 'us-east-2'

    if (!dbUrl) return res.status(500).json({ error: 'DATABASE_URL not set' })
    if (!userPoolId) return res.status(500).json({ error: 'VITE_AWS_USER_POOL_ID not set' })

    const authHeader = req.headers.authorization
    if (!authHeader?.startsWith('Bearer ')) return res.status(401).json({ error: 'Missing token' })
    const token = authHeader.slice(7)
    if (!token) return res.status(401).json({ error: 'Empty token' })

    const jwksUrl = `https://cognito-idp.${region}.amazonaws.com/${userPoolId}/.well-known/jwks.json`
    const JWKS = createRemoteJWKSet(new URL(jwksUrl))
    const { payload } = await jwtVerify(token, JWKS, {
      issuer: `https://cognito-idp.${region}.amazonaws.com/${userPoolId}`,
    })
    const sub = payload.sub
    if (!sub) return res.status(401).json({ error: 'No sub in token' })

    const sql = neon(dbUrl)
    // Join practice so the client gets the practice display name
    // alongside the provider object. Multi-tenant seam: the sidebar
    // header shows practice_name per-user instead of the build-time
    // VITE_PRACTICE_NAME env var. Sara 2026-11-15.
    const rows = await sql`
      SELECT p.*, pr.name AS practice_name
      FROM providers p
      LEFT JOIN practices pr ON pr.id = p.practice_id
      WHERE p.cognito_sub = ${sub}
      LIMIT 1`
    if (rows.length === 0) return res.status(404).json({ error: 'Provider not found', sub })
    const row = rows[0]
    row.zones = row.zones ?? []
    row.states = row.states ?? []
    // Union of all provider states in the practice — lets UI
    // surfaces (marketing audience filter, on-call schedule, etc.)
    // show only states the practice actually operates in instead of
    // hardcoded ['NC','SC','VA'].
    try {
      const stateRows = await sql`
        SELECT DISTINCT UNNEST(states) AS state
        FROM providers
        WHERE practice_id = ${row.practice_id}::uuid
          AND is_active = true
        ORDER BY state`
      row.practice_states = stateRows.map((r: any) => r.state).filter(Boolean)
    } catch {
      row.practice_states = row.states ?? []
    }
    // Count of active providers in the practice — lets UI collapse
    // redundant admin surfaces for solo practices (e.g. hide the
    // admin Availability nav when there's only one provider to
    // pick, since the provider's own /availability covers it).
    try {
      const [countRow] = await sql`
        SELECT COUNT(*)::int AS n
        FROM providers
        WHERE practice_id = ${row.practice_id}::uuid
          AND is_active = true`
      row.practice_provider_count = countRow?.n ?? 1
    } catch {
      row.practice_provider_count = 1
    }
    res.json(row)
  } catch (e: unknown) {
    const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e)
    res.status(500).json({ error: msg })
  }
}
