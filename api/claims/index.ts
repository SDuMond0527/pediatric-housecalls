import type { VercelRequest, VercelResponse } from '@vercel/node'
import { neon } from '@neondatabase/serverless'
import { createRemoteJWKSet, jwtVerify } from 'jose'
import { generateClaimForNote } from '../_lib/generateClaim'

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
  try { sub = await verifyToken(req.headers.authorization) } catch {
    return res.status(401).json({ error: 'Unauthorized' })
  }
  const sql = neon(process.env.DATABASE_URL!)

  const providerRows = await sql`SELECT practice_id FROM providers WHERE cognito_sub = ${sub} LIMIT 1`
  if (!providerRows.length) return res.status(403).json({ error: 'Provider not found' })
  const practiceId = providerRows[0].practice_id as string

  // GET — list claims or unbilled notes
  if (req.method === 'GET') {
    const { status, unbilled } = req.query as Record<string, string>

    if (unbilled === 'true') {
      // Signed notes with CPT codes + diagnoses that have no claim yet
      const rows = await sql`
        SELECT
          en.id AS note_id,
          en.appointment_id,
          en.child_id,
          en.provider_id,
          en.diagnoses,
          en.cpt_codes,
          en.signed_at,
          a.scheduled_date,
          a.visit_type,
          a.zone,
          c.first_name AS child_first_name,
          c.last_name  AS child_last_name,
          c.insurance_provider,
          c.insurance_member_id,
          p.name AS provider_name
        FROM encounter_notes en
        LEFT JOIN appointments a ON a.id = en.appointment_id
        LEFT JOIN children c ON c.id = en.child_id
        LEFT JOIN providers p ON p.id = en.provider_id
        LEFT JOIN claims cl ON cl.encounter_note_id = en.id
        WHERE en.is_signed = true
          AND en.practice_id = ${practiceId}::uuid
          AND cl.id IS NULL
        ORDER BY a.scheduled_date DESC NULLS LAST`
      return res.json(rows)
    }

    if (status) {
      const rows = await sql`
        SELECT cl.*, c.first_name AS child_first_name, c.last_name AS child_last_name,
          fp.email AS family_email, fp.phone AS family_phone,
          ps.status AS statement_status, ps.sent_at AS statement_sent_at
        FROM claims cl
        LEFT JOIN children c ON c.id = cl.child_id
        LEFT JOIN family_profiles fp ON fp.id = c.family_id
        LEFT JOIN patient_statements ps ON ps.claim_id = cl.id
        WHERE cl.status = ${status} AND cl.practice_id = ${practiceId}::uuid
        ORDER BY cl.created_at DESC`
      return res.json(rows)
    }

    const rows = await sql`
      SELECT cl.*, c.first_name AS child_first_name, c.last_name AS child_last_name,
        fp.email AS family_email, fp.phone AS family_phone,
        ps.status AS statement_status, ps.sent_at AS statement_sent_at
      FROM claims cl
      LEFT JOIN children c ON c.id = cl.child_id
      LEFT JOIN family_profiles fp ON fp.id = c.family_id
      LEFT JOIN patient_statements ps ON ps.claim_id = cl.id
      WHERE cl.practice_id = ${practiceId}::uuid
      ORDER BY cl.created_at DESC`
    return res.json(rows)
  }

  // POST — generate a claim from an encounter note
  if (req.method === 'POST') {
    try {
      const { encounter_note_id } = req.body
      if (!encounter_note_id) return res.status(400).json({ error: 'encounter_note_id required' })
      const result = await generateClaimForNote(sql, encounter_note_id, practiceId)
      if (result.error) return res.status(400).json({ error: result.error })
      if (result.skipped) return res.status(409).json({ error: result.skipped })
      return res.status(201).json(result.claim)
    } catch (e: any) {
      console.error('[claims POST] error:', e?.message, e?.stack)
      return res.status(500).json({ error: e?.message ?? 'Failed to generate claim' })
    }
  }

  res.status(405).json({ error: 'Method not allowed' })
}
