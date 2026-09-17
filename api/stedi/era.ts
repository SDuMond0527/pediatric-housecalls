import type { VercelRequest, VercelResponse } from '@vercel/node'
import { neon } from '@neondatabase/serverless'
import { createRemoteJWKSet, jwtVerify } from 'jose'

async function verifyToken(authHeader: string | undefined): Promise<string> {
  if (!authHeader?.startsWith('Bearer ')) throw new Error('Missing token')
  const token = authHeader.slice(7)
  const region     = process.env.VITE_AWS_REGION || 'us-east-2'
  const userPoolId = process.env.VITE_AWS_USER_POOL_ID || ''
  const JWKS = createRemoteJWKSet(new URL(`https://cognito-idp.${region}.amazonaws.com/${userPoolId}/.well-known/jwks.json`))
  const { payload } = await jwtVerify(token, JWKS, { issuer: `https://cognito-idp.${region}.amazonaws.com/${userPoolId}` })
  if (!payload.sub) throw new Error('No sub in token')
  return payload.sub
}

// Walk the 835 JSON and find the claim matching our patient control number.
// Stedi maps X12 segments to JSON — we handle the most common field name variants.
function findAndParseClaimPayment(eraBody: any, patientControlNumber: string) {
  const interchanges = eraBody?.interchanges ?? [eraBody]
  for (const interchange of interchanges) {
    const groups = interchange?.functionalGroups ?? interchange?.functionalGroup ?? [interchange]
    for (const group of groups) {
      const txSets =
        group?.transactionSets ??
        group?.transactionSet ??
        eraBody?.transactionSets ??
        []
      for (const txSet of txSets) {
        const claims =
          txSet?.claimPaymentInformation ??
          txSet?.claimPayments ??
          txSet?.detail?.claimPaymentInformation ??
          []
        for (const cp of claims) {
          const pcn = cp?.patientControlNumber ?? cp?.patientAccountNumber
          if (pcn !== patientControlNumber) continue

          const amountBilled     = parseFloat(cp?.totalClaimChargeAmount ?? 0) || null
          const insurancePayment = parseFloat(cp?.claimPaymentAmount ?? cp?.paymentAmount ?? 0) || null

          let contractualAdj = 0, deductible = 0, coinsurance = 0, copay = 0, nonCovered = 0

          for (const group of (cp?.claimAdjustmentInformation ?? cp?.adjustmentGroups ?? cp?.claimAdjustments ?? [])) {
            const gc      = group?.adjustmentGroupCode ?? group?.claimAdjustmentGroupCode ?? ''
            const details = group?.adjustmentDetails ?? group?.claimAdjustments ?? group?.adjustments ?? []
            for (const d of details) {
              const code   = d?.adjustmentReasonCode ?? d?.claimAdjustmentReasonCode ?? ''
              const amount = parseFloat(d?.adjustmentAmount ?? 0)
              if (gc === 'CO' && code === '45') contractualAdj += amount
              if (gc === 'PR' && code === '1')  deductible     += amount
              if (gc === 'PR' && code === '2')  coinsurance    += amount
              if (gc === 'PR' && code === '3')  copay          += amount
              if (gc === 'PR' && code === '96') nonCovered     += amount
            }
          }

          return {
            amount_billed:          amountBilled,
            insurance_payment:      insurancePayment,
            contractual_adjustment: contractualAdj || null,
            patient_deductible:     deductible     || null,
            patient_coinsurance:    coinsurance    || null,
            patient_copay:          copay          || null,
            patient_non_covered:    nonCovered     || null,
          }
        }
      }
    }
  }
  return null
}

