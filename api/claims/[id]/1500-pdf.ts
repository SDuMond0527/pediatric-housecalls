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
 * GET /api/claims/[id]/1500-pdf
 *
 * Streams the CMS-1500 PDF that Stedi auto-generates for every
 * submitted professional claim. Uses the "Business Identifier" variant
 * of Stedi's export API:
 *
 *   GET /2024-04-01/export/pdf?businessId={correlationId}
 *
 * The correlationId (a ULID) is echoed back in the synchronous
 * submission response as claimReference.correlationId — we already
 * save that whole response into claims.stedi_response, so no DB
 * migration needed. Response is JSON with { pdfs: [{ data: <base64> }] }.
 *
 * Sent back with Content-Type: application/pdf and inline
 * Content-Disposition so the browser previews it in a new tab
 * (Andrea can then use the browser's PDF viewer to download).
 * Filename is patient-slugged for legibility if she does save it.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  let sub: string
  try { sub = await verifyToken(req.headers.authorization) }
  catch { return res.status(401).json({ error: 'Unauthorized' }) }

  try {
    const sql = neon(process.env.DATABASE_URL!)
    const [provider] = await sql`SELECT practice_id FROM providers WHERE cognito_sub = ${sub} LIMIT 1`
    if (!provider) return res.status(403).json({ error: 'Provider not found' })

    const claimId = req.query.id as string
    if (!claimId) return res.status(400).json({ error: 'id required' })

    const [claim] = await sql`
      SELECT
        id,
        patient_first_name,
        patient_last_name,
        service_date,
        stedi_response
      FROM claims
      WHERE id = ${claimId}::uuid AND practice_id = ${provider.practice_id}::uuid
      LIMIT 1
    `
    if (!claim) return res.status(404).json({ error: 'Claim not found' })

    const correlationId = claim.stedi_response?.claimReference?.correlationId ?? null
    if (!correlationId) {
      return res.status(400).json({
        error: 'This claim has no Stedi correlation ID. It may not have been submitted yet, or it was submitted through a legacy path that predates PDF generation.',
      })
    }

    const stediKey = process.env.STEDI_API_KEY
    if (!stediKey) return res.status(500).json({ error: 'STEDI_API_KEY not configured' })

    const stediUrl = `https://healthcare.us.stedi.com/2024-04-01/export/pdf?businessId=${encodeURIComponent(correlationId)}`
    const stediRes = await fetch(stediUrl, { headers: { Authorization: `Key ${stediKey}` } })
    const rawBody = await stediRes.text()

    if (!stediRes.ok) {
      return res.status(502).send(`ERR: Stedi HTTP ${stediRes.status}. ${rawBody.slice(0, 400)}`)
    }

    // Stedi Business Identifier variant returns JSON: { pdfs: [{ data: base64 }] }
    let body: any = null
    try { body = JSON.parse(rawBody) } catch {}
    const b64 = body?.pdfs?.[0]?.data
    if (!b64) {
      return res.status(502).send(`ERR: Stedi returned no PDF. Errors: ${JSON.stringify(body?.errors ?? null)}. Preview: ${rawBody.slice(0, 400)}`)
    }

    const magic = Buffer.from(b64.slice(0, 12), 'base64').slice(0, 5).toString('utf8')
    if (magic !== '%PDF-') {
      return res.status(502).send(`ERR: Decoded bytes are not a PDF (magic="${magic}"). Preview: ${rawBody.slice(0, 400)}`)
    }

    // Return base64 as plain text — no JSON wrapper (nothing to
    // misparse), no binary (nothing for Vercel to mangle). Client just
    // reads response as text, atob() decodes, blob renders.
    const first = String(claim.patient_first_name ?? '').replace(/[^A-Za-z0-9]/g, '')
    const last  = String(claim.patient_last_name  ?? '').replace(/[^A-Za-z0-9]/g, '')
    const dos   = String(claim.service_date ?? '').slice(0, 10) || 'undated'
    const filename = `1500-${first || 'patient'}-${last || 'unknown'}-${dos}.pdf`

    res.setHeader('Content-Type', 'text/plain; charset=utf-8')
    res.setHeader('X-Pdf-Filename', filename)
    res.setHeader('Cache-Control', 'private, max-age=300')
    return res.status(200).send(b64)
  } catch (e: any) {
    console.error('claims/[id]/1500-pdf error:', e)
    return res.status(500).json({ error: e?.message ?? 'Internal server error' })
  }
}
