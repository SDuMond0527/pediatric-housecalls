import type { VercelRequest, VercelResponse } from '@vercel/node'
import { neon } from '@neondatabase/serverless'
import { createRemoteJWKSet, jwtVerify } from 'jose'

const STEDI_API_KEY = process.env.STEDI_API_KEY || ''

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
 * GET /api/admin/diagnose-277-endpoints[?transaction_id=UUID]
 *
 * Shipped 2026-10-06 after we found that 97 of 97 recent 277 webhook
 * events in prod failed to extract any X12 (source='277-webhook-no-x12'
 * in stedi_transactions_processed). The current webhook tries three
 * paths — inline payload, related-resource URL, and
 * reports/v2/{id}/277 — and all three come back empty.
 *
 * This endpoint takes a known-stuck 277 transaction ID and probes
 * every plausible Stedi retrieval URL in parallel, reporting which
 * one returns X12. Once we know the right URL, patch the webhook
 * handler (api/webhooks/stedi-transaction.ts attach277 flow) and
 * delete this file.
 *
 * If no transaction_id query param is supplied, we pick the newest
 * stuck transaction automatically so Sara can click a bookmarklet
 * without having to look one up.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  try { await verifyToken(req.headers.authorization) }
  catch { return res.status(401).json({ error: 'Unauthorized' }) }

  if (!STEDI_API_KEY) return res.status(500).json({ error: 'STEDI_API_KEY not configured' })

  let txId = String(req.query.transaction_id ?? '').trim()
  if (!txId) {
    const sql = neon(process.env.DATABASE_URL!)
    const [row] = await sql`
      SELECT transaction_id FROM stedi_transactions_processed
      WHERE source = '277-webhook-no-x12'
      ORDER BY processed_at DESC
      LIMIT 1
    `
    txId = row?.transaction_id ?? ''
    if (!txId) return res.status(400).json({ error: 'No stuck 277 transactions found to probe.' })
  }

  // Every plausible URL for retrieving a 277 X12 or JSON parse by
  // transaction UUID. Ordered by my best guess at likelihood. The
  // winner here becomes the next webhook extractor.
  const candidates = [
    { name: 'reports/v2/{id}/277 (current)',
      url: `https://healthcare.us.stedi.com/2024-04-01/change/medicalnetwork/reports/v2/${txId}/277`,
      accept: 'application/edi-x12, text/plain' },
    { name: 'reports/v2/{id} (no suffix, 277)',
      url: `https://healthcare.us.stedi.com/2024-04-01/change/medicalnetwork/reports/v2/${txId}`,
      accept: 'application/edi-x12, text/plain' },
    { name: 'reports/v2/{id}/x12 (277)',
      url: `https://healthcare.us.stedi.com/2024-04-01/change/medicalnetwork/reports/v2/${txId}/x12`,
      accept: 'application/edi-x12, text/plain' },
    { name: 'transactions/{id}',
      url: `https://healthcare.us.stedi.com/2024-04-01/change/medicalnetwork/transactions/${txId}`,
      accept: 'application/json' },
    { name: 'transactions/{id}/x12',
      url: `https://healthcare.us.stedi.com/2024-04-01/change/medicalnetwork/transactions/${txId}/x12`,
      accept: 'application/edi-x12, text/plain' },
    { name: 'claims-manager claim-statuses/{id}',
      url: `https://claims-manager.us.stedi.com/2025-09-01/claim-statuses/${txId}`,
      accept: 'application/json' },
    { name: 'claims-manager claim-statuses/{id}/x12',
      url: `https://claims-manager.us.stedi.com/2025-09-01/claim-statuses/${txId}/x12`,
      accept: 'application/edi-x12, text/plain' },
    { name: 'claims-manager responses/{id}',
      url: `https://claims-manager.us.stedi.com/2025-09-01/responses/${txId}`,
      accept: 'application/json' },
    { name: 'claims-manager responses/{id}/x12',
      url: `https://claims-manager.us.stedi.com/2025-09-01/responses/${txId}/x12`,
      accept: 'application/edi-x12, text/plain' },
    { name: 'claims-manager claims/{id}/responses',
      url: `https://claims-manager.us.stedi.com/2025-09-01/claims/${txId}/responses`,
      accept: 'application/json' },
    { name: 'claims-manager claims/{id}',
      url: `https://claims-manager.us.stedi.com/2025-09-01/claims/${txId}`,
      accept: 'application/json' },
    { name: 'claims-manager 277s/{id}/x12',
      url: `https://claims-manager.us.stedi.com/2025-09-01/277s/${txId}/x12`,
      accept: 'application/edi-x12, text/plain' },
    { name: 'claims-manager 277s/{id}',
      url: `https://claims-manager.us.stedi.com/2025-09-01/277s/${txId}`,
      accept: 'application/json' },
  ]

  const probe = async (c: { name: string; url: string; accept: string }) => {
    const started = Date.now()
    try {
      const r = await fetch(c.url, {
        headers: { Authorization: `Key ${STEDI_API_KEY}`, Accept: c.accept },
      })
      const text = await r.text().catch(() => '')
      const isX12 = text.trim().startsWith('ISA')
      let embeddedX12 = false
      if (!isX12 && text) {
        try {
          const j = JSON.parse(text)
          const inner = j?.x12 ?? j?.body ?? j?.content ?? j?.rawX12
          if (typeof inner === 'string' && inner.trim().startsWith('ISA')) embeddedX12 = true
        } catch {}
      }
      return {
        name: c.name,
        url: c.url,
        status: r.status,
        ok: r.ok,
        is_x12: isX12,
        has_embedded_x12: embeddedX12,
        ms: Date.now() - started,
        head: text.slice(0, 500),
      }
    } catch (e: any) {
      return {
        name: c.name,
        url: c.url,
        status: 0,
        ok: false,
        is_x12: false,
        has_embedded_x12: false,
        ms: Date.now() - started,
        error: e?.message ?? String(e),
      }
    }
  }

  const results = await Promise.all(candidates.map(probe))

  // Also try listing claim-statuses by trading partner — in case 277s
  // need a list-then-fetch pattern like ERAs do.
  const listCandidates = [
    { name: 'claims-manager claim-statuses?limit=5',
      url: `https://claims-manager.us.stedi.com/2025-09-01/claim-statuses?limit=5` },
    { name: 'claims-manager responses?limit=5',
      url: `https://claims-manager.us.stedi.com/2025-09-01/responses?limit=5` },
    { name: 'claims-manager 277s?limit=5',
      url: `https://claims-manager.us.stedi.com/2025-09-01/277s?limit=5` },
    { name: 'claims-manager claims?limit=5',
      url: `https://claims-manager.us.stedi.com/2025-09-01/claims?limit=5` },
  ]
  const lists = await Promise.all(listCandidates.map(async c => {
    try {
      const r = await fetch(c.url, {
        headers: { Authorization: `Key ${STEDI_API_KEY}`, Accept: 'application/json' },
      })
      const text = await r.text().catch(() => '')
      return { name: c.name, url: c.url, status: r.status, ok: r.ok, head: text.slice(0, 800) }
    } catch (e: any) {
      return { name: c.name, url: c.url, status: 0, ok: false, error: e?.message ?? String(e) }
    }
  }))

  return res.status(200).json({
    transaction_id: txId,
    probes: results.map(r => ({
      name: r.name,
      status: r.status,
      ok: r.ok,
      is_x12: r.is_x12,
      has_embedded_x12: r.has_embedded_x12,
      ms: r.ms,
      head: r.head?.slice(0, 500),
      error: (r as any).error,
    })),
    list_probes: lists,
  })
}
