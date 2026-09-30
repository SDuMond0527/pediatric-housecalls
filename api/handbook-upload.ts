import type { VercelRequest, VercelResponse } from '@vercel/node'
import { put } from '@vercel/blob'
import { neon } from '@neondatabase/serverless'
import { createRemoteJWKSet, jwtVerify } from 'jose'

async function verifyProviderToken(authHeader: string | undefined): Promise<string> {
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
 * POST /api/handbook-upload — admin-only file upload to Vercel Blob for the
 * "All things PHC" handbook. Client sends base64-encoded data + filename +
 * mime_type; server pushes to Blob and returns { url, filename, mime_type,
 * size_bytes }. The caller then POSTs to /api/handbook with kind:'file' to
 * link the URL into a section.
 *
 * Split from /api/handbook so the CRUD endpoint stays small and this one
 * can carry blob-specific concerns (size limit, mime whitelist eventually).
 *
 * Vercel body limit ~4.5 MB. Documents larger than that will fail here —
 * add client-direct upload if that ever becomes a real constraint.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  let sub: string
  try { sub = await verifyProviderToken(req.headers.authorization) }
  catch { return res.status(401).json({ error: 'Unauthorized' }) }

  const sql = neon(process.env.DATABASE_URL!)
  const [provider] = await sql`SELECT is_admin FROM providers WHERE cognito_sub = ${sub} LIMIT 1`
  if (!provider) return res.status(403).json({ error: 'Provider not found' })
  if (!provider.is_admin) return res.status(403).json({ error: 'Admin only' })

  const { data, filename, mime_type } = req.body as { data: string; filename: string; mime_type?: string }
  if (!data || !filename) return res.status(400).json({ error: 'Missing data or filename' })

  const matches = data.match(/^data:([^;]+);base64,(.+)$/)
  if (!matches) return res.status(400).json({ error: 'Invalid file data' })
  const [, dataUrlContentType, base64] = matches
  const buffer = Buffer.from(base64, 'base64')

  try {
    // Prefix path with 'handbook/' so blobs are organizationally distinct
    // from insurance cards / note photos / provider avatars.
    const contentType = mime_type || dataUrlContentType
    const blob = await put(`handbook/${filename}`, buffer, { access: 'public', contentType })
    return res.json({
      url: blob.url,
      filename,
      mime_type: contentType,
      size_bytes: buffer.byteLength,
    })
  } catch (e: any) {
    return res.status(500).json({ error: e.message ?? 'Upload failed' })
  }
}
