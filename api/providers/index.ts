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

  const providerRows = await sql`SELECT practice_id FROM providers WHERE cognito_sub = ${sub} LIMIT 1`
  if (!providerRows.length) return res.status(403).json({ error: 'Provider not found' })
  const practiceId = providerRows[0].practice_id as string

  const { exclude_admin, name, role, is_active, zone, names, has_secure_text } = req.query as Record<string, string>

  if (name) {
    const [row] = await sql`SELECT * FROM providers WHERE name = ${name} AND practice_id = ${practiceId}::uuid LIMIT 1`
    return res.json(row ?? null)
  }

  if (role && is_active && zone) {
    const rows = await sql`SELECT * FROM providers WHERE role = ${role} AND is_active = true AND ${zone} = ANY(zones) AND practice_id = ${practiceId}::uuid`
    return res.json(rows)
  }

  if (names && has_secure_text === 'true') {
    const nameList = names.split(',').filter(Boolean)
    const rows = await sql`SELECT name, role, secure_text_number FROM providers WHERE name = ANY(${nameList}::text[]) AND secure_text_number IS NOT NULL AND practice_id = ${practiceId}::uuid`
    return res.json(rows)
  }

  let rows: unknown[]
  if (exclude_admin === 'true') {
    rows = await sql`SELECT * FROM providers WHERE role != 'admin' AND practice_id = ${practiceId}::uuid ORDER BY name`
  } else {
    rows = await sql`SELECT * FROM providers WHERE practice_id = ${practiceId}::uuid ORDER BY role, name`
  }
  res.json(rows)
}
