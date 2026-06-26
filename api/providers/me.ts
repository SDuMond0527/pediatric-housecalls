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
    const rows = await sql`SELECT * FROM providers WHERE cognito_sub = ${sub} LIMIT 1`
    if (rows.length === 0) return res.status(404).json({ error: 'Provider not found', sub })
    const row = rows[0]
    row.zones = row.zones ?? []
    row.states = row.states ?? []
    res.json(row)
  } catch (e: unknown) {
    const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e)
    res.status(500).json({ error: msg })
  }
}
