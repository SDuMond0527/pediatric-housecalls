import type { VercelRequest, VercelResponse } from '@vercel/node'
import { put, del as deleteBlob } from '@vercel/blob'
import { neon } from '@neondatabase/serverless'
import { createRemoteJWKSet, jwtVerify } from 'jose'

// Streaming body for POST uploads — same pattern as upload-note-photo.ts.
// GET/DELETE still have their JSON body parsed normally since there's no
// request-body on those.
export const config = { api: { bodyParser: false } }

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

async function bootstrap(sql: any) {
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS claim_attachments (
        id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        claim_id         uuid NOT NULL,
        practice_id      uuid NOT NULL,
        file_name        text NOT NULL,
        file_url         text NOT NULL,
        mime_type        text,
        size_bytes       bigint,
        note             text,
        uploaded_at      timestamptz NOT NULL DEFAULT NOW(),
        uploaded_by      uuid,
        uploaded_by_name text
      )`
  } catch {}
  try { await sql`CREATE INDEX IF NOT EXISTS claim_attachments_claim_id_idx ON claim_attachments(claim_id)` } catch {}
}

/**
 * /api/claims/[id]/attachments
 *
 * GET    — list attachments for the claim (newest first)
 * POST   — body is raw file bytes, filename + contentType in query,
 *          optional note in query. Uploads to Vercel Blob under
 *          `claim-attachments/<claimId>/<ts>-<filename>` and records
 *          the URL in claim_attachments.
 * DELETE — ?attachment_id=<uuid>. Deletes both the Blob and the DB row.
 *
 * Attachments are NOT sent through Stedi's 837 — they stay stored on
 * the claim for Andrea's records and for re-upload to the payer's
 * portal when a payer requests supporting docs. Shipped 2026-10-06 for
 * the Rework-tab resubmit workflow.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  let sub: string
  try { sub = await verifyToken(req.headers.authorization) }
  catch { return res.status(401).json({ error: 'Unauthorized' }) }

  const sql = neon(process.env.DATABASE_URL!)
  const [provider] = await sql`SELECT id, name, practice_id FROM providers WHERE cognito_sub = ${sub} LIMIT 1`
  if (!provider) return res.status(403).json({ error: 'Provider not found' })

  const claimId = req.query.id as string
  if (!claimId) return res.status(400).json({ error: 'id required' })

  await bootstrap(sql)

  // Verify claim exists + belongs to this practice before any mutations.
  const [claim] = await sql`SELECT id FROM claims WHERE id = ${claimId}::uuid AND practice_id = ${provider.practice_id}::uuid LIMIT 1`
  if (!claim) return res.status(404).json({ error: 'Claim not found' })

  if (req.method === 'GET') {
    try {
      const rows = await sql`
        SELECT id, claim_id, file_name, file_url, mime_type, size_bytes, note,
               uploaded_at, uploaded_by, uploaded_by_name
        FROM claim_attachments
        WHERE claim_id = ${claimId}::uuid AND practice_id = ${provider.practice_id}::uuid
        ORDER BY uploaded_at DESC`
      return res.status(200).json(rows)
    } catch (e: any) {
      console.error('[claim-attachments GET]', e)
      return res.status(500).json({ error: e.message ?? 'Internal server error' })
    }
  }

  if (req.method === 'POST') {
    try {
      const filename = String(req.query.filename ?? `attachment-${Date.now()}`).slice(0, 180)
      const contentType = String(req.query.contentType ?? req.headers['content-type'] ?? 'application/octet-stream')
      const note = req.query.note ? String(req.query.note).slice(0, 500) : null
      // Cap stored filenames to safe characters so blob path is predictable.
      const safeName = filename.replace(/[^\w.\-]+/g, '_')

      const blob = await put(`claim-attachments/${claimId}/${Date.now()}-${safeName}`, req as any, {
        access: 'public',
        contentType,
      })

      // Content-length is populated by the client; Vercel Blob's response
      // doesn't echo size back, so fall back to the header for logging.
      const size = Number(req.headers['content-length']) || null

      const [row] = await sql`
        INSERT INTO claim_attachments (
          claim_id, practice_id, file_name, file_url, mime_type, size_bytes,
          note, uploaded_by, uploaded_by_name
        ) VALUES (
          ${claimId}::uuid, ${provider.practice_id}::uuid, ${filename}, ${blob.url}, ${contentType}, ${size},
          ${note}, ${provider.id}::uuid, ${provider.name ?? null}
        ) RETURNING id, claim_id, file_name, file_url, mime_type, size_bytes, note,
                   uploaded_at, uploaded_by, uploaded_by_name`

      // Non-fatal activity log.
      try {
        await sql`
          CREATE TABLE IF NOT EXISTS claim_activity_log (
            id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            claim_id        uuid NOT NULL,
            created_at      timestamptz NOT NULL DEFAULT NOW(),
            created_by      uuid,
            created_by_name text,
            kind            text NOT NULL DEFAULT 'note',
            body            text NOT NULL
          )`
        await sql`
          INSERT INTO claim_activity_log (claim_id, created_by, created_by_name, kind, body)
          VALUES (${claimId}::uuid, ${provider.id}::uuid, ${provider.name ?? 'Biller'}, 'attachment_added',
                  ${`Attached ${filename}${note ? ' — ' + note : ''}`})`
      } catch (e: any) { console.error('[claim-attachments activity log]', e?.message) }

      return res.status(200).json(row)
    } catch (e: any) {
      console.error('[claim-attachments POST]', e)
      return res.status(500).json({ error: e.message ?? 'Internal server error' })
    }
  }

  if (req.method === 'DELETE') {
    try {
      const attachmentId = req.query.attachment_id as string
      if (!attachmentId) return res.status(400).json({ error: 'attachment_id required' })

      const [row] = await sql`
        SELECT id, file_url FROM claim_attachments
        WHERE id = ${attachmentId}::uuid AND claim_id = ${claimId}::uuid AND practice_id = ${provider.practice_id}::uuid
        LIMIT 1`
      if (!row) return res.status(404).json({ error: 'Attachment not found' })

      try { await deleteBlob(row.file_url) } catch (e: any) { console.error('[claim-attachments DELETE blob]', e?.message) }
      await sql`DELETE FROM claim_attachments WHERE id = ${attachmentId}::uuid`

      try {
        await sql`
          INSERT INTO claim_activity_log (claim_id, created_by, created_by_name, kind, body)
          VALUES (${claimId}::uuid, ${provider.id}::uuid, ${provider.name ?? 'Biller'}, 'attachment_removed',
                  ${`Removed attachment (id=${attachmentId})`})`
      } catch (e: any) { console.error('[claim-attachments activity log del]', e?.message) }

      return res.status(200).json({ ok: true })
    } catch (e: any) {
      console.error('[claim-attachments DELETE]', e)
      return res.status(500).json({ error: e.message ?? 'Internal server error' })
    }
  }

  return res.status(405).json({ error: 'Method not allowed' })
}
