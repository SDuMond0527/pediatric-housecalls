import type { VercelRequest, VercelResponse } from '@vercel/node'
import { CognitoIdentityProviderClient, AdminGetUserCommand, ListUsersCommand } from '@aws-sdk/client-cognito-identity-provider'
import { createRemoteJWKSet, jwtVerify } from 'jose'

const region     = process.env.VITE_AWS_REGION || 'us-east-2'
const userPoolId = process.env.VITE_AWS_USER_POOL_ID || ''

async function verifyAdmin(authHeader: string | undefined): Promise<string> {
  if (!authHeader?.startsWith('Bearer ')) throw new Error('Missing token')
  const token = authHeader.slice(7)
  const JWKS = createRemoteJWKSet(new URL(`https://cognito-idp.${region}.amazonaws.com/${userPoolId}/.well-known/jwks.json`))
  const { payload } = await jwtVerify(token, JWKS, { issuer: `https://cognito-idp.${region}.amazonaws.com/${userPoolId}` })
  if (!payload.sub) throw new Error('No sub')
  return payload.sub as string
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
  try { await verifyAdmin(req.headers.authorization) } catch { return res.status(401).json({ error: 'Unauthorized' }) }

  const { email } = req.body as { email: string }
  if (!email) return res.status(400).json({ error: 'email required' })

  const client = new CognitoIdentityProviderClient({
    region,
    credentials: {
      accessKeyId:     process.env.AWS_ADMIN_ACCESS_KEY_ID || '',
      secretAccessKey: process.env.AWS_ADMIN_SECRET_ACCESS_KEY || '',
    },
  })

  // Try looking up by username (email)
  try {
    const result = await client.send(new AdminGetUserCommand({ UserPoolId: userPoolId, Username: email }))
    return res.json({
      found: true,
      username: result.Username,
      status: result.UserStatus,
      attributes: result.UserAttributes,
    })
  } catch (e: any) {
    if (!e.name?.includes('UserNotFound') && !e.message?.includes('does not exist')) {
      return res.status(500).json({ error: e.message })
    }
  }

  // Fall back: search by email attribute
  const list = await client.send(new ListUsersCommand({
    UserPoolId: userPoolId,
    Filter: `email = "${email}"`,
    Limit: 5,
  }))

  if (!list.Users?.length) {
    return res.json({ found: false, message: 'No user found in Cognito with this email' })
  }

  return res.json({
    found: true,
    matchedBy: 'email attribute',
    users: list.Users.map(u => ({ username: u.Username, status: u.UserStatus, attributes: u.Attributes })),
  })
}
