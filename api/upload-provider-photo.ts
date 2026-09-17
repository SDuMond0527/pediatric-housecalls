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
 * POST /api/upload-provider-photo
 *
 * Body: { data: dataUrl, filename: string, provider_id: uuid }
 *
 * Admin-only. Uploads the image to Vercel Blob, then stamps the URL
 * onto providers.photo_url so the family portal shows a headshot next
 * to the provider's name (Sara 2026-09-17 — provider photos on the
 * family booking flow).
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  let sub: string
  try { sub = await verifyProviderToken(req.headers.authorization) }
  catch { return res.status(401).json({ error: 'Unauthorized' }) }

  const sql = neon(process.env.DATABASE_URL!)
  const [me] = await sql`SELECT is_admin, practice_id FROM providers WHERE cognito_sub = ${sub} LIMIT 1`
  if (!me || !me.is_admin) return res.status(403).json({ error: 'Admin access required' })

  const { data, filename, provider_id } = req.body as { data: string; filename: string; provider_id: string }
  if (!data || !filename || !provider_id) {
    return res.status(400).json({ error: 'Missing data, filename, or provider_id' })
  }

  const matches = data.match(/^data:([^;]+);base64,(.+)$/)
  if (!matches) return res.status(400).json({ error: 'Invalid image data' })
  const [, contentType, base64] = matches
  const buffer = Buffer.from(base64, 'base64')

  try {
    // Idempotent — column may not exist on fresh envs.
    try { await sql`ALTER TABLE providers ADD COLUMN IF NOT EXISTS photo_url text` } catch {}

    const blob = await put(`provider-photos/${provider_id}-${Date.now()}-${filename}`, buffer, {
      access: 'public',
      contentType,
    })

    const [updated] = await sql`
      UPDATE providers SET photo_url = ${blob.url}
      WHERE id = ${provider_id}::uuid AND practice_id = ${me.practice_id}::uuid
      RETURNING id, photo_url
    `
    if (!updated) return res.status(404).json({ error: 'Provider not found' })

    return res.json({ url: blob.url, provider: updated })
  } catch (e: any) {
    console.error('upload-provider-photo error:', e)
    return res.status(500).json({ error: e.message ?? 'Upload failed' })
  }
}
