import type { VercelRequest, VercelResponse } from '@vercel/node'
import { neon } from '@neondatabase/serverless'
import { createRemoteJWKSet, jwtVerify } from 'jose'

const PRACTICE_NAME = process.env.PRACTICE_NAME || 'Pediatric House Calls PLLC'
const FROM_EMAIL    = process.env.FROM_EMAIL || 'appointments@phcbooking.com'
const RESEND_API_KEY = process.env.RESEND_API_KEY || ''
const SCHOOL_EXCUSE_INBOX = 'pam@pedshousecalls.com'  // Sara requested 2026-09-17

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

function esc(s: any): string {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]!))
}

function fmtDate(v: any): string {
  if (!v) return '—'
  try { return new Date(String(v)).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) }
  catch { return String(v) }
}

async function sendEmail(to: string, subject: string, html: string, replyTo: string | null) {
  if (!RESEND_API_KEY) throw new Error('RESEND_API_KEY not configured')
  const body: any = { from: `${PRACTICE_NAME} <${FROM_EMAIL}>`, to, subject, html }
  if (replyTo) body.reply_to = replyTo
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`Resend HTTP ${res.status}: ${await res.text().catch(() => '')}`)
}

/**
 * POST /api/family/school-excuse-request
 *
 * Body: { appointment_id, excuse_dates, additional_notes }
 *
 * Verifies the family owns the appointment, then emails pam@pedshousecalls.com
 * with the child's name, DOB, visit date, requested excuse dates, additional
 * notes, and family reply-to. Sara requested 2026-09-17 as a new hook in the
 * post-visit email flow.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  let sub: string
  try { sub = await verifyFamilyToken(req.headers.authorization) }
  catch { return res.status(401).json({ error: 'Unauthorized' }) }

  const sql = neon(process.env.DATABASE_URL!)

  try {
    const { appointment_id, excuse_dates, additional_notes } = req.body ?? {}
    if (!appointment_id) return res.status(400).json({ error: 'appointment_id required' })
    if (!excuse_dates || !String(excuse_dates).trim()) {
      return res.status(400).json({ error: 'Please tell us which dates need to be excused.' })
    }

    const [fam] = await sql`SELECT id, email, display_name, phone FROM family_profiles WHERE cognito_sub = ${sub} LIMIT 1`
    if (!fam) return res.status(403).json({ error: 'Family not found' })

    // Ownership check — the appointment must belong to a child on this family.
    const [row] = await sql`
      SELECT
        a.id AS appointment_id,
        a.scheduled_date,
        a.visit_type,
        c.id AS child_id,
        c.first_name, c.last_name, c.date_of_birth
      FROM appointments a
      LEFT JOIN children c ON c.id = a.child_id
      WHERE a.id = ${appointment_id}::uuid
        AND c.family_id = ${fam.id}::uuid
      LIMIT 1
    `
    if (!row) return res.status(404).json({ error: 'Visit not found for this family.' })

    const childName = [row.first_name, row.last_name].filter(Boolean).join(' ') || 'Patient'
    const excuseDatesStr = String(excuse_dates).trim()
    const notesStr = String(additional_notes ?? '').trim()

    const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#FAFAF8;font-family:'DM Sans',system-ui,sans-serif;color:#1A1A2E;">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px;">
<table width="100%" style="max-width:560px;background:#fff;border-radius:16px;border:1px solid #E8E8E4;overflow:hidden;">
  <tr><td style="background:#1A1A2E;padding:24px 32px;">
    <div style="font-size:11px;color:rgba(255,255,255,0.5);text-transform:uppercase;letter-spacing:0.08em;">${esc(PRACTICE_NAME)}</div>
    <div style="font-size:20px;font-weight:600;color:#fff;margin-top:4px;">New school excuse request</div>
  </td></tr>
  <tr><td style="padding:28px 32px;">
    <table width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;">
      <tr><td style="padding:6px 0;color:#555;width:150px;">Patient</td>       <td style="padding:6px 0;font-weight:600;">${esc(childName)}</td></tr>
      <tr><td style="padding:6px 0;color:#555;">Date of birth</td>              <td style="padding:6px 0;">${esc(fmtDate(row.date_of_birth))}</td></tr>
      <tr><td style="padding:6px 0;color:#555;">Visit date</td>                 <td style="padding:6px 0;">${esc(fmtDate(row.scheduled_date))}${row.visit_type ? ` &middot; ${esc(row.visit_type)}` : ''}</td></tr>
      <tr><td style="padding:6px 0;color:#555;">Requested by</td>               <td style="padding:6px 0;">${esc(fam.display_name || fam.email || 'Family')}${fam.email ? `<br><a href="mailto:${esc(fam.email)}" style="color:#7F77DD;">${esc(fam.email)}</a>` : ''}${fam.phone ? `<br>${esc(fam.phone)}` : ''}</td></tr>
    </table>

    <div style="margin-top:24px;padding:16px 18px;background:#F0FAF6;border:1px solid #A9DFBF;border-radius:10px;">
      <div style="font-size:11px;font-weight:600;color:#0F6E56;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:6px;">Dates to excuse</div>
      <div style="font-size:14px;line-height:1.5;white-space:pre-wrap;">${esc(excuseDatesStr)}</div>
    </div>

    ${notesStr ? `
    <div style="margin-top:16px;padding:16px 18px;background:#FAFAF8;border:1px solid #E8E8E4;border-radius:10px;">
      <div style="font-size:11px;font-weight:600;color:#555;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:6px;">Additional notes from parent</div>
      <div style="font-size:14px;line-height:1.55;white-space:pre-wrap;">${esc(notesStr)}</div>
    </div>` : ''}

    <p style="font-size:12px;color:#888;margin-top:24px;line-height:1.5;">
      Turnaround promised to the family: <strong>24 hours</strong>. Reply to this email to send the school note directly to the parent.
    </p>
  </td></tr>
</table>
</td></tr></table>
</body></html>`

    await sendEmail(
      SCHOOL_EXCUSE_INBOX,
      `School excuse requested — ${childName} (visit ${fmtDate(row.scheduled_date)})`,
      html,
      fam.email || null,
    )

    return res.status(200).json({ ok: true })
  } catch (e: any) {
    console.error('school-excuse-request error:', e)
    return res.status(500).json({ error: e?.message ?? 'Internal server error' })
  }
}
