import type { VercelRequest, VercelResponse } from '@vercel/node'
import { neon } from '@neondatabase/serverless'
import { createRemoteJWKSet, jwtVerify } from 'jose'

async function verifyProviderToken(authHeader: string | undefined): Promise<string> {
  if (!authHeader?.startsWith('Bearer ')) throw new Error('Missing token')
  const token = authHeader.slice(7)
  const region = process.env.VITE_AWS_REGION || 'us-east-2'
  const poolId = process.env.VITE_AWS_USER_POOL_ID || ''
  const JWKS = createRemoteJWKSet(new URL(`https://cognito-idp.${region}.amazonaws.com/${poolId}/.well-known/jwks.json`))
  const { payload } = await jwtVerify(token, JWKS, { issuer: `https://cognito-idp.${region}.amazonaws.com/${poolId}` })
  if (!payload.sub) throw new Error('No sub in token')
  return payload.sub as string
}

// ── ADDITIVE denial-code extractor (2026-09-16) ────────────────────────────
// Same helper duplicated across api/stedi/era.ts, api/cron/stedi-era-poll.ts,
// api/admin/backfill-stedi-cas.ts. Read-only against era_raw here — never
// mutates existing era_ columns.
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
    // Defensive
  }
  return entries
}

/**
 * POST /api/admin/backfill-denial-codes?dry_run=1
 *
 * Reads era_raw from every claim that has an ERA received but no
 * denial_codes populated yet, runs the extractor, writes results.
 * dry_run=1 skips the UPDATE so you can preview counts safely.
 *
 * Read-only against every existing era_* column — never modifies
 * amount_billed_era, patient_deductible_era, contractual_adjustment_era,
 * etc. Only writes to the new denial_codes JSONB column.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  try {
    const sub = await verifyProviderToken(req.headers.authorization)
    const sql = neon(process.env.DATABASE_URL!)

    const [provider] = await sql`SELECT id, is_admin, practice_id FROM providers WHERE cognito_sub = ${sub} LIMIT 1`
    if (!provider) return res.status(403).json({ error: 'Provider not found' })
    if (!provider.is_admin) return res.status(403).json({ error: 'Admin access required' })

    try { await sql`ALTER TABLE claims ADD COLUMN IF NOT EXISTS denial_codes jsonb` } catch {}

    const dryRun = req.query.dry_run === '1'

    const rows = await sql`
      SELECT id, era_raw
      FROM claims
      WHERE practice_id = ${provider.practice_id}::uuid
        AND era_raw IS NOT NULL
        AND denial_codes IS NULL
      LIMIT 1000
    `

    let updated = 0
    let extractedTotal = 0
    const codeHistogram: Record<string, number> = {}
    const perClaimErrors: string[] = []

    for (const row of rows) {
      let codes: DenialCodeEntry[] = []
      try {
        codes = extractDenialCodes(row.era_raw)
      } catch (e: any) {
        perClaimErrors.push(`${row.id}: ${e?.message ?? String(e)}`)
        continue
      }
      if (codes.length === 0) continue
      extractedTotal += codes.length
      for (const c of codes) {
        const key = `${c.group_code}-${c.reason_code}`
        codeHistogram[key] = (codeHistogram[key] ?? 0) + 1
      }
      if (!dryRun) {
        try {
          await sql`UPDATE claims SET denial_codes = ${JSON.stringify(codes)}::jsonb WHERE id = ${row.id}::uuid`
          updated += 1
        } catch (e: any) {
          perClaimErrors.push(`${row.id} update: ${e?.message ?? String(e)}`)
        }
      }
    }

    return res.status(200).json({
      ok: true,
      dry_run: dryRun,
      claims_scanned: rows.length,
      claims_with_codes: Object.keys(codeHistogram).length > 0 ? rows.filter((_r: any, i: number) => i).length : 0,
      claims_updated: updated,
      codes_extracted_total: extractedTotal,
      code_histogram: codeHistogram,
      errors: perClaimErrors.slice(0, 20),
    })
  } catch (e: any) {
    console.error('backfill-denial-codes error:', e)
    return res.status(500).json({ error: e.message ?? 'Internal server error' })
  }
}
