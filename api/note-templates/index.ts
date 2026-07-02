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
  const [provider] = await sql`SELECT id, practice_id FROM providers WHERE cognito_sub = ${sub} LIMIT 1`
  if (!provider) return res.status(403).json({ error: 'Provider not found' })

  const { practice_id, id: providerId } = provider

  // GET — return provider's own templates + practice-shared templates
  if (req.method === 'GET') {
    const rows = await sql`
      SELECT * FROM note_templates
      WHERE practice_id = ${practice_id}::uuid
        AND (provider_id = ${providerId}::uuid OR is_shared = true)
      ORDER BY is_shared ASC, name ASC`
    return res.json(rows)
  }

  // POST — create a new template
  if (req.method === 'POST') {
    const { name, subjective, objective, plan, is_shared } = req.body
    if (!name?.trim()) return res.status(400).json({ error: 'name required' })
    const [row] = await sql`
      INSERT INTO note_templates (practice_id, provider_id, name, subjective, objective, plan, is_shared)
      VALUES (
        ${practice_id}::uuid,
        ${is_shared ? null : providerId}::uuid,
        ${name.trim()},
        ${subjective ?? ''},
        ${objective ?? ''},
        ${plan ?? ''},
        ${is_shared ?? false}
      )
      RETURNING *`
    return res.status(201).json(row)
  }

  return res.status(405).json({ error: 'Method not allowed' })
}
