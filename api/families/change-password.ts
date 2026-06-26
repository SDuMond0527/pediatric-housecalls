import type { VercelRequest, VercelResponse } from '@vercel/node'
import { CognitoIdentityProviderClient, ChangePasswordCommand } from '@aws-sdk/client-cognito-identity-provider'
import { getFamilyContext } from '../_lib/auth'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  try {
    await getFamilyContext(req.headers.authorization)
  } catch {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const { currentPassword, newPassword } = req.body
  if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Current and new password required' })

  const accessToken = req.headers.authorization!.slice(7)
  const region = process.env.VITE_AWS_REGION || 'us-east-2'

  try {
    const client = new CognitoIdentityProviderClient({ region })
    await client.send(new ChangePasswordCommand({
      AccessToken: accessToken,
      PreviousPassword: currentPassword,
      ProposedPassword: newPassword,
    }))
    return res.json({ ok: true })
  } catch (e: any) {
    return res.status(400).json({ error: e.message ?? 'Password change failed' })
  }
}
