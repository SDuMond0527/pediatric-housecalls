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

    const stediKey = process.env.STEDI_API_KEY
    if (!stediKey) return res.status(500).json({ error: 'STEDI_API_KEY not configured' })

    if (!claim.era_received_at) {
      return res.status(404).send('ERR: No ERA has been received for this claim yet.')
    }

    // The saved value MIGHT be the correct 36-char UUID or the older
    // 30-char remittanceId from Claims Manager (which doesn't work
    // with the PDF endpoint). If it's not a valid UUID, we do a
    // one-shot lookup against Poll Transactions to find the real one.
    const isUuid = (s: string) => /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(s)
    let transactionId: string | null = claim.stedi_era_transaction_id && isUuid(String(claim.stedi_era_transaction_id))
      ? String(claim.stedi_era_transaction_id)
      : null

    if (!transactionId) {
      // PCN = the identifier we sent to Stedi on the 837, echoed back
      // in the 835's CLP segment. Same derivation as buildStediPayload.
      const pcn = String(claim.id).replace(/-/g, '').slice(0, 20).toUpperCase()

      // Walk Poll Transactions (35+ days back — most ERAs come within
      // 30 days of submission) looking for an 835 whose businessIdentifiers
      // reference our PCN.
      const startDateTime = new Date(Date.now() - 35 * 24 * 60 * 60 * 1000).toISOString()
      let pageToken: string | undefined
      let scanned = 0
      const maxPages = 20   // hard cap so we never DOS ourselves
      outer: for (let page = 0; page < maxPages; page++) {
        const params = new URLSearchParams()
        if (pageToken) params.set('pageToken', pageToken)
        else params.set('startDateTime', startDateTime)
        params.set('pageSize', '500')
        const pRes = await fetch(`https://healthcare.us.stedi.com/2024-04-01/polling/transactions?${params}`, {
          headers: { Authorization: `Key ${stediKey}` },
        })
        if (!pRes.ok) {
          const t = await pRes.text().catch(() => '')
          return res.status(502).send(`ERR: Stedi polling HTTP ${pRes.status}. ${t.slice(0, 400)}`)
        }
        const body: any = await pRes.json()
        const items: any[] = body?.items ?? []
        for (const it of items) {
          scanned++
          // Only 835 remittances
          const tsi = it?.x12?.metadata?.transaction?.transactionSetIdentifier
          if (tsi !== '835') continue
          // businessIdentifiers[].value may include our PCN
          const bids: any[] = it?.businessIdentifiers ?? []
          if (bids.some(b => String(b?.value ?? '').toUpperCase() === pcn)) {
            transactionId = it.transactionId
            break outer
          }
        }
        pageToken = body?.nextPageToken
        if (!pageToken || items.length === 0) break
      }

      if (!transactionId) {
        return res.status(404).send(`ERR: Could not find an 835 remittance in Stedi's polling that matches this claim's PCN (${pcn}). Scanned ${scanned} transactions. The ERA may be older than 35 days, or the payer's remittance didn't echo our PCN.`)
      }

      // Cache it so next click on this claim is instant.
      try { await sql`UPDATE claims SET stedi_era_transaction_id = ${transactionId} WHERE id = ${claim.id}::uuid` } catch {}
    }

    const stediRes = await fetch(
      `https://healthcare.us.stedi.com/2024-04-01/electronic-remittance-advice/${encodeURIComponent(transactionId)}/pdf`,
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
