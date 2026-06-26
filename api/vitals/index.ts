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
      const rows = await sql`SELECT * FROM vitals WHERE appointment_id = ${appointment_id}::uuid LIMIT 1`
      return res.json(rows[0] ?? null)
    }

    if (child_id) {
      const rows = await sql`SELECT * FROM vitals WHERE child_id = ${child_id}::uuid ORDER BY recorded_at DESC`
      return res.json(rows)
    }

    return res.status(400).json({ error: 'appointment_id or child_id required' })
  }

  if (req.method === 'POST') {
    const {
      appointment_id, child_id,
      temperature_f, heart_rate, respiratory_rate, oxygen_saturation,
      weight_lbs, height_in, systolic_bp, diastolic_bp,
    } = req.body
    if (!appointment_id) return res.status(400).json({ error: 'appointment_id required' })

    const [row] = await sql`
      INSERT INTO vitals (appointment_id, child_id, temperature_f, heart_rate, respiratory_rate, oxygen_saturation, weight_lbs, height_in, systolic_bp, diastolic_bp)
      VALUES (
        ${appointment_id}::uuid,
        ${child_id ?? null}::uuid,
        ${temperature_f ?? null},
        ${heart_rate ?? null},
        ${respiratory_rate ?? null},
        ${oxygen_saturation ?? null},
        ${weight_lbs ?? null},
        ${height_in ?? null},
        ${systolic_bp ?? null},
        ${diastolic_bp ?? null}
      )
      ON CONFLICT (appointment_id) DO UPDATE SET
        child_id           = EXCLUDED.child_id,
        temperature_f      = EXCLUDED.temperature_f,
        heart_rate         = EXCLUDED.heart_rate,
        respiratory_rate   = EXCLUDED.respiratory_rate,
        oxygen_saturation  = EXCLUDED.oxygen_saturation,
        weight_lbs         = EXCLUDED.weight_lbs,
        height_in          = EXCLUDED.height_in,
        systolic_bp        = EXCLUDED.systolic_bp,
        diastolic_bp       = EXCLUDED.diastolic_bp,
        recorded_at        = now()
      RETURNING *`
    return res.json(row)
  }

  res.status(405).json({ error: 'Method not allowed' })
}
