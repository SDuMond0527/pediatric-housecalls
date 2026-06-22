import type { VercelRequest, VercelResponse } from '@vercel/node'
import { CognitoIdentityProviderClient, AdminConfirmSignUpCommand } from '@aws-sdk/client-cognito-identity-provider'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { username } = req.body
  if (!username) return res.status(400).json({ error: 'Username required' })

  const region = process.env.VITE_AWS_REGION || 'us-east-2'
  const userPoolId = process.env.VITE_FAMILY_USER_POOL_ID
  const accessKeyId = process.env.AWS_ADMIN_ACCESS_KEY_ID
  const secretAccessKey = process.env.AWS_ADMIN_SECRET_ACCESS_KEY

  if (!userPoolId) return res.status(500).json({ error: 'VITE_FAMILY_USER_POOL_ID not set' })
  if (!accessKeyId || !secretAccessKey) return res.status(500).json({ error: 'AWS admin credentials not configured' })

  try {
    const client = new CognitoIdentityProviderClient({
      region,
      credentials: { accessKeyId, secretAccessKey },
    })
    await client.send(new AdminConfirmSignUpCommand({ UserPoolId: userPoolId, Username: username }))
    return res.json({ ok: true })
  } catch (e: any) {
    return res.status(400).json({ error: e.message })
  }
}
