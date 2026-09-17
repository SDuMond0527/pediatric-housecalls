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

/**
 * GET /api/claims/[id]/era-pdf
 *
 * Streams the 835 ERA PDF that Stedi renders for a matched
 * remittance. Uses:
 *
 *   GET /2024-04-01/electronic-remittance-advice/{transactionId}/pdf
 *   Accept: application/pdf
 *
 * transactionId is the Stedi ERA UUID we save on the claim when the
 * ERA-processing paths (webhook / cron / refetch / on-demand) match a
 * remittance to it — see claims.stedi_era_transaction_id.
 *
 * If the column isn't set yet (older claim matched before we added
 * this), tell the biller to click "Refetch known ERAs" once to
 * backfill.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  let sub: string
  try { sub = await verifyToken(req.headers.authorization) }
  catch { return res.status(401).json({ error: 'Unauthorized' }) }

  try {
    const sql = neon(process.env.DATABASE_URL!)
    const [provider] = await sql`SELECT practice_id FROM providers WHERE cognito_sub = ${sub} LIMIT 1`
    if (!provider) return res.status(403).json({ error: 'Provider not found' })

    // Bootstrap the column so this endpoint stands on its own even on
    // a fresh env before any ERA processing has run.
    try { await sql`ALTER TABLE claims ADD COLUMN IF NOT EXISTS stedi_era_transaction_id text` } catch {}

    const claimId = req.query.id as string
    if (!claimId) return res.status(400).json({ error: 'id required' })

    const [claim] = await sql`
      SELECT
        id,
        patient_first_name, patient_last_name, service_date,
        stedi_era_transaction_id, era_received_at
      FROM claims
      WHERE id = ${claimId}::uuid AND practice_id = ${provider.practice_id}::uuid
      LIMIT 1
    `
    if (!claim) return res.status(404).json({ error: 'Claim not found' })

    if (!claim.era_received_at) {
      return res.status(404).send('ERR: No ERA has been received for this claim yet.')
    }

    // Render the ERA remittance from our stored raw 835 data. Stedi's
    // dedicated ERA PDF endpoint requires a subscription tier we don't
    // have and different identifier formats we can't reliably obtain
    // (Sara 2026-09-17). We have everything we need in claims.era_raw_835
    // + the era_*_era financial breakdown columns, so we render our own
    // remittance HTML. Andrea can print-to-PDF from the browser.
    const [full] = await sql`
      SELECT
        id, patient_first_name, patient_last_name, patient_dob,
        service_date, payer_name, payer_id, member_id, subscriber_name,
        cpt_codes,
        era_received_at,
        amount_billed_era, insurance_payment_era, contractual_adjustment_era,
        patient_deductible_era, patient_coinsurance_era, patient_copay_era,
        patient_non_covered_era,
        era_raw_835, denial_codes, remark_codes
      FROM claims WHERE id = ${claim.id}::uuid
    `

    const cas: Array<{ group_code: string; reason_code: string; amount: number }> = full.denial_codes ?? []
    const remarks: string[] = full.remark_codes ?? []
    const raw = full.era_raw_835 ?? {}
    const fmtMoney = (v: any) => {
      const n = parseFloat(String(v ?? 0))
      return isNaN(n) ? '$0.00' : `$${n.toFixed(2)}`
    }
    const fmtDate = (v: any) => {
      if (!v) return ''
      try { return new Date(String(v)).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }) }
      catch { return String(v) }
    }
    const esc = (s: any) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]!))

    const html = `<!doctype html>
<html><head><meta charset="utf-8" />
<title>ERA Remittance — ${esc(full.patient_first_name)} ${esc(full.patient_last_name)} — ${esc(fmtDate(full.service_date))}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color: #1A1A2E; padding: 32px; max-width: 900px; margin: 0 auto; font-size: 13px; line-height: 1.5; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .subtitle { color: #555; margin-bottom: 24px; }
  table { width: 100%; border-collapse: collapse; margin: 16px 0; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid #E8E8E4; }
  th { background: #FAFAF8; font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: #555; }
  .right { text-align: right; font-variant-numeric: tabular-nums; }
  .section { margin-top: 28px; }
  .section-title { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: #7F77DD; margin-bottom: 8px; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px 24px; }
  .kv { font-size: 12px; }
  .kv label { color: #666; margin-right: 6px; }
  .totals { background: #F0F9F5; border-left: 4px solid #085041; padding: 14px 18px; border-radius: 6px; margin-top: 16px; }
  .totals .row { display: flex; justify-content: space-between; margin: 4px 0; }
  .totals .grand { font-weight: 700; font-size: 15px; border-top: 1px solid #A9DFBF; padding-top: 8px; margin-top: 8px; }
  .denials { background: #FEF3C7; border-left: 4px solid #B45309; padding: 14px 18px; border-radius: 6px; margin-top: 16px; }
  .denials .code { font-family: 'SF Mono', Menlo, monospace; font-weight: 700; margin-right: 8px; }
  .print-hint { margin-top: 40px; padding: 12px; background: #EEEDFE; border-radius: 6px; color: #3C3489; font-size: 12px; }
  @media print { .print-hint { display: none; } body { padding: 12px; } }
</style>
</head><body>
<h1>Electronic Remittance Advice (835)</h1>
<div class="subtitle">
  Received ${esc(fmtDate(full.era_received_at))}
  ${raw.payerClaimControlNumber ? ` &bull; Payer control #: ${esc(raw.payerClaimControlNumber)}` : ''}
</div>

<div class="section">
  <div class="section-title">Patient &amp; Payer</div>
  <div class="grid">
    <div class="kv"><label>Patient:</label> ${esc(full.patient_first_name)} ${esc(full.patient_last_name)}</div>
    <div class="kv"><label>Payer:</label> ${esc(full.payer_name)} ${full.payer_id ? `(ID: ${esc(full.payer_id)})` : ''}</div>
    <div class="kv"><label>DOB:</label> ${esc(fmtDate(full.patient_dob))}</div>
    <div class="kv"><label>Subscriber:</label> ${esc(full.subscriber_name ?? '—')}</div>
    <div class="kv"><label>Date of service:</label> ${esc(fmtDate(full.service_date))}</div>
    <div class="kv"><label>Member ID:</label> ${esc(full.member_id ?? '—')}</div>
  </div>
</div>

<div class="section">
  <div class="section-title">Services billed</div>
  <table>
    <thead><tr><th>CPT</th><th>Description</th><th class="right">Billed</th></tr></thead>
    <tbody>
      ${(full.cpt_codes ?? []).map((c: any) => `
        <tr>
          <td><strong>${esc(c.code)}</strong>${c.modifier ? ` <span style="color:#7F77DD">${esc(c.modifier)}</span>` : ''}</td>
          <td>${esc(c.description)}</td>
          <td class="right">${fmtMoney(c.charge_amount)}</td>
        </tr>
      `).join('')}
    </tbody>
  </table>
</div>

<div class="totals">
  <div class="section-title" style="color:#085041;margin-bottom:8px">Payment breakdown</div>
  <div class="row"><span>Billed amount</span><span>${fmtMoney(full.amount_billed_era)}</span></div>
  <div class="row"><span>Insurance paid</span><span style="color:#085041;font-weight:600">${fmtMoney(full.insurance_payment_era)}</span></div>
  <div class="row"><span>Contractual adjustment</span><span>(${fmtMoney(full.contractual_adjustment_era)})</span></div>
  <div class="row"><span>Patient deductible</span><span>${fmtMoney(full.patient_deductible_era)}</span></div>
  <div class="row"><span>Patient coinsurance</span><span>${fmtMoney(full.patient_coinsurance_era)}</span></div>
  <div class="row"><span>Patient copay</span><span>${fmtMoney(full.patient_copay_era)}</span></div>
  <div class="row"><span>Patient non-covered</span><span>${fmtMoney(full.patient_non_covered_era)}</span></div>
  <div class="row grand"><span>Patient responsibility total</span><span>${fmtMoney(
    (parseFloat(full.patient_deductible_era ?? 0) || 0) +
    (parseFloat(full.patient_coinsurance_era ?? 0) || 0) +
    (parseFloat(full.patient_copay_era ?? 0) || 0) +
    (parseFloat(full.patient_non_covered_era ?? 0) || 0)
  )}</span></div>
</div>

${cas.length > 0 || remarks.length > 0 ? `
<div class="denials">
  <div class="section-title" style="color:#78350F;margin-bottom:8px">Payer reason codes</div>
  ${cas.map(c => `<div><span class="code">${esc(c.group_code)}-${esc(c.reason_code)}</span>${c.amount ? ` ${fmtMoney(Math.abs(c.amount))}` : ''}</div>`).join('')}
  ${remarks.length > 0 ? `<div style="margin-top:8px"><strong>Remarks:</strong> ${remarks.map(r => `<span class="code">${esc(r)}</span>`).join(' ')}</div>` : ''}
</div>
` : ''}

<div class="print-hint">
  <strong>To save as PDF:</strong> use your browser's Print (⌘P / Ctrl+P) → Destination: <em>Save as PDF</em>.
  This view is generated from Stedi's parsed 835 data — the same numbers that populate the claim in GoRoam.
</div>

</body></html>`

    const first = String(claim.patient_first_name ?? '').replace(/[^A-Za-z0-9]/g, '')
    const last  = String(claim.patient_last_name  ?? '').replace(/[^A-Za-z0-9]/g, '')
    const dos   = String(claim.service_date ?? '').slice(0, 10) || 'undated'
    const filename = `ERA-${first || 'patient'}-${last || 'unknown'}-${dos}.html`

    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.setHeader('X-Pdf-Filename', filename)
    res.setHeader('Cache-Control', 'private, max-age=300')
    return res.status(200).send(html)
  } catch (e: any) {
    console.error('claims/[id]/era-pdf error:', e)
    return res.status(500).json({ error: e?.message ?? 'Internal server error' })
  }
}
