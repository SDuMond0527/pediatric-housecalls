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

  if (req.method === 'GET') {
    const { status, family_id } = req.query as Record<string, string>
    let rows: unknown[]
    if (auth.isFamily) {
      const [profile] = await sql`SELECT id FROM family_profiles WHERE cognito_sub = ${auth.sub} LIMIT 1`
      if (!profile) return res.json([])
      rows = await sql`SELECT id FROM waitlist_entries WHERE family_id = ${profile.id}::uuid AND status = 'waiting'`
    } else if (family_id) {
      rows = await sql`SELECT id FROM waitlist_entries WHERE family_id = ${family_id}::uuid AND status = 'waiting'`
    } else if (status) {
      rows = await sql`SELECT * FROM waitlist_entries WHERE status = ${status} ORDER BY created_at ASC`
    } else {
      rows = await sql`SELECT * FROM waitlist_entries ORDER BY created_at DESC`
    }
    return res.json(rows)
  }

  if (req.method === 'POST') {
    const b = req.body
    const childIds = b.child_ids ?? []
    let familyId = b.family_id
    if (auth.isFamily) {
      const [profile] = await sql`SELECT id FROM family_profiles WHERE cognito_sub = ${auth.sub} LIMIT 1`
      if (!profile) return res.status(404).json({ error: 'Family profile not found' })
      familyId = profile.id
    }
    const [row] = await sql`
      INSERT INTO waitlist_entries (family_id, child_ids, visit_type, zip, zone, state, complaint, status, notes, preferred_time_window)
      VALUES (${familyId}::uuid, ${JSON.stringify(childIds)}::uuid[], ${b.visit_type}, ${b.zip ?? null}, ${b.zone ?? null}, ${b.state ?? null}, ${b.complaint ?? null}, 'waiting', ${b.notes ?? null}, ${b.preferred_time_window ?? null})
      RETURNING *`
    return res.json(row)
  }

  res.status(405).json({ error: 'Method not allowed' })
}
