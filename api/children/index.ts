import type { VercelRequest, VercelResponse } from '@vercel/node'
import { neon } from '@neondatabase/serverless'
import { createRemoteJWKSet, jwtVerify } from 'jose'

async function verifyAnyToken(authHeader: string | undefined): Promise<string> {
  if (!authHeader?.startsWith('Bearer ')) throw new Error('Missing token')
  const token = authHeader.slice(7)
  const region = process.env.VITE_AWS_REGION || 'us-east-2'
  for (const poolId of [process.env.VITE_FAMILY_USER_POOL_ID, process.env.VITE_AWS_USER_POOL_ID].filter(Boolean)) {
    try {
      const JWKS = createRemoteJWKSet(new URL(`https://cognito-idp.${region}.amazonaws.com/${poolId}/.well-known/jwks.json`))
      const { payload } = await jwtVerify(token, JWKS, { issuer: `https://cognito-idp.${region}.amazonaws.com/${poolId}` })
      if (payload.sub) return payload.sub
    } catch {}
  }
  throw new Error('Invalid token')
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  let sub: string
  try {
    sub = await verifyAnyToken(req.headers.authorization)
  } catch {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const sql = neon(process.env.DATABASE_URL!)

  if (req.method === 'GET') {
    const { family_ids, ids, search } = req.query as Record<string, string>

    if (search?.trim()) {
      const q = `%${search.trim()}%`
      const rows = await sql`
        SELECT c.*,
               fp.display_name AS family_display_name,
               fp.email        AS family_email,
               fp.phone        AS family_phone,
               fp.address      AS family_address,
               fp.zip          AS family_zip,
               fp.state        AS family_state
        FROM children c
        LEFT JOIN family_profiles fp ON fp.id = c.family_id
        WHERE c.first_name ILIKE ${q}
           OR c.last_name  ILIKE ${q}
           OR (c.first_name || ' ' || c.last_name) ILIKE ${q}
           OR c.display_label ILIKE ${q}
        ORDER BY c.first_name, c.last_name
        LIMIT 20`
      return res.json(rows)
    }

    if (ids) {
      const idList = ids.split(',').filter(Boolean)
      if (!idList.length) return res.json([])
      const rows = await sql`SELECT * FROM children WHERE id = ANY(${idList}::uuid[])`
      return res.json(rows)
    }
    if (!family_ids) return res.json([])
    const famIds = family_ids.split(',').filter(Boolean)
    const rows = await sql`SELECT * FROM children WHERE family_id = ANY(${famIds}::uuid[])`
    return res.json(rows)
  }

  if (req.method === 'POST') {
    try {
      const { display_label } = req.body
      const [profile] = await sql`SELECT id FROM family_profiles WHERE cognito_sub = ${sub} LIMIT 1`
      if (!profile) return res.status(404).json({ error: 'Family profile not found' })
      const [row] = await sql`
        INSERT INTO children (display_label, family_id)
        VALUES (${display_label}, ${profile.id}::uuid)
        RETURNING *`
      return res.json(row)
    } catch (e: any) {
      return res.status(500).json({ error: e.message ?? String(e) })
    }
  }

  res.status(405).json({ error: 'Method not allowed' })
}
