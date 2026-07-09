import type { VercelRequest, VercelResponse } from '@vercel/node'
import { CognitoIdentityProviderClient, AdminSetUserPasswordCommand } from '@aws-sdk/client-cognito-identity-provider'
import { verifyResetToken } from '../_lib/reset-token'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { token, newPassword } = req.body ?? {}
  if (!token || !newPassword) return res.status(400).json({ error: 'Token and new password required' })

  const payload = verifyResetToken(token)
  if (!payload || payload.userType !== 'provider') return res.status(400).json({ error: 'Invalid or expired reset link' })

  if (newPassword.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' })

  const region     = process.env.VITE_AWS_REGION || 'us-east-2'
  const userPoolId = process.env.VITE_AWS_USER_POOL_ID
  const accessKeyId     = process.env.AWS_ADMIN_ACCESS_KEY_ID
  const secretAccessKey = process.env.AWS_ADMIN_SECRET_ACCESS_KEY

  if (!userPoolId || !accessKeyId || !secretAccessKey) return res.status(500).json({ error: 'Not configured' })

  try {
    const client = new CognitoIdentityProviderClient({ region, credentials: { accessKeyId, secretAccessKey } })
    await client.send(new AdminSetUserPasswordCommand({
      UserPoolId: userPoolId,
      Username: payload.email,
      Password: newPassword,
      Permanent: true,
    }))
    return res.json({ ok: true })
  } catch (e: any) {
    return res.status(400).json({ error: e.message ?? 'Password reset failed' })
  }
}
