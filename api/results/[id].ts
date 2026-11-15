import type { VercelRequest, VercelResponse } from '@vercel/node'
import { neon } from '@neondatabase/serverless'
import { createRemoteJWKSet, jwtVerify } from 'jose'

// GET   /api/results/[id] — single row
// PATCH /api/results/[id]
//   body: any subset of editable fields, PLUS the two lifecycle actions:
//     { action: 'sign',        sign_note?: string }
//     { action: 'acknowledge', ack_channel?: string, ack_note?: string }
//   PATCH without action just updates field values.
//
// Scoped by practice_id on every operation — no cross-practice edits.
// Sara 2026-11-15.

async function verifyToken(authHeader: string | undefined): Promise<string> {
  if (!authHeader?.startsWith('Bearer ')) throw new Error('Missing token')
  const token = authHeader.slice(7)
  const region = process.env.VITE_AWS_REGION || 'us-east-2'
  const poolId = process.env.VITE_AWS_USER_POOL_ID || ''
  const JWKS = createRemoteJWKSet(new URL(`https://cognito-idp.${region}.amazonaws.com/${poolId}/.well-known/jwks.json`))
  const { payload } = await jwtVerify(token, JWKS, { issuer: `https://cognito-idp.${region}.amazonaws.com/${poolId}` })
  if (!payload.sub) throw new Error('No sub')
  return payload.sub as string
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  let sub: string
  try { sub = await verifyToken(req.headers.authorization) }
  catch { return res.status(401).json({ error: 'Unauthorized' }) }

  const id = String(req.query.id ?? '').trim()
  if (!id) return res.status(400).json({ error: 'id required' })

  const sql = neon(process.env.DATABASE_URL!)
  const [provider] = await sql`SELECT id, practice_id FROM providers WHERE cognito_sub = ${sub} LIMIT 1`
  if (!provider) return res.status(403).json({ error: 'Provider not found' })
  const practiceId = provider.practice_id as string
  const providerId = provider.id as string

  if (req.method === 'GET') {
    const [row] = await sql`
      SELECT r.*,
             COALESCE(
               (SELECT first_name || ' ' || last_name FROM patient_profiles WHERE id = r.patient_profile_id),
               (SELECT first_name || ' ' || last_name FROM children         WHERE id = r.child_id)
             ) AS patient_name,
             (SELECT name FROM providers WHERE id = r.signed_by_provider_id) AS signed_by_name
      FROM results r
      WHERE r.id = ${id}::uuid AND r.practice_id = ${practiceId}::uuid
      LIMIT 1`
    if (!row) return res.status(404).json({ error: 'Not found' })
    return res.status(200).json(row)
  }

  if (req.method === 'PATCH') {
    const body = (req.body ?? {}) as Record<string, any>
    const action = String(body.action ?? '').trim()

    // Lifecycle actions — sign + acknowledge. Each enforces that the
    // transition makes sense (can't acknowledge before signing).
    if (action === 'sign') {
      const [current] = await sql`SELECT status FROM results WHERE id = ${id}::uuid AND practice_id = ${practiceId}::uuid`
      if (!current) return res.status(404).json({ error: 'Not found' })
      if (current.status === 'acknowledged') {
        return res.status(409).json({ error: 'Already signed + acknowledged.' })
      }
      const [row] = await sql`
        UPDATE results
        SET status                = 'signed',
            signed_by_provider_id = ${providerId}::uuid,
            signed_at             = COALESCE(signed_at, now()),
            sign_note             = ${body.sign_note ?? null},
            updated_at            = now()
        WHERE id = ${id}::uuid AND practice_id = ${practiceId}::uuid
        RETURNING *`
      return res.status(200).json(row)
    }

    if (action === 'acknowledge') {
      const [current] = await sql`SELECT status FROM results WHERE id = ${id}::uuid AND practice_id = ${practiceId}::uuid`
      if (!current) return res.status(404).json({ error: 'Not found' })
      if (current.status === 'pending_review') {
        return res.status(409).json({ error: 'Must be signed before it can be marked acknowledged to the patient.' })
      }
      const [row] = await sql`
        UPDATE results
        SET status                      = 'acknowledged',
            acknowledged_at             = COALESCE(acknowledged_at, now()),
            acknowledged_by_provider_id = ${providerId}::uuid,
            ack_channel                 = ${body.ack_channel ?? null},
            ack_note                    = ${body.ack_note ?? null},
            updated_at                  = now()
        WHERE id = ${id}::uuid AND practice_id = ${practiceId}::uuid
        RETURNING *`
      return res.status(200).json(row)
    }

    // No action → generic field update. Only editable fields listed
    // here; status + sign/ack lifecycle goes through the actions above.
    const EDITABLE = [
      'specimen_date', 'specimen_type', 'specimen_site',
      'source_lab', 'source_provider', 'report_text', 'report_pdf_url',
      'margins_status', 'breslow_depth_mm', 'clark_level',
      'test_name', 'result_value', 'result_unit', 'reference_range', 'abnormal_flag',
      'icd10_codes',
    ]
    const updates: Record<string, any> = {}
    for (const k of EDITABLE) {
      if (k in body) updates[k] = body[k]
    }
    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No editable fields in body' })
    }
    const [row] = await sql`
      UPDATE results
      SET specimen_date     = COALESCE(${updates.specimen_date ?? null}::date, specimen_date),
          specimen_type     = COALESCE(${updates.specimen_type ?? null}, specimen_type),
          specimen_site     = COALESCE(${updates.specimen_site ?? null}, specimen_site),
          source_lab        = COALESCE(${updates.source_lab ?? null}, source_lab),
          source_provider   = COALESCE(${updates.source_provider ?? null}, source_provider),
          report_text       = COALESCE(${updates.report_text ?? null}, report_text),
          report_pdf_url    = COALESCE(${updates.report_pdf_url ?? null}, report_pdf_url),
          margins_status    = COALESCE(${updates.margins_status ?? null}, margins_status),
          breslow_depth_mm  = COALESCE(${updates.breslow_depth_mm ?? null}, breslow_depth_mm),
          clark_level       = COALESCE(${updates.clark_level ?? null}, clark_level),
          test_name         = COALESCE(${updates.test_name ?? null}, test_name),
          result_value      = COALESCE(${updates.result_value ?? null}, result_value),
          result_unit       = COALESCE(${updates.result_unit ?? null}, result_unit),
          reference_range   = COALESCE(${updates.reference_range ?? null}, reference_range),
          abnormal_flag     = COALESCE(${updates.abnormal_flag ?? null}, abnormal_flag),
          icd10_codes       = COALESCE(${updates.icd10_codes ?? null}::text[], icd10_codes),
          updated_at        = now()
      WHERE id = ${id}::uuid AND practice_id = ${practiceId}::uuid
      RETURNING *`
    if (!row) return res.status(404).json({ error: 'Not found' })
    return res.status(200).json(row)
  }

  return res.status(405).json({ error: 'Method not allowed' })
}
