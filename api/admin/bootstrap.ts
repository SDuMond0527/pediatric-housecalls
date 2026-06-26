import type { VercelRequest, VercelResponse } from '@vercel/node'
import { neon } from '@neondatabase/serverless'
import { CognitoIdentityProviderClient, AdminCreateUserCommand } from '@aws-sdk/client-cognito-identity-provider'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const secret = process.env.BOOTSTRAP_SECRET
  if (!secret) return res.status(503).json({ error: 'Bootstrap not configured' })
  if (req.headers['x-bootstrap-secret'] !== secret) return res.status(401).json({ error: 'Invalid bootstrap secret' })

  const practiceId = process.env.VITE_PRACTICE_ID
  if (!practiceId) return res.status(500).json({ error: 'VITE_PRACTICE_ID not set' })

  const { name, email, initials } = req.body as Record<string, string>
  if (!name || !email) return res.status(400).json({ error: 'name and email are required' })

  const derivedInitials = initials || name.trim().split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase()

  const sql = neon(process.env.DATABASE_URL!)

  const [existing] = await sql`SELECT id FROM providers WHERE practice_id = ${practiceId}::uuid AND is_super_admin = true LIMIT 1`
  if (existing) return res.status(409).json({ error: 'A super admin already exists for this practice. Use the provider portal to add more providers.' })

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
      Username: email,
      UserAttributes: [
        { Name: 'email', Value: email },
        { Name: 'email_verified', Value: 'true' },
        { Name: 'name', Value: name },
      ],
      DesiredDeliveryMediums: ['EMAIL'],
    }))
    const s = result.User?.Attributes?.find(a => a.Name === 'sub')?.Value
    if (!s) throw new Error('No sub returned from Cognito')
    cognitoSub = s
  } catch (e: any) {
    return res.status(400).json({ error: e.message ?? 'Failed to create Cognito user' })
  }

  try {
    const [provider] = await sql`
      INSERT INTO providers (id, cognito_sub, name, role, initials, is_admin, is_super_admin, practice_id)
      VALUES (
        ${cognitoSub}::uuid,
        ${cognitoSub},
        ${name},
        'admin',
        ${derivedInitials},
        true,
        true,
        ${practiceId}::uuid
      )
      RETURNING *
    `
    return res.json(provider)
  } catch (e: any) {
    return res.status(500).json({ error: e.message ?? 'Failed to create provider record' })
  }
}
