import type { VercelRequest, VercelResponse } from '@vercel/node'
import { neon } from '@neondatabase/serverless'
import { createRemoteJWKSet, jwtVerify } from 'jose'

const STEDI_API_KEY = process.env.STEDI_API_KEY || ''
const STEDI_277_REPORT_URL = (txId: string) =>
  `https://healthcare.us.stedi.com/2024-04-01/change/medicalnetwork/reports/v2/${txId}/277`

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

// REJECTION_CATEGORIES_277 + parse277CaJson + findClaim +
// attach277ToClaim mirror api/webhooks/stedi-transaction.ts. No
// cross-file imports in api/ per Vercel bundling constraints. If you
// change the parser or rejection set in one place, change it here too.
const REJECTION_CATEGORIES_277 = new Set(['A3', 'A4', 'A6', 'A7', 'A8', 'R4'])

type Parsed277Status = { category: string; code: string; entity: string; action: string; date: string; amount: number; message: string }
type Parsed277Full = {
  patientControlNumber: string | null
  payerClaimControlNumber: string | null
  patientFirstName: string | null
  patientLastName: string | null
  serviceDateFrom: string | null
  serviceDateTo: string | null
  payerName: string | null
  transactionSetIdentifier: string | null
  statuses: Parsed277Status[]
  isRejection: boolean
}

function parse277CaJson(reportJson: any): Parsed277Full {
  const out: Parsed277Full = {
    patientControlNumber: null, payerClaimControlNumber: null,
    patientFirstName: null, patientLastName: null,
    serviceDateFrom: null, serviceDateTo: null,
    payerName: null, transactionSetIdentifier: '277',
    statuses: [], isRejection: false,
  }
  if (!reportJson || typeof reportJson !== 'object') return out
  const pushStatus = (s: any, entity: string, message: string, action: string = '') => {
    const category = String(s?.healthCareClaimStatusCategoryCode ?? '').trim()
    const code     = String(s?.statusCode ?? '').trim()
    const codeText = String(s?.statusCodeValue ?? '').trim()
    out.statuses.push({
      category, code, entity, action, date: '', amount: 0,
      message: [codeText, message].filter(Boolean).join(' — '),
    })
    if (REJECTION_CATEGORIES_277.has(category)) out.isRejection = true
  }
  const transactions = Array.isArray(reportJson?.transactions) ? reportJson.transactions : []
  for (const t of transactions) {
    const payers = Array.isArray(t?.payers) ? t.payers : []
    for (const p of payers) {
      if (!out.payerName && typeof p?.organizationName === 'string') out.payerName = p.organizationName
      const cst = Array.isArray(p?.claimStatusTransactions) ? p.claimStatusTransactions : []
      for (const batch of cst) {
        for (const pc of (Array.isArray(batch?.providerClaimStatuses) ? batch.providerClaimStatuses : [])) {
          for (const s of (Array.isArray(pc?.providerStatuses) ? pc.providerStatuses : [])) pushStatus(s, 'provider', '')
        }
        for (const d of (Array.isArray(batch?.claimStatusDetails) ? batch.claimStatusDetails : [])) {
          for (const spc of (Array.isArray(d?.serviceProviderClaimStatuses) ? d.serviceProviderClaimStatuses : [])) {
            for (const s of (Array.isArray(spc?.serviceProviderStatuses) ? spc.serviceProviderStatuses : [])) pushStatus(s, 'serviceProvider', '')
          }
          for (const pat of (Array.isArray(d?.patientClaimStatusDetails) ? d.patientClaimStatusDetails : [])) {
            if (pat?.subscriber) {
              out.patientFirstName = out.patientFirstName ?? (pat.subscriber.firstName ?? null)
              out.patientLastName  = out.patientLastName  ?? (pat.subscriber.lastName  ?? null)
            }
            for (const c of (Array.isArray(pat?.claims) ? pat.claims : [])) {
              const cs = c?.claimStatus
              if (cs) {
                if (!out.patientControlNumber) {
                  const pcn = cs.referencedTransactionTraceNumber ?? cs.patientAccountNumber ?? cs.clearinghouseTraceNumber ?? null
                  if (typeof pcn === 'string' && pcn.trim()) out.patientControlNumber = pcn.trim()
                }
                if (!out.payerClaimControlNumber && typeof cs.tradingPartnerClaimNumber === 'string') {
                  out.payerClaimControlNumber = cs.tradingPartnerClaimNumber.trim() || null
                }
                if (!out.serviceDateFrom && typeof cs.claimServiceBeginDate === 'string' && /^\d{8}$/.test(cs.claimServiceBeginDate)) {
                  out.serviceDateFrom = `${cs.claimServiceBeginDate.slice(0,4)}-${cs.claimServiceBeginDate.slice(4,6)}-${cs.claimServiceBeginDate.slice(6,8)}`
                }
                if (!out.serviceDateTo && typeof cs.claimServiceEndDate === 'string' && /^\d{8}$/.test(cs.claimServiceEndDate)) {
                  out.serviceDateTo = `${cs.claimServiceEndDate.slice(0,4)}-${cs.claimServiceEndDate.slice(4,6)}-${cs.claimServiceEndDate.slice(6,8)}`
                }
                for (const info of (Array.isArray(cs?.informationClaimStatuses) ? cs.informationClaimStatuses : [])) {
                  const msg = String(info?.statusMessage ?? '').trim()
                  const action = String(info?.statusInformationActionCodeValue ?? info?.statusInformationActionCode ?? '').trim()
                  for (const s of (Array.isArray(info?.informationStatuses) ? info.informationStatuses : [])) pushStatus(s, 'claim', msg, action)
                }
              }
              for (const sl of (Array.isArray(c?.serviceLines) ? c.serviceLines : [])) {
                for (const sc of (Array.isArray(sl?.serviceClaimStatuses) ? sl.serviceClaimStatuses : [])) {
                  const msg = String(sc?.statusMessage ?? '').trim()
                  for (const s of (Array.isArray(sc?.serviceStatuses) ? sc.serviceStatuses : [])) pushStatus(s, 'serviceLine', msg)
                }
              }
            }
          }
        }
      }
    }
  }
  return out
}

