import type { VercelRequest, VercelResponse } from '@vercel/node'
import { neon } from '@neondatabase/serverless'
import { createRemoteJWKSet, jwtVerify } from 'jose'

// POST /api/admin/refetch-known-eras
//
// Fetches every ERA in the practice via Stedi's CAS-inclusive /eras
// endpoint (the same one api/stedi/era.ts uses for the "Pull from Stedi
// ERA" button on the statement modal). For each remittance, walks the
// full 835 JSON for claim payments and matches them to our claims by
// patientControlNumber. When matched, stores the SCOPED cp payload
// (which contains claimAdjustmentInformation → CAS) on
// claims.era_raw_835, then parses CAS + denial codes and updates the
// claim's era_ columns.
//
// This replaces the earlier refetch flow that used
// healthcare.us.stedi.com/.../reports/v2/{id}/835 — that endpoint
// returns a summary that strips CAS. This one returns CAS intact.

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
const STEDI_ERAS_LIST_URL   = (params: string) => `https://claims-manager.us.stedi.com/2025-09-01/eras?${params}`
const STEDI_ERA_DETAIL_URL  = (id: string)     => `https://claims-manager.us.stedi.com/2025-09-01/eras/${id}`

// Walk any 835 payload for the individual claim-payment structures
// (they contain claimAdjustmentInformation → CAS). Same walker pattern
// api/webhooks/stedi-transaction.ts uses.
function extractClaimPayments(era835: any): Array<{ pcn: string | null; payerClaimControlNumber: string | null; scoped: any }> {
  const out: Array<{ pcn: string | null; payerClaimControlNumber: string | null; scoped: any }> = []
  const walk = (obj: any) => {
    if (!obj || typeof obj !== 'object') return
    if (Array.isArray(obj)) { for (const item of obj) walk(item); return }
    if (obj.patientControlNumber || obj.patientAccountNumber || obj.payerClaimControlNumber) {
      out.push({
        pcn: (obj.patientControlNumber ?? obj.patientAccountNumber) ? String(obj.patientControlNumber ?? obj.patientAccountNumber).trim() : null,
        payerClaimControlNumber: obj.payerClaimControlNumber ? String(obj.payerClaimControlNumber).trim() : null,
        scoped: obj,
      })
    }
    for (const key of Object.keys(obj)) walk(obj[key])
  }
  walk(era835)
  return out
}

