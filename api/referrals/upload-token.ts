import type { VercelRequest, VercelResponse } from '@vercel/node'
import { handleUpload, type HandleUploadBody } from '@vercel/blob/client'

/**
 * POST /api/referrals/upload-token — public signed-URL issuer so an
 * urgent-care provider can upload front/back photos of a patient's
 * insurance card directly from the referral form. No auth required —
 * the form is intentionally public (QR-code use case).
 *
 * Uploads land under /referrals/ prefix. Blob URLs are opaque + hard to
 * guess, so the main risk is spam, not read-leak. Rate-limit at the
 * CDN / Vercel-firewall level if abuse shows up.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const body = req.body as HandleUploadBody
  try {
    const jsonResponse = await handleUpload({
      body,
      request: req as unknown as Request,
      onBeforeGenerateToken: async () => ({
        allowedContentTypes: ['image/jpeg', 'image/png', 'image/heic', 'image/webp'],
        addRandomSuffix: true,
      }),
      onUploadCompleted: async ({ blob }) => {
        console.log('[referrals/upload-token] blob landed:', blob.url)
      },
    })
    return res.status(200).json(jsonResponse)
  } catch (e: any) {
    console.error('[referrals/upload-token] failed:', e?.message)
    return res.status(400).json({ error: e?.message ?? 'Upload token failed' })
  }
}
