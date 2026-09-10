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

  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  const sql = neon(process.env.DATABASE_URL!)

  const providerRows = await sql`SELECT practice_id FROM providers WHERE cognito_sub = ${sub} LIMIT 1`
  if (!providerRows.length) return res.status(403).json({ error: 'Provider not found' })
  const practiceId = providerRows[0].practice_id as string

  const { start, end } = req.query as Record<string, string>
  const [appointments, providers, encounterNotes, onCallShifts] = await Promise.all([
    sql`SELECT id, provider_id, visit_type, scheduled_date, status, notes FROM appointments WHERE scheduled_date >= ${start}::date AND scheduled_date <= ${end}::date AND practice_id = ${practiceId}::uuid`,
    sql`SELECT id, name, role FROM providers WHERE role != 'admin' AND practice_id = ${practiceId}::uuid`,
    sql`
      SELECT
        en.id                 AS encounter_note_id,
        en.provider_id,
        en.cpt_codes,
        a.scheduled_date,
        a.visit_type,
        a.status              AS appointment_status,
        cl.id                 AS claim_id,
        cl.claim_number       AS claim_number,
        cl.created_at         AS claim_created_at,
        cl.payer_name         AS payer_name,
        cl.payer_id           AS payer_id,
        ch.chart_number       AS chart_number,
        ch.first_name         AS patient_first_name,
        ch.last_name          AS patient_last_name
      FROM encounter_notes en
      JOIN appointments a       ON en.appointment_id = a.id
      LEFT JOIN claims cl       ON cl.encounter_note_id = en.id
      LEFT JOIN children ch     ON ch.id = COALESCE(cl.child_id, a.child_id)
      WHERE a.scheduled_date >= ${start}::date
        AND a.scheduled_date <= ${end}::date
        AND en.practice_id = ${practiceId}::uuid
        AND en.cpt_codes IS NOT NULL
    `,
    sql`
      SELECT provider_id, date::text AS date, state, start_time, end_time
      FROM on_call_schedule
      WHERE practice_id = ${practiceId}::uuid
        AND date >= ${start}::date
        AND date <= ${end}::date
    `,
  ])

  res.json({ appointments, providers, encounterNotes, onCallShifts })
}
