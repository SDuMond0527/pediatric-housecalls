import type { VercelRequest, VercelResponse } from '@vercel/node'
import { neon } from '@neondatabase/serverless'
import { createRemoteJWKSet, jwtVerify } from 'jose'

async function verifyAnyToken(authHeader: string | undefined): Promise<{ sub: string; isFamily: boolean }> {
  if (!authHeader?.startsWith('Bearer ')) throw new Error('Missing token')
  const token = authHeader.slice(7)
  const region = process.env.VITE_AWS_REGION || 'us-east-2'
  const familyPoolId = process.env.VITE_FAMILY_USER_POOL_ID || ''
  if (familyPoolId) {
    try {
      const JWKS = createRemoteJWKSet(new URL(`https://cognito-idp.${region}.amazonaws.com/${familyPoolId}/.well-known/jwks.json`))
      const { payload } = await jwtVerify(token, JWKS, { issuer: `https://cognito-idp.${region}.amazonaws.com/${familyPoolId}` })
      if (payload.sub) return { sub: payload.sub, isFamily: true }
    } catch {}
  }
  const providerPoolId = process.env.VITE_AWS_USER_POOL_ID || ''
  const JWKS = createRemoteJWKSet(new URL(`https://cognito-idp.${region}.amazonaws.com/${providerPoolId}/.well-known/jwks.json`))
  const { payload } = await jwtVerify(token, JWKS, { issuer: `https://cognito-idp.${region}.amazonaws.com/${providerPoolId}` })
  if (!payload.sub) throw new Error('No sub in token')
  return { sub: payload.sub, isFamily: false }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  let auth: { sub: string; isFamily: boolean }
  try {
    auth = await verifyAnyToken(req.headers.authorization)
  } catch {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const sql = neon(process.env.DATABASE_URL!)

  let practiceId: string
  if (auth.isFamily) {
    const rows = await sql`SELECT id, practice_id FROM family_profiles WHERE cognito_sub = ${auth.sub} LIMIT 1`
    if (!rows.length) return res.json([])
    practiceId = rows[0].practice_id as string
    const familyProfileId = rows[0].id as string

    if (req.method === 'GET') {
      const result = await sql`SELECT * FROM booking_requests WHERE family_id = ${familyProfileId}::uuid AND practice_id = ${practiceId}::uuid ORDER BY preferred_date DESC LIMIT 20`
      return res.json(result)
    }

    if (req.method === 'POST') {
      const b = req.body
      const childIds = b.child_ids ?? []
      const [row] = await sql`
        INSERT INTO booking_requests (practice_id, family_id, child_ids, visit_type, preferred_provider, zone, state, preferred_date, preferred_time, status, confirmed_provider_id, reference_code, convenience_fee, notes)
        VALUES (${practiceId}::uuid, ${familyProfileId}::uuid, ${childIds}::uuid[], ${b.visit_type}, ${b.preferred_provider ?? null}, ${b.zone ?? null}, ${b.state ?? null}, ${b.preferred_date}::date, ${b.preferred_time}, ${b.status ?? 'pending'}, ${b.confirmed_provider_id ?? null}, ${b.reference_code}, ${b.convenience_fee ?? null}, ${b.notes ?? null})
        RETURNING *`
      return res.json(row)
    }

    return res.status(405).json({ error: 'Method not allowed' })
  }

  // Provider path
  const providerRows = await sql`SELECT practice_id FROM providers WHERE cognito_sub = ${auth.sub} LIMIT 1`
  if (!providerRows.length) return res.status(403).json({ error: 'Provider not found' })
  practiceId = providerRows[0].practice_id as string

  if (req.method === 'GET') {
    const { status, family_id, reference_code, child_id } = req.query as Record<string, string>
    let rows: unknown[]
    if (reference_code) {
      rows = await sql`SELECT * FROM booking_requests WHERE reference_code = ${reference_code} AND practice_id = ${practiceId}::uuid LIMIT 1`
    } else if (child_id) {
      rows = await sql`
        SELECT br.*, p.name AS provider_name
        FROM booking_requests br
        LEFT JOIN providers p ON p.id = br.confirmed_provider_id
        WHERE ${child_id}::uuid = ANY(br.child_ids)
          AND br.practice_id = ${practiceId}::uuid
        ORDER BY br.preferred_date DESC`
    } else if (family_id) {
      rows = await sql`SELECT * FROM booking_requests WHERE family_id = ${family_id}::uuid AND practice_id = ${practiceId}::uuid ORDER BY preferred_date DESC LIMIT 20`
    } else if (status) {
      rows = await sql`SELECT * FROM booking_requests WHERE status = ${status} AND practice_id = ${practiceId}::uuid ORDER BY created_at DESC`
    } else {
      rows = await sql`SELECT * FROM booking_requests WHERE practice_id = ${practiceId}::uuid ORDER BY created_at DESC`
    }
    return res.json(rows)
  }

  if (req.method === 'POST') {
    const b = req.body
    const childIds = b.child_ids ?? []
    const [row] = await sql`
      INSERT INTO booking_requests (practice_id, family_id, child_ids, visit_type, preferred_provider, zone, state, preferred_date, preferred_time, status, confirmed_provider_id, reference_code, convenience_fee, notes)
      VALUES (${practiceId}::uuid, ${b.family_id}::uuid, ${childIds}::uuid[], ${b.visit_type}, ${b.preferred_provider ?? null}, ${b.zone ?? null}, ${b.state ?? null}, ${b.preferred_date}::date, ${b.preferred_time}, ${b.status ?? 'pending'}, ${b.confirmed_provider_id ?? null}, ${b.reference_code}, ${b.convenience_fee ?? null}, ${b.notes ?? null})
      RETURNING *`
    return res.json(row)
  }

  res.status(405).json({ error: 'Method not allowed' })
}
