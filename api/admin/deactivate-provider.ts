import type { VercelRequest, VercelResponse } from '@vercel/node'
import { neon } from '@neondatabase/serverless'
import { CognitoIdentityProviderClient, AdminDisableUserCommand, AdminEnableUserCommand } from '@aws-sdk/client-cognito-identity-provider'
import { createRemoteJWKSet, jwtVerify } from 'jose'

const region     = process.env.VITE_AWS_REGION || 'us-east-2'
const userPoolId = process.env.VITE_AWS_USER_POOL_ID || ''

async function verifyAdmin(authHeader: string | undefined): Promise<string> {
  if (!authHeader?.startsWith('Bearer ')) throw new Error('Missing token')
  const token = authHeader.slice(7)
  const JWKS = createRemoteJWKSet(new URL(`https://cognito-idp.${region}.amazonaws.com/${userPoolId}/.well-known/jwks.json`))
  const { payload } = await jwtVerify(token, JWKS, { issuer: `https://cognito-idp.${region}.amazonaws.com/${userPoolId}` })
  if (!payload.sub) throw new Error('No sub in token')
  return payload.sub as string
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  let adminSub: string
  try { adminSub = await verifyAdmin(req.headers.authorization) } catch {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const sql = neon(process.env.DATABASE_URL!)
  const [caller] = await sql`SELECT practice_id, is_admin FROM providers WHERE cognito_sub = ${adminSub} LIMIT 1`
  if (!caller?.is_admin) return res.status(403).json({ error: 'Admin access required' })

  const { provider_id, reactivate } = req.body as { provider_id: string; reactivate?: boolean }
  if (!provider_id) return res.status(400).json({ error: 'provider_id required' })

  const [target] = await sql`
    SELECT cognito_sub, name FROM providers
    WHERE id = ${provider_id}::uuid AND practice_id = ${caller.practice_id}::uuid
    LIMIT 1
  `
  if (!target) return res.status(404).json({ error: 'Provider not found' })

  if (target.cognito_sub === adminSub) {
    return res.status(400).json({ error: 'You cannot deactivate your own account' })
  }

  const client = new CognitoIdentityProviderClient({
    region,
    credentials: {
      accessKeyId:     process.env.AWS_ADMIN_ACCESS_KEY_ID || '',
      secretAccessKey: process.env.AWS_ADMIN_SECRET_ACCESS_KEY || '',
    },
  })

  if (reactivate) {
    await client.send(new AdminEnableUserCommand({ UserPoolId: userPoolId, Username: target.cognito_sub }))
    const [updated] = await sql`
      UPDATE providers SET is_active = true, updated_at = now()
      WHERE id = ${provider_id}::uuid AND practice_id = ${caller.practice_id}::uuid
      RETURNING *
    `
    return res.json(updated)
  } else {
    await client.send(new AdminDisableUserCommand({ UserPoolId: userPoolId, Username: target.cognito_sub }))
    const [updated] = await sql`
      UPDATE providers SET is_active = false, updated_at = now()
      WHERE id = ${provider_id}::uuid AND practice_id = ${caller.practice_id}::uuid
      RETURNING *
    `
    return res.json(updated)
  }
}
