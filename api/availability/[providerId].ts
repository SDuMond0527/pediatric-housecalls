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

  const sql = neon(process.env.DATABASE_URL!)

  const providerRows = await sql`SELECT practice_id FROM providers WHERE cognito_sub = ${sub} LIMIT 1`
  if (!providerRows.length) return res.status(403).json({ error: 'Provider not found' })
  const practiceId = providerRows[0].practice_id as string

  const { providerId } = req.query as { providerId: string }

  if (req.method === 'GET') {
    const [days, overrides, zoneRestrictions, timeBlocks, visitTypes] = await Promise.all([
      sql`SELECT * FROM availability WHERE provider_id = ${providerId}::uuid AND practice_id = ${practiceId}::uuid ORDER BY day_of_week`,
      sql`SELECT * FROM availability_overrides WHERE provider_id = ${providerId}::uuid AND practice_id = ${practiceId}::uuid ORDER BY date`,
      sql`SELECT * FROM zone_restrictions WHERE provider_id = ${providerId}::uuid AND practice_id = ${practiceId}::uuid`,
      sql`SELECT * FROM time_blocks WHERE provider_id = ${providerId}::uuid AND practice_id = ${practiceId}::uuid`,
      sql`SELECT * FROM visit_type_availability WHERE provider_id = ${providerId}::uuid AND practice_id = ${practiceId}::uuid`,
    ])
    return res.json({ days, overrides, zoneRestrictions, timeBlocks, visitTypes })
  }

  // PUT: upsert all availability days
  if (req.method === 'PUT') {
    const days = req.body as Array<{
      id?: string; day_of_week: number; is_active: boolean; start_time: string; end_time: string
    }>
    const results = await Promise.all(days.map(async (d) => {
      if (d.id) {
        const [row] = await sql`
          UPDATE availability SET is_active=${d.is_active}, start_time=${d.start_time}, end_time=${d.end_time}
          WHERE id=${d.id}::uuid AND practice_id=${practiceId}::uuid RETURNING *`
        return row
      } else {
        const [row] = await sql`
          INSERT INTO availability (practice_id, provider_id, day_of_week, is_active, start_time, end_time)
          VALUES (${practiceId}::uuid, ${providerId}::uuid, ${d.day_of_week}, ${d.is_active}, ${d.start_time}, ${d.end_time})
          ON CONFLICT (provider_id, day_of_week) DO UPDATE
          SET is_active=EXCLUDED.is_active, start_time=EXCLUDED.start_time, end_time=EXCLUDED.end_time
          RETURNING *`
        return row
      }
    }))
    return res.json(results)
  }

  res.status(405).json({ error: 'Method not allowed' })
}
