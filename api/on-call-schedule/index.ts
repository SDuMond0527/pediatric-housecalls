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
  const providerRows = await sql`SELECT id, is_admin, practice_id, role, states, name FROM providers WHERE cognito_sub = ${sub} LIMIT 1`
  if (!providerRows.length) return res.status(403).json({ error: 'Provider not found' })
  const { is_admin: isAdmin, practice_id: practiceId } = providerRows[0] as { id: string; is_admin: boolean; practice_id: string; role: string; states: string[]; name: string }

  if (req.method === 'GET') {
    const { start, end } = req.query as Record<string, string>
    const startDate = start || new Date().toISOString().split('T')[0]
    const endDate = end || new Date(Date.now() + 14 * 86400000).toISOString().split('T')[0]
    const rows = await sql`
      SELECT oc.id, oc.date::text AS date, oc.state, oc.provider_id,
             oc.start_time, oc.end_time,
             p.name AS provider_name, p.role AS provider_role,
             p.initials, p.avatar_color, p.avatar_text_color
      FROM on_call_schedule oc
      JOIN providers p ON p.id = oc.provider_id
      WHERE oc.practice_id = ${practiceId}::uuid
        AND oc.date >= ${startDate}::date
        AND oc.date <= ${endDate}::date
      ORDER BY oc.date, oc.state`
    return res.json(rows)
  }

  if (req.method === 'POST') {
    // Non-admin provider self-claiming an on-call shift
    const { id: providerId, role, states: providerStates, name: providerName } = providerRows[0] as any
    const { date, state, start_time, end_time } = req.body as { date: string; state: string; start_time?: string | null; end_time?: string | null }
    if (!date || !state) return res.status(400).json({ error: 'date and state required' })
    if (role !== 'MD' && role !== 'PNP') return res.status(403).json({ error: 'Only MD/PNP providers can claim on-call shifts' })
    const licStates = (providerStates || []) as string[]
    if (!licStates.includes(state)) return res.status(403).json({ error: `You are not licensed in ${state}` })
    const [row] = await sql`
      INSERT INTO on_call_schedule (practice_id, date, state, provider_id, start_time, end_time)
      VALUES (${practiceId}::uuid, ${date}::date, ${state}, ${providerId}::uuid, ${start_time ?? null}, ${end_time ?? null})
      ON CONFLICT (practice_id, date, state, provider_id, start_time) DO NOTHING
      RETURNING *`
    return res.json({ ...row, provider_name: providerName })
  }

  if (req.method === 'PUT') {
    if (!isAdmin) return res.status(403).json({ error: 'Admin only' })
    const { date, state, provider_id } = req.body as { date: string; state: string; provider_id: string | null }
    if (!date || !state) return res.status(400).json({ error: 'date and state required' })
    if (!provider_id) {
      await sql`DELETE FROM on_call_schedule WHERE practice_id = ${practiceId}::uuid AND date = ${date}::date AND state = ${state}`
      return res.status(204).end()
    }
    const [row] = await sql`
      INSERT INTO on_call_schedule (practice_id, date, state, provider_id)
      VALUES (${practiceId}::uuid, ${date}::date, ${state}, ${provider_id}::uuid)
      ON CONFLICT (practice_id, date, state, provider_id) DO NOTHING
      RETURNING *`
    return res.json(row)
  }

  if (req.method === 'PATCH') {
    const { id: currentProviderId } = providerRows[0] as any
    const { id, start_time, end_time } = req.body as { id: string; start_time: string; end_time: string }
    if (!id) return res.status(400).json({ error: 'id required' })
    const existing = await sql`SELECT provider_id FROM on_call_schedule WHERE id = ${id}::uuid AND practice_id = ${practiceId}::uuid`
    if (!existing.length) return res.status(404).json({ error: 'Shift not found' })
    if (!isAdmin && existing[0].provider_id !== currentProviderId) return res.status(403).json({ error: 'Cannot edit another provider\'s shift' })
    const [row] = await sql`
      UPDATE on_call_schedule SET start_time = ${start_time ?? null}, end_time = ${end_time ?? null}
      WHERE id = ${id}::uuid AND practice_id = ${practiceId}::uuid
      RETURNING *`
    return res.json(row)
  }

  return res.status(405).json({ error: 'Method not allowed' })
}
