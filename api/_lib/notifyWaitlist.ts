import { neon } from '@neondatabase/serverless'

const RESEND_API_KEY = process.env.RESEND_API_KEY || ''
const TWILIO_SID     = process.env.TWILIO_ACCOUNT_SID || ''
const TWILIO_KEY     = process.env.TWILIO_API_KEY_SID || ''
const TWILIO_SECRET  = process.env.TWILIO_API_KEY_SECRET || ''
const TWILIO_FROM    = process.env.TWILIO_FROM_NUMBER || ''
const FROM_EMAIL     = process.env.FROM_EMAIL || 'appointments@phcbooking.com'
const PORTAL_URL     = process.env.PORTAL_URL || 'https://phc-team.com'
const PRACTICE_NAME  = process.env.PRACTICE_NAME || 'Pediatric Housecalls'

async function sendEmail(to: string, subject: string, html: string) {
  if (!RESEND_API_KEY || RESEND_API_KEY === 'PLACEHOLDER') {
    console.error('[notifyWaitlist] email skipped — no RESEND_API_KEY')
    return
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: `${PRACTICE_NAME} <${FROM_EMAIL}>`, to, subject, html }),
  })
  if (!res.ok) {
    const msg = await res.text()
    console.error('[notifyWaitlist] email error:', msg)
  }
}

async function sendSMS(to: string, body: string) {
  if (!TWILIO_SID || !TWILIO_KEY || !TWILIO_FROM) {
    console.error('[notifyWaitlist] SMS skipped — missing Twilio credentials')
    return
  }
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${TWILIO_KEY}:${TWILIO_SECRET}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ From: TWILIO_FROM, To: to, Body: body }),
  })
  if (!res.ok) {
    const msg = await res.text()
    console.error('[notifyWaitlist] SMS error to', to, ':', msg)
  }
}

function emailHtml(data: { zip: string; state: string | null; visitType: string | null; preferredTime: string | null; providerName: string }) {
  const firstName = data.providerName.split(' ').slice(-2)[0]
  const stateLabel = data.state === 'NC' ? 'North Carolina' : data.state === 'SC' ? 'South Carolina' : data.state === 'VA' ? 'Virginia' : data.state || 'your state'
  const parts = PRACTICE_NAME.trim().split(/\s+/)
  const logoHtml = parts.length === 1 ? `<span style="color:#fff;">${PRACTICE_NAME}</span>` : `${parts.slice(0, -1).join(' ')}<span style="color:#EF9F27;">${parts[parts.length - 1]}</span>`
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#FAFAF8;font-family:'DM Sans',system-ui,sans-serif;color:#1A1A2E;">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px;">
<table width="100%" style="max-width:520px;background:#fff;border-radius:16px;border:1px solid #E8E8E4;overflow:hidden;">
<tr><td style="background:#1A1A2E;padding:28px 32px;">
  <div style="font-size:20px;font-weight:600;color:#fff;">${logoHtml}</div>
  <div style="font-size:12px;color:rgba(255,255,255,0.4);margin-top:4px;text-transform:uppercase;letter-spacing:0.06em;">New waitlist entry — ${stateLabel}</div>
</td></tr>
<tr><td style="padding:32px;">
  <p style="font-size:15px;margin:0 0 20px;line-height:1.6;">Hi ${firstName},<br><br>
  A family has joined the waitlist${data.zip ? ` in zip code <strong>${data.zip}</strong>` : ''}.</p>
  ${data.visitType ? `<div style="margin-bottom:10px;"><span style="font-size:12px;color:#999;text-transform:uppercase;">Visit type</span><br><span style="font-size:14px;font-weight:500;">${data.visitType}</span></div>` : ''}
  ${data.preferredTime ? `<div style="margin-bottom:20px;"><span style="font-size:12px;color:#999;text-transform:uppercase;">Preferred time</span><br><span style="font-size:14px;font-weight:500;">${data.preferredTime}</span></div>` : ''}
  <a href="${PORTAL_URL}/admin/waitlist" style="display:inline-block;background:#EF9F27;color:#fff;text-decoration:none;padding:12px 24px;border-radius:10px;font-size:14px;font-weight:500;">View waitlist</a>
</td></tr>
</table></td></tr></table></body></html>`
}

export async function notifyWaitlist(entry: Record<string, unknown>) {
  const sql = neon(process.env.DATABASE_URL!)
  console.error('[notifyWaitlist] triggered for entry', entry.id, 'state:', entry.state)

  const stateLabel = entry.state === 'NC' ? 'North Carolina' : entry.state === 'SC' ? 'South Carolina' : entry.state === 'VA' ? 'Virginia' : (entry.state as string) || 'your state'
  const smsBody = `${PRACTICE_NAME}: New waitlist entry. View: ${PORTAL_URL}/admin/waitlist`

  const providers = await sql`SELECT id, name, phone, email, states FROM providers WHERE role != 'admin' AND is_active = true`
  console.error('[notifyWaitlist] providers to consider:', providers.length)

  for (const prov of providers) {
    const provStates: string[] = (prov.states ?? []) as string[]
    if (entry.state && provStates.length > 0 && !provStates.includes(entry.state as string)) continue
    console.error('[notifyWaitlist] notifying provider:', prov.name)
    if (prov.email) await sendEmail(prov.email, `[Waitlist] New family — zip ${entry.zip}`, emailHtml({ zip: entry.zip as string, state: entry.state as string, visitType: entry.visit_type as string, preferredTime: entry.preferred_time_window as string, providerName: prov.name }))
    if (prov.phone) await sendSMS(prov.phone, smsBody)
  }

  const admins = await sql`SELECT id, name, phone, email FROM providers WHERE role = 'admin'`
  console.error('[notifyWaitlist] admins:', admins.length)
  for (const admin of admins) {
    console.error('[notifyWaitlist] notifying admin:', admin.name)
    if (admin.email) await sendEmail(admin.email, `[Admin Waitlist] New entry — zip ${entry.zip}, ${stateLabel}`, emailHtml({ zip: entry.zip as string, state: entry.state as string, visitType: entry.visit_type as string, preferredTime: entry.preferred_time_window as string, providerName: admin.name || 'Admin' }))
    if (admin.phone) await sendSMS(admin.phone, smsBody)
  }

  console.error('[notifyWaitlist] done')
}
