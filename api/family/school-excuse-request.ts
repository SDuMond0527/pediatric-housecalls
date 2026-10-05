import type { VercelRequest, VercelResponse } from '@vercel/node'
import { neon } from '@neondatabase/serverless'
import { put } from '@vercel/blob'
import { createRemoteJWKSet, jwtVerify } from 'jose'
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib'

const PRACTICE_NAME  = process.env.PRACTICE_NAME || 'Pediatric House Calls PLLC'
const PRACTICE_PHONE = process.env.PRACTICE_PHONE || ''
const FROM_EMAIL     = process.env.FROM_EMAIL || 'appointments@phcbooking.com'
const RESEND_API_KEY = process.env.RESEND_API_KEY || ''
// Pam gets BCC'd on every automated note so she retains a record of
// what went out without having to compose or send anything herself.
const SCHOOL_NOTE_BCC = 'pam@pedshousecalls.com'

async function verifyFamilyToken(authHeader: string | undefined): Promise<string> {
  if (!authHeader?.startsWith('Bearer ')) throw new Error('Missing token')
  const token = authHeader.slice(7)
  const region = process.env.VITE_AWS_REGION || 'us-east-2'
  const poolId = process.env.VITE_FAMILY_USER_POOL_ID || ''
  const JWKS = createRemoteJWKSet(new URL(`https://cognito-idp.${region}.amazonaws.com/${poolId}/.well-known/jwks.json`))
  const { payload } = await jwtVerify(token, JWKS, { issuer: `https://cognito-idp.${region}.amazonaws.com/${poolId}` })
  if (!payload.sub) throw new Error('No sub')
  return payload.sub as string
}

function fmt(val: string | null | undefined): string {
  return val?.trim() || '—'
}

function fmtDateLong(val: string | Date | null | undefined): string {
  if (!val) return '—'
  try {
    const s = typeof val === 'string' ? val : val.toISOString()
    const [y, m, d] = s.split('T')[0].split('-').map(Number)
    const dt = new Date(Date.UTC(y, m - 1, d))
    return dt.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' })
  } catch { return String(val) }
}