async function findClaim(sql: any, pcn: string | null, _payerClaimControlNumber: string | null) {
  if (!pcn) return null
  const pcnTrimmed = pcn.trim()
  const [rowByFullUuid] = await sql`SELECT id, practice_id FROM claims WHERE id::text = ${pcnTrimmed} LIMIT 1`
  if (rowByFullUuid) return rowByFullUuid
  const [rowByUuidPrefix] = await sql`SELECT id, practice_id FROM claims WHERE REPLACE(id::text, '-', '') LIKE ${pcnTrimmed + '%'} LIMIT 1`
  if (rowByUuidPrefix) return rowByUuidPrefix
  const [rowByPcn] = await sql`SELECT id, practice_id FROM claims WHERE payer_control_number = ${pcnTrimmed} LIMIT 1`
  if (rowByPcn) return rowByPcn
  return null
}

async function attach277ToClaim(sql: any, parsed: Parsed277Full, reportJson: any): Promise<{ matched: boolean; claimId?: string }> {
  const claim = await findClaim(sql, parsed.patientControlNumber, parsed.payerClaimControlNumber)
  if (!claim) return { matched: false }
  const reasons = parsed.statuses
    .filter(s => REJECTION_CATEGORIES_277.has(s.category))
    .map(s => ({ category: s.category, code: s.code, entity: s.entity, action: s.action, amount: s.amount, message: s.message }))
  await sql`
    UPDATE claims SET
      claim_rejection_at       = COALESCE(claim_rejection_at, NOW()),
      claim_rejection_response = ${JSON.stringify({ parsed, rawJson: reportJson })}::jsonb,
      claim_rejection_reasons  = ${JSON.stringify(reasons)}::jsonb,
      ready_for_biller_at      = NULL,
      ready_for_biller_by      = NULL,
      updated_at               = NOW()
    WHERE id = ${claim.id}::uuid`
  return { matched: true, claimId: claim.id }
}

