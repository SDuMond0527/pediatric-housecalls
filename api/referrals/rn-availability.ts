import type { VercelRequest, VercelResponse } from '@vercel/node'
import { neon } from '@neondatabase/serverless'
import { createRemoteJWKSet, jwtVerify } from 'jose'

async function verifyToken(authHeader: string | undefined): Promise<string> {
  if (!authHeader?.startsWith('Bearer ')) throw new Error('Missing token')
  const token = authHeader.slice(7)
  const region = process.env.VITE_AWS_REGION || 'us-east-2'
  const poolId = process.env.VITE_AWS_USER_POOL_ID || ''
  const JWKS = createRemoteJWKSet(new URL(`https://cognito-idp.${region}.amazonaws.com/${poolId}/.well-known/jwks.json`))
  const { payload } = await jwtVerify(token, JWKS, { issuer: `https://cognito-idp.${region}.amazonaws.com/${poolId}` })
  if (!payload.sub) throw new Error('No sub in token')
  return payload.sub as string
}

function easternDateStr(base?: Date): string {
  return (base ?? new Date()).toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
}

/**
 * GET /api/referrals/rn-availability
 *
 * Snapshot of which RNs are on today / tomorrow with their override windows
 * and any already-booked time. Powers the inline "RN availability" panel
 * on the referral inbox so the admin doesn't need to flip to the on-call
 * schedule to see who could take the visit.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  let sub: string
  try { sub = await verifyToken(req.headers.authorization) }
  catch { return res.status(401).json({ error: 'Unauthorized' }) }

  const sql = neon(process.env.DATABASE_URL!)
  const [provider] = await sql`SELECT practice_id, is_admin FROM providers WHERE cognito_sub = ${sub} LIMIT 1`
  if (!provider)          return res.status(403).json({ error: 'Provider not found' })
  if (!provider.is_admin) return res.status(403).json({ error: 'Admin only' })

  const today    = easternDateStr()
  const tomorrow = easternDateStr(new Date(Date.now() + 86400000))

  const rns = await sql`
    SELECT id, name, zones, states, avatar_color, avatar_text_color, initials
    FROM providers
    WHERE practice_id = ${provider.practice_id}::uuid AND role = 'RN' AND is_active = true
    ORDER BY name`

  if (rns.length === 0) return res.json({ today, tomorrow, rns: [] })

  const rnIds = (rns as any[]).map(r => r.id)

  const [overrides, appts] = await Promise.all([
    sql`SELECT provider_id, date::text AS date, is_available, start_time, end_time, note
        FROM availability_overrides
        WHERE provider_id = ANY(${rnIds}::uuid[])
          AND date::date IN (${today}::date, ${tomorrow}::date)`,
    sql`SELECT provider_id, scheduled_date::text AS date, scheduled_time, COALESCE(duration_minutes, 60) AS duration_minutes, visit_type
        FROM appointments
        WHERE provider_id = ANY(${rnIds}::uuid[])
          AND scheduled_date::date IN (${today}::date, ${tomorrow}::date)
          AND status != 'cancelled'`,
  ])

  const byProvider: Record<string, any> = {}
  for (const r of rns as any[]) {
    byProvider[r.id] = {
      id: r.id, name: r.name, initials: r.initials,
      avatar_color: r.avatar_color, avatar_text_color: r.avatar_text_color,
      zones: r.zones ?? [], states: r.states ?? [],
      today:    { on: false, start: null, end: null, booked: [] as any[] },
      tomorrow: { on: false, start: null, end: null, booked: [] as any[] },
    }
  }
  for (const o of overrides as any[]) {
    const key = o.date === today ? 'today' : 'tomorrow'
    byProvider[o.provider_id][key] = {
      on: !!o.is_available,
      start: o.start_time,
      end: o.end_time,
      note: o.note ?? null,
      booked: [],
    }
  }
  for (const a of appts as any[]) {
    const key = a.date === today ? 'today' : 'tomorrow'
    byProvider[a.provider_id][key].booked.push({
      time: a.scheduled_time,
      duration_minutes: a.duration_minutes,
      visit_type: a.visit_type,
    })
  }

  return res.json({ today, tomorrow, rns: Object.values(byProvider) })
}
