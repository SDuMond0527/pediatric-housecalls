import type { VercelRequest, VercelResponse } from '@vercel/node'
import { neon } from '@neondatabase/serverless'
import { CognitoIdentityProviderClient, AdminSetUserPasswordCommand } from '@aws-sdk/client-cognito-identity-provider'
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
  // Guarantee at least one of each required character class
  const chars = [
    upper[bytes[0] % upper.length],
    lower[bytes[1] % lower.length],
    digits[bytes[2] % digits.length],
    special[bytes[3] % special.length],
    ...Array.from({ length: 8 }, (_, i) => all[bytes[4 + i] % all.length]),
  ]
  // Fisher-Yates shuffle using remaining random bytes
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

  // Verify caller is an admin
  const [caller] = await sql`
    SELECT practice_id, is_admin FROM providers WHERE cognito_sub = ${adminSub} LIMIT 1
  `
  if (!caller?.is_admin) return res.status(403).json({ error: 'Admin access required' })

  const { provider_id } = req.body as { provider_id: string }
  if (!provider_id) return res.status(400).json({ error: 'provider_id required' })

  // Get target provider's cognito_sub
  const [target] = await sql`
    SELECT cognito_sub FROM providers
    WHERE id = ${provider_id}::uuid AND practice_id = ${caller.practice_id}::uuid
    LIMIT 1
  `
  if (!target?.cognito_sub) return res.status(404).json({ error: 'Provider not found' })

  const password = generatePassword()

  const client = new CognitoIdentityProviderClient({
    region,
    credentials: {
      accessKeyId:     process.env.AWS_ADMIN_ACCESS_KEY_ID || '',
      secretAccessKey: process.env.AWS_ADMIN_SECRET_ACCESS_KEY || '',
    },
  })

  await client.send(new AdminSetUserPasswordCommand({
    UserPoolId: userPoolId,
    Username:   target.cognito_sub,
    Password:   password,
    Permanent:  true,
  }))

  res.json({ password })
}
