import type { VercelRequest, VercelResponse } from '@vercel/node'
import { neon } from '@neondatabase/serverless'
import { createRemoteJWKSet, jwtVerify } from 'jose'
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib'

const RESEND_API_KEY  = process.env.RESEND_API_KEY || ''
const FROM_EMAIL      = process.env.FROM_EMAIL || 'appointments@phcbooking.com'
const PRACTICE_NAME   = process.env.PRACTICE_NAME || 'Pediatric Housecalls'
const PRACTICE_PHONE  = process.env.PRACTICE_PHONE || ''
const LABCORP_ACCOUNT = process.env.LABCORP_ACCOUNT_NUMBER || '32834485'

async function verifyToken(authHeader: string | undefined): Promise<string> {
  if (!authHeader?.startsWith('Bearer ')) throw new Error('Missing token')
  const token = authHeader.slice(7)
  const region = process.env.VITE_AWS_REGION || 'us-east-2'
  const userPoolId = process.env.VITE_AWS_USER_POOL_ID || ''
  const JWKS = createRemoteJWKSet(new URL(`https://cognito-idp.${region}.amazonaws.com/${userPoolId}/.well-known/jwks.json`))
  const { payload } = await jwtVerify(token, JWKS, { issuer: `https://cognito-idp.${region}.amazonaws.com/${userPoolId}` })
  if (!payload.sub) throw new Error('No sub in token')
  return payload.sub
}

