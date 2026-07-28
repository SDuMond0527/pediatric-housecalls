import type { VercelRequest, VercelResponse } from '@vercel/node'
import { neon } from '@neondatabase/serverless'
import { CognitoIdentityProviderClient, AdminCreateUserCommand, AdminSetUserPasswordCommand, AdminDeleteUserCommand, AdminGetUserCommand } from '@aws-sdk/client-cognito-identity-provider'
import { createRemoteJWKSet, jwtVerify } from 'jose'
import { randomBytes } from 'crypto'

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

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  let adminSub: string
  try {
    adminSub = await verifyAdmin(req.headers.authorization)
  } catch {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const sql = neon(process.env.DATABASE_URL!)
  const [caller] = await sql`SELECT is_admin FROM providers WHERE cognito_sub = ${adminSub} LIMIT 1`
  if (!caller?.is_admin) return res.status(403).json({ error: 'Admin access required' })

  const { provider_id, email: rawEmail } = req.body as { provider_id: string; email: string }
  if (!provider_id || !rawEmail) return res.status(400).json({ error: 'provider_id and email are required' })
  const email = rawEmail.trim().toLowerCase()

  const [provider] = await sql`
    SELECT id, cognito_sub, name FROM providers WHERE id = ${provider_id}::uuid LIMIT 1
  `
  if (!provider) return res.status(404).json({ error: 'Provider not found' })

  const client = new CognitoIdentityProviderClient({
    region,
    credentials: {
      accessKeyId:     process.env.AWS_ADMIN_ACCESS_KEY_ID || '',
      secretAccessKey: process.env.AWS_ADMIN_SECRET_ACCESS_KEY || '',
    },
  })

  // Check if a Cognito user already exists for this email
  let existingUser: { username: string; sub: string } | null = null
  try {
    const found = await client.send(new AdminGetUserCommand({ UserPoolId: userPoolId, Username: email }))
    const sub = found.UserAttributes?.find(a => a.Name === 'sub')?.Value
    if (found.Username && sub) existingUser = { username: found.Username, sub }
  } catch { /* no existing user */ }

  const password = generatePassword()
  let actualUsername: string
  let newSub: string

  if (existingUser && existingUser.username === email) {
    // User already exists with email as username — just reset password
    actualUsername = existingUser.username
    newSub = existingUser.sub
    try {
      await client.send(new AdminSetUserPasswordCommand({
        UserPoolId: userPoolId,
        Username: actualUsername,
        Password: password,
        Permanent: false,
      }))
    } catch (e: any) {
      return res.status(500).json({ error: 'Failed to set password: ' + (e.message ?? String(e)) })
    }
  } else {
    // Delete any existing UUID-username user and create a fresh one with email as username.
    // Use TemporaryPassword at creation time — AdminSetUserPasswordCommand silently fails in this pool.
    if (existingUser) {
      try { await client.send(new AdminDeleteUserCommand({ UserPoolId: userPoolId, Username: existingUser.username })) } catch { /* ignore */ }
    }
    try { await client.send(new AdminDeleteUserCommand({ UserPoolId: userPoolId, Username: provider.cognito_sub })) } catch { /* ignore */ }

    try {
      const result = await client.send(new AdminCreateUserCommand({
        UserPoolId: userPoolId,
        Username: email,
        TemporaryPassword: password,
        UserAttributes: [
          { Name: 'email', Value: email },
          { Name: 'email_verified', Value: 'true' },
          { Name: 'name', Value: provider.name },
        ],
        // No MessageAction: SUPPRESS — let Cognito email the temp password directly to the provider
      }))
      const s = result.User?.Attributes?.find(a => a.Name === 'sub')?.Value
      if (!s) throw new Error('No sub returned from Cognito')
      newSub = s
      actualUsername = result.User?.Username ?? email
    } catch (e: any) {
      return res.status(500).json({ error: 'Failed to create Cognito user: ' + (e.message ?? String(e)) })
    }
  }

  await sql`UPDATE providers SET cognito_sub = ${newSub}, email = ${email} WHERE id = ${provider_id}::uuid`

  res.json({
    password,
    cognito_username: actualUsername,
    cognito_sub: newSub,
    mustChangePassword: true,
    message: 'Temporary password set. Provider must set their own password on first login.',
  })
}
