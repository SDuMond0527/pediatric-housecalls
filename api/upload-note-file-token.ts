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
 * POST /api/upload-note-file-token — signed-URL issuer for client-direct
 * upload of encounter-note file attachments to Vercel Blob. The browser
 * uploads directly to Blob storage so audio/video recordings (which can
 * easily be 50-200 MB) aren't blocked by Vercel's serverless function
 * body-size limit.
 *
 * Any authenticated provider can issue a token for themselves. The DB
 * row (encounter_notes.files jsonb append) happens in the client's
 * save flow — this endpoint only issues the upload token.
 *
 * Shipped 2026-10-07 after Sara couldn't upload .3gp/.m4a/.mov files.
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
        } catch { /* fall through — empty token = reject below */ }
        if (!accessToken) throw new Error('Missing access token')
        const sub = await verifyProviderToken(accessToken)
        return {
          allowedContentTypes: undefined, // any file type (audio/video/pdf/etc)
          addRandomSuffix: true,
          tokenPayload: JSON.stringify({ sub }),
        }
      },
      onUploadCompleted: async ({ blob }) => {
        console.log('[upload-note-file-token] blob landed:', blob.url)
      },
    })
    return res.status(200).json(jsonResponse)
  } catch (e: any) {
    console.error('[upload-note-file-token] failed:', e?.message)
    return res.status(400).json({ error: e?.message ?? 'Upload token failed' })
  }
}
