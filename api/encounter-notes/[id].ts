import type { VercelRequest, VercelResponse } from '@vercel/node'
import sql from '../_lib/db'
import { getProviderContext } from '../_lib/auth'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  let practiceId: string
  try {
    const ctx = await getProviderContext(req.headers.authorization)
    practiceId = ctx.practiceId
  } catch {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const { id } = req.query as Record<string, string>
  if (!id) return res.status(400).json({ error: 'id required' })

  if (req.method === 'GET') {
    const rows = await sql`SELECT * FROM encounter_notes WHERE id = ${id}::uuid AND practice_id = ${practiceId} LIMIT 1`
    return res.json(rows[0] ?? null)
  }

  if (req.method === 'PUT') {
    const [existing] = await sql`SELECT is_signed FROM encounter_notes WHERE id = ${id}::uuid AND practice_id = ${practiceId} LIMIT 1`
    if (!existing) return res.status(404).json({ error: 'Note not found' })

    const { note_type, chief_complaint, subjective, objective, assessment, plan, diagnoses, cpt_codes, photos, is_signed } = req.body

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
        is_signed       = ${signing},
        signed_at       = CASE WHEN ${signing} THEN now() WHEN ${unlocking} THEN NULL ELSE signed_at END,
        updated_at      = now()
      WHERE id = ${id}::uuid AND practice_id = ${practiceId}
      RETURNING *`
    return res.json(row)
  }

  res.status(405).json({ error: 'Method not allowed' })
}
