import type { VercelRequest, VercelResponse } from '@vercel/node'
import { neon } from '@neondatabase/serverless'
import { put } from '@vercel/blob'
import { createRemoteJWKSet, jwtVerify } from 'jose'
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib'

// NOTE: PDF/email helpers below are deliberately duplicated from
// api/family/school-excuse-request.ts. The codebase avoids cross-file
// imports inside api/ because Vercel's serverless bundling has
// repeatedly broken on those (see memory feedback_verify_after_every_push.md
// and the inline PAYER_IDS pattern in api/claims/index.ts). If you edit
// buildSchoolNotePdf / sendEmailWithAttachment here, mirror the change
// in api/family/school-excuse-request.ts so family-initiated and
// provider-initiated notes stay visually identical.
// Shipped 2026-10-06.

const PRACTICE_NAME  = process.env.PRACTICE_NAME || 'Pediatric House Calls PLLC'
const PRACTICE_PHONE = process.env.PRACTICE_PHONE || ''
const FROM_EMAIL     = process.env.FROM_EMAIL || 'appointments@phcbooking.com'
const RESEND_API_KEY = process.env.RESEND_API_KEY || ''
const SCHOOL_NOTE_BCC = 'pam@pedshousecalls.com'

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

  page.drawRectangle({ x: 0, y: height - 80, width, height: 80, color: navy })
  page.drawText(PRACTICE_NAME, { x: margin, y: height - 38, font: bold, size: 20, color: white })
  page.drawText('SCHOOL ABSENCE NOTE', { x: margin, y: height - 60, font: regular, size: 10, color: rgb(0.63, 0.63, 0.75) })
  if (PRACTICE_PHONE) {
    const phoneW = regular.widthOfTextAtSize(PRACTICE_PHONE, 10)
    page.drawText(PRACTICE_PHONE, { x: width - margin - phoneW, y: height - 60, font: regular, size: 10, color: rgb(0.63, 0.63, 0.75) })
  }

  y = height - 110

  const todayStr = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
  const dateLabel = `Date issued: ${todayStr}`
  const dateW = regular.widthOfTextAtSize(dateLabel, 10)
  page.drawText(dateLabel, { x: width - margin - dateW, y, font: regular, size: 10, color: gray })

  y -= 30
  page.drawText('To whom it may concern:', { x: margin, y, font: bold, size: 12, color: navy })
  y -= 24

  function drawParagraph(text: string, font = regular, size = 12, lineH = 18, color = navy) {
    const words = text.split(/\s+/)
    let line = ''
    for (const word of words) {
      const candidate = line ? line + ' ' + word : word
      if (font.widthOfTextAtSize(candidate, size) > contentW) {
        page.drawText(line, { x: margin, y, font, size, color })
        y -= lineH
        line = word
      } else { line = candidate }
    }
    if (line) { page.drawText(line, { x: margin, y, font, size, color }); y -= lineH }
  }

  drawParagraph(
    `This note confirms that ${childName} (date of birth ${fmtDateLong(opts.childDob).replace(/^[A-Za-z]+day, /, '')}) was evaluated by our practice on ${fmtDateLong(opts.visitDate)}.`,
    regular, 12, 18, navy,
  )

  y -= 10

  page.drawRectangle({ x: margin - 8, y: y - 50, width: contentW + 16, height: 56, color: light, borderColor: border, borderWidth: 0.5 })
  page.drawText('REQUESTED DATES OF ABSENCE', { x: margin, y: y - 10, font: bold, size: 9, color: gray })
  y -= 28
  drawParagraph(opts.excuseDates.trim(), regular, 12, 16, navy)
  y -= 18

  if (opts.parentAdditionalNotes.trim()) {
    y -= 6
    page.drawRectangle({ x: margin - 8, y: y - 6, width: contentW + 16, height: 6, color: white })
    page.drawRectangle({
      x: margin - 8, y: y - 120, width: contentW + 16, height: 120 - 6,
      color: rgb(0.98, 0.98, 0.96), borderColor: border, borderWidth: 0.5,
    })
    page.drawText('ADDITIONAL INFORMATION', { x: margin, y: y - 10, font: bold, size: 9, color: gray })
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

// Provider-initiated flavor of the parent email — tells the parent the
// provider sent it on their behalf so they're not surprised.
function buildEmailBody(childFirstName: string, providerName: string): string {
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
            ${providerName} has generated a school absence note for ${childFirstName}. It's attached to this email as a PDF — please print it or forward it directly to the school.
          </p>
          <p style="margin:0 0 20px;font-size:14px;color:#444;line-height:1.6;">
            If anything on the note doesn't look right, reply to this email and we'll correct it.
          </p>
          <p style="margin:0;font-size:13px;color:#777;">Thank you so much for allowing us to care for your child!${PRACTICE_PHONE ? ' Questions? Call us at ' + PRACTICE_PHONE : ''}</p>
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
 * POST /api/providers/school-note
 *
 * Provider-initiated school note. Shipped 2026-10-06 after Sara asked
 * for a path to generate school notes on behalf of a patient without
 * waiting for the parent to click the post-visit email link.
 *
 * Body: {
 *   appointment_id: uuid,
 *   excuse_dates: string (free-text, verbatim onto the PDF),
 *   additional_notes?: string,
 *   parent_email_override?: string (used when the family profile email
 *     is stale/wrong; audit log notes the override),
 * }
 *
 * - Verifies provider is in the same practice as the appointment.
 * - Reuses the family-side PDF template (visually identical).
 * - Emails the parent on file (or override) + BCCs Pam.
 * - Writes a school_notes row with requested_by_provider_id set so
 *   AdminSchoolNotes can distinguish provider-initiated from family-
 *   initiated notes.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  let sub: string
  try { sub = await verifyProviderToken(req.headers.authorization) }
  catch { return res.status(401).json({ error: 'Unauthorized' }) }

  const sql = neon(process.env.DATABASE_URL!)

  // Bootstrap — mirrors family endpoint plus the provider-initiated
  // columns we add here.
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
    // Added 2026-10-06 for the provider-initiated path. requested_by
    // becomes the single source of truth for "who kicked this off."
    await sql`ALTER TABLE school_notes ADD COLUMN IF NOT EXISTS requested_by_provider_id uuid REFERENCES providers(id)`
    await sql`ALTER TABLE school_notes ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'family'`
    await sql`CREATE INDEX IF NOT EXISTS school_notes_child_idx ON school_notes(child_id, created_at DESC)`
    await sql`CREATE INDEX IF NOT EXISTS school_notes_practice_idx ON school_notes(practice_id, created_at DESC)`
  } catch (e: any) {
    console.error('[provider school-note] bootstrap failed:', e?.message)
  }

  try {
    const { appointment_id, excuse_dates, additional_notes, parent_email_override } = req.body ?? {}
    if (!appointment_id) return res.status(400).json({ error: 'appointment_id required' })
    if (!excuse_dates || !String(excuse_dates).trim()) {
      return res.status(400).json({ error: 'Excuse dates required.' })
    }

    const [provider] = await sql`SELECT id, name, role, npi, practice_id FROM providers WHERE cognito_sub = ${sub} LIMIT 1`
    if (!provider) return res.status(403).json({ error: 'Provider not found' })

    // Load the appointment + child + family email; scope to provider's
    // practice (admin + any provider in the practice can issue a note
    // for any patient in the practice).
    const [row] = await sql`
      SELECT
        a.id              AS appointment_id,
        a.scheduled_date,
        a.visit_type,
        a.provider_id     AS appointment_provider_id,
        c.id              AS child_id,
        c.first_name,
        c.last_name,
        c.date_of_birth,
        c.parent_email    AS child_parent_email,
        fp.id             AS family_id,
        fp.email          AS family_email,
        rp.id             AS rendering_provider_id,
        rp.name           AS rendering_provider_name,
        rp.role           AS rendering_provider_role,
        rp.npi            AS rendering_provider_npi
      FROM appointments a
      LEFT JOIN children c         ON c.id = a.child_id
      LEFT JOIN family_profiles fp ON fp.id = c.family_id
      LEFT JOIN providers rp       ON rp.id = a.provider_id
      WHERE a.id = ${appointment_id}::uuid
        AND a.practice_id = ${provider.practice_id}::uuid
      LIMIT 1
    `
    if (!row) return res.status(404).json({ error: 'Appointment not found in your practice.' })
    if (!row.child_id) return res.status(400).json({ error: 'Appointment has no linked patient.' })

    // Signing provider: the one who rendered the visit (so the signature
    // on the note matches the visit). If the appointment has no rendering
    // provider on file (manually-added without one), fall back to the
    // provider issuing the note so the PDF has a signature at all.
    const signingName = row.rendering_provider_name ?? provider.name
    const signingRole = row.rendering_provider_role ?? provider.role ?? null
    const signingNpi  = row.rendering_provider_npi  ?? provider.npi  ?? null
    const signingId   = row.rendering_provider_id   ?? provider.id

    const childName = [row.first_name, row.last_name].filter(Boolean).join(' ') || 'Patient'
    const excuseDatesStr = String(excuse_dates).trim()
    const notesStr = String(additional_notes ?? '').trim()
    const emailOverride = parent_email_override ? String(parent_email_override).trim() : ''
    const targetEmail = emailOverride || row.family_email || row.child_parent_email || null

    if (!targetEmail) {
      return res.status(400).json({ error: 'No parent email on file. Provide parent_email_override, or update the family profile first.' })
    }

    // 1. PDF
    const pdfBytes = await buildSchoolNotePdf({
      childFirstName: row.first_name ?? '',
      childLastName:  row.last_name  ?? '',
      childDob:       row.date_of_birth ?? null,
      visitDate:      row.scheduled_date,
      excuseDates:    excuseDatesStr,
      parentAdditionalNotes: notesStr,
      providerName:   signingName,
      providerRole:   signingRole,
      providerNpi:    signingNpi,
    })

    // 2. Blob
    const safeName = childName.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'patient'
    const todayStamp = new Date().toISOString().slice(0, 10)
    const filename = `School-Note-${safeName}-${todayStamp}.pdf`
    const blob = await put(`school-notes/${row.child_id}/${filename}`, Buffer.from(pdfBytes), {
      access: 'public',
      addRandomSuffix: true,
      contentType: 'application/pdf',
    })

    // 3. Email
    let sentAt: Date | null = null
    let sendError: string | null = null
    try {
      await sendEmailWithAttachment(
        targetEmail,
        SCHOOL_NOTE_BCC,
        `School absence note — ${childName}`,
        buildEmailBody(row.first_name ?? '', signingName),
        pdfBytes,
        filename,
      )
      sentAt = new Date()
    } catch (e: any) {
      console.error('[provider school-note] email send failed:', e?.message)
      sendError = e?.message ?? 'unknown'
    }

    // 4. Audit row
    await sql`
      INSERT INTO school_notes (
        practice_id, child_id, appointment_id,
        requested_by_family_id, requested_by_provider_id, requested_by_name, source,
        excuse_dates_text, parent_additional_notes,
        rendering_provider_id, rendering_provider_name, rendering_provider_npi,
        blob_url, filename, sent_to_email, sent_at, status
      ) VALUES (
        ${provider.practice_id}::uuid, ${row.child_id}::uuid, ${appointment_id}::uuid,
        NULL, ${provider.id}::uuid, ${provider.name ?? 'Provider'}, 'provider',
        ${excuseDatesStr}, ${notesStr || null},
        ${signingId}::uuid, ${signingName}, ${signingNpi},
        ${blob.url}, ${filename}, ${sentAt ? targetEmail : null}, ${sentAt}, ${sendError ? 'send_failed' : 'sent'}
      )
    `

    if (sendError) {
      return res.status(500).json({ error: `Note generated but email send failed: ${sendError}. Pam has been notified.` })
    }
    return res.status(200).json({ ok: true, sent_to: targetEmail, blob_url: blob.url })
  } catch (e: any) {
    console.error('[provider school-note] error:', e)
    return res.status(500).json({ error: e?.message ?? 'Internal server error' })
  }
}
