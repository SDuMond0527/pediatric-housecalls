import type { VercelRequest, VercelResponse } from '@vercel/node'
import { neon } from '@neondatabase/serverless'
import { createRemoteJWKSet, jwtVerify } from 'jose'

async function verifyAnyToken(authHeader: string | undefined): Promise<void> {
  if (!authHeader?.startsWith('Bearer ')) throw new Error('Missing token')
  const token = authHeader.slice(7)
  const region = process.env.VITE_AWS_REGION || 'us-east-2'
  const familyPoolId = process.env.VITE_FAMILY_USER_POOL_ID || ''
  if (familyPoolId) {
    try {
      const JWKS = createRemoteJWKSet(new URL(`https://cognito-idp.${region}.amazonaws.com/${familyPoolId}/.well-known/jwks.json`))
      const { payload } = await jwtVerify(token, JWKS, { issuer: `https://cognito-idp.${region}.amazonaws.com/${familyPoolId}` })
      if (payload.sub) return
    } catch {}
  }
  const userPoolId = process.env.VITE_AWS_USER_POOL_ID || ''
  const JWKS = createRemoteJWKSet(new URL(`https://cognito-idp.${region}.amazonaws.com/${userPoolId}/.well-known/jwks.json`))
  const { payload } = await jwtVerify(token, JWKS, { issuer: `https://cognito-idp.${region}.amazonaws.com/${userPoolId}` })
  if (!payload.sub) throw new Error('No sub in token')
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try { await verifyAnyToken(req.headers.authorization) } catch {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  const sql = neon(process.env.DATABASE_URL!)
  const q = (req.query.q as string ?? '').trim()

  const rows = q
    ? await sql`
        SELECT DISTINCT preferred_pharmacy AS name
        FROM children
        WHERE preferred_pharmacy IS NOT NULL
          AND preferred_pharmacy ILIKE ${'%' + q + '%'}
        ORDER BY preferred_pharmacy
        LIMIT 10
      `
    : await sql`
        SELECT DISTINCT preferred_pharmacy AS name
        FROM children
        WHERE preferred_pharmacy IS NOT NULL
        ORDER BY preferred_pharmacy
        LIMIT 50
      `

  return res.json(rows.map(r => r.name))
}