async function buildOrderPdf(opts: {
  patientName: string
  providerName: string
  providerRole: string | null
  providerNpi: string | null
  orderedDate: string
  tests: { code: string; name: string }[]
  diagnoses: string[]
  priority: string
  notes: string | null
}): Promise<Uint8Array> {
  const { patientName, providerName, providerRole, providerNpi, orderedDate, tests, diagnoses, priority, notes } = opts

  const pdfDoc = await PDFDocument.create()
  const page = pdfDoc.addPage([612, 792]) // US Letter
  const { width, height } = page.getSize()

  const bold   = await pdfDoc.embedFont(StandardFonts.HelveticaBold)
  const regular = await pdfDoc.embedFont(StandardFonts.Helvetica)
  const italic  = await pdfDoc.embedFont(StandardFonts.HelveticaOblique)

  const navy   = rgb(0.10, 0.10, 0.18)
  const gray   = rgb(0.45, 0.45, 0.45)
  const light  = rgb(0.96, 0.96, 0.94)
  const border = rgb(0.82, 0.82, 0.80)
  const accent = rgb(0.50, 0.47, 0.87)
  const red    = rgb(0.80, 0.10, 0.10)
  const white  = rgb(1, 1, 1)

  const margin = 48
  const contentW = width - margin * 2
  let y = height - margin

  // ── Header band ──────────────────────────────────────────────────────────
  page.drawRectangle({ x: 0, y: height - 80, width, height: 80, color: navy })
  page.drawText(PRACTICE_NAME, { x: margin, y: height - 38, font: bold, size: 18, color: white })
  page.drawText('LABORATORY ORDER FORM', { x: margin, y: height - 58, font: regular, size: 10, color: rgb(0.63, 0.63, 0.75) })

  // Account # top-right
  page.drawText(`Labcorp Account #: ${LABCORP_ACCOUNT}`, {
    x: width - margin - 160, y: height - 38, font: bold, size: 9, color: white,
  })
  if (PRACTICE_PHONE) {
    page.drawText(PRACTICE_PHONE, { x: width - margin - 160, y: height - 54, font: regular, size: 9, color: rgb(0.63, 0.63, 0.75) })
  }

  y = height - 100

  // STAT banner
  if (priority === 'stat') {
    page.drawRectangle({ x: margin, y: y - 20, width: contentW, height: 24, color: rgb(0.99, 0.93, 0.93) })
    page.drawRectangle({ x: margin, y: y - 20, width: contentW, height: 24, borderColor: rgb(0.85, 0.20, 0.20), borderWidth: 1 })
    page.drawText('⚠  STAT ORDER — Patient should proceed to Labcorp immediately', {
      x: margin + 10, y: y - 13, font: bold, size: 9, color: red,
    })
    y -= 34
  }

  // ── Section helper ────────────────────────────────────────────────────────
  function sectionHeader(label: string) {
    page.drawRectangle({ x: margin, y: y - 18, width: contentW, height: 20, color: light })
    page.drawRectangle({ x: margin, y: y - 18, width: contentW, height: 20, borderColor: border, borderWidth: 0.5 })
    page.drawText(label.toUpperCase(), { x: margin + 8, y: y - 12, font: bold, size: 8, color: gray })
    y -= 26
  }

  function labelValue(label: string, value: string, xOffset = 0, colWidth = contentW) {
    page.drawText(label, { x: margin + xOffset, y, font: bold, size: 9, color: gray })
    page.drawText(value || '—', { x: margin + xOffset + 90, y, font: regular, size: 9, color: navy })
    y -= 16
    _ = colWidth // suppress unused warning
  }
  let _ = 0

  function drawHRule(gap = 10) {
    y -= gap / 2
    page.drawLine({ start: { x: margin, y }, end: { x: margin + contentW, y }, thickness: 0.5, color: border })
    y -= gap / 2
  }

  // ── Patient Information ───────────────────────────────────────────────────
  y -= 8
  sectionHeader('Patient Information')
  labelValue('Patient Name:', patientName)
  labelValue('Date Ordered:', orderedDate)
  y -= 4

  // ── Ordering Provider ────────────────────────────────────────────────────
  drawHRule(16)
  sectionHeader('Ordering Provider')
  labelValue('Provider:', `${providerName}${providerRole ? ', ' + providerRole : ''}`)
  if (providerNpi) labelValue('NPI:', providerNpi)
  y -= 4

  // ── Diagnoses ─────────────────────────────────────────────────────────────
  if (diagnoses.length > 0) {
    drawHRule(16)
    sectionHeader('Diagnosis Codes / Indications')
    for (const dx of diagnoses) {
      page.drawText(`•  ${dx}`, { x: margin + 8, y, font: regular, size: 9, color: navy })
      y -= 14
    }
    y -= 4
  }

  // ── Tests Ordered ─────────────────────────────────────────────────────────
  drawHRule(16)
  sectionHeader('Tests Ordered')

  // Table header row
  page.drawRectangle({ x: margin, y: y - 16, width: contentW, height: 18, color: rgb(0.88, 0.87, 0.96) })
  page.drawText('TEST NAME', { x: margin + 8, y: y - 10, font: bold, size: 8, color: accent })
  page.drawText('CODE', { x: margin + contentW - 80, y: y - 10, font: bold, size: 8, color: accent })
  y -= 20

  for (let i = 0; i < tests.length; i++) {
    const rowColor = i % 2 === 0 ? white : light
    page.drawRectangle({ x: margin, y: y - 14, width: contentW, height: 16, color: rowColor })
    page.drawRectangle({ x: margin, y: y - 14, width: contentW, height: 16, borderColor: border, borderWidth: 0.3 })
    page.drawText(tests[i].name, { x: margin + 8, y: y - 7, font: regular, size: 9, color: navy })
    page.drawText(tests[i].code, { x: margin + contentW - 75, y: y - 7, font: regular, size: 9, color: gray })
    y -= 16
  }
  y -= 4

  // ── Notes ─────────────────────────────────────────────────────────────────
  if (notes) {
    drawHRule(16)
    sectionHeader('Clinical Notes')
    // Wrap notes text
    const words = notes.split(' ')
    let line = ''
    for (const word of words) {
      const candidate = line ? line + ' ' + word : word
      if (regular.widthOfTextAtSize(candidate, 9) > contentW - 16) {
        page.drawText(line, { x: margin + 8, y, font: regular, size: 9, color: navy })
        y -= 13
        line = word
      } else {
        line = candidate
      }
    }
    if (line) {
      page.drawText(line, { x: margin + 8, y, font: regular, size: 9, color: navy })
      y -= 13
    }
    y -= 4
  }

  // ── Signature ─────────────────────────────────────────────────────────────
  drawHRule(24)
  sectionHeader('Provider Signature')
  y -= 4
  page.drawText(`${providerName}${providerRole ? ', ' + providerRole : ''}`, {
    x: margin + 8, y, font: italic, size: 16, color: navy,
  })
  y -= 18
  if (providerNpi) {
    page.drawText(`NPI: ${providerNpi}`, { x: margin + 8, y, font: regular, size: 9, color: gray })
    y -= 14
  }
  page.drawText(`Date: ${orderedDate}`, { x: margin + 8, y, font: regular, size: 9, color: gray })
  y -= 20

  // Signature underline
  page.drawLine({ start: { x: margin + 8, y }, end: { x: margin + 280, y }, thickness: 0.75, color: border })

  // ── Footer ────────────────────────────────────────────────────────────────
  page.drawText(
    'Please present this form at any Labcorp patient service center. Find a location at labcorp.com',
    { x: margin, y: 36, font: regular, size: 8, color: gray }
  )
  page.drawText(
    `${PRACTICE_NAME}  ·  This document contains protected health information`,
    { x: margin, y: 24, font: regular, size: 7, color: rgb(0.70, 0.70, 0.70) }
  )

  return pdfDoc.save()
}

async function sendEmailWithAttachment(to: string, subject: string, html: string, pdfBytes: Uint8Array, filename: string) {
  if (!RESEND_API_KEY || RESEND_API_KEY === 'PLACEHOLDER') {
    console.log(`[EMAIL SKIPPED — no key] To: ${to} | Subject: ${subject}`)
    return
  }
  const base64 = Buffer.from(pdfBytes).toString('base64')
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: `${PRACTICE_NAME} <${FROM_EMAIL}>`,
      to,
      subject,
      html,
      attachments: [{ filename, content: base64 }],
    }),
  })
  if (!res.ok) {
    const msg = await res.text()
    throw new Error(`Email failed: ${msg}`)
  }
}

