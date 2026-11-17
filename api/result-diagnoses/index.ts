// Per-practice library of diagnoses that providers pick from when
// reviewing a pathology or lab result. Dr. Cash (dermatology) wants a
// pre-populated searchable dropdown ("SCC-WD", "BCC-nodular", etc.)
// instead of typing the diagnosis free-text every time.
//
// GET  /api/result-diagnoses?resource_type=pathology|lab
//   → scoped to caller's practice, active rows only, sorted
//
// POST /api/result-diagnoses
//   body: { resource_type, label, short_code?, sort_order? }
//
// Each row is scoped by practice_id — no cross-practice visibility.
// Sara 2026-11-16.

import type { VercelRequest, VercelResponse } from '@vercel/node'
import { neon } from '@neondatabase/serverless'
import { createRemoteJWKSet, jwtVerify } from 'jose'

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

async function bootstrap(sql: any) {
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS result_diagnoses (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        practice_id uuid NOT NULL,
        resource_type text NOT NULL,
        label text NOT NULL,
        short_code text,
        sort_order int NOT NULL DEFAULT 100,
        is_active boolean NOT NULL DEFAULT true,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )`
    await sql`CREATE INDEX IF NOT EXISTS idx_result_diagnoses_practice
              ON result_diagnoses(practice_id, resource_type, is_active, sort_order)`
    // Flag that drives auto-insert into chronic_problems when a result
    // is signed with this diagnosis. Default false — provider opts in
    // per diagnosis so the problem list doesn't fill up with benign
    // noise. Sara 2026-11-17.
    await sql`ALTER TABLE result_diagnoses ADD COLUMN IF NOT EXISTS maps_to_chronic_problem boolean NOT NULL DEFAULT false`
    await sql`ALTER TABLE result_diagnoses ADD COLUMN IF NOT EXISTS default_icd10_code text`
  } catch {}
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  let sub: string
  try { sub = await verifyToken(req.headers.authorization) }
  catch { return res.status(401).json({ error: 'Unauthorized' }) }

  const sql = neon(process.env.DATABASE_URL!)
  await bootstrap(sql)

  const [provider] = await sql`SELECT id, practice_id FROM providers WHERE cognito_sub = ${sub} LIMIT 1`
  if (!provider) return res.status(403).json({ error: 'Provider not found' })
  const practiceId = provider.practice_id as string

  if (req.method === 'GET') {
    const type = String(req.query.resource_type ?? '').trim() || null
    const includeArchived = String(req.query.include_archived ?? '') === '1'
    const rows = await sql`
      SELECT id, resource_type, label, short_code, sort_order, is_active,
             maps_to_chronic_problem, default_icd10_code,
             created_at::text AS created_at, updated_at::text AS updated_at
      FROM result_diagnoses
      WHERE practice_id = ${practiceId}::uuid
        AND (${type}::text IS NULL OR resource_type = ${type})
        AND (${includeArchived}::boolean OR is_active = true)
      ORDER BY resource_type, sort_order, label`
    return res.status(200).json(rows)
  }

  if (req.method === 'POST') {
    const body = (req.body ?? {}) as Record<string, any>
    const resourceType = String(body.resource_type ?? '').trim()
    const label = String(body.label ?? '').trim()
    if (resourceType !== 'pathology' && resourceType !== 'lab') {
      return res.status(400).json({ error: "resource_type must be 'pathology' or 'lab'" })
    }
    if (!label) return res.status(400).json({ error: 'label required' })
    const shortCode = String(body.short_code ?? '').trim() || null
    const sortOrder = Number(body.sort_order ?? 100) || 100
    const mapsToChronic = body.maps_to_chronic_problem === true
    const defaultIcd10 = String(body.default_icd10_code ?? '').trim() || null
    const [row] = await sql`
      INSERT INTO result_diagnoses (practice_id, resource_type, label, short_code, sort_order,
                                    maps_to_chronic_problem, default_icd10_code)
      VALUES (${practiceId}::uuid, ${resourceType}, ${label}, ${shortCode}, ${sortOrder},
              ${mapsToChronic}, ${defaultIcd10})
      RETURNING id, resource_type, label, short_code, sort_order, is_active,
                maps_to_chronic_problem, default_icd10_code,
                created_at::text AS created_at, updated_at::text AS updated_at`
    return res.status(201).json(row)
  }

  return res.status(405).json({ error: 'Method not allowed' })
}
