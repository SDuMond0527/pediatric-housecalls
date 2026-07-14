import type { VercelRequest, VercelResponse } from '@vercel/node'
import { neon } from '@neondatabase/serverless'
import { createRemoteJWKSet, jwtVerify } from 'jose'

async function verifyAnyToken(authHeader: string | undefined): Promise<void> {
  if (!authHeader?.startsWith('Bearer ')) throw new Error('Missing token')
  const token = authHeader.slice(7)
  const region = process.env.VITE_AWS_REGION || 'us-east-2'
  const familyPoolId = process.env.VITE_FAMILY_USER_POOL_ID || ''
  if (familyPoolId) {
    try {
      const JWKS = createRemoteJWKSet(new URL(`https://cognito-idp.${region}.amazonaws.com/${familyPoolId}/.well-known/jwks.json`))
      const { payload } = await jwtVerify(token, JWKS, { issuer: `https://cognito-idp.${region}.amazonaws.com/${familyPoolId}` })
      if (payload.sub) return
    } catch {}
  }
  const userPoolId = process.env.VITE_AWS_USER_POOL_ID || ''
  const JWKS = createRemoteJWKSet(new URL(`https://cognito-idp.${region}.amazonaws.com/${userPoolId}/.well-known/jwks.json`))
  const { payload } = await jwtVerify(token, JWKS, { issuer: `https://cognito-idp.${region}.amazonaws.com/${userPoolId}` })
  if (!payload.sub) throw new Error('No sub in token')
}


export default async function handler(req: VercelRequest, res: VercelResponse) {
  try { await verifyAnyToken(req.headers.authorization) } catch {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const sql = neon(process.env.DATABASE_URL!)

  // GET — list/search PCP directory
  if (req.method === 'GET') {
    const q    = (req.query.q   as string ?? '').trim()
    const all  = req.query.all === 'true'

    const rows = q
      ? await sql`
          SELECT id, name, aliases, fax_number, state, is_active
          FROM pcps
          WHERE (${all} OR is_active = true)
            AND (
              name ILIKE ${'%' + q + '%'}
              OR EXISTS (
                SELECT 1 FROM unnest(aliases) AS a WHERE a ILIKE ${'%' + q + '%'}
              )
            )
          ORDER BY name
          LIMIT 20
        `
      : await sql`
          SELECT id, name, aliases, fax_number, state, is_active,
            (SELECT count(*) FROM children WHERE pcp_id = pcps.id) AS patient_count
          FROM pcps
          WHERE (${all} OR is_active = true)
          ORDER BY fax_number IS NOT NULL, name
        `

    return res.status(200).json(rows)
  }

  // POST — add a new PCP to the directory
  if (req.method === 'POST') {
    const { name, aliases, fax_number, state } = req.body ?? {}
    if (!name) return res.status(400).json({ error: 'name is required' })

    const [row] = await sql`
      INSERT INTO pcps (name, aliases, fax_number, state)
      VALUES (
        ${name},
        ${aliases ? JSON.stringify(aliases) : '{}'}::text[],
        ${fax_number ?? null},
        ${state ?? 'NC'}
      )
      RETURNING *
    `
    return res.status(201).json(row)
  }

  return res.status(405).json({ error: 'Method not allowed' })
}
