import type { VercelRequest, VercelResponse } from '@vercel/node'
import { put } from '@vercel/blob'
import { createRemoteJWKSet, jwtVerify } from 'jose'

async function verifyFamilyToken(authHeader: string | undefined): Promise<void> {
  if (!authHeader?.startsWith('Bearer ')) throw new Error('Missing token')
  const token = authHeader.slice(7)
  const region = process.env.VITE_AWS_REGION || 'us-east-2'
  const userPoolId = process.env.VITE_FAMILY_USER_POOL_ID || ''
  const JWKS = createRemoteJWKSet(new URL(`https://cognito-idp.${region}.amazonaws.com/${userPoolId}/.well-known/jwks.json`))
  const { payload } = await jwtVerify(token, JWKS, { issuer: `https://cognito-idp.${region}.amazonaws.com/${userPoolId}` })
  if (!payload.sub) throw new Error('No sub in token')
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  try {
    await verifyFamilyToken(req.headers.authorization)
  } catch {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const { data, filename } = req.body as { data: string; filename: string }
  if (!data || !filename) return res.status(400).json({ error: 'Missing data or filename' })

  const matches = data.match(/^data:([^;]+);base64,(.+)$/)
  if (!matches) return res.status(400).json({ error: 'Invalid image data' })
  const [, contentType, base64] = matches
  const buffer = Buffer.from(base64, 'base64')

  try {
    const blob = await put(filename, buffer, { access: 'public', contentType })
    return res.json({ url: blob.url })
  } catch (e: any) {
    return res.status(500).json({ error: e.message ?? 'Upload failed' })
  }
}
