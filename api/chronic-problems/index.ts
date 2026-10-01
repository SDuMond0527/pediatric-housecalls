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
  if (!payload.sub) throw new Error('No sub in token')
  return payload.sub as string
}

/**
 * /api/chronic-problems — per-child chronic problem list.
 *
 * GET  ?child_id=X&include_resolved=1 — list problems for a child
 * POST { child_id, label, icd10_code?, source_kind, source_encounter_note_id? }
 *
 * source_kind: 'provider_dx' | 'parent_history' | 'manual'
 *
 * Idempotent on (child_id, icd10_code): posting a second time with the
 * same ICD-10 code returns the existing row rather than duplicating.
 * Non-coded entries (parent history free-text) can repeat.
 *
 * Sara 2026-10-01 — chronic dx carry-over from encounter notes.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  let sub: string
  try { sub = await verifyToken(req.headers.authorization) }
  catch { return res.status(401).json({ error: 'Unauthorized' }) }

  const sql = neon(process.env.DATABASE_URL!)
  const [provider] = await sql`SELECT id, name, practice_id FROM providers WHERE cognito_sub = ${sub} LIMIT 1`
  if (!provider) return res.status(403).json({ error: 'Provider not found' })
  const practiceId = provider.practice_id as string

  // Idempotent bootstrap.
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS chronic_problems (
        id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        practice_id              uuid NOT NULL REFERENCES practices(id) ON DELETE CASCADE,
        child_id                 uuid NOT NULL REFERENCES children(id)  ON DELETE CASCADE,
        label                    text NOT NULL,
        icd10_code               text,
        source_kind              text NOT NULL DEFAULT 'manual',
        source_encounter_note_id uuid,
        added_by                 uuid,
        added_by_name            text,
        added_at                 timestamptz NOT NULL DEFAULT NOW(),
        resolved_at              timestamptz,
        resolved_by              uuid,
        resolved_by_name         text,
        resolved_reason          text
      )`
    await sql`CREATE INDEX IF NOT EXISTS chronic_problems_child_idx ON chronic_problems(child_id)`
    await sql`CREATE INDEX IF NOT EXISTS chronic_problems_practice_idx ON chronic_problems(practice_id)`
  } catch (e: any) {
    console.error('chronic_problems bootstrap failed:', e?.message)
  }

  if (req.method === 'GET') {
    const { child_id, include_resolved } = req.query as Record<string, string>
    if (!child_id) return res.status(400).json({ error: 'child_id required' })
    const rows = include_resolved === '1'
      ? await sql`
          SELECT * FROM chronic_problems
          WHERE child_id = ${child_id}::uuid AND practice_id = ${practiceId}::uuid
          ORDER BY resolved_at NULLS FIRST, added_at DESC`
      : await sql`
          SELECT * FROM chronic_problems
          WHERE child_id = ${child_id}::uuid AND practice_id = ${practiceId}::uuid
            AND resolved_at IS NULL
          ORDER BY added_at DESC`
    return res.status(200).json({ problems: rows })
  }

  if (req.method === 'POST') {
    const { child_id, label, icd10_code, source_kind, source_encounter_note_id } = req.body ?? {}
    if (!child_id) return res.status(400).json({ error: 'child_id required' })
    if (!label || !String(label).trim()) return res.status(400).json({ error: 'label required' })

    // Verify child belongs to this practice (defense in depth).
    const [child] = await sql`SELECT id FROM children WHERE id = ${child_id}::uuid AND practice_id = ${practiceId}::uuid LIMIT 1`
    if (!child) return res.status(404).json({ error: 'Child not found' })

    // Idempotency: if an active row already exists with the same ICD-10
    // code for this child, return it instead of duplicating.
    if (icd10_code) {
      const [existing] = await sql`
        SELECT * FROM chronic_problems
        WHERE child_id = ${child_id}::uuid
          AND icd10_code = ${icd10_code}
          AND resolved_at IS NULL
        LIMIT 1`
      if (existing) return res.status(200).json(existing)
    }

    const [row] = await sql`
      INSERT INTO chronic_problems
        (practice_id, child_id, label, icd10_code, source_kind, source_encounter_note_id, added_by, added_by_name)
      VALUES (
        ${practiceId}::uuid, ${child_id}::uuid, ${String(label).trim()},
        ${icd10_code ?? null}, ${source_kind ?? 'manual'},
        ${source_encounter_note_id ?? null}::uuid,
        ${provider.id}::uuid, ${provider.name ?? 'Unknown'})
      RETURNING *`
    return res.status(200).json(row)
  }

  return res.status(405).json({ error: 'Method not allowed' })
}
