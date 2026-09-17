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
 * GET /api/claims/[id]/era-pdf
 *
 * Streams the 835 ERA PDF that Stedi renders for a matched
 * remittance. Uses:
 *
 *   GET /2024-04-01/electronic-remittance-advice/{transactionId}/pdf
 *   Accept: application/pdf
 *
 * transactionId is the Stedi ERA UUID we save on the claim when the
 * ERA-processing paths (webhook / cron / refetch / on-demand) match a
 * remittance to it — see claims.stedi_era_transaction_id.
 *
 * If the column isn't set yet (older claim matched before we added
 * this), tell the biller to click "Refetch known ERAs" once to
 * backfill.
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

    // Bootstrap the column so this endpoint stands on its own even on
    // a fresh env before any ERA processing has run.
    try { await sql`ALTER TABLE claims ADD COLUMN IF NOT EXISTS stedi_era_transaction_id text` } catch {}

    const claimId = req.query.id as string
    if (!claimId) return res.status(400).json({ error: 'id required' })

    const [claim] = await sql`
      SELECT
        id,
        patient_first_name, patient_last_name, service_date,
        stedi_era_transaction_id, era_received_at
      FROM claims
      WHERE id = ${claimId}::uuid AND practice_id = ${provider.practice_id}::uuid
      LIMIT 1
    `
    if (!claim) return res.status(404).json({ error: 'Claim not found' })

    if (!claim.stedi_era_transaction_id) {
      return res.status(404).json({
        error: claim.era_received_at
          ? 'This ERA was matched before the transaction ID was being saved. Click "Refetch known ERAs" on the Claims page once to backfill.'
          : 'No ERA has been received for this claim yet.',
      })
    }

    const stediKey = process.env.STEDI_API_KEY
    if (!stediKey) return res.status(500).json({ error: 'STEDI_API_KEY not configured' })

    const stediRes = await fetch(
      `https://healthcare.us.stedi.com/2024-04-01/electronic-remittance-advice/${encodeURIComponent(claim.stedi_era_transaction_id)}/pdf`,
      { headers: { Authorization: `Key ${stediKey}` } }
    )
    if (!stediRes.ok) {
      const bodyText = await stediRes.text().catch(() => '')
      return res.status(502).send(`ERR: Stedi HTTP ${stediRes.status}. ${bodyText.slice(0, 400)}`)
    }
    let b64 = (await stediRes.text()).trim()
    if (b64.startsWith('"') && b64.endsWith('"')) b64 = b64.slice(1, -1)

    const magic = Buffer.from(b64.slice(0, 12), 'base64').slice(0, 5).toString('utf8')
    if (magic !== '%PDF-') {
      return res.status(502).send(`ERR: Decoded bytes are not a PDF (magic="${magic}"). Preview: ${b64.slice(0, 400)}`)
    }

    const first = String(claim.patient_first_name ?? '').replace(/[^A-Za-z0-9]/g, '')
    const last  = String(claim.patient_last_name  ?? '').replace(/[^A-Za-z0-9]/g, '')
    const dos   = String(claim.service_date ?? '').slice(0, 10) || 'undated'
    const filename = `ERA-${first || 'patient'}-${last || 'unknown'}-${dos}.pdf`

    res.setHeader('Content-Type', 'text/plain; charset=utf-8')
    res.setHeader('X-Pdf-Filename', filename)
    res.setHeader('Cache-Control', 'private, max-age=300')
    return res.status(200).send(b64)
  } catch (e: any) {
    console.error('claims/[id]/era-pdf error:', e)
    return res.status(500).json({ error: e?.message ?? 'Internal server error' })
  }
}
