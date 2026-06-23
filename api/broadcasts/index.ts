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
  try {
    await verifyToken(req.headers.authorization)
  } catch {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const sql = neon(process.env.DATABASE_URL!)

  if (req.method === 'GET') {
    const { open_only } = req.query as Record<string, string>
    let rows: unknown[]
    if (open_only === 'true') {
      rows = await sql`SELECT * FROM broadcasts WHERE is_open = true ORDER BY is_urgent DESC, created_at ASC`
    } else {
      rows = await sql`SELECT * FROM broadcasts ORDER BY is_urgent DESC, created_at ASC`
    }
    // count only
    if (req.query.count === 'true') {
      return res.json({ count: (rows as unknown[]).length })
    }
    return res.json(rows)
  }

  if (req.method === 'POST') {
    const b = req.body
    const [row] = await sql`
      INSERT INTO broadcasts (patient_first_name, patient_last_name, patient_dob, patient_address, family_phone, family_email, zone, state, visit_type, request_type, complaint, is_urgent, is_open, created_by, created_by_name)
      VALUES (${b.patient_first_name ?? null}, ${b.patient_last_name ?? null}, ${b.patient_dob ?? null}, ${b.patient_address ?? null}, ${b.family_phone ?? null}, ${b.family_email ?? null}, ${b.zone ?? null}, ${b.state ?? null}, ${b.visit_type ?? null}, ${b.request_type ?? 'standard'}, ${b.complaint ?? null}, ${b.is_urgent ?? false}, true, ${b.created_by}::uuid, ${b.created_by_name})
      RETURNING *`
    return res.json(row)
  }

  res.status(405).json({ error: 'Method not allowed' })
}
