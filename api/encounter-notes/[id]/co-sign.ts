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
 * POST   /api/encounter-notes/[id]/co-sign  → supervising physician (MD)
 *                                              adds a co-signature
 * DELETE /api/encounter-notes/[id]/co-sign  → removes the co-signature
 *                                              (any MD may clear it)
 *
 * Co-signature is OPTIONAL — supervising MD is not required to sign
 * every NP note, but wants the ability to endorse specific notes.
 * Only NP-signed notes are eligible; only providers with role='MD'
 * can co-sign.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST' && req.method !== 'DELETE') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  let sub: string
  try { sub = await verifyToken(req.headers.authorization) }
  catch { return res.status(401).json({ error: 'Unauthorized' }) }

  try {
    const sql = neon(process.env.DATABASE_URL!)

    // Idempotent column bootstrap so the endpoint keeps working on a
    // fresh DB or a preview branch that hasn't run the migration yet.
    try { await sql`ALTER TABLE encounter_notes ADD COLUMN IF NOT EXISTS co_signed_by uuid REFERENCES providers(id)` } catch {}
    try { await sql`ALTER TABLE encounter_notes ADD COLUMN IF NOT EXISTS co_signed_by_name text` } catch {}
    try { await sql`ALTER TABLE encounter_notes ADD COLUMN IF NOT EXISTS co_signed_at timestamptz` } catch {}

    const [signer] = await sql`
      SELECT id, name, role, practice_id
      FROM providers WHERE cognito_sub = ${sub} LIMIT 1
    `
    if (!signer) return res.status(403).json({ error: 'Provider not found' })
    if (signer.role !== 'MD') {
      return res.status(403).json({ error: 'Only a supervising physician (MD) can co-sign an NP note.' })
    }
    const practiceId = signer.practice_id as string

    const noteId = req.query.id as string
    if (!noteId) return res.status(400).json({ error: 'id required' })

    const [note] = await sql`
      SELECT en.id, en.is_signed, en.provider_id, en.co_signed_at,
             p.role AS provider_role, p.name AS provider_name
      FROM encounter_notes en
      LEFT JOIN providers p ON p.id = en.provider_id
      WHERE en.id = ${noteId}::uuid AND en.practice_id = ${practiceId}::uuid
      LIMIT 1
    `
    if (!note) return res.status(404).json({ error: 'Note not found' })

    if (req.method === 'DELETE') {
      // Undo — clear co-sign fields. Only meaningful if one was recorded.
      const [updated] = await sql`
        UPDATE encounter_notes SET
          co_signed_by      = NULL,
          co_signed_by_name = NULL,
          co_signed_at      = NULL,
          updated_at        = NOW()
        WHERE id = ${noteId}::uuid AND practice_id = ${practiceId}::uuid
        RETURNING *
      `
      return res.status(200).json(updated)
    }

    // POST — add the co-signature.
    if (!note.is_signed) {
      return res.status(400).json({ error: 'Note must be signed by the rendering provider before it can be co-signed.' })
    }
    if (note.provider_role !== 'PNP') {
      return res.status(400).json({ error: 'Co-signature is only for notes signed by a nurse practitioner (PNP).' })
    }
    if (note.co_signed_at) {
      return res.status(409).json({ error: 'This note has already been co-signed. Refresh to see the latest state.' })
    }

    const [updated] = await sql`
      UPDATE encounter_notes SET
        co_signed_by      = ${signer.id}::uuid,
        co_signed_by_name = ${signer.name},
        co_signed_at      = NOW(),
        updated_at        = NOW()
      WHERE id = ${noteId}::uuid AND practice_id = ${practiceId}::uuid
      RETURNING *
    `
    return res.status(200).json(updated)
  } catch (e: any) {
    console.error('encounter-notes/[id]/co-sign error:', e)
    return res.status(500).json({ error: e.message ?? 'Internal server error' })
  }
}
