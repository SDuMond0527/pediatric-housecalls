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
    if (!rows.length) return res.status(403).json({ error: 'Family not found' })
    practiceId = rows[0].practice_id as string

    if (req.method === 'GET') {
      const { family_ids, ids } = req.query as Record<string, string>
      if (ids) {
        const idList = ids.split(',').filter(Boolean)
        if (!idList.length) return res.json([])
        const result = await sql`SELECT * FROM children WHERE id = ANY(${idList}::uuid[]) AND practice_id = ${practiceId}::uuid`
        return res.json(result)
      }
      if (!family_ids) return res.json([])
      const famIds = family_ids.split(',').filter(Boolean)
      const result = await sql`SELECT * FROM children WHERE family_id = ANY(${famIds}::uuid[]) AND practice_id = ${practiceId}::uuid`
      return res.json(result)
    }

    if (req.method === 'POST') {
      try {
        const { display_label, first_name, last_name, date_of_birth } = req.body
        const familyId = rows[0].id as string
        const label = display_label || [first_name, last_name].filter(Boolean).join(' ') || 'Child'

        // Link to existing provider-added record if names + DOB match
        if (first_name?.trim() && last_name?.trim() && date_of_birth) {
          const existing = await sql`
            SELECT id FROM children
            WHERE practice_id = ${practiceId}::uuid
              AND family_id IS NULL
              AND first_name ILIKE ${first_name.trim()}
              AND last_name ILIKE ${last_name.trim()}
              AND date_of_birth = ${date_of_birth}
            LIMIT 1`
          if (existing.length) {
            const [linked] = await sql`
              UPDATE children SET family_id = ${familyId}::uuid, display_label = ${label}
              WHERE id = ${existing[0].id}::uuid
              RETURNING *`
            return res.json(linked)
          }
        }

        const [row] = await sql`
          INSERT INTO children (practice_id, display_label, first_name, last_name, family_id, date_of_birth)
          VALUES (${practiceId}::uuid, ${label}, ${first_name || null}, ${last_name || null}, ${familyId}::uuid, ${date_of_birth || null})
          RETURNING *`
        return res.json(row)
      } catch (e: any) {
        return res.status(500).json({ error: e.message ?? String(e) })
      }
    }

    return res.status(405).json({ error: 'Method not allowed' })
  }

  // Provider path
  const providerRows = await sql`SELECT practice_id FROM providers WHERE cognito_sub = ${auth.sub} LIMIT 1`
  if (!providerRows.length) return res.status(403).json({ error: 'Provider not found' })
  practiceId = providerRows[0].practice_id as string

  if (req.method === 'GET') {
    const { family_ids, ids, search } = req.query as Record<string, string>

    if (search?.trim()) {
      const q = `%${search.trim()}%`
      const rows = await sql`
        SELECT c.*,
               fp.display_name AS family_display_name,
               fp.email        AS family_email,
               fp.phone        AS family_phone
        FROM children c
        LEFT JOIN family_profiles fp ON fp.id = c.family_id
        WHERE c.practice_id = ${practiceId}::uuid
          AND (
            c.first_name ILIKE ${q}
            OR c.last_name  ILIKE ${q}
            OR (c.first_name || ' ' || c.last_name) ILIKE ${q}
            OR c.display_label ILIKE ${q}
          )
        ORDER BY c.first_name, c.last_name
        LIMIT 20`
      return res.json(rows)
    }

    if (ids) {
      const idList = ids.split(',').filter(Boolean)
      if (!idList.length) return res.json([])
      const rows = await sql`
        SELECT c.*,
               fp.display_name  AS family_display_name,
               fp.email         AS family_email,
               fp.phone         AS family_phone,
               fp.address_line1 AS family_address_line1,
               fp.city          AS family_city,
               fp.state         AS family_state,
               fp.zip           AS family_zip
        FROM children c
        LEFT JOIN family_profiles fp ON fp.id = c.family_id
        WHERE c.id = ANY(${idList}::uuid[]) AND c.practice_id = ${practiceId}::uuid`
      return res.json(rows)
    }
    if (family_ids) {
      const famIds = family_ids.split(',').filter(Boolean)
      const rows = await sql`SELECT * FROM children WHERE family_id = ANY(${famIds}::uuid[]) AND practice_id = ${practiceId}::uuid`
      return res.json(rows)
    }
    // No filters — return all children for this practice
    const rows = await sql`
      SELECT c.*,
             fp.display_name AS family_display_name,
             fp.email        AS family_email,
             fp.phone        AS family_phone
      FROM children c
      LEFT JOIN family_profiles fp ON fp.id = c.family_id
      WHERE c.practice_id = ${practiceId}::uuid
      ORDER BY c.first_name, c.last_name, c.display_label
      LIMIT 200`
    return res.json(rows)
  }

  if (req.method === 'POST') {
    const {
      first_name, last_name, date_of_birth, gender,
      family_id,
      parent_name, parent_phone, parent_email,
      parent_address, parent_city, parent_state, parent_zip,
      pcp, preferred_pharmacy,
      insurance_provider, insurance_member_id, insurance_group_number,
      insurance_subscriber_name, insurance_subscriber_dob, insurance_subscriber_gender,
    } = req.body
    if (!first_name && !last_name) return res.status(400).json({ error: 'Name required' })
    const label = [first_name, last_name].filter(Boolean).join(' ')
    const [row] = await sql`
      INSERT INTO children (
        practice_id, display_label, first_name, last_name, date_of_birth, gender,
        family_id,
        parent_name, parent_phone, parent_email,
        parent_address, parent_city, parent_state, parent_zip,
        pcp, preferred_pharmacy,
        insurance_provider, insurance_member_id, insurance_group_number,
        insurance_subscriber_name, insurance_subscriber_dob, insurance_subscriber_gender
      )
      VALUES (
        ${practiceId}::uuid,
        ${label},
        ${first_name || null},
        ${last_name || null},
        ${date_of_birth || null},
        ${gender || null},
        ${family_id || null},
        ${parent_name || null},
        ${parent_phone || null},
        ${parent_email || null},
        ${parent_address || null},
        ${parent_city || null},
        ${parent_state || null},
        ${parent_zip || null},
        ${pcp || null},
        ${preferred_pharmacy || null},
        ${insurance_provider || null},
        ${insurance_member_id || null},
        ${insurance_group_number || null},
        ${insurance_subscriber_name || null},
        ${insurance_subscriber_dob || null},
        ${insurance_subscriber_gender || null}
      )
      RETURNING *`
    return res.json(row)
  }

  res.status(405).json({ error: 'Method not allowed' })
}
