import type { VercelRequest, VercelResponse } from '@vercel/node'
import {
  CognitoIdentityProviderClient,
  AdminGetUserCommand,
} from '@aws-sdk/client-cognito-identity-provider'
import { neon } from '@neondatabase/serverless'
import { createRemoteJWKSet, jwtVerify } from 'jose'

/**
 * POST /api/providers/cognito-status
 *   body: { email }
 *
 * Admin-only diagnostic. Returns the Cognito status of a provider's
 * account so we can tell whether a Forgot-Password reset flow will
 * succeed before telling the provider to try. No mutations.
 *
 * Possible statuses:
 *   CONFIRMED            — reset will work normally
 *   UNCONFIRMED          — reset will fail (user never verified email)
 *   FORCE_CHANGE_PASSWORD — set but requires a change on next login
 *   RESET_REQUIRED       — admin reset is pending
 *   (null if user doesn't exist in Cognito at all)
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  // Verify caller is a logged-in admin.
  try {
    const auth = req.headers.authorization
    if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' })
    const token = auth.slice(7)
    const region = process.env.VITE_AWS_REGION || 'us-east-2'
    const poolId = process.env.VITE_AWS_USER_POOL_ID || ''
    const JWKS = createRemoteJWKSet(new URL(`https://cognito-idp.${region}.amazonaws.com/${poolId}/.well-known/jwks.json`))
    const { payload } = await jwtVerify(token, JWKS, { issuer: `https://cognito-idp.${region}.amazonaws.com/${poolId}` })
    const sub = payload.sub
    if (!sub) return res.status(401).json({ error: 'Unauthorized' })
    const sql = neon(process.env.DATABASE_URL!)
    const [p] = await sql`SELECT is_admin FROM providers WHERE cognito_sub = ${sub as string} LIMIT 1`
    if (!p?.is_admin) return res.status(403).json({ error: 'Admin only' })
  } catch (e: any) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const { email } = (req.body ?? {}) as { email?: string }
  if (!email || typeof email !== 'string') return res.status(400).json({ error: 'email required' })

  const region = process.env.VITE_AWS_REGION || 'us-east-2'
  const userPoolId = process.env.VITE_AWS_USER_POOL_ID
  const accessKeyId = process.env.AWS_ADMIN_ACCESS_KEY_ID
  const secretAccessKey = process.env.AWS_ADMIN_SECRET_ACCESS_KEY
  if (!userPoolId || !accessKeyId || !secretAccessKey) return res.status(500).json({ error: 'Cognito admin not configured' })

  const client = new CognitoIdentityProviderClient({ region, credentials: { accessKeyId, secretAccessKey } })
  try {
    const info = await client.send(new AdminGetUserCommand({ UserPoolId: userPoolId, Username: email.trim().toLowerCase() }))
    const attrs: Record<string, string> = {}
    for (const a of info.UserAttributes ?? []) {
      if (a.Name) attrs[a.Name] = a.Value ?? ''
    }
    return res.json({
      exists: true,
      status: info.UserStatus,
      username: info.Username,
      enabled: info.Enabled,
      attributes: attrs,
      resetWillWork: info.UserStatus === 'CONFIRMED' || info.UserStatus === 'RESET_REQUIRED',
    })
  } catch (e: any) {
    if (e?.name === 'UserNotFoundException' || /User does not exist/i.test(e?.message ?? '')) {
      return res.json({ exists: false, status: null, resetWillWork: false })
    }
    return res.status(500).json({ error: e?.message ?? 'Lookup failed' })
  }
}
