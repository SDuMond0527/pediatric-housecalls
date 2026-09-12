import type { VercelRequest, VercelResponse } from '@vercel/node'
import { neon } from '@neondatabase/serverless'
import { createRemoteJWKSet, jwtVerify } from 'jose'
import { walkClaimPayments, findClaimByPCN, applyEraPaymentToClaim } from '../lib/applyEraPayment'

// Admin-triggered ERA sync — runs the exact same logic as the
// scheduled cron (api/cron/stedi-era-poll.ts) but auths via the
// admin's provider token instead of CRON_SECRET. Wired into the
// AdminClaims page as a "Test Stedi ERA sync" button so Sara can
// verify the pipeline end-to-end without touching Vercel / terminal.
//
// The response JSON tells us:
//   fetched          — how many remittances Stedi returned
//   matched          — how many claim payments matched a local claim
//   statementsCreated — new patient_statement rows written
//   statementsUpdated — existing rows refreshed
//   unmatched        — payments whose PCN didn't match any local claim
//   errors           — per-claim write errors
//   sampleUnmatchedPCNs — up to 5 unmatched PCNs so we can eyeball them
//   remittanceIds    — the Stedi remittance IDs we fetched (for cross-ref)

const STEDI_API_KEY = process.env.STEDI_API_KEY || ''

const STEDI_REMITTANCES_LIST_URL =
  'https://healthcare.us.stedi.com/2024-04-01/change/medicalnetwork/remittances/v3'
const STEDI_REMITTANCE_DETAIL_URL = (id: string) =>
  `https://healthcare.us.stedi.com/2024-04-01/change/medicalnetwork/remittances/v3/${id}`

async function verifyProviderToken(authHeader: string | undefined): Promise<string> {
  if (!authHeader?.startsWith('Bearer ')) throw new Error('Missing token')
  const token = authHeader.slice(7)
  const region     = process.env.VITE_AWS_REGION || 'us-east-2'
  const userPoolId = process.env.VITE_AWS_USER_POOL_ID || ''
  const JWKS = createRemoteJWKSet(new URL(`https://cognito-idp.${region}.amazonaws.com/${userPoolId}/.well-known/jwks.json`))
  const { payload } = await jwtVerify(token, JWKS, { issuer: `https://cognito-idp.${region}.amazonaws.com/${userPoolId}` })
  if (!payload.sub) throw new Error('No sub in token')
  return payload.sub as string
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  let sub: string
  try {
    sub = await verifyProviderToken(req.headers.authorization)
  } catch {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const sql = neon(process.env.DATABASE_URL!)
  const [provider] = await sql`SELECT id, is_admin, practice_id FROM providers WHERE cognito_sub = ${sub} LIMIT 1`
  if (!provider) return res.status(403).json({ error: 'Provider not found' })
  if (!provider.is_admin) return res.status(403).json({ error: 'Admin only' })

  // Guard: STEDI_API_KEY must be present. If it isn't, tell the admin
  // explicitly — this is the most common cause of "nothing happens."
  if (!STEDI_API_KEY) {
    return res.status(200).json({
      ok: false,
      diagnosis: 'STEDI_API_KEY is not set in Vercel environment variables. Add it and redeploy.',
      fetched: 0, matched: 0, statementsCreated: 0, statementsUpdated: 0, unmatched: 0,
      errors: [], sampleUnmatchedPCNs: [], remittanceIds: [],
    })
  }

  // Idempotent column bootstrap for the era_seen_at column that drives
  // the AdminClaims notification badge.
  try { await sql`ALTER TABLE claims ADD COLUMN IF NOT EXISTS era_seen_at timestamptz` } catch {}

  const summary = {
    ok: true as boolean,
    diagnosis: '' as string,
    fetched: 0,
    matched: 0,
    statementsCreated: 0,
    statementsUpdated: 0,
    unmatched: 0,
    errors: [] as string[],
    sampleUnmatchedPCNs: [] as string[],
    remittanceIds: [] as string[],
  }

  try {
    const params = new URLSearchParams({ limit: '50' })
    const listRes = await fetch(`${STEDI_REMITTANCES_LIST_URL}?${params}`, {
      headers: { Authorization: `Key ${STEDI_API_KEY}`, 'Content-Type': 'application/json' },
    })
    if (!listRes.ok) {
      const body = await listRes.text().catch(() => '')
      summary.ok = false
      summary.diagnosis = `Stedi rejected the list request (HTTP ${listRes.status}). This usually means the API key is wrong, expired, or doesn't have remittance access. Response: ${body.slice(0, 300)}`
      return res.status(200).json(summary)
    }

    const listData = await listRes.json()
    const remittances: any[] = listData?.remittances ?? listData?.items ?? []
    summary.fetched = remittances.length
    summary.remittanceIds = remittances.slice(0, 10).map((r: any) => String(r?.id ?? r?.remittanceId ?? '')).filter(Boolean)

    if (remittances.length === 0) {
      summary.diagnosis = 'Stedi returned zero remittances. Either no ERAs have been received on this Stedi account, or the API key belongs to a different tenant. Verify by logging into Stedi and confirming remittances exist for this account.'
      return res.status(200).json(summary)
    }

    for (const rem of remittances) {
      const remId = rem?.id ?? rem?.remittanceId
      if (!remId) continue

      const detailRes = await fetch(STEDI_REMITTANCE_DETAIL_URL(remId), {
        headers: { Authorization: `Key ${STEDI_API_KEY}` },
      })
      if (!detailRes.ok) {
        summary.errors.push(`Detail fetch ${remId}: HTTP ${detailRes.status}`)
        continue
      }
      const detail = await detailRes.json()

      for (const { pcn, parsed } of walkClaimPayments(detail)) {
        const claim = await findClaimByPCN(sql, pcn)
        if (!claim) {
          summary.unmatched += 1
          if (summary.sampleUnmatchedPCNs.length < 5) summary.sampleUnmatchedPCNs.push(pcn)
          continue
        }
        // Only process claims for this admin's practice.
        if (claim.practice_id !== provider.practice_id) continue
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

    // Diagnostic messaging based on what we found.
    if (summary.matched === 0 && summary.unmatched === 0) {
      summary.diagnosis = `Fetched ${summary.fetched} remittance(s) from Stedi, but none contained a claim payment we could parse. The JSON structure may have changed — check Stedi's API docs or share a raw remittance for me to look at.`
    } else if (summary.matched === 0 && summary.unmatched > 0) {
      summary.diagnosis = `Stedi returned ${summary.unmatched} claim payment(s), but NONE matched a local claim by patient control number. This means the PCN scheme used at claim submission doesn't match the reverse-lookup. Sample unmatched PCNs: ${summary.sampleUnmatchedPCNs.join(', ')}. Compare to first 20 chars of your local claim UUIDs (with dashes stripped).`
    } else {
      summary.diagnosis = `Success — applied ${summary.matched} ERA payment(s) to claims. ${summary.statementsCreated} new patient statements created, ${summary.statementsUpdated} updated. Any unmatched (${summary.unmatched}) are payments for claims not in this database.`
    }

    return res.status(200).json(summary)
  } catch (e: any) {
    console.error('[admin/test-stedi-era-sync] error:', e)
    summary.ok = false
    summary.diagnosis = `Unexpected error: ${e?.message ?? String(e)}`
    return res.status(200).json(summary)
  }
}
