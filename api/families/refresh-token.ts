import type { VercelRequest, VercelResponse } from '@vercel/node'
import { CognitoIdentityProviderClient, AdminInitiateAuthCommand } from '@aws-sdk/client-cognito-identity-provider'

/**
 * POST /api/families/refresh-token
 * Body: { refreshToken: string }
 *
 * Exchanges a Cognito refresh token for a fresh access + id token.
 * Client-side auto-refresh path so a parent whose session expires
 * mid-upload (or mid-anything) gets a transparent retry instead of
 * a "please log in again" wall — critical for the intake flow where
 * a parent has already filled out 20+ fields and would lose them.
 * Sara 2026-09-25.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
  const { refreshToken } = req.body ?? {}
  if (!refreshToken || typeof refreshToken !== 'string') {
    return res.status(400).json({ error: 'refreshToken required' })
  }

  const region = process.env.VITE_AWS_REGION || 'us-east-2'
  const userPoolId = process.env.VITE_FAMILY_USER_POOL_ID!
  const clientId = process.env.VITE_FAMILY_CLIENT_ID!
  const accessKeyId = process.env.AWS_ADMIN_ACCESS_KEY_ID!
  const secretAccessKey = process.env.AWS_ADMIN_SECRET_ACCESS_KEY!

  try {
    const client = new CognitoIdentityProviderClient({ region, credentials: { accessKeyId, secretAccessKey } })
    const result = await client.send(new AdminInitiateAuthCommand({
      UserPoolId: userPoolId,
      ClientId: clientId,
      AuthFlow: 'REFRESH_TOKEN_AUTH',
      AuthParameters: { REFRESH_TOKEN: refreshToken },
    }))
    const t = result.AuthenticationResult
    if (!t?.AccessToken) return res.status(401).json({ error: 'Refresh failed — please log in again.' })
    return res.json({
      accessToken: t.AccessToken,
      idToken:     t.IdToken,
      // Cognito's REFRESH_TOKEN_AUTH flow does NOT return a new refresh
      // token — the caller keeps using the one it already has until it
      // expires (default 30 days).
      expiresIn:   t.ExpiresIn,
    })
  } catch (e: any) {
    return res.status(401).json({ error: e.message || 'Refresh failed — please log in again.', code: e.name })
  }
}