// ── ADDITIVE denial-code extractor (2026-09-16) ────────────────────────────
// Walks an 835 payload and collects every CAS adjustment entry
// (group_code + reason_code + amount). Runs alongside the existing
// bucket logic without modifying it — callers wrap the invocation in
// try/catch, and this function itself catches its own errors so a
// malformed payload can never crash the ERA processing pipeline.
// Duplicated verbatim into api/cron/stedi-era-poll.ts and
// api/admin/backfill-stedi-cas.ts (Vercel treats api/lib/*.ts files as
// serverless functions and rejects deploys — see the note in
// api/appointments/[id].ts).
type DenialCodeEntry = { group_code: string; reason_code: string; amount: number }
function extractDenialCodes(era835: any): DenialCodeEntry[] {
  const entries: DenialCodeEntry[] = []
  try {
    const addAdj = (adj: any) => {
      if (!adj || typeof adj !== 'object') return
      const groupCode = String(adj.claimAdjustmentGroupCode ?? adj.adjustmentGroupCode ?? adj.groupCode ?? '')
      let sawFlat = false
      for (let i = 1; i <= 6; i++) {
        const reason = adj[`adjustmentReasonCode${i}`]
        const amount = adj[`adjustmentAmount${i}`]
        if (reason == null && amount == null) continue
        sawFlat = true
        entries.push({
          group_code: groupCode,
          reason_code: String(reason ?? ''),
          amount: parseFloat(String(amount ?? '0')) || 0,
        })
      }
      if (sawFlat) return
      const details = adj.claimAdjustmentDetails ?? adj.adjustmentDetails ?? null
      if (details && Array.isArray(details)) {
        for (const d of details) {
          entries.push({
            group_code: groupCode,
            reason_code: String(d.adjustmentReasonCode ?? d.reasonCode ?? ''),
            amount: parseFloat(String(d.adjustmentAmount ?? d.amount ?? '0')) || 0,
          })
        }
        return
      }
      entries.push({
        group_code: groupCode,
        reason_code: String(adj.adjustmentReasonCode ?? adj.reasonCode ?? ''),
        amount: parseFloat(String(adj.adjustmentAmount ?? adj.amount ?? '0')) || 0,
      })
    }
    const ADJ_KEYS = new Set(['claimAdjustments', 'serviceAdjustments', 'serviceLineAdjustments', 'adjustments'])
    const walk = (obj: any) => {
      if (!obj || typeof obj !== 'object') return
      if (Array.isArray(obj)) { for (const item of obj) walk(item); return }
      for (const key of Object.keys(obj)) {
        if (ADJ_KEYS.has(key)) {
          const arr = obj[key]
          if (Array.isArray(arr)) for (const adj of arr) addAdj(adj)
        } else {
          walk(obj[key])
        }
      }
    }
    walk(era835)
  } catch (e) {
    // Defensive — return whatever we collected so far
  }
  return entries
}

