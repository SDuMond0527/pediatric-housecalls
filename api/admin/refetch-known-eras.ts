import type { VercelRequest, VercelResponse } from '@vercel/node'
import { neon } from '@neondatabase/serverless'
import { createRemoteJWKSet, jwtVerify } from 'jose'

// POST /api/admin/refetch-known-eras
//
// Reads transaction IDs from stedi_transactions_processed (populated by
// the transaction webhook whenever Stedi delivers an ERA) and refetches
// each 835 via Stedi's by-ID endpoint — the same URL the webhook uses
// successfully. Stores the raw scoped payload on claims.era_raw_835 so
// we can inspect what BCBS/UHC actually sent without waiting for a new
// ERA to arrive.
//
// Every response field is visible to the caller (no silent failure).
// If a fetch fails, the transactionId + Stedi status code is returned.
// If a payload doesn't match a claim, that's returned too.
//
// Read-only against every existing era_* column. Only writes to the
// new era_raw_835 JSONB column.

async function verifyToken(auth: string | undefined): Promise<string> {
  if (!auth?.startsWith('Bearer ')) throw new Error('Missing token')
  const token = auth.slice(7)
  const region = process.env.VITE_AWS_REGION || 'us-east-2'
  const poolId = process.env.VITE_AWS_USER_POOL_ID || ''
  const JWKS = createRemoteJWKSet(new URL(`https://cognito-idp.${region}.amazonaws.com/${poolId}/.well-known/jwks.json`))
  const { payload } = await jwtVerify(token, JWKS, { issuer: `https://cognito-idp.${region}.amazonaws.com/${poolId}` })
  if (!payload.sub) throw new Error('No sub')
  return payload.sub as string
}

const STEDI_API_KEY = process.env.STEDI_API_KEY || ''

// Same URL the webhook uses — known-working. Do NOT change without
// verifying it still returns 200.
const STEDI_835_BY_ID_URL = (transactionId: string) =>
  `https://healthcare.us.stedi.com/2024-04-01/change/medicalnetwork/reports/v2/${transactionId}/835`

function extractClaimPayments(era835: any): Array<{ pcn: string | null; payerClaimControlNumber: string | null; scoped: any }> {
  const out: Array<{ pcn: string | null; payerClaimControlNumber: string | null; scoped: any }> = []
  const walk = (obj: any) => {
    if (!obj || typeof obj !== 'object') return
    if (Array.isArray(obj)) { for (const item of obj) walk(item); return }
    if (obj.patientControlNumber || obj.payerClaimControlNumber) {
      out.push({
        pcn: obj.patientControlNumber ? String(obj.patientControlNumber).trim() : null,
        payerClaimControlNumber: obj.payerClaimControlNumber ? String(obj.payerClaimControlNumber).trim() : null,
        scoped: obj,
      })
    }
    for (const key of Object.keys(obj)) walk(obj[key])
  }
  walk(era835)
  return out
}

async function findClaim(sql: any, pcn: string | null, payerClaimControlNumber: string | null, practiceId: string): Promise<any | null> {
  if (payerClaimControlNumber) {
    const rows = await sql`
      SELECT id FROM claims
      WHERE stedi_payer_claim_control_number = ${payerClaimControlNumber}
        AND practice_id = ${practiceId}::uuid
      LIMIT 1`
    if (rows[0]) return rows[0]
  }
  if (pcn) {
    const rows = await sql`
      SELECT id FROM claims
      WHERE REPLACE(id::text, '-', '') ILIKE ${pcn + '%'}
        AND practice_id = ${practiceId}::uuid
      LIMIT 1`
    if (rows[0]) return rows[0]
  }
  return null
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  let sub: string
  try { sub = await verifyToken(req.headers.authorization) }
  catch { return res.status(401).json({ error: 'Unauthorized' }) }

  try {
    const sql = neon(process.env.DATABASE_URL!)

    const [provider] = await sql`SELECT id, is_admin, practice_id FROM providers WHERE cognito_sub = ${sub} LIMIT 1`
    if (!provider) return res.status(403).json({ error: 'Provider not found' })
    if (!provider.is_admin) return res.status(403).json({ error: 'Admin access required' })

    try { await sql`ALTER TABLE claims ADD COLUMN IF NOT EXISTS era_raw_835 jsonb` } catch {}
    try { await sql`ALTER TABLE claims ADD COLUMN IF NOT EXISTS stedi_payer_claim_control_number text` } catch {}

    // Pull known transaction IDs from OUR OWN DB — no polling endpoint
    // needed. These are the transactions the webhook already recorded.
    const txns = await sql`
      SELECT transaction_id
      FROM stedi_transactions_processed
      ORDER BY processed_at DESC
    `

    const result = {
      transactions_found_in_db: txns.length,
      per_transaction: [] as Array<{
        transaction_id: string
        stedi_status: number | null
        claim_payments_seen: number
        claims_saved: number
        errors: string[]
      }>,
      totals: {
        stedi_fetched: 0,
        claims_saved: 0,
        errors: 0,
      },
    }

    for (const t of txns) {
      const txId: string = t.transaction_id
      const perTx = {
        transaction_id: txId,
        stedi_status: null as number | null,
        claim_payments_seen: 0,
        claims_saved: 0,
        errors: [] as string[],
      }

      try {
        const r = await fetch(STEDI_835_BY_ID_URL(txId), {
          headers: { Authorization: `Key ${STEDI_API_KEY}`, 'Content-Type': 'application/json' },
        })
        perTx.stedi_status = r.status
        if (!r.ok) {
          const errText = await r.text().catch(() => '')
          perTx.errors.push(`Stedi HTTP ${r.status}: ${errText.slice(0, 200)}`)
          result.totals.errors += 1
          result.per_transaction.push(perTx)
          continue
        }
        const era835 = await r.json()
        result.totals.stedi_fetched += 1

        const claimPayments = extractClaimPayments(era835)
        perTx.claim_payments_seen = claimPayments.length

        for (const cp of claimPayments) {
          try {
            const claim = await findClaim(sql, cp.pcn, cp.payerClaimControlNumber, provider.practice_id)
            if (!claim) {
              perTx.errors.push(`No claim match for pcn=${cp.pcn} payerCcn=${cp.payerClaimControlNumber}`)
              continue
            }
            await sql`
              UPDATE claims SET
                era_raw_835 = ${JSON.stringify(cp.scoped)}::jsonb,
                updated_at  = NOW()
              WHERE id = ${claim.id}::uuid
            `
            perTx.claims_saved += 1
            result.totals.claims_saved += 1
          } catch (perCpErr: any) {
            perTx.errors.push(`apply: ${perCpErr?.message ?? String(perCpErr)}`)
            result.totals.errors += 1
          }
        }
      } catch (fetchErr: any) {
        perTx.errors.push(`fetch: ${fetchErr?.message ?? String(fetchErr)}`)
        result.totals.errors += 1
      }

      result.per_transaction.push(perTx)
    }

    return res.status(200).json(result)
  } catch (e: any) {
    console.error('refetch-known-eras error:', e)
    return res.status(500).json({ error: e.message ?? 'Internal server error' })
  }
}