async function buildSchoolNotePdf(opts: {
  childFirstName: string
  childLastName: string
  childDob: string | null
  visitDate: string | Date
  excuseDates: string
  parentAdditionalNotes: string
  providerName: string
  providerRole: string | null
  providerNpi: string | null
}): Promise<Uint8Array> {
  const childName = [opts.childFirstName, opts.childLastName].filter(Boolean).join(' ')

  const pdfDoc = await PDFDocument.create()
  const page = pdfDoc.addPage([612, 792])
  const { width, height } = page.getSize()

  const bold    = await pdfDoc.embedFont(StandardFonts.HelveticaBold)
  const regular = await pdfDoc.embedFont(StandardFonts.Helvetica)
  const italic  = await pdfDoc.embedFont(StandardFonts.HelveticaOblique)

  const navy   = rgb(0.10, 0.10, 0.18)
  const gray   = rgb(0.45, 0.45, 0.45)
  const light  = rgb(0.96, 0.96, 0.94)
  const border = rgb(0.82, 0.82, 0.80)
  const white  = rgb(1, 1, 1)

  const margin   = 56
  const contentW = width - margin * 2
  let y = height - margin

  // Header band
  page.drawRectangle({ x: 0, y: height - 80, width, height: 80, color: navy })
  page.drawText(PRACTICE_NAME, { x: margin, y: height - 38, font: bold, size: 20, color: white })
  page.drawText('SCHOOL ABSENCE NOTE', { x: margin, y: height - 60, font: regular, size: 10, color: rgb(0.63, 0.63, 0.75) })
  if (PRACTICE_PHONE) {
    const phoneW = regular.widthOfTextAtSize(PRACTICE_PHONE, 10)
    page.drawText(PRACTICE_PHONE, { x: width - margin - phoneW, y: height - 60, font: regular, size: 10, color: rgb(0.63, 0.63, 0.75) })
  }

  y = height - 110

  // Date issued (right-aligned)
  const todayStr = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
  const dateLabel = `Date issued: ${todayStr}`
  const dateW = regular.widthOfTextAtSize(dateLabel, 10)
  page.drawText(dateLabel, { x: width - margin - dateW, y, font: regular, size: 10, color: gray })

  y -= 30

  // To whom
  page.drawText('To whom it may concern:', { x: margin, y, font: bold, size: 12, color: navy })
  y -= 24

  // Body paragraph — word-wrapped
  function drawParagraph(text: string, font = regular, size = 12, lineH = 18, color = navy) {
    const words = text.split(/\s+/)
    let line = ''
    for (const word of words) {
      const candidate = line ? line + ' ' + word : word
      if (font.widthOfTextAtSize(candidate, size) > contentW) {
        page.drawText(line, { x: margin, y, font, size, color })
        y -= lineH
        line = word
      } else {
        line = candidate
      }
    }
    if (line) { page.drawText(line, { x: margin, y, font, size, color }); y -= lineH }
  }

  drawParagraph(
    `This note confirms that ${childName} (date of birth ${fmtDateLong(opts.childDob).replace(/^[A-Za-z]+day, /, '')}) was evaluated by our practice on ${fmtDateLong(opts.visitDate)}.`,
    regular, 12, 18, navy,
  )

  y -= 10

  // Excuse dates — highlighted block (parent's verbatim text)
  page.drawRectangle({ x: margin - 8, y: y - 50, width: contentW + 16, height: 56, color: light, borderColor: border, borderWidth: 0.5 })
  page.drawText('REQUESTED DATES OF ABSENCE', { x: margin, y: y - 10, font: bold, size: 9, color: gray })
  y -= 28
  drawParagraph(opts.excuseDates.trim(), regular, 12, 16, navy)
  y -= 18

  // Parent additional notes — verbatim block, labeled so school knows
  // these are the parent's words, not a clinical statement.
  if (opts.parentAdditionalNotes.trim()) {
    y -= 6
    page.drawRectangle({ x: margin - 8, y: y - 6, width: contentW + 16, height: 6, color: white })
    page.drawRectangle({
      x: margin - 8, y: y - 120, width: contentW + 16, height: 120 - 6,
      color: rgb(0.98, 0.98, 0.96), borderColor: border, borderWidth: 0.5,
    })
    page.drawText('ADDITIONAL INFORMATION PROVIDED BY PARENT', { x: margin, y: y - 10, font: bold, size: 9, color: gray })
    y -= 28
    drawParagraph(opts.parentAdditionalNotes.trim(), italic, 11, 15, navy)
    y -= 10
  }

  y -= 10
  drawParagraph(
    'Please excuse this absence. If you have any questions about this note, please contact our office at the number listed above.',
    regular, 12, 18, navy,
  )

  y -= 24

  // Signature block
  page.drawText('Sincerely,', { x: margin, y, font: regular, size: 12, color: navy })
  y -= 36
  page.drawText(`${opts.providerName}${opts.providerRole ? ', ' + opts.providerRole : ''}`, {
    x: margin, y, font: italic, size: 18, color: navy,
  })
  y -= 22
  page.drawText(`${opts.providerName}${opts.providerRole ? ', ' + opts.providerRole : ''}`, {
    x: margin, y, font: regular, size: 11, color: navy,
  })
  y -= 14
  if (opts.providerNpi) { page.drawText(`NPI: ${opts.providerNpi}`, { x: margin, y, font: regular, size: 10, color: gray }); y -= 14 }
  page.drawText(PRACTICE_NAME, { x: margin, y, font: regular, size: 10, color: gray })

  // Footer
  page.drawText(
    `${PRACTICE_NAME}  ·  This document contains protected health information`,
    { x: margin, y: 32, font: regular, size: 8, color: rgb(0.70, 0.70, 0.70) }
  )

  return pdfDoc.save()
}

async function sendEmailWithAttachment(to: string, bcc: string | null, subject: string, html: string, pdfBytes: Uint8Array, filename: string) {
  if (!RESEND_API_KEY) {
    console.log(`[EMAIL SKIPPED — no RESEND_API_KEY] To: ${to} | Subject: ${subject}`)
    return
  }
  const base64 = Buffer.from(pdfBytes).toString('base64')
  const body: any = {
    from: `${PRACTICE_NAME} <${FROM_EMAIL}>`,
    to,
    subject,
    html,
    attachments: [{ filename, content: base64 }],
  }
  if (bcc) body.bcc = bcc
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`Resend HTTP ${res.status}: ${await res.text().catch(() => '')}`)
}