function buildEmailBody(patientFirstName: string, practiceName: string, practicePhone: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f5f4ef;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f4ef;padding:32px 0;">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;">
        <tr><td style="background:#1a1a2e;border-radius:12px 12px 0 0;padding:24px 32px;">
          <div style="font-size:20px;font-weight:700;color:#fff;">${practiceName}</div>
          <div style="font-size:13px;color:#a0a0c0;margin-top:4px;">Lab Order</div>
        </td></tr>
        <tr><td style="background:#fff;padding:28px 32px;">
          <p style="margin:0 0 16px;font-size:15px;color:#1a1a2e;">Hi ${patientFirstName},</p>
          <p style="margin:0 0 16px;font-size:14px;color:#444;line-height:1.6;">
            Your provider has placed a lab order for you. Your order form is attached to this email as a PDF.
          </p>
          <p style="margin:0 0 20px;font-size:14px;color:#444;line-height:1.6;">
            <strong>Please print the attached form</strong> (or show it on your phone) and bring it to any Labcorp patient service center to have your labs drawn.
          </p>
          <div style="background:#e8f4fd;border:1px solid #bfdbfe;border-radius:8px;padding:14px 16px;margin-bottom:20px;">
            <div style="font-size:13px;font-weight:600;color:#1e40af;margin-bottom:4px;">Find a Labcorp Location</div>
            <div style="font-size:13px;color:#1e40af;">Visit <a href="https://www.labcorp.com/labs-and-appointments/find-lab" style="color:#2563eb;">labcorp.com</a> to find the nearest patient service center. Most locations accept walk-ins.</div>
          </div>
          <p style="margin:0;font-size:13px;color:#777;line-height:1.6;">
            Questions? Contact us${practicePhone ? ' at ' + practicePhone : ''}.
          </p>
        </td></tr>
        <tr><td style="background:#f5f4ef;border-radius:0 0 12px 12px;padding:16px 32px;text-align:center;">
          <p style="margin:0;font-size:12px;color:#aaa;">${practiceName} · This email contains protected health information.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  let sub: string
  try { sub = await verifyToken(req.headers.authorization) } catch {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const sql = neon(process.env.DATABASE_URL!)
  const [provider] = await sql`SELECT id, practice_id FROM providers WHERE cognito_sub = ${sub} LIMIT 1`
  if (!provider) return res.status(403).json({ error: 'Provider not found' })

  const orderId = req.query.id as string
  if (!orderId) return res.status(400).json({ error: 'Order ID required' })

  try {
    const [order] = await sql`
      SELECT
        o.id, o.tests, o.diagnoses, o.priority, o.notes, o.created_at,
        p.name AS provider_name, p.role AS provider_role, p.npi AS provider_npi,
        ch.first_name AS child_first_name, ch.last_name AS child_last_name,
        COALESCE(fp.email, ch.parent_email) AS family_email
      FROM lab_orders o
      JOIN providers p ON p.id = o.provider_id AND p.practice_id = ${provider.practice_id}::uuid
      JOIN children ch ON ch.id = o.child_id
      LEFT JOIN family_profiles fp ON fp.id = ch.family_id
      WHERE o.id = ${orderId}::uuid
    `
    if (!order) return res.status(404).json({ error: 'Order not found' })

    const email = order.family_email
    if (!email) return res.status(400).json({ error: 'No email address on file for this patient' })

    const patientName = [order.child_first_name, order.child_last_name].filter(Boolean).join(' ')
    const orderedDate = new Date(order.created_at).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })

    const pdfBytes = await buildOrderPdf({
      patientName,
      providerName: order.provider_name,
      providerRole: order.provider_role ?? null,
      providerNpi: order.provider_npi ?? null,
      orderedDate,
      tests: Array.isArray(order.tests) ? order.tests : [],
      diagnoses: Array.isArray(order.diagnoses) ? order.diagnoses : [],
      priority: order.priority ?? 'routine',
      notes: order.notes ?? null,
    })

    const emailHtml = buildEmailBody(order.child_first_name ?? 'there', PRACTICE_NAME, PRACTICE_PHONE)
    const filename = `Lab-Order-${patientName.replace(/\s+/g, '-')}-${orderedDate.replace(/\s+/g, '-')}.pdf`

    await sendEmailWithAttachment(email, `Lab Order — ${patientName}`, emailHtml, pdfBytes, filename)

    return res.status(200).json({ sent: true, to: email })
  } catch (err: any) {
    console.error('[labs email] error:', err)
    return res.status(500).json({ error: err.message ?? 'Failed to send email' })
  }
}
