import type { VercelRequest, VercelResponse } from '@vercel/node'
import { CognitoIdentityProviderClient, AdminCreateUserCommand } from '@aws-sdk/client-cognito-identity-provider'
import sql from '../_lib/db'
import { getProviderContext } from '../_lib/auth'

async function requireSuperAdmin(authHeader: string | undefined) {
  const ctx = await getProviderContext(authHeader)
  const [p] = await sql`SELECT is_super_admin FROM providers WHERE id = ${ctx.providerId}::uuid`
  if (!p?.is_super_admin) throw new Error('Forbidden')
  return ctx
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    await requireSuperAdmin(req.headers.authorization)
  } catch (e: any) {
    return res.status(e.message === 'Forbidden' ? 403 : 401).json({ error: e.message })
  }

  if (req.method === 'GET') {
    const practices = await sql`SELECT * FROM practices ORDER BY created_at DESC`
    return res.json(practices)
  }

  if (req.method === 'POST') {
    const { name, slug, city, state, subscription_tier, admin_name, admin_email } = req.body ?? {}
    if (!name || !slug || !admin_name || !admin_email) {
      return res.status(400).json({ error: 'name, slug, admin_name, and admin_email are required' })
    }

    // Create practice record
    const [practice] = await sql`
      INSERT INTO practices (name, slug, city, state, subscription_tier)
      VALUES (${name}, ${slug}, ${city ?? null}, ${state ?? null}, ${subscription_tier ?? 'starter'})
      RETURNING *`

    // Create Cognito user in provider pool — sends them an invite email with temp password
    const region = process.env.VITE_AWS_REGION || 'us-east-2'
    const userPoolId = process.env.VITE_AWS_USER_POOL_ID || ''
    const client = new CognitoIdentityProviderClient({
      region,
      credentials: {
        accessKeyId: process.env.AWS_ADMIN_ACCESS_KEY_ID!,
        secretAccessKey: process.env.AWS_ADMIN_SECRET_ACCESS_KEY!,
      },
    })

    let cognitoSub: string
    try {
      const result = await client.send(new AdminCreateUserCommand({
        UserPoolId: userPoolId,
        Username: admin_email,
        UserAttributes: [
          { Name: 'email', Value: admin_email },
          { Name: 'email_verified', Value: 'true' },
          { Name: 'name', Value: admin_name },
        ],
        DesiredDeliveryMediums: ['EMAIL'],
      }))
      cognitoSub = result.User?.Attributes?.find(a => a.Name === 'sub')?.Value ?? ''
      if (!cognitoSub) throw new Error('Cognito did not return a sub')
    } catch (e: any) {
      await sql`DELETE FROM practices WHERE id = ${practice.id}::uuid`
      return res.status(500).json({ error: `Failed to create login: ${e.message}` })
    }

    // Create provider/admin record in DB
    const initials = admin_name.split(' ').map((w: string) => w[0] ?? '').join('').toUpperCase().slice(0, 2)
    const [provider] = await sql`
      INSERT INTO providers (id, cognito_sub, name, role, initials, is_admin, is_active, practice_id)
      VALUES (${cognitoSub}::uuid, ${cognitoSub}, ${admin_name}, 'admin', ${initials}, true, true, ${practice.id}::uuid)
      RETURNING *`

    return res.status(201).json({ practice, provider })
  }

  res.status(405).json({ error: 'Method not allowed' })
}
