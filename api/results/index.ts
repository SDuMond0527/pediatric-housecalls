import type { VercelRequest, VercelResponse } from '@vercel/node'
import { neon } from '@neondatabase/serverless'
import { createRemoteJWKSet, jwtVerify } from 'jose'

// GET  /api/results
//   ?type=pathology|lab         (required for inbox queries)
//   ?status=pending_review      (optional filter)
//   ?child_id=<uuid>            (patient chart lookup — pediatric)
//   ?patient_profile_id=<uuid>  (patient chart lookup — adult)
//   ?limit=50                   (default 100)
//
// POST /api/results
//   body: {
//     type: 'pathology' | 'lab',
//     patient_profile_id? | child_id?,
//     encounter_note_id?,
//     specimen_date?, specimen_type?, specimen_site?,
//     source_lab?, source_provider?,
//     report_text?, report_pdf_url?,
//     margins_status?, breslow_depth_mm?, clark_level?,    (pathology)
//     test_name?, result_value?, result_unit?,              (lab)
//     reference_range?, abnormal_flag?,
//     icd10_codes?: string[]
//   }
//
// Scoped by caller's practice_id. Multi-tenant seam — no cross-practice
// visibility, ever. Sara 2026-11-15.

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

  const sql = neon(process.env.DATABASE_URL!)
  const [provider] = await sql`SELECT id, practice_id FROM providers WHERE cognito_sub = ${sub} LIMIT 1`
  if (!provider) return res.status(403).json({ error: 'Provider not found' })
  const practiceId = provider.practice_id as string
  const providerId = provider.id as string

  if (req.method === 'GET') {
    const type = String(req.query.type ?? '').trim() || null
    const status = String(req.query.status ?? '').trim() || null
    const childId = String(req.query.child_id ?? '').trim() || null
    const patientProfileId = String(req.query.patient_profile_id ?? '').trim() || null
    const limit = Math.min(Number(req.query.limit ?? 100) || 100, 500)

    const rows = await sql`
      SELECT
        r.id, r.practice_id, r.patient_profile_id, r.child_id, r.encounter_note_id,
        r.type, r.received_at::text AS received_at, r.specimen_date::text AS specimen_date,
        r.specimen_type, r.specimen_site, r.source_lab, r.source_provider,
        r.report_text, r.report_pdf_url,
        r.margins_status, r.breslow_depth_mm, r.clark_level,
        r.test_name, r.result_value, r.result_unit, r.reference_range, r.abnormal_flag,
        r.icd10_codes,
        r.status, r.signed_by_provider_id, r.signed_at::text AS signed_at, r.sign_note,
        r.acknowledged_at::text AS acknowledged_at, r.acknowledged_by_provider_id, r.ack_channel, r.ack_note,
        r.created_by_provider_id, r.created_at::text AS created_at, r.updated_at::text AS updated_at,
        -- Patient display name for the inbox UI. COALESCE across both patient models.
        COALESCE(
          (SELECT first_name || ' ' || last_name FROM patient_profiles WHERE id = r.patient_profile_id),
          (SELECT first_name || ' ' || last_name FROM children         WHERE id = r.child_id)
        ) AS patient_name,
        -- Signing provider's name for display.
        (SELECT name FROM providers WHERE id = r.signed_by_provider_id) AS signed_by_name
      FROM results r
      WHERE r.practice_id = ${practiceId}::uuid
        AND (${type}::text   IS NULL OR r.type   = ${type})
        AND (${status}::text IS NULL OR r.status = ${status})
        AND (${childId}::uuid           IS NULL OR r.child_id           = ${childId}::uuid)
        AND (${patientProfileId}::uuid  IS NULL OR r.patient_profile_id = ${patientProfileId}::uuid)
      ORDER BY r.received_at DESC
      LIMIT ${limit}`
    return res.status(200).json(rows)
  }

  if (req.method === 'POST') {
    const body = (req.body ?? {}) as Record<string, any>
    const type = String(body.type ?? '').trim()
    if (type !== 'pathology' && type !== 'lab') {
      return res.status(400).json({ error: "type must be 'pathology' or 'lab'" })
    }
    if (!body.patient_profile_id && !body.child_id) {
      return res.status(400).json({ error: 'patient_profile_id or child_id required' })
    }
    const toDate = (v: any) => (v && String(v).trim()) ? String(v).trim() : null
    const toNum  = (v: any) => (v === '' || v == null) ? null : Number(v)
    const [row] = await sql`
      INSERT INTO results (
        practice_id, patient_profile_id, child_id, encounter_note_id,
        type, specimen_date, specimen_type, specimen_site,
        source_lab, source_provider, report_text, report_pdf_url,
        margins_status, breslow_depth_mm, clark_level,
        test_name, result_value, result_unit, reference_range, abnormal_flag,
        icd10_codes, created_by_provider_id
      ) VALUES (
        ${practiceId}::uuid,
        ${body.patient_profile_id ?? null}::uuid,
        ${body.child_id ?? null}::uuid,
        ${body.encounter_note_id ?? null}::uuid,
        ${type},
        ${toDate(body.specimen_date)}::date,
        ${body.specimen_type ?? null},
        ${body.specimen_site ?? null},
        ${body.source_lab ?? null},
        ${body.source_provider ?? null},
        ${body.report_text ?? null},
        ${body.report_pdf_url ?? null},
        ${body.margins_status ?? null},
        ${toNum(body.breslow_depth_mm)},
        ${toNum(body.clark_level)},
        ${body.test_name ?? null},
        ${body.result_value ?? null},
        ${body.result_unit ?? null},
        ${body.reference_range ?? null},
        ${body.abnormal_flag ?? null},
        ${Array.isArray(body.icd10_codes) ? body.icd10_codes : null}::text[],
        ${providerId}::uuid
      )
      RETURNING id`
    return res.status(201).json({ id: row?.id })
  }

  return res.status(405).json({ error: 'Method not allowed' })
}
