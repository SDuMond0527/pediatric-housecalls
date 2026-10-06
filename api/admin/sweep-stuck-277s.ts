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

// Inlined duplicates of the 277 parser from api/webhooks/stedi-transaction.ts.
// No cross-file imports in api/ per Vercel bundling constraints — if you
// edit the parser there, mirror the edit here.
const REJECTION_CATEGORIES_277 = new Set(['A3', 'A4', 'A6', 'A7', 'A8'])

type Parsed277Status = { category: string; code: string; entity: string; action: string; date: string; amount: number; message: string }
type Parsed277Full = {
  patientControlNumber: string | null
  payerClaimControlNumber: string | null
  subscriberFirstName: string | null
  subscriberLastName: string | null
  patientFirstName: string | null
  patientLastName: string | null
  statusAt: string | null
  isRejection: boolean
  statuses: Parsed277Status[]
}

function parseX12_277_full(text: string): Parsed277Full {
  const out: Parsed277Full = {
    patientControlNumber: null, payerClaimControlNumber: null,
    subscriberFirstName: null, subscriberLastName: null,
    patientFirstName: null, patientLastName: null,
    statusAt: null, isRejection: false, statuses: [],
  }
  const segs = text.split('~').map(s => s.trim()).filter(Boolean)
  let lastEntity = ''
  for (const seg of segs) {
    const el = seg.split('*')
    const tag = el[0]
    if (tag === 'NM1') {
      const ent = el[1] ?? ''
      lastEntity = ent
      if (ent === 'QC') {
        out.patientLastName = el[3] ?? null
        out.patientFirstName = el[4] ?? null
      } else if (ent === 'IL') {
        out.subscriberLastName = el[3] ?? null
        out.subscriberFirstName = el[4] ?? null
      }
    } else if (tag === 'TRN') {
      if (el[1] === '2' && el[2]) out.patientControlNumber = el[2]
    } else if (tag === 'REF') {
      if (el[1] === '1K' && el[2]) out.payerClaimControlNumber = el[2]
    } else if (tag === 'DTP') {
      if (el[1] === '472' && el[3]) out.statusAt = el[3]
    } else if (tag === 'STC') {
      const sub = (el[1] ?? '').split(':')
      const category = sub[0] ?? ''
      const code = sub[1] ?? ''
      const action = (el[2] ?? '').trim()
      const amount = el[4] ? Number(el[4]) : 0
      const message = (el[11] ?? el[7] ?? '').trim()
      const date = el[2] && /^\d{8}$/.test(el[2]) ? el[2] : ''
      out.statuses.push({ category, code, entity: lastEntity, action, date, amount: isNaN(amount) ? 0 : amount, message })
      if (REJECTION_CATEGORIES_277.has(category)) out.isRejection = true
    }
  }
  return out
}

async function findClaim(sql: any, pcn: string | null, _payerClaimControlNumber: string | null) {
  if (!pcn) return null
  // The webhook does more sophisticated multi-format matching; mirror
  // that pattern. Both UUID-prefix and PEDS#### formats are supported.
  const pcnTrimmed = pcn.trim()
  const [rowByFullUuid] = await sql`
    SELECT id, practice_id FROM claims WHERE id::text = ${pcnTrimmed} LIMIT 1`
  if (rowByFullUuid) return rowByFullUuid
  const [rowByUuidPrefix] = await sql`
    SELECT id, practice_id FROM claims WHERE REPLACE(id::text, '-', '') LIKE ${pcnTrimmed + '%'} LIMIT 1`
  if (rowByUuidPrefix) return rowByUuidPrefix
  const [rowByPcn] = await sql`
    SELECT id, practice_id FROM claims WHERE payer_control_number = ${pcnTrimmed} LIMIT 1`
  if (rowByPcn) return rowByPcn
  return null
}

