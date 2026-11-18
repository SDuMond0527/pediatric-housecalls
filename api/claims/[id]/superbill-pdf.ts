import type { VercelRequest, VercelResponse } from '@vercel/node'
import { neon } from '@neondatabase/serverless'
import { createRemoteJWKSet, jwtVerify } from 'jose'
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib'

// GET /api/claims/[id]/superbill-pdf
//
// Streams a clean modern superbill PDF for one claim. A superbill is an
// itemized receipt of services rendered — the family uses it to seek
// reimbursement from their own insurer (out-of-network), submit to
// their HSA/FSA administrator, or keep for tax records. Phase 2 (if
// the practice drops insurance) this becomes universal.
//
// Dual auth — the same endpoint serves the staff Billing tab AND the
// parent portal visit card:
//   - Family token → the family must have a child_id on the claim.
//   - Provider token → the provider's practice_id must own the claim.
//
// All practice-identity data (name, NPI, tax ID, address, phone) is
// read from practices.settings jsonb so multi-tenant practices render
// their OWN details — not PHC's env fallback. Required settings are
// `tax_id` and `group_npi` (or the legacy env PRACTICE_NPI fallback).
//
// Sara 2026-11-18.

async function verifyProviderToken(authHeader: string): Promise<string> {
  const token = authHeader.slice(7)
  const region = process.env.VITE_AWS_REGION || 'us-east-2'
  const poolId = process.env.VITE_AWS_USER_POOL_ID || ''
  const JWKS = createRemoteJWKSet(new URL(`https://cognito-idp.${region}.amazonaws.com/${poolId}/.well-known/jwks.json`))
  const { payload } = await jwtVerify(token, JWKS, { issuer: `https://cognito-idp.${region}.amazonaws.com/${poolId}` })
  if (!payload.sub) throw new Error('No sub in token')
  return payload.sub as string
}

async function verifyFamilyToken(authHeader: string): Promise<string> {
  const token = authHeader.slice(7)
  const region = process.env.VITE_AWS_REGION || 'us-east-2'
  const poolId = process.env.VITE_FAMILY_USER_POOL_ID || ''
  const JWKS = createRemoteJWKSet(new URL(`https://cognito-idp.${region}.amazonaws.com/${poolId}/.well-known/jwks.json`))
  const { payload } = await jwtVerify(token, JWKS, { issuer: `https://cognito-idp.${region}.amazonaws.com/${poolId}` })
  if (!payload.sub) throw new Error('No sub in token')
  return payload.sub as string
}

function fmtDate(val: unknown): string {
  if (!val) return '—'
  try {
    const s = val instanceof Date ? val.toISOString() : String(val)
    const [y, m, d] = s.split('T')[0].split('-').map(Number)
    if (!y || !m || !d) return String(val)
    return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' })
  } catch { return String(val) }
}

function fmtMoney(cents: number): string {
  const dollars = cents / 100
  return `$${dollars.toFixed(2)}`
}

function moneyToCents(v: unknown): number {
  if (v == null) return 0
  const n = typeof v === 'number' ? v : parseFloat(String(v))
  if (isNaN(n)) return 0
  return Math.round(n * 100)
}

type ClaimRow = {
  id: string
  practice_id: string
  child_id: string | null
  patient_profile_id: string | null
  service_date: string | null
  place_of_service: string | null
  patient_first_name: string | null
  patient_last_name: string | null
  patient_dob: string | null
  patient_address: string | null
  patient_city: string | null
  patient_state: string | null
  patient_zip: string | null
  subscriber_name: string | null
  subscriber_dob: string | null
  member_id: string | null
  group_number: string | null
  payer_name: string | null
  payer_id: string | null
  cpt_codes: any[]
  diagnoses: any[]
  total_charge: number | string | null
  rendering_provider_name: string | null
  rendering_provider_npi: string | null
}

type PracticeIdentity = {
  name: string
  legalName: string | null
  tax_id: string | null
  group_npi: string | null
  address_line1: string | null
  address_city: string | null
  address_state: string | null
  address_zip: string | null
  main_phone: string | null
  statement_footer_text: string | null
  generates_superbills: boolean
}

