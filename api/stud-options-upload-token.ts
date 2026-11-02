import type { VercelRequest, VercelResponse } from '@vercel/node'
import { handleUpload, type HandleUploadBody } from '@vercel/blob/client'
import { createRemoteJWKSet, jwtVerify } from 'jose'

async function verifyProviderToken(rawToken: string): Promise<string> {
  const region = process.env.VITE_AWS_REGION || 'us-east-2'
  const poolId = process.env.VITE_AWS_USER_POOL_ID || ''
  const JWKS = createRemoteJWKSet(new URL(`https://cognito-idp.${region}.amazonaws.com/${poolId}/.well-known/jwks.json`))
  const { payload } = await jwtVerify(rawToken, JWKS, { issuer: `https://cognito-idp.${region}.amazonaws.com/${poolId}` })
  if (!payload.sub) throw new Error('No sub in token')
  return payload.sub as string
}

/**
 * POST /api/stud-options-upload-token — signed-URL issuer for admin
 * client-direct upload of stud option photos. Cognito-authed. Images
 * land under stud-options/ prefix.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const body = req.body as HandleUploadBody
  try {
    const jsonResponse = await handleUpload({
      body,
      request: req as unknown as Request,
      onBeforeGenerateToken: async (_pathname, clientPayload) => {
        let accessToken = ''
        try {
          const parsed = JSON.parse(clientPayload || '{}')
          accessToken = String(parsed.accessToken ?? '')
        } catch {}
        if (!accessToken) throw new Error('Missing access token')
        await verifyProviderToken(accessToken)
        return {
          allowedContentTypes: ['image/jpeg', 'image/png', 'image/webp', 'image/heic'],
          addRandomSuffix: true,
        }
      },
      onUploadCompleted: async ({ blob }) => {
        console.log('[stud-options-upload-token] blob landed:', blob.url)
      },
    })
    return res.status(200).json(jsonResponse)
  } catch (e: any) {
    return res.status(400).json({ error: e?.message ?? 'Upload token failed' })
  }
}