/**
 * POST /api/admin/sweep-stuck-277s[?dry_run=1&limit=N]
 *
 * Recovers every 277 webhook event that stedi_transactions_processed
 * shows as 'source=277-webhook-no-x12' (or the newer -fetch-failed /
 * -fetch-threw variants). Backfill after the 2026-10-06 fix.
 *
 * For each stuck transaction:
 *   1. GET /2024-04-01/change/medicalnetwork/reports/v2/{id}/277
 *      with Accept: application/json (the webhook used to parse this
 *      as X12 and silently drop it — Stedi actually returns JSON here).
 *   2. parse277CaJson walks every status level (provider / service-
 *      provider / claim-info / service-line).
 *   3. If any status.category ∈ REJECTION_CATEGORIES_277, attach to the
 *      claim matching the parsed PCN (same findClaim as the webhook).
 *   4. Flip the stedi_transactions_processed row to '277-webhook-swept'
 *      (or '-swept-unmatched' / '-swept-ack-only' / '-still-failed')
 *      so the queue drains.
 *
 * dry_run=1 — probe + parse but don't write any claim mutations.
 * limit=N  — process only the first N stuck transactions (default: all).
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
  try { await verifyToken(req.headers.authorization) } catch { return res.status(401).json({ error: 'Unauthorized' }) }
  if (!STEDI_API_KEY) return res.status(500).json({ error: 'STEDI_API_KEY not configured' })

  const dryRun = req.query.dry_run === '1' || req.query.dry_run === 'true'
  const limit = Math.max(1, Math.min(200, parseInt(String(req.query.limit ?? '200'), 10) || 200))
  const sql = neon(process.env.DATABASE_URL!)

  const stuck = await sql`
    SELECT transaction_id FROM stedi_transactions_processed
    WHERE source IN ('277-webhook-no-x12', '277-webhook-fetch-failed', '277-webhook-fetch-threw')
    ORDER BY processed_at DESC
    LIMIT ${limit}
  `
  if (!stuck.length) return res.status(200).json({ ok: true, swept: 0, note: 'No stuck 277 transactions.' })

  const perTransaction: any[] = []
  let rejectionsAttached = 0, ackOnly = 0, unmatched = 0, stillFailed = 0, fetchErrors = 0

  for (const row of stuck) {
    const txId = row.transaction_id as string
    let reportJson: any = null
    try {
      const r = await fetch(STEDI_277_REPORT_URL(txId), {
        headers: { Authorization: `Key ${STEDI_API_KEY}`, Accept: 'application/json' },
      })
      if (!r.ok) {
        fetchErrors += 1
        const errText = (await r.text().catch(() => '')).slice(0, 200)
        perTransaction.push({ transaction_id: txId, outcome: 'fetch_failed', status: r.status, error: errText })
        if (!dryRun) {
          await sql`UPDATE stedi_transactions_processed SET source = '277-webhook-still-failed', processed_at = NOW() WHERE transaction_id = ${txId}`
        }
        continue
      }
      reportJson = await r.json()
    } catch (e: any) {
      fetchErrors += 1
      perTransaction.push({ transaction_id: txId, outcome: 'fetch_threw', error: e?.message ?? String(e) })
      if (!dryRun) {
        await sql`UPDATE stedi_transactions_processed SET source = '277-webhook-still-failed', processed_at = NOW() WHERE transaction_id = ${txId}`
      }
      continue
    }

    const parsed = parse277CaJson(reportJson)
    if (!parsed.isRejection) {
      ackOnly += 1
      if (!dryRun) {
        await sql`UPDATE stedi_transactions_processed SET source = '277-webhook-swept-ack-only', matched_claim_count = 0, processed_at = NOW() WHERE transaction_id = ${txId}`
      }
      perTransaction.push({ transaction_id: txId, outcome: 'ack_only', pcn: parsed.patientControlNumber, categories: parsed.statuses.map(s => `${s.category}/${s.code}`) })
      continue
    }

    if (dryRun) {
      perTransaction.push({ transaction_id: txId, outcome: 'rejection_detected_dry_run', pcn: parsed.patientControlNumber, patient: `${parsed.patientFirstName ?? ''} ${parsed.patientLastName ?? ''}`.trim(), reasons: parsed.statuses.filter(s => REJECTION_CATEGORIES_277.has(s.category)) })
      continue
    }

    const { matched, claimId } = await attach277ToClaim(sql, parsed, reportJson)
    if (matched) {
      rejectionsAttached += 1
      await sql`UPDATE stedi_transactions_processed SET source = '277-webhook-swept', matched_claim_count = 1, processed_at = NOW() WHERE transaction_id = ${txId}`
      perTransaction.push({ transaction_id: txId, outcome: 'rejection_attached', pcn: parsed.patientControlNumber, claim_id: claimId, patient: `${parsed.patientFirstName ?? ''} ${parsed.patientLastName ?? ''}`.trim() })
    } else {
      unmatched += 1
      await sql`UPDATE stedi_transactions_processed SET source = '277-webhook-swept-unmatched', matched_claim_count = 0, processed_at = NOW() WHERE transaction_id = ${txId}`
      perTransaction.push({ transaction_id: txId, outcome: 'rejection_unmatched_pcn', pcn: parsed.patientControlNumber })
    }
  }

  return res.status(200).json({
    ok: true,
    dry_run: dryRun,
    swept: stuck.length,
    outcomes: {
      rejections_attached: rejectionsAttached,
      ack_only: ackOnly,
      unmatched_pcn: unmatched,
      fetch_errors: fetchErrors,
      still_failed: stillFailed,
    },
    per_transaction: perTransaction,
  })
}