async function loadPractice(sql: any, practiceId: string): Promise<PracticeIdentity | null> {
  const [row] = await sql`SELECT name, settings FROM practices WHERE id = ${practiceId}::uuid LIMIT 1`
  if (!row) return null
  const s = (row.settings ?? {}) as any
  return {
    name:               row.name ?? s.dba ?? s.legal_name ?? 'Practice',
    legalName:          s.legal_name ?? null,
    tax_id:             s.tax_id ?? null,
    group_npi:          s.group_npi ?? null,
    address_line1:      s.address_line1 ?? null,
    address_city:       s.address_city ?? null,
    address_state:      s.address_state ?? null,
    address_zip:        s.address_zip ?? null,
    main_phone:         s.main_phone ?? null,
    statement_footer_text: s.statement_footer_text ?? null,
    generates_superbills:  s.generates_superbills !== false,
  }
}

// Payment total for this claim — sum of the patient's paid portion.
// Looks across patient_statements (if a statement was generated) for
// the most authoritative amount_paid; otherwise falls back to the
// claim's own payment_posted amount (for manually-posted payments)
// or the ERA copay/coinsurance/deductible fields.
async function loadAmountPaidCents(sql: any, claimId: string): Promise<{ paid_cents: number; source: string }> {
  const [stmt] = await sql`
    SELECT paid_amount_cents, status
    FROM patient_statements
    WHERE claim_id = ${claimId}::uuid
    ORDER BY created_at DESC
    LIMIT 1`
  if (stmt?.paid_amount_cents != null && Number(stmt.paid_amount_cents) > 0) {
    return { paid_cents: Number(stmt.paid_amount_cents), source: 'patient_statement' }
  }
  const [claim] = await sql`
    SELECT payment_posted_at, patient_copay_era, patient_coinsurance_era, patient_deductible_era
    FROM claims WHERE id = ${claimId}::uuid LIMIT 1`
  if (claim?.payment_posted_at) {
    // Manual payment — sum the ERA patient-resp fields if present, else 0.
    const total = moneyToCents(claim.patient_copay_era)
                + moneyToCents(claim.patient_coinsurance_era)
                + moneyToCents(claim.patient_deductible_era)
    return { paid_cents: total, source: 'claim' }
  }
  return { paid_cents: 0, source: 'none' }
}

// Letters A, B, C, ... for linking each CPT line to its diagnosis
// pointers. Matches the CMS-1500 convention so insurers process it
// like a familiar claim form.
const DIAG_LETTERS = 'ABCDEFGHIJKL'.split('')

