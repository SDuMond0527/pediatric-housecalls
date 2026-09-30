import type { VercelRequest, VercelResponse } from '@vercel/node'
import { neon } from '@neondatabase/serverless'
import { del as deleteBlob } from '@vercel/blob'
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
 * /api/handbook — the "All things PHC" in-app handbook.
 *
 * GET:  returns { sections: [...], entries: [...] } for this practice.
 *       Any authenticated provider can read.
 * POST: { kind: 'section' | 'entry', ...fields }  — create.
 *       Admin-only.
 * PATCH:{ kind, id, ...fields }                    — update.
 *       Admin-only.
 * DELETE?kind=section|entry&id=<uuid>              — delete.
 *       Admin-only. Deleting a section cascades to its entries.
 *
 * Content is per-practice. Sections have title + sort_order; entries
 * live under one section with title + body + sort_order. Body is
 * plain text with preserved whitespace on render.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  let sub: string
  try { sub = await verifyToken(req.headers.authorization) }
  catch { return res.status(401).json({ error: 'Unauthorized' }) }

  const sql = neon(process.env.DATABASE_URL!)

  const [provider] = await sql`
    SELECT id, is_admin, practice_id
    FROM providers WHERE cognito_sub = ${sub} LIMIT 1
  `
  if (!provider) return res.status(403).json({ error: 'Provider not found' })
  const practiceId = provider.practice_id as string
  const isAdmin = !!provider.is_admin

  // Idempotent bootstrap — same pattern used elsewhere in the codebase
  // (mark-paid, cosign, etc.) so a fresh DB / preview branch just works
  // without a separate migration step.
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS handbook_sections (
        id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        practice_id uuid NOT NULL REFERENCES practices(id) ON DELETE CASCADE,
        title       text NOT NULL,
        sort_order  int  NOT NULL DEFAULT 0,
        created_at  timestamptz NOT NULL DEFAULT now(),
        updated_at  timestamptz NOT NULL DEFAULT now()
      )
    `
    await sql`CREATE INDEX IF NOT EXISTS handbook_sections_practice_idx ON handbook_sections(practice_id)`
    await sql`
      CREATE TABLE IF NOT EXISTS handbook_entries (
        id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        section_id  uuid NOT NULL REFERENCES handbook_sections(id) ON DELETE CASCADE,
        title       text NOT NULL,
        body        text NOT NULL DEFAULT '',
        sort_order  int  NOT NULL DEFAULT 0,
        created_at  timestamptz NOT NULL DEFAULT now(),
        updated_at  timestamptz NOT NULL DEFAULT now()
      )
    `
    await sql`CREATE INDEX IF NOT EXISTS handbook_entries_section_idx ON handbook_entries(section_id)`
    // Files-as-first-class items in a section (Sara 2026-09-30). Blob URLs
    // live on Vercel Blob; DELETE handler purges the blob alongside the row.
    await sql`
      CREATE TABLE IF NOT EXISTS handbook_files (
        id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        section_id  uuid NOT NULL REFERENCES handbook_sections(id) ON DELETE CASCADE,
        title       text NOT NULL,
        blob_url    text NOT NULL,
        filename    text NOT NULL,
        mime_type   text,
        size_bytes  bigint,
        sort_order  int  NOT NULL DEFAULT 0,
        created_at  timestamptz NOT NULL DEFAULT now(),
        updated_at  timestamptz NOT NULL DEFAULT now()
      )
    `
    await sql`CREATE INDEX IF NOT EXISTS handbook_files_section_idx ON handbook_files(section_id)`
  } catch (e: any) {
    console.error('handbook bootstrap failed:', e?.message)
  }

  if (req.method === 'GET') {
    const [sections, entries, files] = await Promise.all([
      sql`SELECT id, title, sort_order FROM handbook_sections WHERE practice_id = ${practiceId}::uuid ORDER BY sort_order, title`,
      sql`
        SELECT e.id, e.section_id, e.title, e.body, e.sort_order, e.updated_at
        FROM handbook_entries e
        JOIN handbook_sections s ON s.id = e.section_id
        WHERE s.practice_id = ${practiceId}::uuid
        ORDER BY e.sort_order, e.created_at
      `,
      sql`
        SELECT f.id, f.section_id, f.title, f.blob_url, f.filename, f.mime_type, f.size_bytes, f.sort_order, f.updated_at
        FROM handbook_files f
        JOIN handbook_sections s ON s.id = f.section_id
        WHERE s.practice_id = ${practiceId}::uuid
        ORDER BY f.sort_order, f.created_at
      `,
    ])
    return res.status(200).json({ sections, entries, files })
  }

  // Everything below is a write — admin-only.
  if (!isAdmin) return res.status(403).json({ error: 'Admin only' })

  if (req.method === 'POST') {
    const { kind } = req.body ?? {}
    if (kind === 'section') {
      const { title, sort_order } = req.body
      if (!title?.trim()) return res.status(400).json({ error: 'title required' })
      const [row] = await sql`
        INSERT INTO handbook_sections (practice_id, title, sort_order)
        VALUES (${practiceId}::uuid, ${title.trim()}, ${Number(sort_order) || 0})
        RETURNING id, title, sort_order
      `
      return res.status(200).json(row)
    }
    if (kind === 'entry') {
      const { section_id, title, body, sort_order } = req.body
      if (!section_id) return res.status(400).json({ error: 'section_id required' })
      if (!title?.trim()) return res.status(400).json({ error: 'title required' })
      // Verify the section belongs to this practice before allowing an
      // entry to attach to it (defense in depth against a crafted body).
      const [sect] = await sql`SELECT id FROM handbook_sections WHERE id = ${section_id}::uuid AND practice_id = ${practiceId}::uuid LIMIT 1`
      if (!sect) return res.status(404).json({ error: 'Section not found' })
      const [row] = await sql`
        INSERT INTO handbook_entries (section_id, title, body, sort_order)
        VALUES (${section_id}::uuid, ${title.trim()}, ${(body ?? '').toString()}, ${Number(sort_order) || 0})
        RETURNING id, section_id, title, body, sort_order, updated_at
      `
      return res.status(200).json(row)
    }
    if (kind === 'file') {
      const { section_id, title, blob_url, filename, mime_type, size_bytes, sort_order } = req.body
      if (!section_id) return res.status(400).json({ error: 'section_id required' })
      if (!title?.trim()) return res.status(400).json({ error: 'title required' })
      if (!blob_url) return res.status(400).json({ error: 'blob_url required (upload first)' })
      if (!filename) return res.status(400).json({ error: 'filename required' })
      const [sect] = await sql`SELECT id FROM handbook_sections WHERE id = ${section_id}::uuid AND practice_id = ${practiceId}::uuid LIMIT 1`
      if (!sect) return res.status(404).json({ error: 'Section not found' })
      const [row] = await sql`
        INSERT INTO handbook_files (section_id, title, blob_url, filename, mime_type, size_bytes, sort_order)
        VALUES (${section_id}::uuid, ${title.trim()}, ${blob_url}, ${filename}, ${mime_type ?? null}, ${size_bytes ?? null}, ${Number(sort_order) || 0})
        RETURNING id, section_id, title, blob_url, filename, mime_type, size_bytes, sort_order, updated_at
      `
      return res.status(200).json(row)
    }
    return res.status(400).json({ error: 'kind must be section, entry, or file' })
  }

  if (req.method === 'PATCH') {
    const { kind, id, title, body, sort_order } = req.body ?? {}
    if (!id) return res.status(400).json({ error: 'id required' })
    if (kind === 'section') {
      const [row] = await sql`
        UPDATE handbook_sections SET
          title      = COALESCE(${title?.trim() || null}, title),
          sort_order = COALESCE(${sort_order != null ? Number(sort_order) : null}, sort_order),
          updated_at = NOW()
        WHERE id = ${id}::uuid AND practice_id = ${practiceId}::uuid
        RETURNING id, title, sort_order
      `
      if (!row) return res.status(404).json({ error: 'Section not found' })
      return res.status(200).json(row)
    }
    if (kind === 'entry') {
      const [row] = await sql`
        UPDATE handbook_entries e SET
          title      = COALESCE(${title?.trim() || null}, e.title),
          body       = COALESCE(${body != null ? String(body) : null}, e.body),
          sort_order = COALESCE(${sort_order != null ? Number(sort_order) : null}, e.sort_order),
          updated_at = NOW()
        FROM handbook_sections s
        WHERE e.id = ${id}::uuid
          AND s.id = e.section_id
          AND s.practice_id = ${practiceId}::uuid
        RETURNING e.id, e.section_id, e.title, e.body, e.sort_order, e.updated_at
      `
      if (!row) return res.status(404).json({ error: 'Entry not found' })
      return res.status(200).json(row)
    }
    if (kind === 'file') {
      // Only title / sort_order are patchable — the blob itself is
      // immutable once uploaded (replace = delete + reupload).
      const [row] = await sql`
        UPDATE handbook_files f SET
          title      = COALESCE(${title?.trim() || null}, f.title),
          sort_order = COALESCE(${sort_order != null ? Number(sort_order) : null}, f.sort_order),
          updated_at = NOW()
        FROM handbook_sections s
        WHERE f.id = ${id}::uuid
          AND s.id = f.section_id
          AND s.practice_id = ${practiceId}::uuid
        RETURNING f.id, f.section_id, f.title, f.blob_url, f.filename, f.mime_type, f.size_bytes, f.sort_order, f.updated_at
      `
      if (!row) return res.status(404).json({ error: 'File not found' })
      return res.status(200).json(row)
    }
    return res.status(400).json({ error: 'kind must be section, entry, or file' })
  }

  if (req.method === 'DELETE') {
    const kind = req.query.kind as string
    const id   = req.query.id as string
    if (!id) return res.status(400).json({ error: 'id required' })
    if (kind === 'section') {
      const rows = await sql`DELETE FROM handbook_sections WHERE id = ${id}::uuid AND practice_id = ${practiceId}::uuid RETURNING id`
      if (!rows.length) return res.status(404).json({ error: 'Section not found' })
      return res.status(200).json({ ok: true })
    }
    if (kind === 'entry') {
      const rows = await sql`
        DELETE FROM handbook_entries e
        USING handbook_sections s
        WHERE e.id = ${id}::uuid
          AND s.id = e.section_id
          AND s.practice_id = ${practiceId}::uuid
        RETURNING e.id
      `
      if (!rows.length) return res.status(404).json({ error: 'Entry not found' })
      return res.status(200).json({ ok: true })
    }
    if (kind === 'file') {
      // Fetch blob_url before delete so we can purge the actual object
      // storage — otherwise orphan blobs accumulate on Vercel forever.
      const rows = await sql`
        DELETE FROM handbook_files f
        USING handbook_sections s
        WHERE f.id = ${id}::uuid
          AND s.id = f.section_id
          AND s.practice_id = ${practiceId}::uuid
        RETURNING f.blob_url
      `
      if (!rows.length) return res.status(404).json({ error: 'File not found' })
      try { await deleteBlob(rows[0].blob_url as string) } catch (e: any) { console.error('handbook file blob delete failed (row already gone):', e?.message) }
      return res.status(200).json({ ok: true })
    }
    return res.status(400).json({ error: 'kind must be section, entry, or file' })
  }

  return res.status(405).json({ error: 'Method not allowed' })
}
