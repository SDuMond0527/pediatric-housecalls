import type { VercelRequest, VercelResponse } from '@vercel/node'
import { neon } from '@neondatabase/serverless'
import { createRemoteJWKSet, jwtVerify } from 'jose'
import { CognitoIdentityProviderClient, AdminCreateUserCommand } from '@aws-sdk/client-cognito-identity-provider'

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

  const sql = neon(process.env.DATABASE_URL!)

  const [caller] = await sql`SELECT is_super_admin FROM providers WHERE cognito_sub = ${sub} LIMIT 1`
  if (!caller) return res.status(403).json({ error: 'Provider not found' })
  if (!caller.is_super_admin) return res.status(403).json({ error: 'Super admin access required' })

  const { name, email, role, initials, practice_id } = req.body as Record<string, string>
  if (!name || !email || !role || !initials || !practice_id) {
    return res.status(400).json({ error: 'name, email, role, initials, and practice_id are required' })
  }

  const region = process.env.VITE_AWS_REGION || 'us-east-2'
  const userPoolId = process.env.VITE_AWS_USER_POOL_ID || ''
  const client = new CognitoIdentityProviderClient({
    region,
    credentials: {
      accessKeyId: process.env.AWS_ADMIN_ACCESS_KEY_ID!,
      secretAccessKey: process.env.AWS_ADMIN_SECRET_ACCESS_KEY!,
    },
  })

  let cognitoSub: string
  try {
    const result = await client.send(new AdminCreateUserCommand({
      UserPoolId: userPoolId,
      Username: email,
      UserAttributes: [
        { Name: 'email', Value: email },
        { Name: 'email_verified', Value: 'true' },
        { Name: 'name', Value: name },
      ],
      DesiredDeliveryMediums: ['EMAIL'],
    }))
    const s = result.User?.Attributes?.find(a => a.Name === 'sub')?.Value
    if (!s) throw new Error('No sub returned from Cognito')
    cognitoSub = s
  } catch (e: any) {
    return res.status(400).json({ error: e.message ?? 'Failed to create Cognito user' })
  }

  try {
    const [provider] = await sql`
      INSERT INTO providers (id, cognito_sub, name, role, initials, is_admin, practice_id)
      VALUES (
        ${cognitoSub}::uuid,
        ${cognitoSub},
        ${name},
        ${role},
        ${initials},
        ${role === 'admin'},
        ${practice_id}::uuid
      )
      RETURNING *
    `
    return res.json(provider)
  } catch (e: any) {
    return res.status(500).json({ error: e.message ?? 'Failed to create provider record' })
  }
}