export async function buildSuperbillPdf(opts: {
  claim: ClaimRow
  practice: PracticeIdentity
  amountPaidCents: number
}): Promise<Uint8Array> {
  const { claim, practice, amountPaidCents } = opts

  const pdfDoc = await PDFDocument.create()
  const page = pdfDoc.addPage([612, 792])
  const { width, height } = page.getSize()

  const bold    = await pdfDoc.embedFont(StandardFonts.HelveticaBold)
  const regular = await pdfDoc.embedFont(StandardFonts.Helvetica)
  const italic  = await pdfDoc.embedFont(StandardFonts.HelveticaOblique)

  const navy    = rgb(0.10, 0.10, 0.18)
  const purple  = rgb(0.498, 0.467, 0.867)
  const gray    = rgb(0.45, 0.45, 0.45)
  const subtle  = rgb(0.75, 0.75, 0.75)
  const light   = rgb(0.98, 0.98, 0.96)
  const border  = rgb(0.86, 0.86, 0.84)
  const white   = rgb(1, 1, 1)
  const black   = rgb(0.10, 0.10, 0.18)

  const margin = 50
  let y = height - margin

  // ─── Header band ─────────────────────────────────────────────────
  page.drawRectangle({ x: 0, y: height - 90, width, height: 90, color: navy })
  page.drawText(practice.name, { x: margin, y: height - 38, font: bold, size: 20, color: white })
  page.drawText('SUPERBILL · Statement of Services Rendered', {
    x: margin, y: height - 58, font: regular, size: 10, color: rgb(0.70, 0.68, 0.90),
  })

  const addrLine2 = [practice.address_city, practice.address_state].filter(Boolean).join(', ')
  const addrLine3 = [addrLine2, practice.address_zip].filter(Boolean).join(' ')
  const practiceLines = [
    practice.address_line1 ?? null,
    addrLine3 || null,
    practice.main_phone ?? null,
  ].filter(Boolean) as string[]
  let hdrY = height - 36
  for (const line of practiceLines) {
    const w = regular.widthOfTextAtSize(line, 9)
    page.drawText(line, { x: width - margin - w, y: hdrY, font: regular, size: 9, color: rgb(0.80, 0.78, 0.92) })
    hdrY -= 12
  }

  y = height - 110

  // ─── Practice identifiers row ────────────────────────────────────
  const idLeft = `NPI: ${practice.group_npi ?? '—'}`
  const idRight = `Tax ID: ${practice.tax_id ?? '—'}`
  page.drawText(idLeft, { x: margin, y, font: regular, size: 10, color: black })
  const idRightW = regular.widthOfTextAtSize(idRight, 10)
  page.drawText(idRight, { x: width - margin - idRightW, y, font: regular, size: 10, color: black })
  y -= 22

  // ─── Section: Patient + Insurance ────────────────────────────────
  const drawSectionHeader = (label: string) => {
    page.drawRectangle({ x: margin, y: y - 4, width: width - margin * 2, height: 16, color: light })
    page.drawText(label, { x: margin + 6, y: y, font: bold, size: 9, color: navy })
    y -= 22
  }

  drawSectionHeader('PATIENT')
  const patientName = [claim.patient_first_name, claim.patient_last_name].filter(Boolean).join(' ') || '—'
  const patientAddr = [claim.patient_address, [claim.patient_city, claim.patient_state].filter(Boolean).join(', '), claim.patient_zip].filter(Boolean).join('  ')
  page.drawText(`Name:`, { x: margin, y, font: bold, size: 10, color: black })
  page.drawText(patientName, { x: margin + 60, y, font: regular, size: 10, color: black })
  y -= 14
  page.drawText(`DOB:`, { x: margin, y, font: bold, size: 10, color: black })
  page.drawText(fmtDate(claim.patient_dob), { x: margin + 60, y, font: regular, size: 10, color: black })
  y -= 14
  if (patientAddr) {
    page.drawText(`Address:`, { x: margin, y, font: bold, size: 10, color: black })
    page.drawText(patientAddr, { x: margin + 60, y, font: regular, size: 10, color: black })
    y -= 14
  }
  y -= 6

  const hasInsurance = !!(claim.payer_name || claim.member_id)
  if (hasInsurance) {
    drawSectionHeader('INSURED / SUBSCRIBER')
    const subName = claim.subscriber_name ?? patientName
    page.drawText(`Insured:`, { x: margin, y, font: bold, size: 10, color: black })
    page.drawText(subName || '—', { x: margin + 60, y, font: regular, size: 10, color: black })
    y -= 14
    if (claim.subscriber_dob) {
      page.drawText(`DOB:`, { x: margin, y, font: bold, size: 10, color: black })
      page.drawText(fmtDate(claim.subscriber_dob), { x: margin + 60, y, font: regular, size: 10, color: black })
      y -= 14
    }
    page.drawText(`Insurance:`, { x: margin, y, font: bold, size: 10, color: black })
    page.drawText(claim.payer_name ?? '—', { x: margin + 60, y, font: regular, size: 10, color: black })
    y -= 14
    if (claim.member_id) {
      page.drawText(`Member ID:`, { x: margin, y, font: bold, size: 10, color: black })
      page.drawText(claim.member_id, { x: margin + 60, y, font: regular, size: 10, color: black })
      y -= 14
    }
    if (claim.group_number) {
      page.drawText(`Group:`, { x: margin, y, font: bold, size: 10, color: black })
      page.drawText(claim.group_number, { x: margin + 60, y, font: regular, size: 10, color: black })
      y -= 14
    }
    y -= 6
  }

  // ─── Section: Visit ──────────────────────────────────────────────
  drawSectionHeader('VISIT')
  page.drawText(`Date of Service:`, { x: margin, y, font: bold, size: 10, color: black })
  page.drawText(fmtDate(claim.service_date), { x: margin + 110, y, font: regular, size: 10, color: black })
  const posLabel = claim.place_of_service === '12' ? '12 (Home)'
                 : claim.place_of_service === '11' ? '11 (Office)'
                 : claim.place_of_service === '10' ? '10 (Telehealth — patient home)'
                 : claim.place_of_service === '02' ? '02 (Telehealth)'
                 : claim.place_of_service ? claim.place_of_service : '—'
  page.drawText(`Place of Service:`, { x: 320, y, font: bold, size: 10, color: black })
  page.drawText(posLabel, { x: 320 + 110, y, font: regular, size: 10, color: black })
  y -= 14
  page.drawText(`Rendering Provider:`, { x: margin, y, font: bold, size: 10, color: black })
  page.drawText(claim.rendering_provider_name ?? '—', { x: margin + 110, y, font: regular, size: 10, color: black })
  page.drawText(`Provider NPI:`, { x: 320, y, font: bold, size: 10, color: black })
  page.drawText(claim.rendering_provider_npi ?? '—', { x: 320 + 110, y, font: regular, size: 10, color: black })
  y -= 22

  // ─── Section: Diagnoses ──────────────────────────────────────────
  drawSectionHeader('DIAGNOSES (ICD-10)')
  const diagnoses: any[] = Array.isArray(claim.diagnoses) ? claim.diagnoses : []
  const dxPointerByCode = new Map<string, string>()
  if (diagnoses.length === 0) {
    page.drawText('None on file.', { x: margin, y, font: italic, size: 10, color: gray })
    y -= 14
  } else {
    diagnoses.forEach((d: any, i: number) => {
      const letter = DIAG_LETTERS[i] ?? String(i + 1)
      const code = d?.code ?? d?.icd10 ?? '—'
      const desc = d?.description ?? d?.label ?? ''
      dxPointerByCode.set(String(code), letter)
      page.drawText(`${letter}.`, { x: margin, y, font: bold, size: 10, color: purple })
      page.drawText(String(code), { x: margin + 18, y, font: bold, size: 10, color: black })
      if (desc) page.drawText(String(desc).slice(0, 72), { x: margin + 88, y, font: regular, size: 10, color: black })
      y -= 14
    })
  }
  y -= 6

  // ─── Section: Services provided (CPT table) ──────────────────────
  drawSectionHeader('SERVICES PROVIDED')

  // Column layout
  const col = {
    cpt: margin,
    desc: margin + 60,
    dx:  margin + 280,
    units: margin + 330,
    charge: width - margin - 60,
  }

  // Table header
  page.drawRectangle({ x: margin, y: y - 4, width: width - margin * 2, height: 16, color: rgb(0.94, 0.93, 0.98), borderColor: border, borderWidth: 0.5 })
  page.drawText('CPT',     { x: col.cpt + 2, y: y, font: bold, size: 9, color: navy })
  page.drawText('Description', { x: col.desc + 2, y: y, font: bold, size: 9, color: navy })
  page.drawText('Dx',      { x: col.dx + 2, y: y, font: bold, size: 9, color: navy })
  page.drawText('Units',   { x: col.units + 2, y: y, font: bold, size: 9, color: navy })
  const chargeHeader = 'Charge'
  const chHW = bold.widthOfTextAtSize(chargeHeader, 9)
  page.drawText(chargeHeader, { x: width - margin - chHW - 2, y: y, font: bold, size: 9, color: navy })
  y -= 18

  // Table rows
  const cpts: any[] = Array.isArray(claim.cpt_codes) ? claim.cpt_codes : []
  let totalChargeCents = 0
  if (cpts.length === 0) {
    page.drawText('No CPT codes on file.', { x: margin, y, font: italic, size: 10, color: gray })
    y -= 14
  } else {
    for (const c of cpts) {
      const code = c?.code ?? '—'
      const desc = c?.description ?? ''
      const units = c?.units ?? 1
      const chargeCents = moneyToCents(c?.charge_amount ?? c?.amount ?? 0)
      totalChargeCents += chargeCents
      // Which diagnoses apply to this line? Use explicit pointers if the
      // CPT row has them; otherwise default to "A" (first diagnosis) so
      // every service line has a dx pointer visible.
      let dxPointers = ''
      if (Array.isArray(c?.diagnosis_pointers)) {
        dxPointers = c.diagnosis_pointers.join('')
      } else if (Array.isArray(c?.dx_codes)) {
        dxPointers = c.dx_codes.map((dc: string) => dxPointerByCode.get(dc) ?? '').filter(Boolean).join('')
      }
      if (!dxPointers && diagnoses.length > 0) dxPointers = DIAG_LETTERS[0]

      page.drawText(String(code), { x: col.cpt + 2, y: y, font: regular, size: 10, color: black })
      page.drawText(String(desc).slice(0, 36), { x: col.desc + 2, y: y, font: regular, size: 10, color: black })
      page.drawText(dxPointers || '—', { x: col.dx + 2, y: y, font: regular, size: 10, color: black })
      page.drawText(String(units), { x: col.units + 2, y: y, font: regular, size: 10, color: black })
      const chargeStr = fmtMoney(chargeCents)
      const chW = regular.widthOfTextAtSize(chargeStr, 10)
      page.drawText(chargeStr, { x: width - margin - chW - 2, y: y, font: regular, size: 10, color: black })
      y -= 16
    }
  }
  // Fall back to claim.total_charge when per-line amounts summed to 0
  // (older rows that didn't carry per-CPT charge_amount).
  if (totalChargeCents === 0) totalChargeCents = moneyToCents(claim.total_charge)

  y -= 4
  page.drawLine({ start: { x: margin, y }, end: { x: width - margin, y }, thickness: 0.5, color: border })
  y -= 14

  // ─── Totals ──────────────────────────────────────────────────────
  const drawTotalLine = (label: string, cents: number, emphasize = false) => {
    const font = emphasize ? bold : regular
    const color = emphasize ? navy : black
    page.drawText(label, { x: margin, y: y, font, size: 10, color })
    const amt = fmtMoney(cents)
    const w = font.widthOfTextAtSize(amt, 10)
    page.drawText(amt, { x: width - margin - w, y: y, font, size: 10, color })
    y -= 14
  }
  drawTotalLine('Total charges', totalChargeCents)
  drawTotalLine('Amount paid by patient', amountPaidCents)
  const balance = Math.max(0, totalChargeCents - amountPaidCents)
  drawTotalLine('Balance due', balance, true)
  y -= 10

  // ─── Signature block ─────────────────────────────────────────────
  page.drawLine({ start: { x: margin, y: y - 2 }, end: { x: margin + 220, y: y - 2 }, thickness: 0.5, color: border })
  page.drawText(claim.rendering_provider_name ?? '—', { x: margin, y: y - 14, font: italic, size: 10, color: black })
  page.drawText('Rendering provider', { x: margin, y: y - 26, font: regular, size: 8, color: gray })
  y -= 50

  // ─── Footer explanation ──────────────────────────────────────────
  const footerText = practice.statement_footer_text?.trim()
    || 'This superbill documents medically necessary services rendered on the date shown. Submit to your insurance carrier for out-of-network reimbursement, to your HSA/FSA administrator for reimbursement of qualified medical expenses, or retain for tax records.'
  const footerLines = wrapText(footerText, 94)
  for (const line of footerLines) {
    page.drawText(line, { x: margin, y, font: regular, size: 8, color: gray })
    y -= 10
  }

  return pdfDoc.save()
}

