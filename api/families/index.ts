import type { VercelRequest, VercelResponse } from '@vercel/node'
import { neon } from '@neondatabase/serverless'
import { createRemoteJWKSet, jwtVerify } from 'jose'

async function verifyProviderToken(authHeader: string | undefined): Promise<string> {
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
    sub = await verifyProviderToken(req.headers.authorization)
  } catch {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const sql = neon(process.env.DATABASE_URL!)

  const providerRows = await sql`SELECT practice_id FROM providers WHERE cognito_sub = ${sub} LIMIT 1`
  if (!providerRows.length) return res.status(403).json({ error: 'Provider not found' })
  const practiceId = providerRows[0].practice_id as string

  if (req.method === 'GET') {
    const { ids } = req.query as Record<string, string>
    if (!ids) return res.json([])
    const idList = ids.split(',').filter(Boolean)
    const rows = await sql`SELECT * FROM family_profiles WHERE id = ANY(${idList}::uuid[]) AND practice_id = ${practiceId}::uuid`
    return res.json(rows)
  }

  // Admin PATCH — used by the Waitlist "edit patient info" flow to
  // update a family's contact fields. Previously saveEdit only wrote
  // to waitlist_entries.notes, leaving family_profiles.phone stale
  // (Sara DuMond 2026-09-12: cron kept sending SMS to 5555555555
  // because the source-of-truth phone was never actually updated).
  // Propagates to children.parent_* for every kid in the family so
  // all downstream displays and joins pick up the new value.
  if (req.method === 'PATCH') {
    const { id, phone, email, address_line1, city, state, zip } = req.body as Record<string, any>
    if (!id) return res.status(400).json({ error: 'family id required' })
    const [family] = await sql`SELECT id FROM family_profiles WHERE id = ${id}::uuid AND practice_id = ${practiceId}::uuid LIMIT 1`
    if (!family) return res.status(404).json({ error: 'Family not found' })

    await sql`
      UPDATE family_profiles SET
        phone         = COALESCE(${phone         ?? null}, phone),
        email         = COALESCE(${email         ?? null}, email),
        address_line1 = COALESCE(${address_line1 ?? null}, address_line1),
        city          = COALESCE(${city          ?? null}, city),
        state         = COALESCE(${state         ?? null}, state),
        zip           = COALESCE(${zip           ?? null}, zip)
      WHERE id = ${id}::uuid AND practice_id = ${practiceId}::uuid`

    // Also sync to children.parent_* so card/list displays that read
    // from children (not family_profiles) also show the new value.
    await sql`
      UPDATE children SET
        parent_phone   = COALESCE(${phone         ?? null}, parent_phone),
        parent_email   = COALESCE(${email         ?? null}, parent_email),
        parent_address = COALESCE(${address_line1 ?? null}, parent_address),
        parent_city    = COALESCE(${city          ?? null}, parent_city),
        parent_state   = COALESCE(${state         ?? null}, parent_state),
        parent_zip     = COALESCE(${zip           ?? null}, parent_zip)
      WHERE family_id = ${id}::uuid AND practice_id = ${practiceId}::uuid`
    return res.json({ ok: true })
  }

  return res.status(405).json({ error: 'Method not allowed' })
}
