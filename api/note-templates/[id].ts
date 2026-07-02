import type { VercelRequest, VercelResponse } from '@vercel/node'
import { neon } from '@neondatabase/serverless'
import { createRemoteJWKSet, jwtVerify } from 'jose'

async function verifyToken(authHeader: string | undefined): Promise<{ sub: string }> {
  if (!authHeader?.startsWith('Bearer ')) throw new Error('Missing token')
  const token = authHeader.slice(7)
  const region = process.env.VITE_AWS_REGION || 'us-east-2'
  const userPoolId = process.env.VITE_AWS_USER_POOL_ID || ''
  const JWKS = createRemoteJWKSet(new URL(`https://cognito-idp.${region}.amazonaws.com/${userPoolId}/.well-known/jwks.json`))
  const { payload } = await jwtVerify(token, JWKS, { issuer: `https://cognito-idp.${region}.amazonaws.com/${userPoolId}` })
  if (!payload.sub) throw new Error('No sub in token')
  return { sub: payload.sub as string }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  let sub: string
  try {
    ({ sub } = await verifyToken(req.headers.authorization))
  } catch {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const sql = neon(process.env.DATABASE_URL!)
  const [provider] = await sql`SELECT id, practice_id, is_admin FROM providers WHERE cognito_sub = ${sub} LIMIT 1`
  if (!provider) return res.status(403).json({ error: 'Provider not found' })

  const { id } = req.query as { id: string }

  const [template] = await sql`SELECT * FROM note_templates WHERE id = ${id}::uuid LIMIT 1`
  if (!template) return res.status(404).json({ error: 'Template not found' })
  if (template.practice_id !== provider.practice_id) return res.status(403).json({ error: 'Forbidden' })

  // Only the owning provider or an admin can modify/delete
  const canEdit = provider.is_admin || template.provider_id === provider.id || template.provider_id === null && provider.is_admin
  if (!canEdit) return res.status(403).json({ error: 'Not authorized to edit this template' })

  // PATCH — update
  if (req.method === 'PATCH') {
    const { name, subjective, objective, plan, is_shared } = req.body
    const [row] = await sql`
      UPDATE note_templates SET
        name       = COALESCE(${name?.trim() ?? null}, name),
        subjective = COALESCE(${subjective ?? null}, subjective),
        objective  = COALESCE(${objective ?? null}, objective),
        plan       = COALESCE(${plan ?? null}, plan),
        is_shared  = COALESCE(${is_shared ?? null}, is_shared),
        provider_id = CASE WHEN ${is_shared ?? null} = true THEN NULL ELSE provider_id END
      WHERE id = ${id}::uuid
      RETURNING *`
    return res.json(row)
  }

  // DELETE
  if (req.method === 'DELETE') {
    await sql`DELETE FROM note_templates WHERE id = ${id}::uuid`
    return res.json({ ok: true })
  }

  return res.status(405).json({ error: 'Method not allowed' })
}