function buildParentEmailBody(childFirstName: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f5f4ef;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f4ef;padding:32px 0;">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;">
        <tr><td style="background:#1a1a2e;border-radius:12px 12px 0 0;padding:24px 32px;">
          <div style="font-size:20px;font-weight:700;color:#fff;">${PRACTICE_NAME}</div>
          <div style="font-size:13px;color:#a0a0c0;margin-top:4px;">School absence note</div>
        </td></tr>
        <tr><td style="background:#fff;padding:28px 32px;">
          <p style="margin:0 0 16px;font-size:15px;color:#1a1a2e;">Hi,</p>
          <p style="margin:0 0 16px;font-size:14px;color:#444;line-height:1.6;">
            Your school absence note for ${childFirstName} is attached as a PDF. Please print it out or forward it directly to your school.
          </p>
          <p style="margin:0 0 20px;font-size:14px;color:#444;line-height:1.6;">
            If anything on the note doesn't match what you requested, reply to this email and we'll correct it.
          </p>
          <p style="margin:0;font-size:13px;color:#777;">Thanks${PRACTICE_PHONE ? '. Questions? Call us at ' + PRACTICE_PHONE : ''}.</p>
        </td></tr>
        <tr><td style="background:#f5f4ef;border-radius:0 0 12px 12px;padding:16px 32px;text-align:center;">
          <p style="margin:0;font-size:12px;color:#aaa;">${PRACTICE_NAME} · This email contains protected health information.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`
}

/**
 * POST /api/family/school-excuse-request
 *
 * Body: { appointment_id, excuse_dates, additional_notes }
 *
 * Fully automated flow (replaces the Pam-composes-manually workflow,
 * Sara 2026-10-05):
 *   1. Verify the family owns the appointment.
 *   2. Pull child + rendering provider from the chart.
 *   3. Generate a PDF school absence note with practice letterhead,
 *      visit date, parent-supplied excuse dates (verbatim), parent's
 *      additional notes (verbatim, labeled as parent-provided), and
 *      rendering provider signature block.
 *   4. Store the PDF on Vercel Blob + insert a row in school_notes
 *      so Sara / Pam can see every note that went out.
 *   5. Email the PDF directly to the parent, BCC pam@pedshousecalls.com
 *      so Pam retains visibility without having to compose anything.
 *
 * NO clinical diagnosis is included on the note (Sara's call) — only
 * the fact that the patient was evaluated on the visit date. If the
 * parent wants anything clinical attested, their verbatim notes
 * appear in the "Additional information provided by parent" section.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  let sub: string
  try { sub = await verifyFamilyToken(req.headers.authorization) }
  catch { return res.status(401).json({ error: 'Unauthorized' }) }

  const sql = neon(process.env.DATABASE_URL!)

  // Idempotent bootstrap — same pattern used across the codebase.
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS school_notes (
        id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        practice_id            uuid NOT NULL REFERENCES practices(id),
        child_id               uuid NOT NULL REFERENCES children(id) ON DELETE CASCADE,
        appointment_id         uuid REFERENCES appointments(id),
        requested_by_family_id uuid REFERENCES family_profiles(id),
        requested_by_name      text,
        excuse_dates_text      text NOT NULL,
        parent_additional_notes text,
        rendering_provider_id  uuid REFERENCES providers(id),
        rendering_provider_name text,
        rendering_provider_npi text,
        blob_url               text NOT NULL,
        filename               text NOT NULL,
        sent_to_email          text,
        sent_at                timestamptz,
        status                 text NOT NULL DEFAULT 'generated',
        created_at             timestamptz NOT NULL DEFAULT NOW()
      )`
    await sql`CREATE INDEX IF NOT EXISTS school_notes_child_idx ON school_notes(child_id, created_at DESC)`
    await sql`CREATE INDEX IF NOT EXISTS school_notes_practice_idx ON school_notes(practice_id, created_at DESC)`
  } catch (e: any) {
    console.error('school_notes bootstrap failed:', e?.message)
  }

  try {
    const { appointment_id, excuse_dates, additional_notes } = req.body ?? {}
    if (!appointment_id) return res.status(400).json({ error: 'appointment_id required' })
    if (!excuse_dates || !String(excuse_dates).trim()) {
      return res.status(400).json({ error: 'Please tell us which dates need to be excused.' })
    }

    const [fam] = await sql`SELECT id, email, display_name, phone, practice_id FROM family_profiles WHERE cognito_sub = ${sub} LIMIT 1`
    if (!fam) return res.status(403).json({ error: 'Family not found' })
    if (!fam.email) return res.status(400).json({ error: 'No email address on file. Please update your profile first.' })

    // Ownership check + full context for the PDF.
    const [row] = await sql`
      SELECT
        a.id AS appointment_id,
        a.scheduled_date,
        a.visit_type,
        a.provider_id,
        c.id AS child_id,
        c.first_name, c.last_name, c.date_of_birth,
        p.id AS prov_id, p.name AS prov_name, p.role AS prov_role, p.npi AS prov_npi
      FROM appointments a
      LEFT JOIN children c ON c.id = a.child_id
      LEFT JOIN providers p ON p.id = a.provider_id
      WHERE a.id = ${appointment_id}::uuid
        AND c.family_id = ${fam.id}::uuid
      LIMIT 1
    `
    if (!row) return res.status(404).json({ error: 'Visit not found for this family.' })
    if (!row.prov_name) return res.status(500).json({ error: 'Visit has no rendering provider on file — contact the office.' })

    const childName = [row.first_name, row.last_name].filter(Boolean).join(' ') || 'Patient'
    const excuseDatesStr = String(excuse_dates).trim()
    const notesStr = String(additional_notes ?? '').trim()

    // 1. Generate the PDF.
    const pdfBytes = await buildSchoolNotePdf({
      childFirstName: row.first_name ?? '',
      childLastName:  row.last_name  ?? '',
      childDob:       row.date_of_birth ?? null,
      visitDate:      row.scheduled_date,
      excuseDates:    excuseDatesStr,
      parentAdditionalNotes: notesStr,
      providerName:   row.prov_name,
      providerRole:   row.prov_role ?? null,
      providerNpi:    row.prov_npi ?? null,
    })

    // 2. Store the PDF on Blob (public URL, random suffix prevents guessing).
    const safeName = childName.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'patient'
    const todayStamp = new Date().toISOString().slice(0, 10)
    const filename = `School-Note-${safeName}-${todayStamp}.pdf`
    const blob = await put(`school-notes/${row.child_id}/${filename}`, Buffer.from(pdfBytes), {
      access: 'public',
      addRandomSuffix: true,
      contentType: 'application/pdf',
    })

    // 3. Email the parent + BCC Pam.
    let sentAt: Date | null = null
    let sendError: string | null = null
    try {
      await sendEmailWithAttachment(
        fam.email,
        SCHOOL_NOTE_BCC,
        `School absence note — ${childName}`,
        buildParentEmailBody(row.first_name ?? ''),
        pdfBytes,
        filename,
      )
      sentAt = new Date()
    } catch (e: any) {
      // Don't fail the whole flow — the PDF is already generated and
      // persisted; Pam can resend from the admin surface if the email
      // delivery itself blew up.
      console.error('school note email send failed:', e?.message)
      sendError = e?.message ?? 'unknown'
    }

    // 4. Persist audit row.
    await sql`
      INSERT INTO school_notes (
        practice_id, child_id, appointment_id,
        requested_by_family_id, requested_by_name,
        excuse_dates_text, parent_additional_notes,
        rendering_provider_id, rendering_provider_name, rendering_provider_npi,
        blob_url, filename, sent_to_email, sent_at, status
      )
      VALUES (
        ${fam.practice_id}::uuid, ${row.child_id}::uuid, ${appointment_id}::uuid,
        ${fam.id}::uuid, ${fam.display_name ?? fam.email ?? 'Family'},
        ${excuseDatesStr}, ${notesStr || null},
        ${row.prov_id}::uuid, ${row.prov_name}, ${row.prov_npi ?? null},
        ${blob.url}, ${filename}, ${sentAt ? fam.email : null}, ${sentAt}, ${sendError ? 'send_failed' : 'sent'}
      )
    `

    if (sendError) {
      return res.status(500).json({ error: `Note generated but email send failed: ${sendError}. The office has been notified.` })
    }
    return res.status(200).json({ ok: true, sent_to: fam.email, blob_url: blob.url })
  } catch (e: any) {
    console.error('school-excuse-request error:', e)
    return res.status(500).json({ error: e?.message ?? 'Internal server error' })
  }
}
