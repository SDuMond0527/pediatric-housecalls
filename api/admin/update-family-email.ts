import type { VercelRequest, VercelResponse } from '@vercel/node'
import {
  CognitoIdentityProviderClient,
  AdminUpdateUserAttributesCommand,
  AdminGetUserCommand,
} from '@aws-sdk/client-cognito-identity-provider'
import { neon } from '@neondatabase/serverless'

/**
 * POST /api/admin/update-family-email
 *   body: { family_id, new_email }
 *   header: X-Internal-Service-Token
 *
 * Fixes a typo on a parent account by updating the email everywhere it
 * matters in one shot:
 *   1. Cognito user attribute `email` (family pool) — drives login
 *   2. family_profiles.email
 *   3. children.parent_email for every child in the family
 *
 * Marks the Cognito email as verified so the parent doesn't get stuck
 * in a re-verification loop on their next login.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const expected = process.env.INTERNAL_SERVICE_TOKEN || ''
  const provided = String(req.headers['x-internal-service-token'] ?? '')
  if (!expected || provided !== expected) return res.status(401).json({ error: 'Unauthorized' })

  const { family_id, new_email } = (req.body ?? {}) as { family_id?: string; new_email?: string }
  if (!family_id) return res.status(400).json({ error: 'family_id required' })
  if (!new_email) return res.status(400).json({ error: 'new_email required' })
  const normalized = new_email.trim().toLowerCase()
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalized)) return res.status(400).json({ error: 'new_email does not look like a valid email' })

  const region = process.env.VITE_AWS_REGION || 'us-east-2'
  const userPoolId = process.env.VITE_FAMILY_USER_POOL_ID
  const accessKeyId = process.env.AWS_ADMIN_ACCESS_KEY_ID
  const secretAccessKey = process.env.AWS_ADMIN_SECRET_ACCESS_KEY
  if (!userPoolId || !accessKeyId || !secretAccessKey) return res.status(500).json({ error: 'Cognito admin not configured' })

  const sql = neon(process.env.DATABASE_URL!)
  const [family] = await sql`SELECT id, cognito_sub, email FROM family_profiles WHERE id = ${family_id}::uuid LIMIT 1`
  if (!family) return res.status(404).json({ error: 'Family not found' })
  if (!family.cognito_sub) return res.status(400).json({ error: 'Family profile has no cognito_sub' })

  const client = new CognitoIdentityProviderClient({ region, credentials: { accessKeyId, secretAccessKey } })

  try {
    const before = await client.send(new AdminGetUserCommand({ UserPoolId: userPoolId, Username: family.cognito_sub }))
    const oldCognitoEmail = (before.UserAttributes ?? []).find(a => a.Name === 'email')?.Value ?? null

    await client.send(new AdminUpdateUserAttributesCommand({
      UserPoolId: userPoolId,
      Username: family.cognito_sub,
      UserAttributes: [
        { Name: 'email', Value: normalized },
        { Name: 'email_verified', Value: 'true' },
      ],
    }))

    const [profile] = await sql`
      UPDATE family_profiles SET email = ${normalized} WHERE id = ${family_id}::uuid
      RETURNING id, email`

    const children = await sql`
      UPDATE children SET parent_email = ${normalized} WHERE family_id = ${family_id}::uuid
      RETURNING id, first_name, last_name`

    return res.json({
      ok: true,
      old_cognito_email: oldCognitoEmail,
      old_db_email: family.email,
      new_email: normalized,
      profile_updated: profile,
      children_updated: children,
    })
  } catch (e: any) {
    console.error('[admin/update-family-email]', e?.message)
    return res.status(400).json({ error: e?.message ?? 'Update failed' })
  }
}