function wrapText(text: string, charsPerLine: number): string[] {
  const words = text.split(/\s+/)
  const lines: string[] = []
  let cur = ''
  for (const w of words) {
    if (cur.length + w.length + 1 > charsPerLine) {
      if (cur) lines.push(cur)
      cur = w
    } else {
      cur = cur ? `${cur} ${w}` : w
    }
  }
  if (cur) lines.push(cur)
  return lines
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  const authHeader = req.headers.authorization
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const claimId = req.query.id as string
  if (!claimId) return res.status(400).json({ error: 'id required' })

  const sql = neon(process.env.DATABASE_URL!)

  // Load the claim (unscoped — we scope by auth below).
  try { await sql`ALTER TABLE claims ADD COLUMN IF NOT EXISTS patient_profile_id uuid` } catch {}
  const [claim] = await sql`
    SELECT id, practice_id, child_id, patient_profile_id,
           service_date::text AS service_date, place_of_service,
           patient_first_name, patient_last_name, patient_dob::text AS patient_dob,
           patient_address, patient_city, patient_state, patient_zip,
           subscriber_name, subscriber_dob::text AS subscriber_dob,
           member_id, group_number, payer_name, payer_id,
           cpt_codes, diagnoses, total_charge,
           rendering_provider_name, rendering_provider_npi
    FROM claims WHERE id = ${claimId}::uuid LIMIT 1`
  if (!claim) return res.status(404).json({ error: 'Claim not found' })

  // ─── Authorize ────────────────────────────────────────────────────
  // Try family token first (it's the more common parent-portal path).
  // Family must have a child_id matching the claim's child_id. If that
  // fails, try provider auth and match on practice_id.
  let authorized = false
  try {
    const famSub = await verifyFamilyToken(authHeader)
    const [fam] = await sql`SELECT id, practice_id FROM family_profiles WHERE cognito_sub = ${famSub} LIMIT 1`
    if (fam && String(fam.practice_id) === String(claim.practice_id)) {
      // Family must own a child on this claim.
      const [owned] = await sql`
        SELECT 1 FROM children
        WHERE id = ${claim.child_id}::uuid AND family_id = ${fam.id}::uuid
        LIMIT 1`
      if (owned) authorized = true
    }
  } catch { /* fall through to provider auth */ }

  if (!authorized) {
    try {
      const sub = await verifyProviderToken(authHeader)
      const [provider] = await sql`SELECT practice_id FROM providers WHERE cognito_sub = ${sub} LIMIT 1`
      if (provider && String(provider.practice_id) === String(claim.practice_id)) {
        authorized = true
      }
    } catch { /* fall through */ }
  }
  if (!authorized) return res.status(403).json({ error: 'Not authorized to view this claim' })

  // ─── Multi-tenant feature flag check ──────────────────────────────
  const practice = await loadPractice(sql, String(claim.practice_id))
  if (!practice) return res.status(500).json({ error: 'Practice not found' })
  if (!practice.generates_superbills) {
    return res.status(403).json({ error: 'This practice does not generate superbills.' })
  }

  const { paid_cents } = await loadAmountPaidCents(sql, claimId)

  const pdfBytes = await buildSuperbillPdf({
    claim: claim as ClaimRow,
    practice,
    amountPaidCents: paid_cents,
  })

  // Match openClaimPdf client — base64 as plain text so Vercel doesn't
  // mangle binary. Client decodes via atob.
  const b64 = Buffer.from(pdfBytes).toString('base64')
  const first = String(claim.patient_first_name ?? '').replace(/[^A-Za-z0-9]/g, '') || 'patient'
  const last  = String(claim.patient_last_name  ?? '').replace(/[^A-Za-z0-9]/g, '') || 'unknown'
  const dos   = String(claim.service_date ?? '').slice(0, 10) || 'undated'
  const filename = `superbill-${first}-${last}-${dos}.pdf`

  res.setHeader('Content-Type', 'text/plain; charset=utf-8')
  res.setHeader('X-Pdf-Filename', filename)
  res.setHeader('Cache-Control', 'private, no-store')
  return res.status(200).send(b64)
}
