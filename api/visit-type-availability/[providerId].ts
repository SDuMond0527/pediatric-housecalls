import type { VercelRequest, VercelResponse } from '@vercel/node'
import { neon } from '@neondatabase/serverless'
import { createRemoteJWKSet, jwtVerify } from 'jose'

async function verifyToken(authHeader: string | undefined): Promise<string> {
  if (!authHeader?.startsWith('Bearer ')) throw new Error('Missing token')
  const token = authHeader.slice(7)
  const region = process.env.VITE_AWS_REGION || 'us-east-2'
  const userPoolId = process.env.VITE_AWS_USER_POOL_ID || ''
  const JWKS = createRemoteJWKSet(new URL(`https://cognito-idp.${region}.amazonaws.com/${userPoolId}/.well-known/jwks.json`))
  const { payload } = await jwtVerify(token, JWKS, { issuer: `https://cognito-idp.${region}.amazonaws.com/${userPoolId}` })
  if (!payload.sub) throw new Error('No sub in token')
  return payload.sub
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  let sub: string
  try {
    sub = await verifyToken(req.headers.authorization)
  } catch {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  if (req.method !== 'PUT') return res.status(405).json({ error: 'Method not allowed' })

  const sql = neon(process.env.DATABASE_URL!)

  const providerRows = await sql`SELECT id, is_admin, practice_id FROM providers WHERE cognito_sub = ${sub} LIMIT 1`
  if (!providerRows.length) return res.status(403).json({ error: 'Provider not found' })
  const { id: callerId, is_admin: callerIsAdmin, practice_id: practiceId } = providerRows[0] as { id: string; is_admin: boolean; practice_id: string }

  const { providerId } = req.query as { providerId: string }

  if (!callerIsAdmin && callerId !== providerId) {
    return res.status(403).json({ error: 'Forbidden' })
  }
  const rows = req.body as Array<{ visit_type: string; is_active: boolean; start_time: string; end_time: string }>

  const results = await Promise.all(rows.map(async (r) => {
    const [row] = await sql`
      INSERT INTO visit_type_availability (practice_id, provider_id, visit_type, is_active, start_time, end_time)
      VALUES (${practiceId}::uuid, ${providerId}::uuid, ${r.visit_type}, ${r.is_active}, ${r.start_time}, ${r.end_time})
      ON CONFLICT (provider_id, visit_type) DO UPDATE
      SET is_active=EXCLUDED.is_active, start_time=EXCLUDED.start_time, end_time=EXCLUDED.end_time
      RETURNING *`
    return row
  }))
  res.json(results)
}
