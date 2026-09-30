import type { VercelRequest, VercelResponse } from '@vercel/node'
import { handleUpload, type HandleUploadBody } from '@vercel/blob/client'
import { neon } from '@neondatabase/serverless'
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
 * POST /api/handbook-upload-token — signed-URL issuer for client-direct
 * upload to Vercel Blob. The old /api/handbook-upload endpoint routed the
 * whole file through the Vercel function (base64 in the request body) which
 * capped at ~4.5 MB. This endpoint returns a signed token so the browser
 * uploads directly to Blob storage; there's no meaningful size limit
 * beyond Blob's 5 TB per file.
 *
 * Two callback surfaces per @vercel/blob/client's contract:
 *   - onBeforeGenerateToken: our auth gate. Cognito JWT must belong to an
 *     admin provider on this practice. If not, throw to reject.
 *   - onUploadCompleted: fires from Blob's servers when the upload lands.
 *     We don't need to persist here — the browser flow POSTs to
 *     /api/handbook right after upload() resolves to create the DB row,
 *     which gives us better error semantics. Left in place per SDK
 *     requirement.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const body = req.body as HandleUploadBody
  try {
    const jsonResponse = await handleUpload({
      body,
      request: req as unknown as Request,
      // The Vercel Blob client can't forward custom auth headers to
      // this endpoint, so the browser passes the Cognito access token
      // in clientPayload. Parse + verify here on every request.
      onBeforeGenerateToken: async (_pathname, clientPayload) => {
        let accessToken = ''
        try {
          const parsed = JSON.parse(clientPayload || '{}')
          accessToken = String(parsed.accessToken ?? '')
        } catch { /* fall through — empty token = reject below */ }
        if (!accessToken) throw new Error('Missing access token')
        const sub = await verifyProviderToken(accessToken)
        const sql = neon(process.env.DATABASE_URL!)
        const [provider] = await sql`SELECT is_admin, practice_id FROM providers WHERE cognito_sub = ${sub} LIMIT 1`
        if (!provider) throw new Error('Provider not found')
        if (!provider.is_admin) throw new Error('Admin only')
        return {
          allowedContentTypes: undefined, // any file type
          addRandomSuffix: true,
          tokenPayload: JSON.stringify({ sub, practice_id: provider.practice_id }),
        }
      },
      onUploadCompleted: async ({ blob }) => {
        // No-op: DB row creation happens in the client's follow-up POST
        // to /api/handbook. Logged for troubleshooting.
        console.log('[handbook-upload-token] blob landed:', blob.url)
      },
    })
    return res.status(200).json(jsonResponse)
  } catch (e: any) {
    console.error('[handbook-upload-token] failed:', e?.message)
    return res.status(400).json({ error: e?.message ?? 'Upload token failed' })
  }
}

// Vercel body-size limit workaround: handleUpload needs to read the raw
// body itself, so keep the JSON parser enabled (default) — the request
// body from the client is small (metadata only, not the file).
