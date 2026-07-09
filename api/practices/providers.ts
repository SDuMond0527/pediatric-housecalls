import type { VercelRequest, VercelResponse } from '@vercel/node'
import { neon } from '@neondatabase/serverless'
import { createRemoteJWKSet, jwtVerify } from 'jose'
import { CognitoIdentityProviderClient, AdminCreateUserCommand, AdminSetUserPasswordCommand } from '@aws-sdk/client-cognito-identity-provider'
import { randomBytes } from 'crypto'

function generatePassword(): string {
  const upper   = 'ABCDEFGHJKLMNPQRSTUVWXYZ'
  const lower   = 'abcdefghijkmnpqrstuvwxyz'
  const digits  = '23456789'
  const special = '@#$%'
  const all     = upper + lower + digits + special
  const bytes   = randomBytes(16)
  const chars = [
    upper[bytes[0] % upper.length],
    lower[bytes[1] % lower.length],
    digits[bytes[2] % digits.length],
    special[bytes[3] % special.length],
    ...Array.from({ length: 8 }, (_, i) => all[bytes[4 + i] % all.length]),
  ]
  for (let i = chars.length - 1; i > 0; i--) {
    const j = bytes[i % bytes.length] % (i + 1)
    ;[chars[i], chars[j]] = [chars[j], chars[i]]
  }
  return chars.join('')
}

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
      MessageAction: 'SUPPRESS',
    }))
    const s = result.User?.Attributes?.find(a => a.Name === 'sub')?.Value
    if (!s) throw new Error('No sub returned from Cognito')
    cognitoSub = s
  } catch (e: any) {
    return res.status(400).json({ error: e.message ?? 'Failed to create Cognito user' })
  }

  const password = generatePassword()
  try {
    await client.send(new AdminSetUserPasswordCommand({
      UserPoolId: userPoolId,
      Username: email,
      Password: password,
      Permanent: true,
    }))
  } catch (e: any) {
    return res.status(500).json({ error: 'Account created in Cognito but failed to set permanent password: ' + e.message })
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
    return res.json({ ...provider, password })
  } catch (e: any) {
    return res.status(500).json({ error: e.message ?? 'Failed to create provider record' })
  }
}
