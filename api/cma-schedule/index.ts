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

  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  const sql = neon(process.env.DATABASE_URL!)
  const providerRows = await sql`SELECT practice_id FROM providers WHERE cognito_sub = ${sub} LIMIT 1`
  if (!providerRows.length) return res.status(403).json({ error: 'Provider not found' })
  const { practice_id: practiceId } = providerRows[0] as { practice_id: string }

  const { start, end } = req.query as Record<string, string>
  const startDate = start || new Date().toISOString().split('T')[0]
  const endDate = end || new Date(Date.now() + 13 * 86400000).toISOString().split('T')[0]

  const cmas = await sql`
    SELECT id, name, initials, avatar_color, avatar_text_color, states
    FROM providers
    WHERE practice_id = ${practiceId}::uuid AND role = 'CMA' AND is_active = true
    ORDER BY name`

  if (!cmas.length) return res.json({})

  const cmaIds = cmas.map((c: any) => c.id)

  const [availRows, overrideRows] = await Promise.all([
    sql`SELECT provider_id, day_of_week, is_active, start_time, end_time FROM availability WHERE provider_id = ANY(${cmaIds}::uuid[])`,
    sql`SELECT provider_id, date, is_available, start_time, end_time FROM availability_overrides WHERE provider_id = ANY(${cmaIds}::uuid[]) AND date >= ${startDate}::date AND date <= ${endDate}::date`,
  ])

  // Build lookup maps
  const availMap: Record<string, Record<number, any>> = {}
  for (const a of availRows) {
    if (!availMap[a.provider_id]) availMap[a.provider_id] = {}
    availMap[a.provider_id][a.day_of_week] = a
  }

  const overrideMap: Record<string, Record<string, any>> = {}
  for (const o of overrideRows) {
    const d = typeof o.date === 'string' ? o.date.slice(0, 10) : (o.date as Date).toISOString().slice(0, 10)
    if (!overrideMap[o.provider_id]) overrideMap[o.provider_id] = {}
    overrideMap[o.provider_id][d] = o
  }

  // Compute working CMAs for each date in range
  const result: Record<string, any[]> = {}
  const cur = new Date(startDate + 'T12:00:00')
  const last = new Date(endDate + 'T12:00:00')

  while (cur <= last) {
    const dateStr = cur.toISOString().slice(0, 10)
    const dow = cur.getDay()
    result[dateStr] = []

    for (const cma of cmas) {
      const override = overrideMap[cma.id]?.[dateStr]
      const weekly = availMap[cma.id]?.[dow]

      let working: boolean
      let start_time: string
      let end_time: string

      if (override) {
        working = override.is_available
        start_time = override.start_time || weekly?.start_time || '09:00'
        end_time = override.end_time || weekly?.end_time || '17:00'
      } else if (weekly) {
        working = weekly.is_active
        start_time = weekly.start_time || '09:00'
        end_time = weekly.end_time || '17:00'
      } else {
        // No schedule row — weekdays on by default, weekends off
        working = dow !== 0 && dow !== 6
        start_time = '09:00'
        end_time = '17:00'
      }

      if (working) {
        result[dateStr].push({
          provider_id: cma.id,
          name: cma.name,
          initials: cma.initials,
          avatar_color: cma.avatar_color,
          avatar_text_color: cma.avatar_text_color,
          states: cma.states ?? [],
          start_time,
          end_time,
        })
      }
    }

    cur.setDate(cur.getDate() + 1)
  }

  res.json(result)
}
