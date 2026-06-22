import type { VercelRequest, VercelResponse } from '@vercel/node'
import { CognitoIdentityProviderClient, DescribeUserPoolClientCommand, UpdateUserPoolClientCommand } from '@aws-sdk/client-cognito-identity-provider'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const region = process.env.VITE_AWS_REGION || 'us-east-2'
  const userPoolId = process.env.VITE_FAMILY_USER_POOL_ID!
  const clientId = process.env.VITE_FAMILY_CLIENT_ID!
  const accessKeyId = process.env.AWS_ADMIN_ACCESS_KEY_ID!
  const secretAccessKey = process.env.AWS_ADMIN_SECRET_ACCESS_KEY!

  const client = new CognitoIdentityProviderClient({ region, credentials: { accessKeyId, secretAccessKey } })

  if (req.method === 'GET') {
    const result = await client.send(new DescribeUserPoolClientCommand({ UserPoolId: userPoolId, ClientId: clientId }))
    return res.json({
      ExplicitAuthFlows: result.UserPoolClient?.ExplicitAuthFlows,
      HasClientSecret: !!result.UserPoolClient?.ClientSecret,
    })
  }

  if (req.method === 'POST') {
    const current = await client.send(new DescribeUserPoolClientCommand({ UserPoolId: userPoolId, ClientId: clientId }))
    const c = current.UserPoolClient!
    await client.send(new UpdateUserPoolClientCommand({
      UserPoolId: userPoolId,
      ClientId: clientId,
      ClientName: c.ClientName,
      ExplicitAuthFlows: ['ALLOW_USER_SRP_AUTH', 'ALLOW_USER_PASSWORD_AUTH', 'ALLOW_ADMIN_USER_PASSWORD_AUTH', 'ALLOW_REFRESH_TOKEN_AUTH'],
      SupportedIdentityProviders: c.SupportedIdentityProviders,
      CallbackURLs: c.CallbackURLs,
      LogoutURLs: c.LogoutURLs,
      AllowedOAuthFlows: c.AllowedOAuthFlows,
      AllowedOAuthScopes: c.AllowedOAuthScopes,
      AllowedOAuthFlowsUserPoolClient: c.AllowedOAuthFlowsUserPoolClient,
    }))
    return res.json({ ok: true, message: 'Auth flows updated' })
  }

  res.status(405).json({ error: 'Method not allowed' })
}
