import type { VercelRequest, VercelResponse } from '@vercel/node'
import { neon } from '@neondatabase/serverless'

const TWILIO_SID       = process.env.TWILIO_ACCOUNT_SID || ''
const TWILIO_KEY       = process.env.TWILIO_API_KEY_SID || ''
const TWILIO_SEC       = process.env.TWILIO_API_KEY_SECRET || ''
const TWILIO_FROM      = process.env.TWILIO_FROM_NUMBER || ''
const RESEND_KEY       = process.env.RESEND_API_KEY || ''
const FROM_EMAIL       = process.env.FROM_EMAIL || 'appointments@phcbooking.com'
const PORTAL_URL       = process.env.PORTAL_URL || 'https://phc-team.com'
const PRACTICE_NAME    = process.env.PRACTICE_NAME || 'Pediatric Housecalls'
const PRACTICE_PHONE   = process.env.PRACTICE_PHONE || ''

async function sendSMS(to: string, body: string): Promise<void> {
  if (!TWILIO_SID || !TWILIO_KEY) return
  const form = new URLSearchParams({ From: TWILIO_FROM, To: to, Body: body })
  const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${TWILIO_KEY}:${TWILIO_SEC}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: form,
  })
  if (!r.ok) console.error('[waitlist respond] SMS err:', await r.text())
}

async function sendEmail(to: string, subject: string, html: string): Promise<void> {
  if (!RESEND_KEY) return
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: `${PRACTICE_NAME} <${FROM_EMAIL}>`, to, subject, html }),
  })
  if (!r.ok) console.error('[waitlist respond] Email err:', await r.text())
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;')
}

function htmlPage(title: string, message: string, color: string): string {
  const contactBits: string[] = []
  contactBits.push(escapeHtml(PRACTICE_NAME))
  if (PRACTICE_PHONE) contactBits.push(`<a href="tel:${escapeHtml(PRACTICE_PHONE)}" style="color:#7F77DD;">${escapeHtml(PRACTICE_PHONE)}</a>`)
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${escapeHtml(title)}</title>
<style>
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #FAFAF8; color: #1A1A2E; margin: 0; padding: 24px 16px; }
.card { max-width: 480px; margin: 40px auto; background: #fff; border-radius: 16px; padding: 32px; box-shadow: 0 2px 12px rgba(0,0,0,0.06); }
h1 { color: ${color}; margin: 0 0 16px; font-size: 22px; }
p { font-size: 16px; line-height: 1.55; margin: 0 0 12px; }
.footer { color: #999; font-size: 13px; margin-top: 24px; }
</style></head>
<body><div class="card">
<h1>${escapeHtml(title)}</h1>
<p>${escapeHtml(message)}</p>
<p class="footer">— ${contactBits.join(' · ')}</p>
</div></body></html>`
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8')

  const token  = (req.query.t as string) || ''
  const action = (req.query.a as string) || ''

  if (!token || !['keep', 'remove'].includes(action)) {
    return res.status(400).send(htmlPage('Invalid link', 'This link is missing information. Please check the message you received, or call us if you need help.', '#DC2626'))
  }

  const sql = neon(process.env.DATABASE_URL!)

  const [entry] = await sql`
    SELECT we.id, we.status, we.family_id, we.notes, we.state, we.zip,
           we.parent_response,
           fp.email AS family_email, fp.phone AS family_phone,
           COALESCE(fp.display_name, (SELECT first_name || ' ' || last_name FROM children WHERE family_id = fp.id LIMIT 1), fp.email) AS family_name
    FROM waitlist_entries we
    LEFT JOIN family_profiles fp ON fp.id = we.family_id
    WHERE we.reminder_token = ${token}
    LIMIT 1
  `
  if (!entry) {
    return res.status(404).send(htmlPage('Link not found', 'This link is no longer valid. If you need help, please call us.', '#DC2626'))
  }

  if (entry.parent_response && entry.parent_response !== 'auto_eod') {
    const alreadyRemoved = entry.parent_response === 'remove'
    return res.status(200).send(htmlPage(
      alreadyRemoved ? 'You have been removed' : 'You are still on our waitlist',
      alreadyRemoved
        ? 'We already received your request to remove this waitlist entry. If this was a mistake, please call us.'
        : "We already received your confirmation. We'll keep looking for a provider today.",
      '#7F77DD'
    ))
  }

  if (action === 'keep') {
    await sql`
      UPDATE waitlist_entries
      SET parent_response = 'keep', parent_response_at = NOW()
      WHERE id = ${entry.id}::uuid
    `
    return res.status(200).send(htmlPage(
      'Thanks — you are still on our waitlist',
      "We'll keep doing our best to find a provider for you today. If we can't place your child by the end of the day, we'll remove the entry so you can make other plans.",
      '#1D9E75'
    ))
  }

  // action === 'remove'
  await sql`
    UPDATE waitlist_entries
    SET parent_response = 'remove',
        parent_response_at = NOW(),
        status = 'removed'
    WHERE id = ${entry.id}::uuid
  `

  // Notify the same staff list that was originally notified when the entry
  // was created (see /api/waitlist-entries sendWaitlistNotifications).
  try {
    const recipients = await sql`SELECT name, phone, email, states, role, is_admin FROM providers WHERE is_active = true OR is_admin = true`
    const patientLabel = ((entry.notes || '') as string).match(/Patient:\s*([^|]+)/)?.[1]?.trim() || String(entry.family_name || 'A patient')
    const stateLbl = entry.state === 'NC' ? 'North Carolina' : entry.state === 'SC' ? 'South Carolina' : entry.state === 'VA' ? 'Virginia' : (entry.state as string) || ''
    const smsBody = `${PRACTICE_NAME}: ${patientLabel} removed themselves from the waitlist${entry.zip ? ` (zip ${entry.zip})` : ''}. View: ${PORTAL_URL}/admin/waitlist`
    const emailSubject = `[Waitlist] Removed by parent — ${patientLabel}`
    const emailHtml = `<!DOCTYPE html><html><body style="font-family:sans-serif;color:#1A1A2E;">
<h2 style="color:#1A1A2E;">${PRACTICE_NAME} — Waitlist Entry Removed by Parent</h2>
<p><strong>${patientLabel}</strong> chose to remove themselves from the waitlist after receiving the automated 3-hour reminder.</p>
<ul>
  ${entry.zip ? `<li><strong>Zip:</strong> ${entry.zip}</li>` : ''}
  ${stateLbl ? `<li><strong>State:</strong> ${stateLbl}</li>` : ''}
</ul>
<p><a href="${PORTAL_URL}/admin/waitlist" style="background:#EF9F27;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none;">View waitlist</a></p>
</body></html>`

    for (const prov of recipients) {
      const provStates: string[] = (prov.states ?? []) as string[]
      const stateFiltered = !prov.is_admin && ['MD', 'PNP'].includes(prov.role)
      if (stateFiltered && entry.state && provStates.length > 0 && !provStates.includes(entry.state as string)) continue
      if (prov.email) sendEmail(prov.email, emailSubject, emailHtml).catch(() => {})
      if (prov.phone) sendSMS(prov.phone, smsBody).catch(() => {})
    }
  } catch (e) {
    console.error('[waitlist respond] staff notify err:', e)
  }

  return res.status(200).send(htmlPage(
    'You have been removed',
    "We're sorry we couldn't find a provider for you today. If you change your mind, please call us — we'd be glad to help you get back on the waitlist.",
    '#DC2626'
  ))
}