async function attach277ToClaim(sql: any, parsed: Parsed277Full, rawX12: string): Promise<{ matched: boolean; claimId?: string }> {
  const claim = await findClaim(sql, parsed.patientControlNumber, parsed.payerClaimControlNumber)
  if (!claim) return { matched: false }
  const reasons = parsed.statuses
    .filter(s => REJECTION_CATEGORIES_277.has(s.category))
    .map(s => ({ category: s.category, code: s.code, entity: s.entity, action: s.action, amount: s.amount, message: s.message }))
  await sql`
    UPDATE claims SET
      claim_rejection_at       = COALESCE(claim_rejection_at, NOW()),
      claim_rejection_response = ${JSON.stringify({ parsed, rawX12 })}::jsonb,
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
 * Shipped 2026-10-06 to recover ALL 277 webhook events that
 * stedi_transactions_processed shows as 'source=277-webhook-no-x12'.
 * At ship time: 97 unique transaction IDs over the last 14 days,
 * covering ~33 submitted claims (every claim normally gets 2-3 277
 * events — clearinghouse ack, payer ack, final status — so one
 * missed rejection could be buried in there).
 *
 * For each stuck transaction, probes every plausible Stedi URL (same
 * list as the self-healing webhook probe in stedi-transaction.ts).
 * If any URL returns ISA-headed X12, parses it. If it's a rejection,
 * attaches to the matching claim (same findClaim logic as the webhook).
 * If it's an ack, flips the stedi_transactions_processed row to
 * '277-webhook-ack-only'.
 *
 * Returns detailed per-transaction results so Sara can see which URL
 * variant worked (for trimming the probe list afterwards) and which
 * claims got rejections attached.
 *
 * dry_run=1 — probe + parse but do NOT write any claim mutations.
 * limit=N  — process only the first N stuck transactions (default:
 *   all). Safe default; useful for testing on a few before all 97.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  try { await verifyToken(req.headers.authorization) }
  catch { return res.status(401).json({ error: 'Unauthorized' }) }

  if (!STEDI_API_KEY) return res.status(500).json({ error: 'STEDI_API_KEY not configured' })

  const dryRun = req.query.dry_run === '1' || req.query.dry_run === 'true'
  const limit = Math.max(1, Math.min(200, parseInt(String(req.query.limit ?? '200'), 10) || 200))

  const sql = neon(process.env.DATABASE_URL!)
  const stuck = await sql`
    SELECT transaction_id FROM stedi_transactions_processed
    WHERE source = '277-webhook-no-x12'
    ORDER BY processed_at DESC
    LIMIT ${limit}
  `
  if (!stuck.length) return res.status(200).json({ ok: true, swept: 0, note: 'No stuck 277 transactions.' })

  const buildProbeUrls = (txId: string) => [
    `https://healthcare.us.stedi.com/2024-04-01/change/medicalnetwork/reports/v2/${txId}/277`,
    `https://healthcare.us.stedi.com/2024-04-01/change/medicalnetwork/reports/v2/${txId}/x12`,
    `https://healthcare.us.stedi.com/2024-04-01/change/medicalnetwork/reports/v2/${txId}`,
    `https://healthcare.us.stedi.com/2024-04-01/change/medicalnetwork/transactions/${txId}/x12`,
    `https://healthcare.us.stedi.com/2024-04-01/change/medicalnetwork/transactions/${txId}`,
    `https://claims-manager.us.stedi.com/2025-09-01/claim-statuses/${txId}/x12`,
    `https://claims-manager.us.stedi.com/2025-09-01/claim-statuses/${txId}`,
    `https://claims-manager.us.stedi.com/2025-09-01/responses/${txId}/x12`,
    `https://claims-manager.us.stedi.com/2025-09-01/responses/${txId}`,
    `https://claims-manager.us.stedi.com/2025-09-01/277s/${txId}/x12`,
    `https://claims-manager.us.stedi.com/2025-09-01/277s/${txId}`,
  ]

  const probeOne = async (url: string): Promise<{ url: string; x12: string | null; status: number }> => {
    try {
      const r = await fetch(url, {
        headers: {
          Authorization: `Key ${STEDI_API_KEY}`,
          Accept: 'application/edi-x12, text/plain, application/json',
        },
      })
      if (!r.ok) return { url, x12: null, status: r.status }
      const text = (await r.text()).trim()
      if (text.startsWith('ISA')) return { url, x12: text, status: r.status }
      try {
        const j = JSON.parse(text)
        const inner = j?.x12 ?? j?.body ?? j?.content ?? j?.rawX12
        if (typeof inner === 'string' && inner.trim().startsWith('ISA')) {
          return { url, x12: inner.trim(), status: r.status }
        }
      } catch {}
      return { url, x12: null, status: r.status }
    } catch {
      return { url, x12: null, status: 0 }
    }
  }

  const perTransaction: any[] = []
  const winningUrlCounts: Record<string, number> = {}
  let rejectionsAttached = 0
  let ackOnly = 0
  let stillStuck = 0
  let unmatched = 0

  for (const row of stuck) {
    const txId = row.transaction_id as string
    const urls = buildProbeUrls(txId)
    const results = await Promise.all(urls.map(probeOne))
    const winner = results.find(r => r.x12)
    if (!winner) {
      stillStuck += 1
      perTransaction.push({
        transaction_id: txId,
        outcome: 'still_stuck',
        probe_statuses: results.map(r => ({ url: r.url, status: r.status })),
      })
      continue
    }
    winningUrlCounts[winner.url] = (winningUrlCounts[winner.url] ?? 0) + 1
    const parsed = parseX12_277_full(winner.x12 as string)
    if (!parsed.isRejection) {
      ackOnly += 1
      if (!dryRun) {
        await sql`
          UPDATE stedi_transactions_processed
          SET source = '277-webhook-ack-only', matched_claim_count = 0, processed_at = NOW()
          WHERE transaction_id = ${txId}`
      }
      perTransaction.push({ transaction_id: txId, outcome: 'ack_only', winning_url: winner.url, pcn: parsed.patientControlNumber })
      continue
    }
    // Rejection — attach to matching claim.
    if (dryRun) {
      perTransaction.push({ transaction_id: txId, outcome: 'rejection_detected_dry_run', winning_url: winner.url, pcn: parsed.patientControlNumber, reasons: parsed.statuses.filter(s => REJECTION_CATEGORIES_277.has(s.category)) })
      continue
    }
    const { matched, claimId } = await attach277ToClaim(sql, parsed, winner.x12 as string)
    if (matched) {
      rejectionsAttached += 1
      await sql`
        UPDATE stedi_transactions_processed
        SET source = '277-webhook-swept', matched_claim_count = 1, processed_at = NOW()
        WHERE transaction_id = ${txId}`
      perTransaction.push({ transaction_id: txId, outcome: 'rejection_attached', winning_url: winner.url, pcn: parsed.patientControlNumber, claim_id: claimId })
    } else {
      unmatched += 1
      await sql`
        UPDATE stedi_transactions_processed
        SET source = '277-webhook-swept-unmatched', matched_claim_count = 0, processed_at = NOW()
        WHERE transaction_id = ${txId}`
      perTransaction.push({ transaction_id: txId, outcome: 'rejection_unmatched_pcn', winning_url: winner.url, pcn: parsed.patientControlNumber })
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
      still_stuck: stillStuck,
    },
    winning_urls: winningUrlCounts,
    per_transaction: perTransaction,
  })
}
