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
  let sub: string
  try { sub = await verifyToken(req.headers.authorization) } catch {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const sql = neon(process.env.DATABASE_URL!)
  const [me] = await sql`SELECT is_super_admin FROM providers WHERE cognito_sub = ${sub} LIMIT 1`
  if (!me?.is_super_admin) return res.status(403).json({ error: 'Super admin access required' })

  if (req.method === 'GET') {
    const rows = await sql`SELECT * FROM practices ORDER BY created_at DESC`
    return res.json(rows)
  }

  if (req.method === 'POST') {
    const { name, slug, city, state, phone, email, subscription_tier } = req.body ?? {}
    if (!name || !slug) return res.status(400).json({ error: 'name and slug required' })

    try {
      const [practice] = await sql`
        INSERT INTO practices (name, slug, city, state, phone, email, subscription_tier)
        VALUES (
          ${name},
          ${slug},
          ${city ?? null},
          ${state ?? null},
          ${phone ?? null},
          ${email ?? null},
          ${subscription_tier ?? 'starter'}
        )
        RETURNING *`
      return res.status(201).json(practice)
    } catch (err: any) {
      if (err.message?.includes('unique') || err.message?.includes('duplicate')) {
        return res.status(409).json({ error: `Slug "${slug}" is already taken` })
      }
      throw err
    }
  }

  res.status(405).json({ error: 'Method not allowed' })
}
