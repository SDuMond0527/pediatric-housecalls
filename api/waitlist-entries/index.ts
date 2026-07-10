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

async function pingNotifications(waitlistEntryId: string) {
  const base = process.env.PORTAL_URL || 'https://phcbooking.com'
  try {
    await fetch(`${base}/api/notifications`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'waitlist', waitlistEntryId }),
    })
  } catch (err) {
    console.error('[waitlist-entries] notification ping failed:', err)
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  let auth: { sub: string; isFamily: boolean }
  try {
    auth = await verifyAnyToken(req.headers.authorization)
  } catch {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const sql = neon(process.env.DATABASE_URL!)

  if (auth.isFamily) {
    const profileRows = await sql`SELECT id, practice_id FROM family_profiles WHERE cognito_sub = ${auth.sub} LIMIT 1`
    if (!profileRows.length) return res.json([])
    const practiceId = profileRows[0].practice_id as string
    const familyProfileId = profileRows[0].id as string

    if (req.method === 'GET') {
      const rows = await sql`SELECT id FROM waitlist_entries WHERE family_id = ${familyProfileId}::uuid AND practice_id = ${practiceId}::uuid AND status = 'waiting'`
      return res.json(rows)
    }

    if (req.method === 'POST') {
      const b = req.body
      const childIds: string[] = b.child_ids ?? []
      const childIdsPg = `{${childIds.join(',')}}`
      const [row] = await sql`
        INSERT INTO waitlist_entries (practice_id, family_id, child_ids, visit_type, zip, zone, state, complaint, status, notes, preferred_time_window)
        VALUES (${practiceId}::uuid, ${familyProfileId}::uuid, ${childIdsPg}::uuid[], ${b.visit_type}, ${b.zip ?? null}, ${b.zone ?? null}, ${b.state ?? null}, ${b.complaint ?? null}, 'waiting', ${b.notes ?? null}, ${b.preferred_time_window ?? null})
        RETURNING *`
      await pingNotifications(row.id as string)
      return res.json(row)
    }

    return res.status(405).json({ error: 'Method not allowed' })
  }

  // Provider path
  const providerRows = await sql`SELECT practice_id, states FROM providers WHERE cognito_sub = ${auth.sub} LIMIT 1`
  if (!providerRows.length) return res.status(403).json({ error: 'Provider not found' })
  const practiceId = providerRows[0].practice_id as string
  const providerStates: string[] = (providerRows[0].states ?? []) as string[]

  if (req.method === 'GET') {
    const { status, family_id } = req.query as Record<string, string>
    let rows: unknown[]
    if (family_id) {
      rows = await sql`SELECT id FROM waitlist_entries WHERE family_id = ${family_id}::uuid AND practice_id = ${practiceId}::uuid AND status = 'waiting'`
    } else if (status) {
      if (providerStates.length > 0) {
        rows = await sql`SELECT * FROM waitlist_entries WHERE status = ${status} AND practice_id = ${practiceId}::uuid AND (state = ANY(${providerStates}::text[]) OR state IS NULL) ORDER BY created_at ASC`
      } else {
        rows = await sql`SELECT * FROM waitlist_entries WHERE status = ${status} AND practice_id = ${practiceId}::uuid ORDER BY created_at ASC`
      }
    } else {
      rows = await sql`SELECT * FROM waitlist_entries WHERE practice_id = ${practiceId}::uuid ORDER BY created_at DESC`
    }
    return res.json(rows)
  }

  if (req.method === 'POST') {
    const b = req.body
    const childIds: string[] = b.child_ids ?? []
    const childIdsPg = `{${childIds.join(',')}}`
    const [row] = await sql`
      INSERT INTO waitlist_entries (practice_id, family_id, child_ids, visit_type, zip, zone, state, complaint, status, notes, preferred_time_window)
      VALUES (${practiceId}::uuid, ${b.family_id}::uuid, ${childIdsPg}::uuid[], ${b.visit_type}, ${b.zip ?? null}, ${b.zone ?? null}, ${b.state ?? null}, ${b.complaint ?? null}, 'waiting', ${b.notes ?? null}, ${b.preferred_time_window ?? null})
      RETURNING *`
    return res.json(row)
  }

  res.status(405).json({ error: 'Method not allowed' })
}
