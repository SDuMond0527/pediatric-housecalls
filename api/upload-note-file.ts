import type { VercelRequest, VercelResponse } from '@vercel/node'
import { put } from '@vercel/blob'
import { createRemoteJWKSet, jwtVerify } from 'jose'

// Streaming body for POST uploads — same pattern as upload-note-photo.ts.
export const config = { api: { bodyParser: false } }

async function verifyToken(authHeader: string | undefined): Promise<string> {
  if (!authHeader?.startsWith('Bearer ')) throw new Error('Missing token')
  const token = authHeader.slice(7)
  const region = process.env.VITE_AWS_REGION || 'us-east-2'
  const userPoolId = process.env.VITE_AWS_USER_POOL_ID || ''
  const JWKS = createRemoteJWKSet(new URL(`https://cognito-idp.${region}.amazonaws.com/${userPoolId}/.well-known/jwks.json`))
  const { payload } = await jwtVerify(token, JWKS, { issuer: `https://cognito-idp.${region}.amazonaws.com/${userPoolId}` })
  if (!payload.sub) throw new Error('No sub in token')
  return payload.sub
}

/**
 * POST /api/upload-note-file
 *   ?filename=<name>&contentType=<mime>
 *   body: raw file bytes
 *
 * Companion to upload-note-photo.ts, but accepts any file type (PDF,
 * doc, scan, lab result export, etc.) attached to an encounter note.
 * The URL is returned and the client appends { url, name } to the
 * note's files jsonb array. Sara 2026-10-07.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  try { await verifyToken(req.headers.authorization) } catch {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const filename = (req.query.filename as string) || `file-${Date.now()}`
  const safeName = String(filename).replace(/[^\w.\-]+/g, '_').slice(0, 180)
  const contentType = (req.query.contentType as string) || (req.headers['content-type'] as string) || 'application/octet-stream'

  const blob = await put(`note-files/${Date.now()}-${safeName}`, req as any, {
    access: 'public',
    contentType,
  })

  return res.json({ url: blob.url, name: filename, content_type: contentType })
}
