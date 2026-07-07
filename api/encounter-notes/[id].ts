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
  const { id } = req.query as Record<string, string>
  if (!id) return res.status(400).json({ error: 'id required' })

  const providerRows = await sql`SELECT practice_id FROM providers WHERE cognito_sub = ${sub} LIMIT 1`
  if (!providerRows.length) return res.status(403).json({ error: 'Provider not found' })
  const practiceId = providerRows[0].practice_id as string

  if (req.method === 'GET') {
    const rows = await sql`SELECT * FROM encounter_notes WHERE id = ${id}::uuid AND practice_id = ${practiceId}::uuid LIMIT 1`
    return res.json(rows[0] ?? null)
  }

  if (req.method === 'PUT') {
    const [existing] = await sql`SELECT is_signed FROM encounter_notes WHERE id = ${id}::uuid AND practice_id = ${practiceId}::uuid LIMIT 1`
    if (!existing) return res.status(404).json({ error: 'Note not found' })

    const { note_type, chief_complaint, subjective, objective, assessment, plan, diagnoses, cpt_codes, photos, is_signed, child_id } = req.body

    const unlocking = is_signed === false
    if (existing.is_signed && !unlocking) return res.status(403).json({ error: 'Cannot edit a signed note' })

    const signing = is_signed === true

    const [row] = await sql`
      UPDATE encounter_notes SET
        note_type       = COALESCE(${note_type ?? null}, note_type),
        chief_complaint = COALESCE(${chief_complaint ?? null}, chief_complaint),
        subjective      = COALESCE(${subjective ?? null}, subjective),
        objective       = COALESCE(${objective ?? null}, objective),
        assessment      = COALESCE(${assessment ?? null}, assessment),
        plan            = COALESCE(${plan ?? null}, plan),
        diagnoses       = COALESCE(${diagnoses != null ? JSON.stringify(diagnoses) : null}::jsonb, diagnoses),
        cpt_codes       = COALESCE(${cpt_codes != null ? JSON.stringify(cpt_codes) : null}::jsonb, cpt_codes),
        photos          = COALESCE(${photos != null ? JSON.stringify(photos) : null}::jsonb, photos),
        child_id        = COALESCE(${child_id ?? null}::uuid, child_id),
        is_signed       = ${signing},
        signed_at       = CASE WHEN ${signing} THEN now() WHEN ${unlocking} THEN NULL ELSE signed_at END,
        updated_at      = now()
      WHERE id = ${id}::uuid AND practice_id = ${practiceId}::uuid
      RETURNING *`
    if (child_id && row?.appointment_id) {
      await sql`UPDATE appointments SET child_id = ${child_id}::uuid WHERE id = ${row.appointment_id}::uuid AND practice_id = ${practiceId}::uuid`
    }
    return res.json(row)
  }

  res.status(405).json({ error: 'Method not allowed' })
}
