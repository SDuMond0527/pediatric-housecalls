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
const STEDI_ERAS_LIST_URL = (params: string) => `https://claims-manager.us.stedi.com/2025-09-01/eras?${params}`
const STEDI_ERA_X12_URL   = (id: string)     => `https://claims-manager.us.stedi.com/2025-09-01/eras/${id}/x12`

// X12 835 parser. Reads the raw EDI string returned by
// /eras/{id}/x12 and pulls out every claim's CLP (header) + CAS
// (adjustments) segments. Format:
//   CLP*<pcn>*<status>*<charge>*<paid>*<patientResp>*<filingInd>*<payerCcn>*<facility>*<freq>
//   CAS*<group>*<reason1>*<amount1>*<qty1>*<reason2>*<amount2>*...
// ── Ensure a draft patient_statement exists for a claim (2026-09-17) ───────
// Same helper as api/webhooks/stedi-transaction.ts + cron/stedi-era-poll.ts.
// Every ERA (even one that resolves to $0 patient responsibility) creates
// a draft statement so the biller must actively review + confirm.
async function ensureStatementForClaim(
  sql: any,
  claimId: string,
  cas: { patient_deductible: number; patient_coinsurance: number; patient_copay: number; patient_non_covered: number; contractual_adjustment: number },
  amountBilled: number | null,
  insurancePayment: number | null,
): Promise<{ created: boolean; statementId?: string }> {
  const [existing] = await sql`SELECT id FROM patient_statements WHERE claim_id = ${claimId}::uuid LIMIT 1`
  if (existing) return { created: false, statementId: existing.id as string }

  const [claim] = await sql`
    SELECT
      cl.id, cl.practice_id, cl.child_id, cl.appointment_id, cl.service_date,
      cl.cpt_codes, cl.patient_first_name, cl.patient_last_name, cl.patient_dob,
      ch.parent_email, ch.parent_phone,
      fp.email AS family_email, fp.phone AS family_phone
    FROM claims cl
    LEFT JOIN children ch ON ch.id = COALESCE(cl.child_id, (SELECT child_id FROM appointments WHERE id = cl.appointment_id LIMIT 1))
    LEFT JOIN family_profiles fp ON fp.id = ch.family_id
    WHERE cl.id = ${claimId}::uuid
    LIMIT 1
  `
  if (!claim) return { created: false }

  const patientResp = +((cas.patient_copay ?? 0) + (cas.patient_deductible ?? 0) + (cas.patient_coinsurance ?? 0) + (cas.patient_non_covered ?? 0)).toFixed(2)
  const remaining = +((amountBilled ?? 0) - (insurancePayment ?? 0) - (cas.contractual_adjustment ?? 0)).toFixed(2)
  const email = claim.parent_email ?? claim.family_email ?? null
  const phone = claim.parent_phone ?? claim.family_phone ?? null

  const [row] = await sql`
    INSERT INTO patient_statements (
      practice_id, claim_id,
      patient_first_name, patient_last_name, patient_dob,
      date_of_service, cpt_codes,
      patient_email, patient_phone,
      amount_billed, insurance_payment, contractual_adjustment,
      patient_copay, patient_deductible, patient_coinsurance, patient_non_covered,
      remaining_balance, prior_balance, total_amount_due, total_amount_due_text,
      status, created_at, updated_at
    ) VALUES (
      ${claim.practice_id}::uuid, ${claim.id},
      ${claim.patient_first_name}, ${claim.patient_last_name}, ${claim.patient_dob},
      ${claim.service_date}, ${JSON.stringify(claim.cpt_codes ?? [])}::jsonb,
      ${email}, ${phone},
      ${amountBilled}, ${insurancePayment}, ${cas.contractual_adjustment},
      ${cas.patient_copay}, ${cas.patient_deductible}, ${cas.patient_coinsurance}, ${cas.patient_non_covered},
      ${remaining}, 0, ${patientResp}, ${String(patientResp)},
      'draft', NOW(), NOW()
    )
    RETURNING id
  `
  return { created: true, statementId: row?.id as string }
}

