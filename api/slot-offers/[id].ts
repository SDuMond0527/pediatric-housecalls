import type { VercelRequest, VercelResponse } from '@vercel/node'
import { neon } from '@neondatabase/serverless'
import { createRemoteJWKSet, jwtVerify } from 'jose'

async function verifyAnyToken(authHeader: string | undefined): Promise<{ sub: string; isFamily: boolean }> {
  if (!authHeader?.startsWith('Bearer ')) throw new Error('Missing token')
  const token = authHeader.slice(7)
  const region = process.env.VITE_AWS_REGION || 'us-east-2'
  const familyPoolId = process.env.VITE_FAMILY_USER_POOL_ID || ''
  if (familyPoolId) {
    try {
      const JWKS = createRemoteJWKSet(new URL(`https://cognito-idp.${region}.amazonaws.com/${familyPoolId}/.well-known/jwks.json`))
      const { payload } = await jwtVerify(token, JWKS, { issuer: `https://cognito-idp.${region}.amazonaws.com/${familyPoolId}` })
      if (payload.sub) return { sub: payload.sub, isFamily: true }
    } catch {}
  }
  const providerPoolId = process.env.VITE_AWS_USER_POOL_ID || ''
  const JWKS = createRemoteJWKSet(new URL(`https://cognito-idp.${region}.amazonaws.com/${providerPoolId}/.well-known/jwks.json`))
  const { payload } = await jwtVerify(token, JWKS, { issuer: `https://cognito-idp.${region}.amazonaws.com/${providerPoolId}` })
  if (!payload.sub) throw new Error('No sub in token')
  return { sub: payload.sub, isFamily: false }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  let auth: { sub: string; isFamily: boolean }
  try {
    auth = await verifyAnyToken(req.headers.authorization)
  } catch {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  if (req.method !== 'PATCH') return res.status(405).json({ error: 'Method not allowed' })

  const sql = neon(process.env.DATABASE_URL!)

  let practiceId: string
  if (auth.isFamily) {
    const rows = await sql`SELECT practice_id FROM family_profiles WHERE cognito_sub = ${auth.sub} LIMIT 1`
    if (!rows.length) return res.status(403).json({ error: 'Family not found' })
    practiceId = rows[0].practice_id as string
  } else {
    const rows = await sql`SELECT practice_id FROM providers WHERE cognito_sub = ${auth.sub} LIMIT 1`
    if (!rows.length) return res.status(403).json({ error: 'Provider not found' })
    practiceId = rows[0].practice_id as string
  }

  const { id } = req.query as { id: string }
  const { status } = req.body
  const [row] = await sql`UPDATE slot_offers SET status=${status} WHERE id=${id}::uuid AND practice_id=${practiceId}::uuid RETURNING *`
  res.json(row)
}
