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
    const { appointment_id, child_id } = req.query as Record<string, string>

    if (appointment_id) {
      const rows = await sql`SELECT * FROM encounter_notes WHERE appointment_id = ${appointment_id}::uuid LIMIT 1`
      return res.json(rows[0] ?? null)
    }

    if (child_id) {
      const rows = await sql`
        SELECT en.*, a.visit_type, a.scheduled_date, a.scheduled_time, a.zone, p.name as provider_name
        FROM encounter_notes en
        JOIN appointments a ON a.id = en.appointment_id
        LEFT JOIN providers p ON p.id = en.provider_id
        WHERE en.child_id = ${child_id}::uuid
        ORDER BY a.scheduled_date DESC`
      return res.json(rows)
    }

    return res.status(400).json({ error: 'appointment_id or child_id required' })
  }

  if (req.method === 'POST') {
    const { appointment_id, child_id, provider_id, note_type, chief_complaint, subjective, objective, assessment, plan, diagnoses, photos } = req.body
    if (!appointment_id) return res.status(400).json({ error: 'appointment_id required' })

    const diagnosesVal = diagnoses ?? []
    const photosVal = photos ?? []

    const [row] = await sql`
      INSERT INTO encounter_notes (appointment_id, child_id, provider_id, note_type, chief_complaint, subjective, objective, assessment, plan, diagnoses, photos)
      VALUES (
        ${appointment_id}::uuid,
        ${child_id ?? null}::uuid,
        ${provider_id ?? null}::uuid,
        ${note_type ?? null},
        ${chief_complaint ?? null},
        ${subjective ?? null},
        ${objective ?? null},
        ${assessment ?? null},
        ${plan ?? null},
        ${JSON.stringify(diagnosesVal)}::jsonb,
        ${JSON.stringify(photosVal)}::jsonb
      )
      RETURNING *`
    return res.json(row)
  }

  res.status(405).json({ error: 'Method not allowed' })
}
