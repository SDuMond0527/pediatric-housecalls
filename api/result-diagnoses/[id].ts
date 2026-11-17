// PATCH /api/result-diagnoses/[id]
//   body: { label?, short_code?, sort_order?, is_active? }
// DELETE /api/result-diagnoses/[id]  → sets is_active=false (soft delete)
//
// Scoped by practice_id — admins can only touch their own library.
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

  if (req.method === 'PATCH') {
    const body = (req.body ?? {}) as Record<string, any>
    const label      = typeof body.label      === 'string' ? body.label.trim() : undefined
    const shortCode  = typeof body.short_code === 'string' ? (body.short_code.trim() || null) : undefined
    const sortOrder  = body.sort_order != null ? Number(body.sort_order) : undefined
    const isActive   = typeof body.is_active  === 'boolean' ? body.is_active : undefined
    const mapsToChronic = typeof body.maps_to_chronic_problem === 'boolean' ? body.maps_to_chronic_problem : undefined
    const defaultIcd10  = typeof body.default_icd10_code === 'string' ? (body.default_icd10_code.trim() || null) : undefined

    // Bootstrap new columns idempotently in case the admin hits this
    // endpoint before the index GET runs.
    try { await sql`ALTER TABLE result_diagnoses ADD COLUMN IF NOT EXISTS maps_to_chronic_problem boolean NOT NULL DEFAULT false` } catch {}
    try { await sql`ALTER TABLE result_diagnoses ADD COLUMN IF NOT EXISTS default_icd10_code text` } catch {}

    const [row] = await sql`
      UPDATE result_diagnoses SET
        label      = COALESCE(${label ?? null}, label),
        short_code = CASE WHEN ${shortCode === undefined}::boolean THEN short_code ELSE ${shortCode} END,
        sort_order = COALESCE(${sortOrder ?? null}, sort_order),
        is_active  = COALESCE(${isActive ?? null}::boolean, is_active),
        maps_to_chronic_problem = COALESCE(${mapsToChronic ?? null}::boolean, maps_to_chronic_problem),
        default_icd10_code = CASE WHEN ${defaultIcd10 === undefined}::boolean THEN default_icd10_code ELSE ${defaultIcd10} END,
        updated_at = now()
      WHERE id = ${id}::uuid AND practice_id = ${practiceId}::uuid
      RETURNING id, resource_type, label, short_code, sort_order, is_active,
                maps_to_chronic_problem, default_icd10_code,
                created_at::text AS created_at, updated_at::text AS updated_at`
    if (!row) return res.status(404).json({ error: 'Not found' })
    return res.status(200).json(row)
  }

  if (req.method === 'DELETE') {
    const [row] = await sql`
      UPDATE result_diagnoses SET is_active = false, updated_at = now()
      WHERE id = ${id}::uuid AND practice_id = ${practiceId}::uuid
      RETURNING id`
    if (!row) return res.status(404).json({ error: 'Not found' })
    return res.status(200).json({ ok: true })
  }

  return res.status(405).json({ error: 'Method not allowed' })
}
