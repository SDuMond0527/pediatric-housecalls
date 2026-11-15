import type { VercelRequest, VercelResponse } from '@vercel/node'
import { neon } from '@neondatabase/serverless'
import { createRemoteJWKSet, jwtVerify } from 'jose'

// Returns the caller's practice_id. Supports either the provider
// pool (admin + clinical) or the family pool. Returns null if no
// token or no practice resolved. Sara 2026-11-15.
async function resolveCallerPracticeId(sql: any, authHeader: string | undefined): Promise<string | null> {
  if (!authHeader?.startsWith('Bearer ')) return null
  const token = authHeader.slice(7)
  const region = process.env.VITE_AWS_REGION || 'us-east-2'
  const familyPoolId = process.env.VITE_FAMILY_USER_POOL_ID || ''
  if (familyPoolId) {
    try {
      const JWKS = createRemoteJWKSet(new URL(`https://cognito-idp.${region}.amazonaws.com/${familyPoolId}/.well-known/jwks.json`))
      const { payload } = await jwtVerify(token, JWKS, { issuer: `https://cognito-idp.${region}.amazonaws.com/${familyPoolId}` })
      if (payload.sub) {
        const [row] = await sql`SELECT practice_id FROM family_profiles WHERE cognito_sub = ${payload.sub} LIMIT 1`
        return (row?.practice_id as string) ?? null
      }
    } catch {}
  }
  const userPoolId = process.env.VITE_AWS_USER_POOL_ID || ''
  if (userPoolId) {
    try {
      const JWKS = createRemoteJWKSet(new URL(`https://cognito-idp.${region}.amazonaws.com/${userPoolId}/.well-known/jwks.json`))
      const { payload } = await jwtVerify(token, JWKS, { issuer: `https://cognito-idp.${region}.amazonaws.com/${userPoolId}` })
      if (payload.sub) {
        const [row] = await sql`SELECT practice_id FROM providers WHERE cognito_sub = ${payload.sub} LIMIT 1`
        return (row?.practice_id as string) ?? null
      }
    } catch {}
  }
  return null
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  const sql = neon(process.env.DATABASE_URL!)

  // Multi-tenant seam: visit types MUST come from the caller's own
  // practice. Before 2026-11-15 this endpoint hard-wired
  // VITE_PRACTICE_ID (PHC) and served PHC's visit types to every
  // caller — so Direct Dermatology's Analytics page showed "In-home
  // CPR class" / "Sports physical" / etc. as columns.
  //
  // Also added token verification — previously this was an
  // unauthenticated endpoint leaking visit-type labels to anyone.
  const practiceId = await resolveCallerPracticeId(sql, req.headers.authorization)
  if (!practiceId) return res.status(401).json({ error: 'Unauthorized' })

  // No visit-type renames on read — the descriptive names already in the
  // DB (`CMA + telemedicine`, `RN in-home IV fluids administration`,
  // `Video telemedicine screening for IV fluids`) are the source of truth.
  // An earlier version of this endpoint tried to rename them based on the
  // shorter badge_labels, but that matched nothing and confused everyone.

  const rows = await sql`
    SELECT * FROM practice_visit_types
    WHERE practice_id = ${practiceId}::uuid AND is_active = true
    ORDER BY sort_order, visit_type`
  res.json(rows)
}
