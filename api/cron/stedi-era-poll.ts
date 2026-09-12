import type { VercelRequest, VercelResponse } from '@vercel/node'
import { neon } from '@neondatabase/serverless'
import { walkClaimPayments, findClaimByPCN, applyEraPaymentToClaim } from '../lib/applyEraPayment'

// Poll Stedi's remittances (835 ERAs) endpoint every 30 min as a
// catch-up in case the webhook (api/webhooks/stedi-era.ts) missed a
// notification or Stedi didn't POST for whatever reason. Both the
// webhook and this cron delegate the actual write to the same
// applyEraPaymentToClaim helper, so they produce identical DB state.
// See memory: feedback_extract_shared_code_first_try.md.
//
// Auth: CRON_SECRET env var (Bearer). Vercel's cron trigger sets this
// header automatically for scheduled invocations.

const STEDI_API_KEY = process.env.STEDI_API_KEY || ''
const CRON_SECRET   = process.env.CRON_SECRET   || ''

const STEDI_REMITTANCES_LIST_URL =
  'https://healthcare.us.stedi.com/2024-04-01/change/medicalnetwork/remittances/v3'
const STEDI_REMITTANCE_DETAIL_URL = (id: string) =>
  `https://healthcare.us.stedi.com/2024-04-01/change/medicalnetwork/remittances/v3/${id}`

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (CRON_SECRET && req.headers.authorization !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' })
  }
  if (!STEDI_API_KEY) {
    return res.status(500).json({ error: 'STEDI_API_KEY not configured' })
  }

  const sql = neon(process.env.DATABASE_URL!)

  // Idempotent column bootstrap: era_seen_at drives the "N unseen ERA
  // payments" badge on AdminClaims. Safe to re-run every invocation.
  try { await sql`ALTER TABLE claims ADD COLUMN IF NOT EXISTS era_seen_at timestamptz` } catch {}

  const summary = { fetched: 0, matched: 0, statementsCreated: 0, statementsUpdated: 0, unmatched: 0, errors: [] as string[] }

  try {
    // List the most recent remittances. Stedi's list endpoint returns
    // paginated results — grab first page (limit 50) which covers the
    // typical 30-min window comfortably.
    const params = new URLSearchParams({ limit: '50' })
    const listRes = await fetch(`${STEDI_REMITTANCES_LIST_URL}?${params}`, {
      headers: { Authorization: `Key ${STEDI_API_KEY}`, 'Content-Type': 'application/json' },
    })
    if (!listRes.ok) {
      const body = await listRes.text().catch(() => '')
      return res.status(200).json({ ...summary, errors: [`Stedi list failed: ${listRes.status} ${body.slice(0, 200)}`] })
    }
    const listData = await listRes.json()
    const remittances: any[] = listData?.remittances ?? listData?.items ?? []
    summary.fetched = remittances.length

    for (const rem of remittances) {
      const remId = rem?.id ?? rem?.remittanceId
      if (!remId) continue

      const detailRes = await fetch(STEDI_REMITTANCE_DETAIL_URL(remId), {
        headers: { Authorization: `Key ${STEDI_API_KEY}` },
      })
      if (!detailRes.ok) {
        summary.errors.push(`Detail fetch ${remId}: ${detailRes.status}`)
        continue
      }
      const detail = await detailRes.json()

      for (const { pcn, parsed } of walkClaimPayments(detail)) {
        const claim = await findClaimByPCN(sql, pcn)
        if (!claim) {
          summary.unmatched += 1
          continue
        }
        try {
          const { statementCreated } = await applyEraPaymentToClaim(sql, claim, parsed, detail)
          summary.matched += 1
          if (statementCreated) summary.statementsCreated += 1
          else summary.statementsUpdated += 1
        } catch (perClaimErr: any) {
          summary.errors.push(`Claim ${claim.id}: ${perClaimErr?.message ?? String(perClaimErr)}`)
        }
      }
    }

    return res.status(200).json(summary)
  } catch (e: any) {
    console.error('[stedi-era-poll] error:', e)
    return res.status(200).json({ ...summary, errors: [...summary.errors, e?.message ?? String(e)] })
  }
}