type ParsedX12Claim = {
  pcn: string
  payerClaimControlNumber: string
  totalCharge: number
  totalPaid: number
  patientResponsibility: number
  cas: Array<{ group: string; reason: string; amount: number }>
  remarks: string[]
}
function parseX12_835(text: string): ParsedX12Claim[] {
  const claims: ParsedX12Claim[] = []
  if (!text || typeof text !== 'string') return claims
  const segments = text.split('~').map(s => s.trim()).filter(Boolean)
  let current: ParsedX12Claim | null = null
  const looksLikeRarc = (s: string) => /^(?:M|MA|N)[A-Z]?\d+$/i.test(s)
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
        remarks: [],
      }
    } else if (tag === 'CAS' && current) {
      // Fields: [0]=CAS, [1]=group, then triples of (reason, amount, qty)
      const group = String(fields[1] ?? '').trim()
      for (let i = 2; i < fields.length; i += 3) {
        const reason = String(fields[i] ?? '').trim()
        const amount = parseFloat(String(fields[i + 1] ?? '0')) || 0
        if (reason && amount !== 0) {
          current.cas.push({ group, reason, amount })
        }
      }
    } else if (tag === 'LQ' && current) {
      // LQ*HE*<code> — RARC (Remark Advice Remark Code)
      const codeType = String(fields[1] ?? '').trim()
      const code = String(fields[2] ?? '').trim() || codeType
      if (code && looksLikeRarc(code) && !current.remarks.includes(code)) {
        current.remarks.push(code)
      }
    } else if ((tag === 'MOA' || tag === 'MIA') && current) {
      // MOA and MIA can carry up to 5 remark codes in fields 3-7.
      for (let i = 3; i <= 7; i++) {
        const code = String(fields[i] ?? '').trim()
        if (code && looksLikeRarc(code) && !current.remarks.includes(code)) {
          current.remarks.push(code)
        }
      }
    }
  }
  if (current) claims.push(current)
  return claims
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

    // Bucket X12 CAS entries into our era_ columns.
    // Only these CO CARCs are truly "contractual" (fee-schedule write-downs
    // we agreed to). Everything else in the CO group is a denial /
    // documentation request — surfaced separately via denial_codes so
    // the UI can flag "REJECTED BY PAYER" instead of hiding it. (Sara
    // caught CO-252 hidden as contractual on Carson Yates, 2026-09-16.)
    const CONTRACTUAL_CO_CODES = new Set(['45', '97', '24', '131', '137'])
    const bucketCas = (cas: Array<{ group: string; reason: string; amount: number }>) => {
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
        } else if (c.group === 'CO' && CONTRACTUAL_CO_CODES.has(c.reason)) {
          totals.contractual_adjustment += c.amount
        }
      }
      for (const k of Object.keys(totals) as (keyof typeof totals)[]) totals[k] = +totals[k].toFixed(2)
      return totals
    }

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
        const x12Res = await fetch(STEDI_ERA_X12_URL(String(remId)), {
          headers: { Authorization: `Key ${STEDI_API_KEY}`, Accept: 'application/edi-x12, text/plain' },
        })
        perRem.detail_http = x12Res.status
        if (!x12Res.ok) {
          result.errors.push(`x12 ${remId} HTTP ${x12Res.status}`)
          result.per_remittance.push(perRem)
          continue
        }
        result.remittances_fetched += 1
        const x12Text = await x12Res.text()

        // Diagnostic sample for the first remittance
        if (!result.sample_top_level_keys.length) {
          result.sample_top_level_keys = ['<X12 EDI text — not JSON>']
          result.sample_detail_shape = x12Text.slice(0, 3000)
          ;(result as any).x12_http = x12Res.status
          ;(result as any).x12_sample = x12Text.slice(0, 3000)
        }

        const parsedClaims = parseX12_835(x12Text)
        perRem.claim_payments_seen = parsedClaims.length
        result.claim_payments_seen += parsedClaims.length

        for (const pc of parsedClaims) {
          const pcn = String(pc.pcn ?? '').toUpperCase()
          const match = pcnToClaim.get(pcn)
          if (!match) continue

          const casTotals = bucketCas(pc.cas)

          await sql`
            UPDATE claims SET
              era_received_at            = COALESCE(era_received_at, NOW()),
              era_raw_835                = ${JSON.stringify({
                                              pcn: pc.pcn,
                                              payerClaimControlNumber: pc.payerClaimControlNumber,
                                              totalCharge: pc.totalCharge,
                                              totalPaid: pc.totalPaid,
                                              patientResponsibility: pc.patientResponsibility,
                                              cas: pc.cas,
                                              remarks: pc.remarks,
                                            })}::jsonb,
              amount_billed_era          = ${pc.totalCharge},
              insurance_payment_era      = ${pc.totalPaid},
              contractual_adjustment_era = ${casTotals.contractual_adjustment},
              patient_deductible_era     = ${casTotals.patient_deductible},
              patient_coinsurance_era    = ${casTotals.patient_coinsurance},
              patient_copay_era          = ${casTotals.patient_copay},
              patient_non_covered_era    = ${casTotals.patient_non_covered},
              updated_at                 = NOW()
            WHERE id = ${match.id}::uuid
          `

          // Denial codes = every CAS entry as { group_code, reason_code, amount }
          const denialCodes = pc.cas.map(c => ({ group_code: c.group, reason_code: c.reason, amount: c.amount }))
          if (denialCodes.length > 0) {
            await sql`UPDATE claims SET denial_codes = ${JSON.stringify(denialCodes)}::jsonb WHERE id = ${match.id}::uuid`
          }
          try { await sql`ALTER TABLE claims ADD COLUMN IF NOT EXISTS remark_codes jsonb` } catch {}
          if (pc.remarks && pc.remarks.length > 0) {
            await sql`UPDATE claims SET remark_codes = ${JSON.stringify(pc.remarks)}::jsonb WHERE id = ${match.id}::uuid`
          }

          if (pc.payerClaimControlNumber) {
            await sql`UPDATE claims SET stedi_payer_claim_control_number = ${pc.payerClaimControlNumber} WHERE id = ${match.id}::uuid AND stedi_payer_claim_control_number IS NULL`
          }

          // Auto-create draft statement so every ERA is reviewed by biller
          try {
            await ensureStatementForClaim(sql, match.id, casTotals, pc.totalCharge, pc.totalPaid)
          } catch (stmtErr: any) {
            result.errors.push(`stmt ${match.id}: ${String(stmtErr?.message ?? stmtErr).slice(0, 200)}`)
          }

          perRem.matched.push({ claim_id: match.id, pcn, cas: casTotals, denial_codes_count: denialCodes.length })
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
