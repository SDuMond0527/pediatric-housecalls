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
  try {
    await verifyToken(req.headers.authorization)
  } catch {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const sql = neon(process.env.DATABASE_URL!)

  if (req.method === 'GET') {
    const { provider_id, date } = req.query as Record<string, string>
    const rows = await sql`
      SELECT * FROM schedule_blocks
      WHERE provider_id = ${provider_id}::uuid
        AND start_date <= ${date}::date
        AND end_date >= ${date}::date
      ORDER BY start_time`
    return res.json(rows)
  }

  if (req.method === 'POST') {
    const { provider_id, start_date, end_date, all_day, start_time, end_time, reason } = req.body
    const [row] = await sql`
      INSERT INTO schedule_blocks (provider_id, start_date, end_date, all_day, start_time, end_time, reason)
      VALUES (${provider_id}::uuid, ${start_date}::date, ${end_date}::date, ${all_day ?? false}, ${start_time ?? null}, ${end_time ?? null}, ${reason ?? null})
      RETURNING *`
    return res.json(row)
  }

  res.status(405).json({ error: 'Method not allowed' })
}
