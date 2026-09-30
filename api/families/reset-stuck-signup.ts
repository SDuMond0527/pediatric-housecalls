import type { VercelRequest, VercelResponse } from '@vercel/node'
import {
  CognitoIdentityProviderClient,
  AdminGetUserCommand,
  AdminDeleteUserCommand,
} from '@aws-sdk/client-cognito-identity-provider'

/**
 * Called by the family signup flow when Cognito returns UsernameExists —
 * some parents get stuck as UNCONFIRMED (auto-confirm step failed on their
 * original attempt) and then can't sign up again OR reset their password
 * (AdminSetUserPassword refuses unconfirmed users). This endpoint checks
 * the user's Cognito status:
 *
 *   - UNCONFIRMED  → deletes them so signUp can succeed on retry
 *   - CONFIRMED    → returns { deleted: false, confirmed: true }
 *   - not found    → returns { deleted: false, confirmed: false }
 *
 * Auth: NONE. The delete only runs against genuinely-orphan UNCONFIRMED
 * users who never validated their email — no meaningful data to protect.
 * Rate limiting relies on Cognito's admin-op quotas.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { email } = req.body ?? {}
  if (!email || typeof email !== 'string') return res.status(400).json({ error: 'Email required' })

  const region          = process.env.VITE_AWS_REGION || 'us-east-2'
  const userPoolId      = process.env.VITE_FAMILY_USER_POOL_ID
  const accessKeyId     = process.env.AWS_ADMIN_ACCESS_KEY_ID
  const secretAccessKey = process.env.AWS_ADMIN_SECRET_ACCESS_KEY

  if (!userPoolId || !accessKeyId || !secretAccessKey) {
    return res.status(500).json({ error: 'Cognito admin not configured' })
  }

  const client = new CognitoIdentityProviderClient({ region, credentials: { accessKeyId, secretAccessKey } })
  const normalizedEmail = email.toLowerCase().trim()

  try {
    const info = await client.send(new AdminGetUserCommand({ UserPoolId: userPoolId, Username: normalizedEmail }))
    const status = info.UserStatus
    if (status === 'UNCONFIRMED') {
      await client.send(new AdminDeleteUserCommand({ UserPoolId: userPoolId, Username: normalizedEmail }))
      return res.json({ deleted: true, previousStatus: status })
    }
    return res.json({ deleted: false, confirmed: status === 'CONFIRMED', status })
  } catch (e: any) {
    if (e?.name === 'UserNotFoundException' || /User does not exist/i.test(e?.message ?? '')) {
      return res.json({ deleted: false, confirmed: false, status: null })
    }
    return res.status(400).json({ error: e?.message ?? 'Lookup failed' })
  }
}
