import type { VercelRequest, VercelResponse } from '@vercel/node'
import { neon } from '@neondatabase/serverless'
import { createRemoteJWKSet, jwtVerify } from 'jose'

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
const STEDI_835_REPORT_URL = (transactionId: string) =>
  `https://healthcare.us.stedi.com/2024-04-01/change/medicalnetwork/reports/v2/${transactionId}/835`

/**
 * GET /api/admin/inspect-unmatched-eras
 *
 * Diagnostic — fetches every unmatched ERA transaction (rows in
 * stedi_transactions_processed with matched_claim_count = 0), pulls
 * the raw 835 from Stedi, and extracts just enough metadata to
 * identify which claim it belongs to:
 *
 *   - patient name / DOB
 *   - PCN (patient control number) the payer echoed back
 *   - payer claim control number
 *   - service date
 *   - payer name
 *   - total charge + insurance paid
 *
 * Use this when Andrea says "the ERA came back but I don't see it in
 * the platform" — the unmatched ERAs are here, we just can't figure
 * out which claim record to attach them to. Once we see the PCN the
 * payer returned vs. the PCN we sent, we know whether to (a) manually
 * attach with a targeted SQL, or (b) loosen findClaim() to match.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })
  if (!STEDI_API_KEY) return res.status(500).json({ error: 'STEDI_API_KEY not configured' })

  let sub: string
  try { sub = await verifyToken(req.headers.authorization) }
  catch { return res.status(401).json({ error: 'Unauthorized' }) }

  try {
    const sql = neon(process.env.DATABASE_URL!)
    const [provider] = await sql`SELECT id, is_admin FROM providers WHERE cognito_sub = ${sub} LIMIT 1`
    if (!provider?.is_admin) return res.status(403).json({ error: 'Admin access required' })

    const days = parseInt(String(req.query.days ?? '60'), 10) || 60
    const includeLegacy = String(req.query.include_legacy ?? '') === '1'
    const rows = await sql`
      SELECT transaction_id, source, processed_at
        FROM stedi_transactions_processed
       WHERE matched_claim_count = 0
         AND processed_at > NOW() - (${days}::int || ' days')::interval
       ORDER BY processed_at DESC
       LIMIT 50`

    const results: any[] = []

    for (const r of rows) {
      const transactionId = r.transaction_id as string
      try {
        const reportRes = await fetch(STEDI_835_REPORT_URL(transactionId), {
          headers: { Authorization: `Key ${STEDI_API_KEY}`, 'Content-Type': 'application/json' },
        })
        if (!reportRes.ok) {
          results.push({
            transaction_id: transactionId,
            source: r.source,
            processed_at: r.processed_at,
            error: `${reportRes.status} ${reportRes.statusText}`,
          })
          continue
        }
        const era835 = await reportRes.json()

        // Extract useful metadata from the 835 without depending on the
        // full findClaim / applyCas machinery — we just want to know
        // WHOSE ERA this is + WHAT PCN it carries.
        const claims: any[] = []
        const walk = (obj: any) => {
          if (!obj || typeof obj !== 'object') return
          if (Array.isArray(obj)) { for (const item of obj) walk(item); return }
          if (obj.patientControlNumber || obj.payerClaimControlNumber) {
            claims.push({
              patient_control_number:      obj.patientControlNumber ?? null,
              payer_claim_control_number:  obj.payerClaimControlNumber ?? null,
              claim_status_code:           obj.claimStatusCode ?? null,
              total_claim_charge:          obj.totalClaimChargeAmount ?? null,
              insurance_payment:           obj.claimPaymentAmount ?? null,
              patient_first:               obj.patientName?.firstName ?? obj.patient?.firstName ?? null,
              patient_last:                obj.patientName?.lastName  ?? obj.patient?.lastName  ?? null,
              service_dates:               obj.serviceLines ? [...new Set((obj.serviceLines ?? [])
                                              .map((l: any) => l.serviceDate ?? l.serviceDates?.serviceDate ?? l.serviceDates?.startDate)
                                              .filter(Boolean))] : [],
            })
          }
          for (const key of Object.keys(obj)) walk(obj[key])
        }
        walk(era835)

        // Header info (payer, etc.) lives near the top of the 835.
        const payerName = era835?.payer?.name
                       ?? era835?.transactions?.[0]?.detailInfo?.[0]?.payer?.name
                       ?? era835?.transactions?.[0]?.detailInfo?.[0]?.paymentAndRemitInfo?.payer?.name
                       ?? null

        results.push({
          transaction_id: transactionId,
          source: r.source,
          processed_at: r.processed_at,
          payer_name: payerName,
          claim_count: claims.length,
          claims,
        })
      } catch (e: any) {
        results.push({
          transaction_id: transactionId,
          source: r.source,
          processed_at: r.processed_at,
          error: e?.message ?? String(e),
        })
      }
    }

    // Legacy PED#### PCNs are pre-platform old-EHR remittances (Charm
// era), reconciled in the old system and not our concern. Filter them
// out by default — they'd otherwise clutter the modal forever. Pass
// ?include_legacy=1 to see them.
    const filtered = includeLegacy
      ? results
      : results.filter((r: any) => !(r?.claims ?? []).every((cl: any) => /^PED\d+$/i.test(String(cl?.patient_control_number ?? ''))))
    const hiddenLegacyCount = results.length - filtered.length

    return res.status(200).json({
      ok: true,
      days,
      unmatched_count: rows.length,
      hidden_legacy_count: hiddenLegacyCount,
      include_legacy: includeLegacy,
      results: filtered,
    })
  } catch (e: any) {
    console.error('inspect-unmatched-eras error:', e)
    return res.status(500).json({ error: e.message ?? 'Internal server error' })
  }
}
