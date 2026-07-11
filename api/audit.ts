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
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  let sub: string
  try {
    sub = await verifyToken(req.headers.authorization)
  } catch {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const { action, resource_type, resource_id } = req.body as {
    action: string
    resource_type: string
    resource_id?: string
  }

  if (!action || !resource_type) return res.status(400).json({ error: 'action and resource_type required' })

  const sql = neon(process.env.DATABASE_URL!)

  const [providerRow] = await sql`SELECT id FROM providers WHERE cognito_sub = ${sub} LIMIT 1`
  if (!providerRow) return res.status(403).json({ error: 'Provider not found' })

  await sql`
    INSERT INTO phi_audit_log (provider_id, action, resource_type, resource_id)
    VALUES (${providerRow.id}::uuid, ${action}, ${resource_type}, ${resource_id ?? null})`

  return res.status(204).end()
}
