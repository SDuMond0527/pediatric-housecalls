import type { VercelRequest, VercelResponse } from '@vercel/node'
import { neon } from '@neondatabase/serverless'
import { createRemoteJWKSet, jwtVerify } from 'jose'

async function verifyToken(authHeader: string | undefined): Promise<string> {
  if (!authHeader?.startsWith('Bearer ')) throw new Error('Missing token')
  const token = authHeader.slice(7)
  const region = process.env.VITE_AWS_REGION || 'us-east-2'
  const userPoolId = process.env.VITE_AWS_USER_POOL_ID || ''
  const JWKS = createRemoteJWKSet(new URL(`https://cognito-idp.${region}.amazonaws.com/${userPoolId}/.well-known/jwks.json`))
  const { payload } = await jwtVerify(token, JWKS, { issuer: `https://cognito-idp.${region}.amazonaws.com/${userPoolId}` })
  if (!payload.sub) throw new Error('No sub in token')
  return payload.sub
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  let sub: string
  try {
    sub = await verifyToken(req.headers.authorization)
  } catch {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const sql = neon(process.env.DATABASE_URL!)

  const [caller] = await sql`SELECT id, is_admin FROM providers WHERE cognito_sub = ${sub} LIMIT 1`
  if (!caller) return res.status(403).json({ error: 'Provider not found' })
  if (!caller.is_admin) return res.status(403).json({ error: 'Admin access required' })

  const { provider_id, resource_type, resource_id, days = '30', limit = '200' } = req.query as Record<string, string>

  const rows = await sql`
    SELECT
      a.id,
      a.action,
      a.resource_type,
      a.resource_id,
      a.created_at,
      p.name  AS provider_name,
      p.role  AS provider_role
    FROM phi_audit_log a
    JOIN providers p ON p.id = a.provider_id
    WHERE a.created_at > now() - (${days}::int || ' days')::interval
      AND (${provider_id ?? null}::uuid IS NULL OR a.provider_id = ${provider_id ?? null}::uuid)
      AND (${resource_type ?? null}::text IS NULL OR a.resource_type = ${resource_type ?? null})
      AND (${resource_id ?? null}::text IS NULL OR a.resource_id = ${resource_id ?? null})
    ORDER BY a.created_at DESC
    LIMIT ${parseInt(limit, 10)}
  `

  return res.status(200).json(rows)
}
