import type { VercelRequest, VercelResponse } from '@vercel/node'
import {
  CognitoIdentityProviderClient,
  AdminUpdateUserAttributesCommand,
  AdminGetUserCommand,
} from '@aws-sdk/client-cognito-identity-provider'
import { neon } from '@neondatabase/serverless'
import { createRemoteJWKSet, jwtVerify } from 'jose'

/**
 * POST /api/providers/update-cognito-email
 *   body: { sub, newEmail }
 *
 * Admin-only. Updates the `email` attribute (and sets email_verified
 * to true) on a provider's Cognito user. Used when the email on the
 * Cognito account is wrong — common cause: provisioning typo. The
 * Cognito Username is immutable (it's the sub), but the email
 * attribute (which drives email-alias login + password reset) can be
 * freely updated. We also mark email_verified so the user doesn't
 * need to re-verify via a code.
 *
 * No DB side-effect — update the providers row separately if needed.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  // Admin auth.
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
  } catch {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const { sub, newEmail } = (req.body ?? {}) as { sub?: string; newEmail?: string }
  if (!sub || typeof sub !== 'string') return res.status(400).json({ error: 'sub required' })
  if (!newEmail || typeof newEmail !== 'string') return res.status(400).json({ error: 'newEmail required' })
  const normalized = newEmail.trim().toLowerCase()
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalized)) return res.status(400).json({ error: 'newEmail does not look like a valid email' })

  const region = process.env.VITE_AWS_REGION || 'us-east-2'
  const userPoolId = process.env.VITE_AWS_USER_POOL_ID
  const accessKeyId = process.env.AWS_ADMIN_ACCESS_KEY_ID
  const secretAccessKey = process.env.AWS_ADMIN_SECRET_ACCESS_KEY
  if (!userPoolId || !accessKeyId || !secretAccessKey) return res.status(500).json({ error: 'Cognito admin not configured' })

  const client = new CognitoIdentityProviderClient({ region, credentials: { accessKeyId, secretAccessKey } })

  try {
    // Confirm the Cognito user exists under this sub before mutating.
    const before = await client.send(new AdminGetUserCommand({ UserPoolId: userPoolId, Username: sub }))
    const oldEmail = (before.UserAttributes ?? []).find(a => a.Name === 'email')?.Value ?? null

    await client.send(new AdminUpdateUserAttributesCommand({
      UserPoolId: userPoolId,
      Username: sub,
      UserAttributes: [
        { Name: 'email', Value: normalized },
        { Name: 'email_verified', Value: 'true' },
      ],
    }))

    return res.json({ ok: true, oldEmail, newEmail: normalized })
  } catch (e: any) {
    console.error('[providers/update-cognito-email]', e?.message)
    return res.status(400).json({ error: e?.message ?? 'Update failed' })
  }
}