// ── X12 835 parser (2026-09-16) ────────────────────────────────────────────
// Same parser as api/admin/refetch-known-eras.ts and
// api/webhooks/stedi-transaction.ts. Reads raw X12 EDI from
// /eras/{id}/x12 (the CAS-inclusive endpoint) and pulls out CLP claim
// headers + subsequent CAS adjustment segments.
type X12CasEntry = { group: string; reason: string; amount: number }
type ParsedX12Claim = {
  pcn: string
  payerClaimControlNumber: string
  totalCharge: number
  totalPaid: number
  patientResponsibility: number
  cas: X12CasEntry[]
}
function parseX12_835(text: string): ParsedX12Claim[] {
  const claims: ParsedX12Claim[] = []
  if (!text || typeof text !== 'string') return claims
  const segments = text.split('~').map(s => s.trim()).filter(Boolean)
  let current: ParsedX12Claim | null = null
  for (const seg of segments) {
    const fields = seg.split('*')
    const tag = fields[0]
    if (tag === 'CLP') {
      if (current) claims.push(current)
      current = {
        pcn:                    String(fields[1] ?? '').trim(),
        totalCharge:            parseFloat(String(fields[3] ?? '0')) || 0,
        totalPaid:              parseFloat(String(fields[4] ?? '0')) || 0,
        patientResponsibility:  parseFloat(String(fields[5] ?? '0')) || 0,
        payerClaimControlNumber: String(fields[7] ?? '').trim(),
        cas: [],
      }
    } else if (tag === 'CAS' && current) {
      const group = String(fields[1] ?? '').trim()
      for (let i = 2; i < fields.length; i += 3) {
        const reason = String(fields[i] ?? '').trim()
        const amount = parseFloat(String(fields[i + 1] ?? '0')) || 0
        if (reason && amount !== 0) current.cas.push({ group, reason, amount })
      }
    }
  }
  if (current) claims.push(current)
  return claims
}
function bucketCasFromX12(cas: X12CasEntry[]) {
  const totals = {
    patient_deductible: 0, patient_coinsurance: 0, patient_copay: 0,
    patient_non_covered: 0, contractual_adjustment: 0,
  }
  for (const c of cas) {
    if (c.group === 'PR') {
      switch (c.reason) {
        case '1':  totals.patient_deductible  += c.amount; break
        case '2':  totals.patient_coinsurance += c.amount; break
        case '3':  totals.patient_copay       += c.amount; break
        case '96': totals.patient_non_covered += c.amount; break
        default:   totals.patient_non_covered += c.amount; break
      }
    } else if (c.group === 'CO' || c.group === 'OA' || c.group === 'PI') {
      totals.contractual_adjustment += c.amount
    }
  }
  for (const k of Object.keys(totals) as (keyof typeof totals)[]) totals[k] = +totals[k].toFixed(2)
  return totals
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  try {
    const sub = await verifyToken(req.headers.authorization)
    const sql = neon(process.env.DATABASE_URL!)

    const [provider] = await sql`SELECT practice_id FROM providers WHERE cognito_sub = ${sub} LIMIT 1`
    if (!provider) return res.status(403).json({ error: 'Provider not found' })

    const claimId = req.query.claim_id as string
    if (!claimId) return res.status(400).json({ error: 'claim_id required' })

    const [claim] = await sql`
      SELECT id, stedi_claim_id, payer_id,
             era_received_at,
             amount_billed_era, insurance_payment_era,
             contractual_adjustment_era, patient_deductible_era,
             patient_coinsurance_era, patient_copay_era, patient_non_covered_era,
             era_raw
      FROM claims
      WHERE id = ${claimId}::uuid AND practice_id = ${provider.practice_id}::uuid
      LIMIT 1
    `
    if (!claim) return res.status(404).json({ error: 'Claim not found' })

    // 1. Serve stored ERA data immediately — fastest path, set by the webhook
    if (claim.era_received_at) {
      return res.status(200).json({
        available: true,
        source: 'stored',
        era_received_at: claim.era_received_at,
        amount_billed:          claim.amount_billed_era,
        insurance_payment:      claim.insurance_payment_era,
        contractual_adjustment: claim.contractual_adjustment_era,
        patient_deductible:     claim.patient_deductible_era,
        patient_coinsurance:    claim.patient_coinsurance_era,
        patient_copay:          claim.patient_copay_era,
        patient_non_covered:    claim.patient_non_covered_era,
      })
    }

    const stediApiKey = process.env.STEDI_API_KEY
    if (!stediApiKey || !claim.stedi_claim_id) {
      return res.status(200).json({ available: false, message: 'ERA not yet received for this claim' })
    }

    // Patient control number = how we identified this claim in the 837 submission
    const patientControlNumber = claimId.replace(/-/g, '').slice(0, 20)

    // 2. Try to pull from Stedi's remittances (835 ERA) API
    // Stedi lists ERA files received for your account, filtered by payer
    // Verify endpoint and params at: https://www.stedi.com/docs/api/healthcare
    try {
      const params = new URLSearchParams()
      if (claim.payer_id) params.set('tradingPartnerId', claim.payer_id)
      params.set('limit', '50')

      // URL corrected 2026-09-11 — the previous
      // healthcare.us.stedi.com/.../remittances/v3 was 404 forever
      // and nobody noticed because the flow silently fell through.
      const listRes = await fetch(
        `https://claims-manager.us.stedi.com/2025-09-01/eras?${params}`,
        { headers: { Authorization: `Key ${stediApiKey}`, 'Content-Type': 'application/json' } }
      )

      if (listRes.ok) {
        const listData = await listRes.json()
        const remittances: any[] = listData?.remittances ?? listData?.items ?? []
        const pcnUpper = patientControlNumber.toUpperCase()

        for (const rem of remittances) {
          const remId = rem?.id ?? rem?.remittanceId
          if (!remId) continue

          // Fetch /eras/{id}/x12 — the CAS-inclusive endpoint. The
          // /eras/{id} JSON endpoint returns only the remittance header
          // (verified 2026-09-16 by dumping the response). CAS lives in
          // the X12 EDI text at the /x12 sub-resource.
          const x12Res = await fetch(
            `https://claims-manager.us.stedi.com/2025-09-01/eras/${remId}/x12`,
            { headers: { Authorization: `Key ${stediApiKey}`, Accept: 'application/edi-x12, text/plain' } }
          )
          if (!x12Res.ok) continue
          const x12Text = await x12Res.text()
          const parsedClaims = parseX12_835(x12Text)

          const pc = parsedClaims.find(c => String(c.pcn ?? '').toUpperCase() === pcnUpper)
          if (!pc) continue

          const cas = bucketCasFromX12(pc.cas)

          await sql`
            UPDATE claims SET
              era_received_at            = NOW(),
              era_raw_835                = ${JSON.stringify({
                                              pcn: pc.pcn,
                                              payerClaimControlNumber: pc.payerClaimControlNumber,
                                              totalCharge: pc.totalCharge,
                                              totalPaid: pc.totalPaid,
                                              patientResponsibility: pc.patientResponsibility,
                                              cas: pc.cas,
                                            })}::jsonb,
              amount_billed_era          = ${pc.totalCharge},
              insurance_payment_era      = ${pc.totalPaid},
              contractual_adjustment_era = ${cas.contractual_adjustment},
              patient_deductible_era     = ${cas.patient_deductible},
              patient_coinsurance_era    = ${cas.patient_coinsurance},
              patient_copay_era          = ${cas.patient_copay},
              patient_non_covered_era    = ${cas.patient_non_covered},
              updated_at                 = NOW()
            WHERE id = ${claimId}::uuid
          `

          // Shape response like the previous JSON parser did
          const parsed = {
            amount_billed:          pc.totalCharge,
            insurance_payment:      pc.totalPaid,
            contractual_adjustment: cas.contractual_adjustment,
            patient_deductible:     cas.patient_deductible,
            patient_coinsurance:    cas.patient_coinsurance,
            patient_copay:          cas.patient_copay,
            patient_non_covered:    cas.patient_non_covered,
          }

          try {
            await sql`ALTER TABLE claims ADD COLUMN IF NOT EXISTS denial_codes jsonb`
            const codes = pc.cas.map(c => ({ group_code: c.group, reason_code: c.reason, amount: c.amount }))
            if (codes.length > 0) {
              await sql`UPDATE claims SET denial_codes = ${JSON.stringify(codes)}::jsonb WHERE id = ${claimId}::uuid`
            }
          } catch (denialErr: any) {
            console.error('[stedi/era] denial-code capture failed (non-fatal):', denialErr?.message)
          }

          return res.status(200).json({ available: true, source: 'live', ...parsed })
        }
      }
    } catch (liveErr: any) {
      console.warn('[stedi/era] Live remittances pull failed:', liveErr?.message)
      // Fall through to "not yet available"
    }

    return res.status(200).json({ available: false, message: 'ERA not yet received for this claim' })

  } catch (e: any) {
    console.error('[stedi/era] error:', e)
    return res.status(200).json({ available: false, message: 'ERA not yet available' })
  }
}
