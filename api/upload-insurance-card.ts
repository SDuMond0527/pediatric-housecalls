import { handleUpload, type HandleUploadBody } from '@vercel/blob/client'
import type { VercelRequest, VercelResponse } from '@vercel/node'
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
    const jsonResponse = await handleUpload({
      body: req.body as HandleUploadBody,
      request: req as any,
      onBeforeGenerateToken: async (_pathname) => {
        await verifyFamilyToken(req.headers.authorization)
        return {
          allowedContentTypes: ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'],
          maximumSizeInBytes: 15 * 1024 * 1024,
        }
      },
      onUploadCompleted: async ({ blob }) => {
        console.log('Insurance card uploaded:', blob.url)
      },
    })
    return res.json(jsonResponse)
  } catch (e: any) {
    const status = e.message?.includes('Unauthorized') || e.message?.includes('Missing token') || e.message?.includes('No sub') ? 401 : 400
    return res.status(status).json({ error: e.message ?? 'Upload failed' })
  }
}
