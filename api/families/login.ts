import type { VercelRequest, VercelResponse } from '@vercel/node'
import { CognitoIdentityProviderClient, AdminInitiateAuthCommand } from '@aws-sdk/client-cognito-identity-provider'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
  const { username, password } = req.body
  const region = process.env.VITE_AWS_REGION || 'us-east-2'
  const userPoolId = process.env.VITE_FAMILY_USER_POOL_ID!
  const clientId = process.env.VITE_FAMILY_CLIENT_ID!
  const accessKeyId = process.env.AWS_ADMIN_ACCESS_KEY_ID!
  const secretAccessKey = process.env.AWS_ADMIN_SECRET_ACCESS_KEY!
  try {
    const client = new CognitoIdentityProviderClient({ region, credentials: { accessKeyId, secretAccessKey } })
    const result = await client.send(new AdminInitiateAuthCommand({
      UserPoolId: userPoolId, ClientId: clientId,
      AuthFlow: 'ADMIN_USER_PASSWORD_AUTH',
      AuthParameters: { USERNAME: username, PASSWORD: password },
    }))
    const t = result.AuthenticationResult!
    return res.json({ accessToken: t.AccessToken, idToken: t.IdToken, refreshToken: t.RefreshToken, expiresIn: t.ExpiresIn })
  } catch (e: any) {
    return res.status(401).json({ error: e.message, code: e.name })
  }
}
