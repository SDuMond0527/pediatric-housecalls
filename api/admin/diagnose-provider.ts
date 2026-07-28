import type { VercelRequest, VercelResponse } from '@vercel/node'
import { neon } from '@neondatabase/serverless'
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

  const { provider_id } = req.body as { provider_id: string }
  if (!provider_id) return res.status(400).json({ error: 'provider_id required' })

  const sql = neon(process.env.DATABASE_URL!)
  const [row] = await sql`SELECT id, cognito_sub, email, name, is_active FROM providers WHERE id = ${provider_id}::uuid LIMIT 1`
  if (!row) return res.status(404).json({ error: 'Provider not found in database' })

  const client = new CognitoIdentityProviderClient({
    region,
    credentials: {
      accessKeyId:     process.env.AWS_ADMIN_ACCESS_KEY_ID || '',
      secretAccessKey: process.env.AWS_ADMIN_SECRET_ACCESS_KEY || '',
    },
  })

  const result: Record<string, unknown> = {
    db: {
      id: row.id,
      cognito_sub: row.cognito_sub,
      email: row.email,
      name: row.name,
      is_active: row.is_active,
    },
    cognito_by_email: null,
    cognito_by_sub: null,
    issues: [] as string[],
  }

  const issues = result.issues as string[]

  // Look up Cognito user by email (as username)
  if (row.email) {
    try {
      const u = await client.send(new AdminGetUserCommand({ UserPoolId: userPoolId, Username: row.email }))
      const cognitoSub = u.UserAttributes?.find(a => a.Name === 'sub')?.Value
      result.cognito_by_email = {
        username: u.Username,
        status: u.UserStatus,
        enabled: u.Enabled,
        sub: cognitoSub,
        email_verified: u.UserAttributes?.find(a => a.Name === 'email_verified')?.Value,
      }
      if (cognitoSub !== row.cognito_sub) {
        issues.push(`SUB MISMATCH: DB has cognito_sub=${row.cognito_sub} but Cognito user at ${row.email} has sub=${cognitoSub}`)
      }
      if (!u.Enabled) issues.push('Cognito account is DISABLED — user cannot log in')
      if (u.UserStatus === 'FORCE_CHANGE_PASSWORD') issues.push('Status is FORCE_CHANGE_PASSWORD — permanent password was not set correctly')
    } catch (e: any) {
      result.cognito_by_email = { error: e.message }
      issues.push(`No Cognito user found with username="${row.email}": ${e.message}`)
    }
  } else {
    issues.push('No email stored in DB — cannot look up by email')
  }

  // Look up Cognito user by cognito_sub (via ListUsers)
  if (row.cognito_sub) {
    try {
      const list = await client.send(new ListUsersCommand({
        UserPoolId: userPoolId,
        Filter: `sub = "${row.cognito_sub}"`,
        Limit: 1,
      }))
      if (list.Users?.length) {
        const u = list.Users[0]
        result.cognito_by_sub = {
          username: u.Username,
          status: u.UserStatus,
          enabled: u.Enabled,
          email_attr: u.Attributes?.find(a => a.Name === 'email')?.Value,
        }
        if (u.Username !== row.email) {
          issues.push(`USERNAME MISMATCH: Cognito user for sub=${row.cognito_sub} has username="${u.Username}" but DB email="${row.email}"`)
        }
      } else {
        result.cognito_by_sub = { error: 'No user found with this sub' }
        issues.push(`No Cognito user found with sub=${row.cognito_sub}`)
      }
    } catch (e: any) {
      result.cognito_by_sub = { error: e.message }
    }
  }

  if (issues.length === 0) issues.push('No issues detected — credentials may simply be wrong')

  res.json(result)
}