// Same CAS bucket logic as api/webhooks/stedi-transaction.ts and
// api/admin/backfill-stedi-cas.ts. Duplicated so we don't touch either
// of those files.
interface CasBreakdown {
  patient_deductible:     number
  patient_coinsurance:    number
  patient_copay:          number
  patient_non_covered:    number
  contractual_adjustment: number
}
function parseCasAdjustments(scoped: any): CasBreakdown {
  const totals: CasBreakdown = {
    patient_deductible: 0, patient_coinsurance: 0, patient_copay: 0,
    patient_non_covered: 0, contractual_adjustment: 0,
  }
  const bucketFor = (groupCode: string | undefined, reasonCode: any): keyof CasBreakdown | null => {
    if (groupCode === 'PR') {
      switch (String(reasonCode)) {
        case '1':  return 'patient_deductible'
        case '2':  return 'patient_coinsurance'
        case '3':  return 'patient_copay'
        case '96': return 'patient_non_covered'
        default:   return 'patient_non_covered'
      }
    }
    if (groupCode === 'CO' || groupCode === 'OA' || groupCode === 'PI') return 'contractual_adjustment'
    return null
  }
  const addAdj = (adj: any) => {
    if (!adj) return
    const groupCode = adj.claimAdjustmentGroupCode ?? adj.adjustmentGroupCode ?? adj.groupCode
    let sawFlat = false
    for (let i = 1; i <= 6; i++) {
      const reason = adj[`adjustmentReasonCode${i}`]
      const amount = adj[`adjustmentAmount${i}`]
      if (reason == null && amount == null) continue
      sawFlat = true
      const bucket = bucketFor(groupCode, reason)
      if (bucket) totals[bucket] += parseFloat(String(amount ?? '0')) || 0
    }
    if (sawFlat) return
    const details = adj.claimAdjustmentDetails ?? adj.adjustmentDetails ?? null
    if (details && Array.isArray(details)) {
      for (const d of details) {
        const bucket = bucketFor(groupCode, d.adjustmentReasonCode ?? d.reasonCode)
        if (bucket) totals[bucket] += parseFloat(String(d.adjustmentAmount ?? d.amount ?? '0')) || 0
      }
      return
    }
    const bucket = bucketFor(groupCode, adj.adjustmentReasonCode ?? adj.reasonCode)
    if (bucket) totals[bucket] += parseFloat(String(adj.adjustmentAmount ?? adj.amount ?? '0')) || 0
  }
  const ADJ_KEYS = new Set(['claimAdjustments', 'serviceAdjustments', 'serviceLineAdjustments', 'adjustments', 'claimAdjustmentInformation', 'adjustmentGroups'])
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
  walk(scoped)
  for (const k of Object.keys(totals) as (keyof CasBreakdown)[]) totals[k] = +totals[k].toFixed(2)
  return totals
}

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
        entries.push({ group_code: groupCode, reason_code: String(reason ?? ''), amount: parseFloat(String(amount ?? '0')) || 0 })
      }
      if (sawFlat) return
      const details = adj.claimAdjustmentDetails ?? adj.adjustmentDetails ?? null
      if (details && Array.isArray(details)) {
        for (const d of details) {
          entries.push({ group_code: groupCode, reason_code: String(d.adjustmentReasonCode ?? d.reasonCode ?? ''), amount: parseFloat(String(d.adjustmentAmount ?? d.amount ?? '0')) || 0 })
        }
        return
      }
      entries.push({ group_code: groupCode, reason_code: String(adj.adjustmentReasonCode ?? adj.reasonCode ?? ''), amount: parseFloat(String(adj.adjustmentAmount ?? adj.amount ?? '0')) || 0 })
    }
    const ADJ_KEYS = new Set(['claimAdjustments', 'serviceAdjustments', 'serviceLineAdjustments', 'adjustments', 'claimAdjustmentInformation', 'adjustmentGroups'])
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
    // Defensive
  }
  return entries
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
    try { await sql`ALTER TABLE claims ADD COLUMN IF NOT EXISTS denial_codes jsonb` } catch {}

    const practiceId = provider.practice_id as string

    // Build a lookup: patientControlNumber (uppercased, first 20 chars of
    // dashless UUID) → claim record. This is how Stedi identifies our
    // claim in the ERA payload. Only include claims we care about
    // (submitted or error), scoped to this practice.
    const claims = await sql`
      SELECT id, payer_id, payer_name
      FROM claims
      WHERE practice_id = ${practiceId}::uuid
    `
    const pcnToClaim = new Map<string, { id: string; payer_id: string | null; payer_name: string | null }>()
    for (const c of claims) {
      const pcn = String(c.id).replace(/-/g, '').slice(0, 20).toUpperCase()
      pcnToClaim.set(pcn, { id: c.id as string, payer_id: c.payer_id ?? null, payer_name: c.payer_name ?? null })
    }

    // Group our claims by tradingPartnerId (payer_id). Stedi's /eras
    // list requires a tradingPartnerId filter to scope results — without
    // it we get every remittance in Stedi's account, most of which won't
    // contain our claims.
    const payerIds = new Set<string>()
    for (const c of pcnToClaim.values()) if (c.payer_id) payerIds.add(c.payer_id)

    const result = {
      list_http: 0,
      remittances_seen: 0,
      remittances_fetched: 0,
      claim_payments_seen: 0,
      claims_matched: 0,
      per_remittance: [] as Array<{
        remittance_id: string
        detail_http: number
        claim_payments_seen: number
        matched: Array<{ claim_id: string; pcn: string; cas: any; denial_codes_count: number }>
      }>,
      // First remittance detail dumped in full so we can inspect the
      // response shape. Truncated to 3000 chars.
      sample_detail_shape: '' as string,
      sample_top_level_keys: [] as string[],
      payer_ids_queried: Array.from(payerIds),
      errors: [] as string[],
    }

    let allRemittances: any[] = []
    for (const payerId of payerIds) {
      const listParams = new URLSearchParams()
      listParams.set('tradingPartnerId', payerId)
      listParams.set('limit', '100')
      const listRes = await fetch(STEDI_ERAS_LIST_URL(listParams.toString()), {
        headers: { Authorization: `Key ${STEDI_API_KEY}`, 'Content-Type': 'application/json' },
      })
      result.list_http = listRes.status
      if (!listRes.ok) {
        const err = await listRes.text().catch(() => '')
        result.errors.push(`list ${payerId} HTTP ${listRes.status}: ${err.slice(0, 200)}`)
        continue
      }
      const listBody = await listRes.json() as any
      const rems: any[] = listBody?.remittances ?? listBody?.items ?? []
      allRemittances.push(...rems)
    }
    result.remittances_seen = allRemittances.length

    for (const rem of allRemittances) {
      const remId = rem?.id ?? rem?.remittanceId
      if (!remId) continue
      const perRem = {
        remittance_id: String(remId),
        detail_http: 0,
        claim_payments_seen: 0,
        matched: [] as Array<{ claim_id: string; pcn: string; cas: any; denial_codes_count: number }>,
      }

      try {
        const detailRes = await fetch(STEDI_ERA_DETAIL_URL(String(remId)), {
          headers: { Authorization: `Key ${STEDI_API_KEY}`, 'Content-Type': 'application/json' },
        })
        perRem.detail_http = detailRes.status
        if (!detailRes.ok) {
          result.errors.push(`detail ${remId} HTTP ${detailRes.status}`)
          result.per_remittance.push(perRem)
          continue
        }
        result.remittances_fetched += 1
        const detail = await detailRes.json()

        // Save the SHAPE of the first successful detail response so I
        // can see what the /eras/{id} response actually looks like.
        if (!result.sample_top_level_keys.length) {
          result.sample_top_level_keys = Object.keys(detail ?? {}).slice(0, 40)
          result.sample_detail_shape = JSON.stringify(detail, null, 2).slice(0, 3000)
        }

        const cps = extractClaimPayments(detail)
        perRem.claim_payments_seen = cps.length
        result.claim_payments_seen += cps.length

        for (const cp of cps) {
          const pcn = String(cp.pcn ?? '').toUpperCase()
          const match = pcnToClaim.get(pcn)
          if (!match) continue

          // Save the SCOPED cp payload — this is what parseCasAdjustments
          // and extractDenialCodes actually work on. Contains
          // claimAdjustmentInformation → CAS.
          await sql`
            UPDATE claims SET
              era_raw_835 = ${JSON.stringify(cp.scoped)}::jsonb,
              updated_at  = NOW()
            WHERE id = ${match.id}::uuid
          `

          // Parse CAS and apply to the claim's era_ columns
          const cas = parseCasAdjustments(cp.scoped)
          const amountBilled = parseFloat(String(cp.scoped?.totalClaimChargeAmount ?? '0')) || null
          const insurancePayment = parseFloat(String(cp.scoped?.claimPaymentAmount ?? cp.scoped?.paymentAmount ?? '0')) || null

          await sql`
            UPDATE claims SET
              era_received_at            = COALESCE(era_received_at, NOW()),
              amount_billed_era          = COALESCE(${amountBilled}, amount_billed_era),
              insurance_payment_era      = COALESCE(${insurancePayment}, insurance_payment_era),
              contractual_adjustment_era = ${cas.contractual_adjustment},
              patient_deductible_era     = ${cas.patient_deductible},
              patient_coinsurance_era    = ${cas.patient_coinsurance},
              patient_copay_era          = ${cas.patient_copay},
              patient_non_covered_era    = ${cas.patient_non_covered},
              updated_at                 = NOW()
            WHERE id = ${match.id}::uuid
          `

          // Denial codes
          const codes = extractDenialCodes(cp.scoped)
          if (codes.length > 0) {
            await sql`UPDATE claims SET denial_codes = ${JSON.stringify(codes)}::jsonb WHERE id = ${match.id}::uuid`
          }

          if (cp.payerClaimControlNumber) {
            await sql`UPDATE claims SET stedi_payer_claim_control_number = ${cp.payerClaimControlNumber} WHERE id = ${match.id}::uuid AND stedi_payer_claim_control_number IS NULL`
          }

          perRem.matched.push({ claim_id: match.id, pcn, cas, denial_codes_count: codes.length })
          result.claims_matched += 1
        }
      } catch (perErr: any) {
        result.errors.push(`rem ${remId}: ${perErr?.message ?? String(perErr)}`)
      }

      result.per_remittance.push(perRem)
    }

    return res.status(200).json(result)
  } catch (e: any) {
    console.error('refetch-known-eras error:', e)
    return res.status(500).json({ error: e.message ?? 'Internal server error' })
  }
}
