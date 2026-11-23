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
  let sub: string
  try {
    sub = await verifyToken(req.headers.authorization)
  } catch {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const sql = neon(process.env.DATABASE_URL!)

  const providerRows = await sql`SELECT practice_id FROM providers WHERE cognito_sub = ${sub} LIMIT 1`
  if (!providerRows.length) return res.status(403).json({ error: 'Provider not found' })
  const practiceId = providerRows[0].practice_id as string

  // Multi-sibling bookings: vitals are per-kid even when siblings share
  // one appointment. Drop the legacy UNIQUE(appointment_id) and replace
  // with a partial unique on (appointment_id, child_id). Idempotent.
  // Sara 2026-11-23.
  try { await sql`ALTER TABLE vitals DROP CONSTRAINT IF EXISTS vitals_appointment_id_key` } catch {}
  try { await sql`CREATE UNIQUE INDEX IF NOT EXISTS vitals_appt_child_uniq ON vitals (appointment_id, child_id) WHERE child_id IS NOT NULL` } catch {}

  if (req.method === 'GET') {
    const { appointment_id, child_id } = req.query as Record<string, string>

    if (appointment_id) {
      // Filter by child_id when provided — critical for multi-child
      // appointments where each sibling has their own vitals row.
      const rows = child_id
        ? await sql`SELECT * FROM vitals WHERE appointment_id = ${appointment_id}::uuid AND child_id = ${child_id}::uuid AND practice_id = ${practiceId}::uuid LIMIT 1`
        : await sql`SELECT * FROM vitals WHERE appointment_id = ${appointment_id}::uuid AND practice_id = ${practiceId}::uuid ORDER BY recorded_at DESC LIMIT 1`
      return res.json(rows[0] ?? null)
    }

    if (child_id) {
      const rows = await sql`SELECT * FROM vitals WHERE child_id = ${child_id}::uuid AND practice_id = ${practiceId}::uuid ORDER BY recorded_at DESC`
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

    // ON CONFLICT needs a real matching UNIQUE constraint. Postgres
    // partial unique indexes qualify as long as the predicate lines up
    // with the INSERT's values — child_id IS NOT NULL. For the legacy
    // path where child_id is null, drop into a SELECT-then-update to
    // avoid conflict-matching gymnastics.
    if (child_id) {
      const [row] = await sql`
        INSERT INTO vitals (practice_id, appointment_id, child_id, temperature_f, heart_rate, respiratory_rate, oxygen_saturation, weight_lbs, height_in, systolic_bp, diastolic_bp)
        VALUES (
          ${practiceId}::uuid,
          ${appointment_id}::uuid,
          ${child_id}::uuid,
          ${temperature_f ?? null},
          ${heart_rate ?? null},
          ${respiratory_rate ?? null},
          ${oxygen_saturation ?? null},
          ${weight_lbs ?? null},
          ${height_in ?? null},
          ${systolic_bp ?? null},
          ${diastolic_bp ?? null}
        )
        ON CONFLICT (appointment_id, child_id) WHERE child_id IS NOT NULL DO UPDATE SET
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

    const [existing] = await sql`SELECT id FROM vitals WHERE appointment_id = ${appointment_id}::uuid AND child_id IS NULL AND practice_id = ${practiceId}::uuid LIMIT 1`
    if (existing) {
      const [row] = await sql`
        UPDATE vitals SET
          temperature_f = ${temperature_f ?? null},
          heart_rate = ${heart_rate ?? null},
          respiratory_rate = ${respiratory_rate ?? null},
          oxygen_saturation = ${oxygen_saturation ?? null},
          weight_lbs = ${weight_lbs ?? null},
          height_in = ${height_in ?? null},
          systolic_bp = ${systolic_bp ?? null},
          diastolic_bp = ${diastolic_bp ?? null},
          recorded_at = now()
        WHERE id = ${existing.id}::uuid RETURNING *`
      return res.json(row)
    }
    const [row] = await sql`
      INSERT INTO vitals (practice_id, appointment_id, child_id, temperature_f, heart_rate, respiratory_rate, oxygen_saturation, weight_lbs, height_in, systolic_bp, diastolic_bp)
      VALUES (${practiceId}::uuid, ${appointment_id}::uuid, NULL, ${temperature_f ?? null}, ${heart_rate ?? null}, ${respiratory_rate ?? null}, ${oxygen_saturation ?? null}, ${weight_lbs ?? null}, ${height_in ?? null}, ${systolic_bp ?? null}, ${diastolic_bp ?? null})
      RETURNING *`
    return res.json(row)
  }

  res.status(405).json({ error: 'Method not allowed' })
}
