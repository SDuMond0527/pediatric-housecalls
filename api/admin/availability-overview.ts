import type { VercelRequest, VercelResponse } from '@vercel/node'
import { neon } from '@neondatabase/serverless'
import { createRemoteJWKSet, jwtVerify } from 'jose'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  const authHeader = req.headers.authorization
  if (!authHeader?.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' })

  const token = authHeader.slice(7)
  const region = process.env.VITE_AWS_REGION || 'us-east-2'
  const userPoolId = process.env.VITE_AWS_USER_POOL_ID || ''
  const JWKS = createRemoteJWKSet(new URL(`https://cognito-idp.${region}.amazonaws.com/${userPoolId}/.well-known/jwks.json`))

  let sub: string
  try {
    const { payload } = await jwtVerify(token, JWKS, { issuer: `https://cognito-idp.${region}.amazonaws.com/${userPoolId}` })
    sub = payload.sub as string
  } catch {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const sql = neon(process.env.DATABASE_URL!)
  const myRows = await sql`SELECT practice_id FROM providers WHERE cognito_sub = ${sub} LIMIT 1`
  if (!myRows.length) return res.status(403).json({ error: 'Not found' })
  const practiceId = myRows[0].practice_id as string

  const [providers, availability, overrides] = await Promise.all([
    sql`SELECT id, name, role, initials, avatar_color, avatar_text_color FROM providers WHERE practice_id = ${practiceId}::uuid AND role != 'admin' AND is_active = true ORDER BY name`,
    sql`SELECT provider_id, day_of_week, is_active, start_time, end_time FROM availability WHERE practice_id = ${practiceId}::uuid ORDER BY day_of_week`,
    sql`SELECT provider_id, date, is_available, start_time, end_time, note FROM availability_overrides WHERE practice_id = ${practiceId}::uuid AND date >= CURRENT_DATE AND date <= CURRENT_DATE + INTERVAL '60 days' ORDER BY date`,
  ])

  res.json({ providers, availability, overrides })
}
