import type { VercelRequest, VercelResponse } from '@vercel/node'
import { neon } from '@neondatabase/serverless'
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
 * GET /api/claims/[id]/277-x12
 *
 * Streams the stored raw 277 X12 payload for this claim as a
 * text/plain download. Parallel to /era-pdf and /1500-pdf, except
 * 277s aren't PDFs — they're EDI text. Andrea uses this to archive,
 * forward to payer support, or diff against a resubmission.
 *
 * Raw X12 is stored in claim_rejection_response.rawX12 (attached
 * either by the webhook or by the manual attach-277-x12 endpoint).
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  let sub: string
  try { sub = await verifyToken(req.headers.authorization) }
  catch { return res.status(401).json({ error: 'Unauthorized' }) }

  try {
    const sql = neon(process.env.DATABASE_URL!)
    const [provider] = await sql`SELECT id, practice_id FROM providers WHERE cognito_sub = ${sub} LIMIT 1`
    if (!provider) return res.status(403).json({ error: 'Provider not found' })

    const claimId = req.query.id as string
    if (!claimId) return res.status(400).json({ error: 'id required' })

    const [row] = await sql`
      SELECT
        claim_rejection_response,
        claim_rejection_at,
        patient_first_name,
        patient_last_name,
        service_date
      FROM claims
      WHERE id = ${claimId}::uuid AND practice_id = ${provider.practice_id}::uuid
      LIMIT 1
    `
    if (!row) return res.status(404).json({ error: 'Claim not found' })
    if (!row.claim_rejection_at) return res.status(404).json({ error: 'No 277 rejection on record for this claim' })

    const rejResp = row.claim_rejection_response ?? {}
    const rawX12: string | null = typeof rejResp?.rawX12 === 'string' ? rejResp.rawX12 : null
    if (!rawX12) {
      return res.status(404).json({ error: 'This rejection was recorded before raw X12 storage was wired — parsed reasons are visible on the claim card but the original X12 was not preserved.' })
    }

    const safePatient = `${row.patient_first_name ?? ''}_${row.patient_last_name ?? ''}`.replace(/[^a-z0-9_-]/gi, '') || 'patient'
    const safeDate = row.service_date ? String(row.service_date).slice(0, 10) : 'nodate'
    const filename = `277_${safePatient}_${safeDate}.txt`

    res.setHeader('Content-Type', 'text/plain; charset=utf-8')
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
    return res.status(200).send(rawX12)
  } catch (e: any) {
    console.error('claims/[id]/277-x12 error:', e)
    return res.status(500).json({ error: e.message ?? 'Internal server error' })
  }
}
