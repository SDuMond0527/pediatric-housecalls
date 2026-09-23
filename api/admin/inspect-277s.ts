import type { VercelRequest, VercelResponse } from '@vercel/node'
import { createRemoteJWKSet, jwtVerify } from 'jose'
import { neon } from '@neondatabase/serverless'

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

const STEDI_API_KEY = process.env.STEDI_API_KEY || ''
const STEDI_POLL_TRANSACTIONS_URL =
  'https://core.us.stedi.com/2026-06-01/polling/transactions'
// Same base as 835 report; substituting the transaction type. If Stedi
// returns 404 for this URL, the response will surface here and we
// iterate — better than guessing in the full pipeline.
const STEDI_277_REPORT_URL = (transactionId: string) =>
  `https://healthcare.us.stedi.com/2024-04-01/change/medicalnetwork/reports/v2/${transactionId}/277`

/**
 * GET /api/admin/inspect-277s?days=30
 *
 * DIAGNOSTIC — polls Stedi's transactions API for inbound 277 Claim
 * Acknowledgment transactions in the last N days, fetches each report,
 * returns the parsed shape so we can see:
 *
 *   - How Stedi labels 277 artifacts (artifactType / model)
 *   - What the 277 report JSON looks like (fields for status codes,
 *     SmartEdits messages, patient control number, etc.)
 *   - Whether the report URL pattern I assumed actually works
 *
 * Once this returns real data, I can write the full 277 ingestion
 * pipeline against a known contract instead of guessing.
 *
 * Delete this endpoint once the pipeline is live.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })
  if (!STEDI_API_KEY) return res.status(500).json({ error: 'STEDI_API_KEY not configured' })

  let sub: string
  try { sub = await verifyToken(req.headers.authorization) }
  catch { return res.status(401).json({ error: 'Unauthorized' }) }

  try {
    const sql = neon(process.env.DATABASE_URL!)
    const [provider] = await sql`SELECT is_admin FROM providers WHERE cognito_sub = ${sub} LIMIT 1`
    if (!provider?.is_admin) return res.status(403).json({ error: 'Admin access required' })

    const days = Math.max(1, Math.min(90, parseInt(String(req.query.days ?? '30'), 10) || 30))
    const startDateTime = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()

    // Poll transactions — return everything for the window so we can
    // see what artifact types Stedi is exposing beyond 835.
    const params = new URLSearchParams()
    params.set('pageSize', '250')
    params.set('startDateTime', startDateTime)

    const listRes = await fetch(`${STEDI_POLL_TRANSACTIONS_URL}?${params}`, {
      headers: { Authorization: `Key ${STEDI_API_KEY}`, 'Content-Type': 'application/json' },
    })
    if (!listRes.ok) {
      const body = await listRes.text().catch(() => '')
      return res.status(200).json({ ok: false, step: 'poll-transactions', http: listRes.status, body: body.slice(0, 400) })
    }
    const list = await listRes.json()
    const items: any[] = list?.items ?? []

    // Categorize what came back — surface artifact types so we know
    // exactly what Stedi calls a 277.
    const byType: Record<string, number> = {}
    const candidates: any[] = []
    for (const tx of items) {
      const arts: any[] = Array.isArray(tx?.artifacts) ? tx.artifacts : []
      for (const a of arts) {
        const key = `${a?.artifactType ?? '?'} / ${a?.model ?? '?'}`
        byType[key] = (byType[key] ?? 0) + 1
      }
      const is277 = arts.some(a =>
        String(a?.artifactType ?? '').toLowerCase().includes('277') ||
        String(a?.model ?? '').toLowerCase().includes('claim status') ||
        String(a?.model ?? '').toLowerCase().includes('acknowledgment') ||
        String(a?.model ?? '').toLowerCase().includes('acknowledgement'))
      if (tx?.direction === 'INBOUND' && is277) {
        candidates.push(tx)
      }
    }

    // Fetch the 277 report for the first few candidates so we can see
    // the parsed JSON shape without blowing the budget on huge lists.
    const samples: any[] = []
    for (const tx of candidates.slice(0, 5)) {
      const transactionId = tx.transactionId as string
      try {
        const r = await fetch(STEDI_277_REPORT_URL(transactionId), {
          headers: { Authorization: `Key ${STEDI_API_KEY}`, 'Content-Type': 'application/json' },
        })
        if (!r.ok) {
          const body = await r.text().catch(() => '')
          samples.push({ transaction_id: transactionId, http: r.status, body: body.slice(0, 300) })
          continue
        }
        const parsed = await r.json()
        samples.push({
          transaction_id: transactionId,
          direction: tx.direction,
          created_at: tx.createdAt ?? tx.created_at,
          artifacts: tx.artifacts?.map((a: any) => ({ artifactType: a.artifactType, model: a.model, id: a.id })),
          parsed_report_keys_top_level: Object.keys(parsed ?? {}),
          parsed_sample: parsed,
        })
      } catch (e: any) {
        samples.push({ transaction_id: transactionId, error: e?.message ?? String(e) })
      }
    }

    return res.status(200).json({
      ok: true,
      days,
      total_transactions_in_window: items.length,
      artifact_type_counts: byType,
      candidate_277_count: candidates.length,
      samples,
    })
  } catch (e: any) {
    console.error('inspect-277s error:', e)
    return res.status(500).json({ error: e.message ?? 'Internal server error' })
  }
}
