import type { VercelRequest, VercelResponse } from '@vercel/node'
import { neon } from '@neondatabase/serverless'

const RESEND_API_KEY    = process.env.RESEND_API_KEY || ''
const TWILIO_SID        = process.env.TWILIO_ACCOUNT_SID || ''
const TWILIO_API_KEY    = process.env.TWILIO_API_KEY_SID || ''
const TWILIO_API_SECRET = process.env.TWILIO_API_KEY_SECRET || ''
const TWILIO_FROM       = process.env.TWILIO_FROM_NUMBER || ''
const FROM_EMAIL        = process.env.FROM_EMAIL || 'appointments@phcbooking.com'
const PORTAL_URL        = process.env.PORTAL_URL || 'https://phc-team.com'
const PRACTICE_NAME     = process.env.PRACTICE_NAME || 'Pediatric Housecalls'
const TELEMEDICINE_URL  = process.env.TELEMEDICINE_URL || 'https://doxy.me/v2/check-in/pediatrichousecalls/'
const GOOGLE_REVIEW_URL = process.env.GOOGLE_REVIEW_URL || 'https://g.page/r/CeBMcqioHWlQEBM/review'
const VENMO_HANDLE      = process.env.VENMO_HANDLE || '@Pediatric-Housecalls'

// Splits practice name into "first words" (white) + "last word" (accent color)
function logo(accentColor: string): string {
  const parts = PRACTICE_NAME.trim().split(/\s+/)
  if (parts.length === 1) return `<span style="color:#fff;">${PRACTICE_NAME}</span>`
  const last = parts[parts.length - 1]
  const rest = parts.slice(0, -1).join(' ')
  return `${rest}<span style="color:${accentColor};">${last}</span>`
}

// ── Email via Resend ──────────────────────────────────────────────────────────

async function sendEmail(to: string, subject: string, html: string) {
  if (!RESEND_API_KEY || RESEND_API_KEY === 'PLACEHOLDER') {
    console.log(`[EMAIL SKIPPED — no key] To: ${to} | Subject: ${subject}`)
    return
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: `${PRACTICE_NAME} <${FROM_EMAIL}>`, to, subject, html }),
  })
  if (!res.ok) {
    const msg = await res.text()
    console.error('Email error:', msg)
    throw new Error(`Email failed: ${msg}`)
  }
}

// ── SMS via Twilio ────────────────────────────────────────────────────────────

function normalizePhone(phone: string): string {
  const digits = phone.replace(/\D/g, '')
  if (digits.length === 10) return `+1${digits}`
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`
  return phone
}

async function sendSMS(to: string, body: string) {
  if (!TWILIO_SID || !TWILIO_API_KEY) {
    console.log(`[SMS SKIPPED — no credentials] To: ${to} | Body: ${body}`)
    return
  }
  const formData = new URLSearchParams({ From: TWILIO_FROM, To: normalizePhone(to), Body: body })
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${Buffer.from(`${TWILIO_API_KEY}:${TWILIO_API_SECRET}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: formData,
  })
  if (!res.ok) {
    const msg = await res.text()
    console.error('SMS error:', msg)
    throw new Error(`SMS failed: ${msg}`)
  }
}

// ── Email templates ───────────────────────────────────────────────────────────

function row(icon: string, label: string, value: string) {
  return `<table width="100%" style="margin-bottom:10px;"><tr>
    <td width="24" style="font-size:16px;vertical-align:top;padding-top:1px;">${icon}</td>
    <td style="font-size:12px;color:#999;text-transform:uppercase;letter-spacing:0.05em;width:80px;vertical-align:top;padding-top:3px;">${label}</td>
    <td style="font-size:14px;font-weight:500;color:#1A1A2E;">${value}</td>
  </tr></table>`
}

function formatDate(dateStr: string | Date): string {
  const s = dateStr instanceof Date ? dateStr.toISOString() : String(dateStr)
  const clean = s.includes('T') ? s.split('T')[0] : s
  const d = new Date(clean + 'T12:00:00')
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
}

function to12h(time24: string): string {
  const [hStr, mStr] = time24.split(':')
  let h = parseInt(hStr, 10)
  const m = mStr || '00'
  const ampm = h >= 12 ? 'PM' : 'AM'
  h = h % 12 || 12
  return `${h}:${m} ${ampm}`
}

function parentConfirmationEmail(data: {
  visitType: string, date: string, time: string,
  provider: string, zone: string, ref: string,
  displayName: string | null,
}) {
  const greeting = data.displayName ? `Hi ${data.displayName.split(' ')[0]},` : 'Hi there,'
  const isVirtual = ['Video telemedicine', 'Text visit'].includes(data.visitType)
  const isVideoVisit = data.visitType === 'Video telemedicine'
  const isIVFluids = data.visitType.toLowerCase().includes('iv') || data.visitType.toLowerCase().includes('fluid')

  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#FAFAF8;font-family:'DM Sans',system-ui,sans-serif;color:#1A1A2E;">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px;">
<table width="100%" style="max-width:520px;background:#fff;border-radius:16px;border:1px solid #E8E8E4;overflow:hidden;">

  <!-- Header -->
  <tr><td style="background:#1A1A2E;padding:28px 32px;">
    <div style="font-size:20px;font-weight:600;color:#fff;letter-spacing:-0.3px;">${logo('#7F77DD')}</div>
    <div style="font-size:12px;color:rgba(255,255,255,0.4);margin-top:4px;text-transform:uppercase;letter-spacing:0.06em;">Appointment confirmed</div>
  </td></tr>

  <!-- Body -->
  <tr><td style="padding:32px;">
    <p style="font-size:15px;margin:0 0 20px;line-height:1.6;">${greeting}<br><br>
    Your appointment is confirmed. We look forward to seeing you!</p>

    <!-- Appointment details box -->
    <table width="100%" style="background:#FAFAF8;border-radius:12px;border:1px solid #E8E8E4;margin-bottom:24px;">
      <tr><td style="padding:20px;">
        <div style="font-size:18px;font-weight:600;margin-bottom:16px;">${data.visitType}</div>
        ${row('📅', 'Date', data.date)}
        ${row('🕐', 'Time', data.time)}
        ${row('👩‍⚕️', 'Provider', data.provider)}
        ${row('📍', 'Zone', data.zone)}
      </td></tr>
    </table>

    ${isVideoVisit ? `
    <div style="background:#EEEDFE;border-radius:10px;padding:14px 16px;margin-bottom:20px;font-size:13px;color:#3C3489;">
      <strong>Video visit:</strong> When it is time for your scheduled video visit, please click on the following link to log into the secure ${PRACTICE_NAME} telemedicine waiting room:<br><br>
      <a href="${TELEMEDICINE_URL}" style="display:inline-block;background:#7F77DD;color:#fff;text-decoration:none;padding:10px 20px;border-radius:8px;font-size:13px;font-weight:600;">Join telemedicine waiting room →</a><br><br>
      <span style="font-size:12px;color:#5550A0;">Or copy this link: ${TELEMEDICINE_URL}</span>
    </div>` : isVirtual ? `
    <div style="background:#EEEDFE;border-radius:10px;padding:14px 16px;margin-bottom:20px;font-size:13px;color:#3C3489;">
      <strong>Text visit:</strong> Your provider will send you a text message at your scheduled time via their secure messaging platform. That text message will come directly to your cell phone at the scheduled time.
    </div>` : isIVFluids ? `
    <div style="background:#E1F5EE;border-radius:10px;padding:14px 16px;margin-bottom:20px;font-size:13px;color:#085041;">
      <strong>IV fluids request received:</strong> One of our physicians or nurse practitioners will be reaching out to you shortly to arrange for a brief video telemedicine screening to determine that IV fluids are medically safe for your child in this scenario, and to determine the kind and volume of fluids that the nurse will administer. Once that video consult is completed, your nurse will reach back out to you to confirm her arrival time at your home.
    </div>` : `
    <div style="background:#E1F5EE;border-radius:10px;padding:14px 16px;margin-bottom:20px;font-size:13px;color:#085041;">
      <strong>In-home visit:</strong> Your provider will arrive within 15 minutes of your scheduled time. Please be available at your address.
    </div>`}

    ${!isVirtual ? `
    <div style="background:#FAEEDA;border-radius:10px;padding:14px 16px;margin-bottom:24px;font-size:12px;color:#633806;">
      <strong>Cancellation policy:</strong> Cancellations within 2 hours of an in-person visit are subject to a $75 fee. To cancel, log in to your account at <a href="${PORTAL_URL}/family/dashboard" style="color:#633806;">${PORTAL_URL}</a>.
    </div>` : ''}

    <a href="${PORTAL_URL}/family/dashboard" style="display:inline-block;background:#1A1A2E;color:#fff;text-decoration:none;padding:12px 24px;border-radius:10px;font-size:14px;font-weight:500;">View my appointments</a>
  </td></tr>

  <!-- Footer -->
  <tr><td style="padding:20px 32px;border-top:1px solid #E8E8E4;font-size:11px;color:#999;text-align:center;">
    Booking reference: <strong style="font-family:monospace;">${data.ref}</strong><br><br>
    Questions? Reply to this email or call/text us directly.
  </td></tr>

</table>
</td></tr></table>
</body></html>`
}

function providerNotificationEmail(data: {
  visitType: string, date: string, time: string,
  zone: string, ref: string, providerName: string,
}) {
  const firstName = data.providerName.split(' ').slice(-2)[0]
  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#FAFAF8;font-family:'DM Sans',system-ui,sans-serif;color:#1A1A2E;">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px;">
<table width="100%" style="max-width:520px;background:#fff;border-radius:16px;border:1px solid #E8E8E4;overflow:hidden;">

  <tr><td style="background:#1A1A2E;padding:28px 32px;">
    <div style="font-size:20px;font-weight:600;color:#fff;letter-spacing:-0.3px;">${logo('#7F77DD')}</div>
    <div style="font-size:12px;color:rgba(255,255,255,0.4);margin-top:4px;text-transform:uppercase;letter-spacing:0.06em;">New appointment</div>
  </td></tr>

  <tr><td style="padding:32px;">
    <p style="font-size:15px;margin:0 0 20px;line-height:1.6;">Hi ${firstName},<br><br>
    A new appointment has been added to your schedule.</p>

    <table width="100%" style="background:#FAFAF8;border-radius:12px;border:1px solid #E8E8E4;margin-bottom:24px;">
      <tr><td style="padding:20px;">
        <div style="font-size:18px;font-weight:600;margin-bottom:16px;">${data.visitType}</div>
        ${row('📅', 'Date', data.date)}
        ${row('🕐', 'Time', data.time)}
        ${row('📍', 'Zone', data.zone)}
      </td></tr>
    </table>

    <div style="background:#EEEDFE;border-radius:10px;padding:14px 16px;margin-bottom:24px;font-size:13px;color:#3C3489;">
      Patient details are available in your Charm Health portal. Log in to the provider portal to view and manage this appointment.
    </div>

    <a href="${PORTAL_URL}/today" style="display:inline-block;background:#7F77DD;color:#fff;text-decoration:none;padding:12px 24px;border-radius:10px;font-size:14px;font-weight:500;">View my schedule</a>
  </td></tr>

  <tr><td style="padding:20px 32px;border-top:1px solid #E8E8E4;font-size:11px;color:#999;text-align:center;">
    Booking reference: <strong style="font-family:monospace;">${data.ref}</strong>
  </td></tr>

</table>
</td></tr></table>
</body></html>`
}

function postVisitEmail(data: {
  displayName: string | null
  childName: string | null
  providerName: string
  dateFormatted: string
  instructions: string | null
}) {
  const greeting = data.displayName ? `Hi ${data.displayName.split(' ')[0]},` : 'Hi there,'
  const childPhrase = data.childName ? `${data.childName}'s` : "your child's"

  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#FAFAF8;font-family:'DM Sans',system-ui,sans-serif;color:#1A1A2E;">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px;">
<table width="100%" style="max-width:520px;background:#fff;border-radius:16px;border:1px solid #E8E8E4;overflow:hidden;">

  <!-- Header -->
  <tr><td style="background:#1A1A2E;padding:28px 32px;">
    <div style="font-size:20px;font-weight:600;color:#fff;letter-spacing:-0.3px;">${logo('#1D9E75')}</div>
    <div style="font-size:12px;color:rgba(255,255,255,0.4);margin-top:4px;text-transform:uppercase;letter-spacing:0.06em;">Thank you for your visit</div>
  </td></tr>

  <!-- Body -->
  <tr><td style="padding:32px;">
    <p style="font-size:15px;margin:0 0 20px;line-height:1.65;">${greeting}<br><br>
    Thank you so much for trusting ${PRACTICE_NAME} with ${childPhrase} care${data.dateFormatted ? ` on ${data.dateFormatted}` : ' today'}. It is truly our honor to be there for your family right in the comfort of your own home.</p>

    ${data.instructions ? `
    <!-- After-visit instructions -->
    <div style="background:#F0FAF6;border:1px solid #9FDECA;border-radius:10px;padding:18px 20px;margin-bottom:24px;">
      <div style="font-size:11px;font-weight:600;color:#0F6E56;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:8px;">After-visit instructions from ${data.providerName}</div>
      <p style="font-size:15px;margin:0;line-height:1.65;color:#1A1A2E;white-space:pre-wrap;">${data.instructions}</p>
    </div>` : ''}

    <p style="font-size:15px;margin:0 0 24px;line-height:1.65;">If you have a moment, we would be so grateful if you could share your experience with a Google review. It helps other families in your community find us — and it means the world to our team.</p>

    <!-- Review button -->
    <table width="100%" style="margin-bottom:28px;">
      <tr><td>
        <a href="${GOOGLE_REVIEW_URL}" style="display:inline-block;background:#F9AB00;color:#1A1A2E;text-decoration:none;padding:14px 28px;border-radius:10px;font-size:15px;font-weight:600;">
          ⭐&nbsp; Leave a Google Review
        </a>
      </td></tr>
    </table>

    <p style="font-size:13px;color:#888;margin:0;line-height:1.6;">With gratitude,<br><strong style="color:#1A1A2E;">The ${PRACTICE_NAME} Team</strong></p>
  </td></tr>

  <!-- Footer -->
  <tr><td style="padding:16px 32px;border-top:1px solid #E8E8E4;font-size:11px;color:#bbb;text-align:center;">
    Questions? Reply to this email or log in at <a href="${PORTAL_URL}/family/dashboard" style="color:#bbb;">${PORTAL_URL}</a>
  </td></tr>

</table>
</td></tr></table>
</body></html>`
}

function cancellationNotificationEmail(data: {
  recipientName: string
  visitType: string
  date: string
  time: string
  zone: string
  familyName: string
}) {
  const firstName = data.recipientName.split(' ').slice(-2)[0]
  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#FAFAF8;font-family:'DM Sans',system-ui,sans-serif;color:#1A1A2E;">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px;">
<table width="100%" style="max-width:520px;background:#fff;border-radius:16px;border:1px solid #E8E8E4;overflow:hidden;">
  <tr><td style="background:#1A1A2E;padding:28px 32px;">
    <div style="font-size:20px;font-weight:600;color:#fff;letter-spacing:-0.3px;">${logo('#7F77DD')}</div>
    <div style="font-size:12px;color:rgba(255,255,255,0.4);margin-top:4px;text-transform:uppercase;letter-spacing:0.06em;">Appointment cancelled</div>
  </td></tr>
  <tr><td style="padding:32px;">
    <p style="font-size:15px;margin:0 0 20px;line-height:1.6;">Hi ${firstName},<br><br>
    <strong>${data.familyName}</strong> has cancelled their upcoming appointment.</p>
    <table width="100%" style="background:#FAFAF8;border-radius:12px;border:1px solid #E8E8E4;margin-bottom:24px;">
      <tr><td style="padding:20px;">
        <div style="font-size:18px;font-weight:600;margin-bottom:16px;">${data.visitType}</div>
        ${row('📅', 'Date', data.date)}
        ${row('🕐', 'Time', data.time)}
        ${data.zone ? row('📍', 'Zone', data.zone) : ''}
        ${row('👤', 'Family', data.familyName)}
      </td></tr>
    </table>
    <div style="background:#FBEAF0;border-radius:10px;padding:14px 16px;font-size:13px;color:#993556;">
      This time slot is now open. No action is needed — this is for your records.
    </div>
  </td></tr>
</table>
</td></tr></table>
</body></html>`
}

function appointmentCancelledByProviderEmail(data: {
  displayName: string | null
  visitType: string
  date: string
  time: string
  zone: string
}) {
  const greeting = data.displayName ? `Hi ${data.displayName.split(' ')[0]},` : 'Hi,'
  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#FAFAF8;font-family:'DM Sans',system-ui,sans-serif;color:#1A1A2E;">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px;">
<table width="100%" style="max-width:520px;background:#fff;border-radius:16px;border:1px solid #E8E8E4;overflow:hidden;">
  <tr><td style="background:#1A1A2E;padding:28px 32px;">
    <div style="font-size:20px;font-weight:600;color:#fff;letter-spacing:-0.3px;">${logo('#7F77DD')}</div>
    <div style="font-size:12px;color:rgba(255,255,255,0.4);margin-top:4px;text-transform:uppercase;letter-spacing:0.06em;">Appointment cancelled</div>
  </td></tr>
  <tr><td style="padding:32px;">
    <p style="font-size:15px;margin:0 0 20px;line-height:1.6;">${greeting}<br><br>
    We're sorry — your upcoming appointment has been cancelled by your provider. Please contact us to reschedule.</p>
    <table width="100%" style="background:#FAFAF8;border-radius:12px;border:1px solid #E8E8E4;margin-bottom:24px;">
      <tr><td style="padding:20px;">
        <div style="font-size:18px;font-weight:600;margin-bottom:16px;">${data.visitType}</div>
        ${row('📅', 'Date', data.date)}
        ${row('🕐', 'Time', data.time)}
        ${data.zone ? row('📍', 'Zone', data.zone) : ''}
      </td></tr>
    </table>
    <div style="background:#FBEAF0;border-radius:10px;padding:14px 16px;font-size:13px;color:#993556;">
      To reschedule, please visit <a href="${PORTAL_URL}/family/book" style="color:#993556;">${PORTAL_URL}</a> or reply to this email.
    </div>
  </td></tr>
</table>
</td></tr></table>
</body></html>`
}

function cprConfirmationEmail(data: {
  displayName: string | null
  visitType: string
  date: string
  time: string
  address: string
  participantCount: number
  participantNames: string
  ref: string
}) {
  const greeting = data.displayName ? `Hi ${data.displayName.split(' ')[0]},` : 'Hi there,'
  const totalCost = data.participantCount * 80

  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#FAFAF8;font-family:'DM Sans',system-ui,sans-serif;color:#1A1A2E;">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px;">
<table width="100%" style="max-width:560px;background:#fff;border-radius:16px;border:1px solid #E8E8E4;overflow:hidden;">

  <!-- Header -->
  <tr><td style="background:#1A1A2E;padding:28px 32px;">
    <div style="font-size:20px;font-weight:600;color:#fff;letter-spacing:-0.3px;">${logo('#E74C3C')}</div>
    <div style="font-size:12px;color:rgba(255,255,255,0.4);margin-top:4px;text-transform:uppercase;letter-spacing:0.06em;">CPR class confirmed</div>
  </td></tr>

  <!-- Body -->
  <tr><td style="padding:32px;">
    <p style="font-size:15px;margin:0 0 8px;line-height:1.7;">${greeting}</p>
    <p style="font-size:15px;margin:0 0 20px;line-height:1.7;">Thank you for registering for an in-home CPR class.</p>
    <p style="font-size:15px;margin:0 0 20px;line-height:1.7;">The first part of the class is an online portion done at your own pace. The second portion is an in-home skills class where you can practice the skills. Prior to us meeting please complete the online portion. Please let me know if you have any difficulties accessing it.</p>

    <!-- Appointment details -->
    <table width="100%" style="background:#FAFAF8;border-radius:12px;border:1px solid #E8E8E4;margin-bottom:28px;">
      <tr><td style="padding:20px;">
        ${row('📅', 'Date', data.date)}
        ${row('🕐', 'Time', data.time)}
        ${row('👩‍🏫', 'Instructor', 'Melissa Jesse')}
        ${row('📍', 'Address', data.address)}
        ${row('👥', 'Participants', `${data.participantCount} person${data.participantCount > 1 ? 's' : ''}`)}
        ${data.participantNames ? row('📋', 'Attendees', data.participantNames) : ''}
      </td></tr>
    </table>

    <!-- Online portion intro -->
    <p style="font-size:15px;margin:0 0 20px;line-height:1.7;">There are 2 options for the online portion. Both links and descriptions are below. You can complete the one that best meets your needs. In the in-home skills portion we will practice all skills and can focus on what you would like to.</p>

    <!-- Course 1: Heartsaver Pediatric -->
    <div style="border:1px solid #E8E8E4;border-radius:12px;overflow:hidden;margin-bottom:16px;">
      <div style="background:#FDEDEC;padding:16px 20px;border-bottom:1px solid #F5B7B1;">
        <div style="font-size:15px;font-weight:700;color:#922B21;margin-bottom:2px;">Heartsaver® Pediatric First Aid CPR AED Online</div>
        <a href="https://shopcpr.heart.org/heartsaver-pediatric-first-aid-cpr-aed-online" style="font-size:12px;color:#922B21;opacity:0.7;">shopcpr.heart.org</a>
      </div>
      <div style="padding:16px 20px;">
        <ul style="margin:0;padding-left:18px;font-size:13px;line-height:1.9;color:#333;">
          <li>Child and Infant CPR and AED use</li>
          <li>Pediatric first aid basics</li>
          <li>Pediatric medical emergencies (including choking)</li>
          <li>Pediatric injury emergencies</li>
          <li>Environmental emergencies</li>
          <li>Preventing illness and injury</li>
          <li>Opioid-associated life-threatening emergencies and how to use Naloxone</li>
          <li>Optional modules in Adult CPR AED</li>
        </ul>
        <a href="https://shopcpr.heart.org/heartsaver-pediatric-first-aid-cpr-aed-online" style="display:inline-block;margin-top:14px;background:#E74C3C;color:#fff;text-decoration:none;padding:10px 20px;border-radius:8px;font-size:13px;font-weight:600;">Start Heartsaver Pediatric →</a>
      </div>
    </div>

    <!-- Course 2: Heartsaver Total -->
    <div style="border:1px solid #E8E8E4;border-radius:12px;overflow:hidden;margin-bottom:28px;">
      <div style="background:#FDEDEC;padding:16px 20px;border-bottom:1px solid #F5B7B1;">
        <div style="font-size:15px;font-weight:700;color:#922B21;margin-bottom:2px;">Heartsaver® Total — First Aid CPR AED Online</div>
        <a href="https://shopcpr.heart.org/heartsaver-first-aid-cpr-aed-online" style="font-size:12px;color:#922B21;opacity:0.7;">shopcpr.heart.org</a>
      </div>
      <div style="padding:16px 20px;">
        <ul style="margin:0;padding-left:18px;font-size:13px;line-height:1.9;color:#333;">
          <li>Adult CPR and AED use</li>
          <li>First aid basics</li>
          <li>Medical emergencies (including choking)</li>
          <li>Injury emergencies</li>
          <li>Environmental emergencies</li>
          <li>Preventing illness and injury</li>
          <li>Opioid-associated life-threatening emergencies and how to use Naloxone</li>
          <li>Recognizing the signs of mental health crisis in the workplace</li>
          <li>Optional modules in Child CPR AED and Infant CPR AED</li>
        </ul>
        <a href="https://shopcpr.heart.org/heartsaver-first-aid-cpr-aed-online" style="display:inline-block;margin-top:14px;background:#E74C3C;color:#fff;text-decoration:none;padding:10px 20px;border-radius:8px;font-size:13px;font-weight:600;">Start Heartsaver Total →</a>
      </div>
    </div>

    <!-- Payment -->
    <div style="background:#E8F8F5;border-radius:12px;border:1px solid #A9DFBF;padding:18px 20px;margin-bottom:28px;">
      <div style="font-size:14px;font-weight:600;color:#1E8449;margin-bottom:8px;">💳 Payment</div>
      <p style="font-size:13px;color:#1E8449;margin:0;line-height:1.55;">
        Please send <strong>$${totalCost}</strong> ($80 × ${data.participantCount} person${data.participantCount > 1 ? 's' : ''}) via Venmo to <strong>${VENMO_HANDLE}</strong> before your class.
      </p>
    </div>

    <!-- Sign-off -->
    <p style="font-size:15px;margin:0 0 4px;line-height:1.7;">Thank you,</p>
    <p style="font-size:15px;font-weight:600;margin:0 0 2px;">Melissa Jesse</p>
    <p style="font-size:13px;color:#666;margin:0 0 24px;line-height:1.6;">Pediatric Nurse Practitioner and Certified BLS and Heartsaver CPR Instructor</p>

    <p style="font-size:13px;color:#888;margin:0;line-height:1.6;">Questions? Reach Melissa directly at <a href="mailto:deeringmel@me.com" style="color:#555;">deeringmel@me.com</a></p>
  </td></tr>

  <!-- Footer -->
  <tr><td style="padding:20px 32px;border-top:1px solid #E8E8E4;font-size:11px;color:#999;text-align:center;">
    Booking reference: <strong style="font-family:monospace;">${data.ref}</strong>
  </td></tr>

</table>
</td></tr></table>
</body></html>`
}

function cprMelissaEmail(data: {
  visitType: string
  date: string
  time: string
  address: string
  participantCount: number
  participantNames: string
  familyName: string
  familyEmail: string
  ref: string
}) {
  const totalCost = data.participantCount * 80
  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#FAFAF8;font-family:'DM Sans',system-ui,sans-serif;color:#1A1A2E;">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px;">
<table width="100%" style="max-width:520px;background:#fff;border-radius:16px;border:1px solid #E8E8E4;overflow:hidden;">
  <tr><td style="background:#1A1A2E;padding:28px 32px;">
    <div style="font-size:20px;font-weight:600;color:#fff;">${logo('#E74C3C')}</div>
    <div style="font-size:12px;color:rgba(255,255,255,0.4);margin-top:4px;text-transform:uppercase;letter-spacing:0.06em;">New CPR class booked</div>
  </td></tr>
  <tr><td style="padding:32px;">
    <p style="font-size:15px;margin:0 0 20px;line-height:1.6;">Hi Melissa,<br><br>
    A new ${data.visitType} has been booked!</p>
    <table width="100%" style="background:#FAFAF8;border-radius:12px;border:1px solid #E8E8E4;margin-bottom:24px;">
      <tr><td style="padding:20px;">
        ${row('📅', 'Date', data.date)}
        ${row('🕐', 'Time', data.time)}
        ${row('📍', 'Address', data.address)}
        ${row('👥', 'Participants', `${data.participantCount} person${data.participantCount > 1 ? 's' : ''} · $${totalCost} total`)}
        ${data.participantNames ? row('📋', 'Attendee names', data.participantNames) : ''}
        ${row('👤', 'Booked by', `${data.familyName} (${data.familyEmail})`)}
      </td></tr>
    </table>
    <div style="background:#FDEDEC;border-radius:10px;padding:14px 16px;font-size:13px;color:#922B21;">
      Reminder: Arrive <strong>30 minutes early</strong> to set up. The family has been instructed to send attendee names to your email.
    </div>
  </td></tr>
  <tr><td style="padding:20px 32px;border-top:1px solid #E8E8E4;font-size:11px;color:#999;text-align:center;">
    Booking reference: <strong style="font-family:monospace;">${data.ref}</strong>
  </td></tr>
</table>
</td></tr></table>
</body></html>`
}

function pickupNotificationEmail(data: { recipientName: string; acceptedBy: string; description: string }) {
  const firstName = data.recipientName.split(' ').slice(-2)[0]
  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#FAFAF8;font-family:'DM Sans',system-ui,sans-serif;color:#1A1A2E;">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px;">
<table width="100%" style="max-width:520px;background:#fff;border-radius:16px;border:1px solid #E8E8E4;overflow:hidden;">
<tr><td style="background:#1A1A2E;padding:28px 32px;">
  <div style="font-size:20px;font-weight:600;color:#fff;">${logo('#1D9E75')}</div>
  <div style="font-size:12px;color:rgba(255,255,255,0.4);margin-top:4px;text-transform:uppercase;letter-spacing:0.06em;">Patient picked up</div>
</td></tr>
<tr><td style="padding:32px;">
  <p style="font-size:15px;margin:0 0 20px;line-height:1.6;">Hi ${firstName},<br><br>
  <strong>${data.acceptedBy}</strong> has picked up ${data.description}.</p>
  <div style="background:#E1F5EE;border-radius:10px;padding:14px 16px;font-size:13px;color:#085041;">
    This request is now covered — no action needed from you.
  </div>
</td></tr>
</table>
</td></tr></table>
</body></html>`
}

function ivFluidsEmailHtml(): string {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#FAFAF8;font-family:'DM Sans',system-ui,sans-serif;color:#1A1A2E;">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px;">
<table width="100%" style="max-width:520px;background:#fff;border-radius:16px;border:1px solid #E8E8E4;overflow:hidden;">
<tr><td style="background:#1A1A2E;padding:28px 32px;">
  <div style="font-size:20px;font-weight:600;color:#fff;">${logo('#1D9E75')}</div>
  <div style="font-size:12px;color:rgba(255,255,255,0.4);margin-top:4px;text-transform:uppercase;letter-spacing:0.06em;">IV fluids request received</div>
</td></tr>
<tr><td style="padding:32px;">
  <p style="font-size:15px;margin:0 0 16px;line-height:1.6;">Your request for in-home IV fluids has been received.</p>
  <p style="font-size:14px;margin:0 0 16px;line-height:1.7;color:#444;">One of our physicians or nurse practitioners will review the request and will schedule to consult with you via video telemedicine visit shortly. You will receive another email with the link to log into the ${PRACTICE_NAME} virtual visit room.</p>
  <p style="font-size:14px;margin:0;line-height:1.7;color:#444;">Once you've had a chance to meet with the physician or nurse practitioner via video and they confirm and agree that IV fluids are medically appropriate and indicated, the IV fluids nurse will reach out to you to let you know what time she will be arriving at your home to administer the IV fluids.</p>
</td></tr>
</table></td></tr></table></body></html>`
}

function waitlistProviderEmail(data: {
  zip: string, state: string | null, visitType: string | null,
  preferredTime: string | null, providerName: string,
}) {
  const firstName = data.providerName.split(' ').slice(-2)[0]
  const stateLabel = data.state === 'NC' ? 'North Carolina' : data.state === 'SC' ? 'South Carolina' : data.state === 'VA' ? 'Virginia' : data.state || 'your state'
  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#FAFAF8;font-family:'DM Sans',system-ui,sans-serif;color:#1A1A2E;">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px;">
<table width="100%" style="max-width:520px;background:#fff;border-radius:16px;border:1px solid #E8E8E4;overflow:hidden;">
  <tr><td style="background:#1A1A2E;padding:28px 32px;">
    <div style="font-size:20px;font-weight:600;color:#fff;">${logo('#EF9F27')}</div>
    <div style="font-size:12px;color:rgba(255,255,255,0.4);margin-top:4px;text-transform:uppercase;letter-spacing:0.06em;">New waitlist entry — ${stateLabel}</div>
  </td></tr>
  <tr><td style="padding:32px;">
    <p style="font-size:15px;margin:0 0 20px;line-height:1.6;">Hi ${firstName},<br><br>
    A family in <strong>${stateLabel}</strong> has joined the waitlist. They're located in zip code <strong>${data.zip}</strong> — an area we don't currently serve.</p>
    <table width="100%" style="background:#FAFAF8;border-radius:12px;border:1px solid #E8E8E4;margin-bottom:24px;">
      <tr><td style="padding:20px;">
        ${data.visitType ? `<div style="margin-bottom:10px;"><span style="font-size:12px;color:#999;text-transform:uppercase;">Visit type</span><br><span style="font-size:14px;font-weight:500;">${data.visitType}</span></div>` : ''}
        ${data.preferredTime ? `<div><span style="font-size:12px;color:#999;text-transform:uppercase;">Preferred time</span><br><span style="font-size:14px;font-weight:500;">${data.preferredTime}</span></div>` : ''}
      </td></tr>
    </table>
    <div style="background:#FAEEDA;border-radius:10px;padding:14px 16px;margin-bottom:24px;font-size:13px;color:#633806;">
      If you're able to accommodate this family, view the waitlist in the admin portal to reach out.
    </div>
    <a href="${PORTAL_URL}/admin/waitlist" style="display:inline-block;background:#EF9F27;color:#fff;text-decoration:none;padding:12px 24px;border-radius:10px;font-size:14px;font-weight:500;">View waitlist</a>
  </td></tr>
  <tr><td style="padding:20px 32px;border-top:1px solid #E8E8E4;font-size:11px;color:#999;text-align:center;">
    Zip code: ${data.zip} · ${stateLabel}
  </td></tr>
</table>
</td></tr></table>
</body></html>`
}

// ── Shared booking notification rule ─────────────────────────────────────────
// All booking types (family self-book, admin book, provider waitlist accept)
// call this one function. Change the rule here and it applies everywhere.

async function notifyBookingParties(
  sql: any,
  {
    familyEmail, familyPhone,
    provider,
    practiceId,
    familySubject, familyHtml, familySms,
    providerSubject, providerHtml, providerSms,
    adminSms,
    excludeAdminIds = [],
  }: {
    familyEmail?: string | null
    familyPhone?: string | null
    provider?: { id?: string; email?: string | null; phone?: string | null } | null
    practiceId?: string
    familySubject?: string; familyHtml?: string; familySms?: string
    providerSubject?: string; providerHtml?: string; providerSms?: string
    adminSms: string
    excludeAdminIds?: string[]
  }
) {
  // 1. Family confirmation
  if (familyEmail && familySubject && familyHtml)
    await sendEmail(familyEmail, familySubject, familyHtml).catch(e => console.error('Booking family email failed:', e))
  if (familyPhone && familySms)
    await sendSMS(familyPhone, familySms).catch(e => console.error('Booking family SMS failed:', e))

  // 2. Assigned provider (omitted when provider initiated the booking, e.g. waitlist acceptance)
  if (provider?.email && providerSubject && providerHtml)
    await sendEmail(provider.email, providerSubject, providerHtml).catch(e => console.error('Booking provider email failed:', e))
  if (provider?.phone && providerSms)
    await sendSMS(provider.phone, providerSms).catch(e => console.error('Booking provider SMS failed:', e))

  // 3. All admins — deduped against assigned provider and any additionally excluded IDs
  const skipIds = new Set([...(provider?.id ? [provider.id] : []), ...excludeAdminIds])
  const admins = practiceId
    ? await sql`SELECT id, phone, email FROM providers WHERE is_admin = true AND practice_id = ${practiceId}::uuid`
    : await sql`SELECT id, phone, email FROM providers WHERE is_admin = true`
  for (const admin of admins) {
    if (skipIds.has(admin.id)) continue
    if (admin.email) await sendEmail(admin.email, `[${PRACTICE_NAME} Admin] ${adminSms}`, `<p style="font-family:sans-serif;font-size:14px;color:#1A1A2E;">${adminSms}</p>`).catch(e => console.error('Booking admin email failed:', e))
    if (admin.phone) await sendSMS(admin.phone, adminSms).catch(e => console.error('Booking admin SMS failed:', e))
  }
}

// ── Admin helpers ─────────────────────────────────────────────────────────────

async function notifyAdmins(sql: any, smsBody: string, practiceId?: string) {
  const admins = practiceId
    ? await sql`SELECT id, phone, email FROM providers WHERE is_admin = true AND practice_id = ${practiceId}::uuid`
    : await sql`SELECT id, phone, email FROM providers WHERE is_admin = true`
  for (const admin of admins) {
    if (admin.email) await sendEmail(admin.email, `[${PRACTICE_NAME} Admin] ` + smsBody, `<p style="font-family:sans-serif;font-size:14px;color:#1A1A2E;">${smsBody}</p>`).catch(e => console.error('Admin email failed:', e))
    if (admin.phone) await sendSMS(admin.phone, smsBody).catch(e => console.error('Admin SMS failed:', e))
  }
}

async function notifyAllProviders(
  sql: any,
  smsBody: string,
  emailSubject: string,
  makeHtml: (providerName: string) => string,
  excludeId?: string | null,
  practiceId?: string,
) {
  const providers = practiceId
    ? await sql`SELECT id, name, phone, email FROM providers WHERE (is_active = true OR role = 'admin') AND practice_id = ${practiceId}::uuid`
    : await sql`SELECT id, name, phone, email FROM providers WHERE is_active = true OR role = 'admin'`
  for (const prov of providers) {
    if (excludeId && prov.id === excludeId) continue
    if (prov.email) await sendEmail(prov.email, emailSubject, makeHtml(prov.name)).catch(e => console.error('notifyAllProviders email failed:', e))
    if (prov.phone) await sendSMS(prov.phone, smsBody).catch(e => console.error('notifyAllProviders SMS failed:', e))
  }
}

// ── Main handler ──────────────────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const sql = neon(process.env.DATABASE_URL!)

  try {
    const body = req.body

    // ── Waitlist notification ──────────────────────────────────────────────────
    if (body.type === 'waitlist') {
      console.error('[notifications] waitlist triggered, entryId:', body.waitlistEntryId)
      const [entry] = await sql`SELECT * FROM waitlist_entries WHERE id = ${body.waitlistEntryId}::uuid`
      if (!entry) throw new Error('Waitlist entry not found')
      console.error('[notifications] entry found, state:', entry.state, 'zip:', entry.zip)

      const stateLabel = entry.state === 'NC' ? 'North Carolina' : entry.state === 'SC' ? 'South Carolina' : entry.state === 'VA' ? 'Virginia' : entry.state || 'your state'
      const providerSmsBody = `${PRACTICE_NAME}: New waitlist entry. View: ${PORTAL_URL}/waitlist`

      // Notify providers licensed in the patient's state
      const stateProviders = await sql`SELECT id, name, role, phone, email, states FROM providers WHERE role != 'admin' AND is_active = true`
      console.error('[notifications] active providers found:', stateProviders.length)
      for (const prov of stateProviders) {
        const provStates: string[] = (prov.states ?? []) as string[]
        const stateFiltered = ['MD', 'PNP'].includes(prov.role)
        if (stateFiltered && entry.state && provStates.length > 0 && !provStates.includes(entry.state)) continue
        console.error('[notifications] notifying provider:', prov.name, 'email:', !!prov.email, 'phone:', !!prov.phone)
        if (prov.email) {
          await sendEmail(
            prov.email,
            `[Waitlist] New family in ${stateLabel} — zip ${entry.zip}`,
            waitlistProviderEmail({
              zip: entry.zip,
              state: entry.state,
              visitType: entry.visit_type,
              preferredTime: entry.preferred_time_window,
              providerName: prov.name,
            })
          ).catch(err => console.error('[notifications] email failed for', prov.name, err))
        }
        if (prov.phone) await sendSMS(prov.phone, providerSmsBody).catch(err => console.error('[notifications] SMS failed for', prov.name, err))
      }

      const admins = await sql`SELECT id, phone, email FROM providers WHERE is_admin = true`
      console.error('[notifications] admins found:', admins.length)
      for (const admin of admins) {
        console.error('[notifications] notifying admin email:', !!admin.email, 'phone:', !!admin.phone)
        if (admin.email) await sendEmail(admin.email, `[Admin Waitlist] New entry — zip ${entry.zip}, ${stateLabel}`, waitlistProviderEmail({ zip: entry.zip, state: entry.state, visitType: entry.visit_type, preferredTime: entry.preferred_time_window, providerName: 'Admin' })).catch(err => console.error('[notifications] admin email failed', err))
        if (admin.phone) await sendSMS(admin.phone, `${PRACTICE_NAME}: New waitlist entry. View: ${PORTAL_URL}/admin/waitlist`).catch(err => console.error('[notifications] admin SMS failed', err))
      }

      // Confirm to the family that they've been added
      if (entry.family_id) {
        const [family] = await sql`SELECT email, phone, display_name FROM family_profiles WHERE id = ${entry.family_id}::uuid`
        const greeting = family?.display_name ? `Hi ${family.display_name.split(' ')[0]},` : 'Hi there,'
        const familyHtml = `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#FAFAF8;font-family:'DM Sans',system-ui,sans-serif;color:#1A1A2E;">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px;">
<table width="100%" style="max-width:520px;background:#fff;border-radius:16px;border:1px solid #E8E8E4;overflow:hidden;">
<tr><td style="background:#1A1A2E;padding:28px 32px;">
  <div style="font-size:20px;font-weight:600;color:#fff;">${logo('#EF9F27')}</div>
  <div style="font-size:12px;color:rgba(255,255,255,0.4);margin-top:4px;text-transform:uppercase;letter-spacing:0.06em;">You're on the waitlist</div>
</td></tr>
<tr><td style="padding:32px;">
  <p style="font-size:15px;margin:0 0 16px;line-height:1.6;">${greeting}<br><br>
  You've been added to the ${PRACTICE_NAME} waitlist. We'll notify you as soon as a provider in ${stateLabel} is available to see your child.</p>
  <div style="background:#FAFAF8;border-radius:12px;border:1px solid #E8E8E4;padding:16px 20px;margin-bottom:24px;">
    ${entry.visit_type ? `<div style="margin-bottom:8px;"><span style="font-size:11px;color:#999;text-transform:uppercase;">Visit type</span><br><span style="font-size:14px;font-weight:500;">${entry.visit_type}</span></div>` : ''}
    ${entry.preferred_time_window ? `<div><span style="font-size:11px;color:#999;text-transform:uppercase;">Preferred time</span><br><span style="font-size:14px;font-weight:500;">${entry.preferred_time_window}</span></div>` : ''}
  </div>
  <div style="background:#FAEEDA;border-radius:10px;padding:14px 16px;font-size:13px;color:#633806;">
    You'll receive a text and email the moment a provider picks up your request. No action is needed from you in the meantime.
  </div>
</td></tr>
</table></td></tr></table></body></html>`
        if (family?.email) await sendEmail(family.email, `You're on the ${PRACTICE_NAME} waitlist`, familyHtml).catch(e => console.error('Waitlist family confirmation email failed:', e))
        if (family?.phone) await sendSMS(family.phone, `${PRACTICE_NAME}: You've been added to the waitlist. We'll text you as soon as a provider is available. Questions? Log in at ${PORTAL_URL}/family/dashboard`).catch(e => console.error('Waitlist family confirmation SMS failed:', e))
      }

      return res.json({ ok: true })
    }

    // ── Waitlist accepted notification ────────────────────────────────────────
    if (body.type === 'waitlist_accepted') {
      const [entry] = await sql`SELECT * FROM waitlist_entries WHERE id = ${body.waitlistEntryId}::uuid`
      if (!entry) throw new Error('Entry not found')

      const [family] = await sql`SELECT email, display_name, phone FROM family_profiles WHERE id = ${entry.family_id}::uuid`

      const greeting = family?.display_name ? `Hi ${family.display_name.split(' ')[0]},` : 'Hi there,'
      const dateFormatted = new Date(body.date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })

      const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#FAFAF8;font-family:'DM Sans',system-ui,sans-serif;color:#1A1A2E;">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px;">
<table width="100%" style="max-width:520px;background:#fff;border-radius:16px;border:1px solid #E8E8E4;overflow:hidden;">
<tr><td style="background:#1A1A2E;padding:28px 32px;">
  <div style="font-size:20px;font-weight:600;color:#fff;">${logo('#1D9E75')}</div>
  <div style="font-size:12px;color:rgba(255,255,255,0.4);margin-top:4px;text-transform:uppercase;letter-spacing:0.06em;">Good news — a provider has accepted your request</div>
</td></tr>
<tr><td style="padding:32px;">
  <p style="font-size:15px;margin:0 0 20px;line-height:1.6;">${greeting}<br><br>
  A ${PRACTICE_NAME} provider has accepted your waitlist request and scheduled an appointment for you!</p>
  <table width="100%" style="background:#FAFAF8;border-radius:12px;border:1px solid #E8E8E4;margin-bottom:24px;"><tr><td style="padding:20px;">
    <div style="margin-bottom:10px;"><span style="font-size:12px;color:#999;text-transform:uppercase;">Provider</span><br><span style="font-size:14px;font-weight:500;">${body.providerName}</span></div>
    <div style="margin-bottom:10px;"><span style="font-size:12px;color:#999;text-transform:uppercase;">Date</span><br><span style="font-size:14px;font-weight:500;">${dateFormatted}</span></div>
    <div><span style="font-size:12px;color:#999;text-transform:uppercase;">Time</span><br><span style="font-size:14px;font-weight:500;">${body.time}</span></div>
  </td></tr></table>
  <div style="background:#E1F5EE;border-radius:10px;padding:14px 16px;margin-bottom:24px;font-size:13px;color:#085041;">
    Your provider will be in touch before the visit to confirm details and collect any additional information needed.
  </div>
  <a href="${PORTAL_URL}/family/dashboard" style="display:inline-block;background:#1D9E75;color:#fff;text-decoration:none;padding:12px 24px;border-radius:10px;font-size:14px;font-weight:500;">View my appointments</a>
</td></tr>
</table></td></tr></table></body></html>`

      const waitlistPracticeId: string | undefined = entry.practice_id ?? undefined
      // Provider is null here — they initiated the acceptance themselves, no need to notify them
      await notifyBookingParties(sql, {
        familyEmail: family?.email,
        familyPhone: family?.phone,
        provider: null,
        practiceId: waitlistPracticeId,
        familySubject: `Your appointment is confirmed — ${dateFormatted} at ${body.time}`,
        familyHtml: html,
        familySms: `${PRACTICE_NAME}: ${body.providerName} has accepted your waitlist request and will see your child on ${dateFormatted} at ${body.time}. Log in for details: ${PORTAL_URL}/family/dashboard`,
        adminSms: `${PRACTICE_NAME}: Waitlist patient booked. View: ${PORTAL_URL}/admin/waitlist`,
      })

      const pickupDesc = `a waitlist patient (zip ${entry.zip}${entry.state ? `, ${entry.state}` : ''})`
      const pickupSms = `${PRACTICE_NAME}: A waitlist patient has been picked up. View: ${PORTAL_URL}/broadcasts`
      await notifyAllProviders(
        sql,
        pickupSms,
        `[Pickup] ${body.providerName} accepted a waitlist patient — zip ${entry.zip}`,
        (name) => pickupNotificationEmail({ recipientName: name, acceptedBy: body.providerName, description: pickupDesc }),
        body.providerId ?? null,
        waitlistPracticeId,
      )

      return res.json({ ok: true })
    }

    // ── Slot opened (appointment cancelled → notify waitlist families) ─────────
    if (body.type === 'slot_opened') {
      const { providerId, zone, visitType, date, time, matchingZips } = body
      let providerName: string = body.providerName || ''
      let slotPracticeId: string | null = null
      if (providerId) {
        const [prov] = await sql`SELECT name, practice_id FROM providers WHERE id = ${providerId}::uuid`
        if (!providerName) providerName = prov?.name || 'Your provider'
        slotPracticeId = prov?.practice_id ?? null
      }

      // If caller didn't supply matchingZips, look them up from the zone name
      let zipsToMatch: string[] = matchingZips ?? []
      if (!zipsToMatch.length && zone && slotPracticeId) {
        const [zoneRow] = await sql`SELECT zip_codes FROM practice_zones WHERE zone_name = ${zone} AND practice_id = ${slotPracticeId}::uuid LIMIT 1`
        zipsToMatch = zoneRow?.zip_codes ?? []
      }

      if (!zipsToMatch.length) {
        return res.json({ ok: true, notified: 0 })
      }

      const entries = slotPracticeId
        ? await sql`SELECT id, family_id, zip FROM waitlist_entries WHERE zip = ANY(${zipsToMatch}::text[]) AND status = 'waiting' AND practice_id = ${slotPracticeId}::uuid`
        : await sql`SELECT id, family_id, zip FROM waitlist_entries WHERE zip = ANY(${zipsToMatch}::text[]) AND status = 'waiting'`

      if (!entries?.length) {
        return res.json({ ok: true, notified: 0 })
      }

      const dateFormatted = formatDate(date)

      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()

      for (const entry of entries) {
        if (slotPracticeId) {
          await sql`INSERT INTO slot_offers (practice_id, waitlist_entry_id, provider_id, provider_name, visit_type, offered_date, offered_time, zone, status, expires_at)
            VALUES (${slotPracticeId}::uuid, ${entry.id}::uuid, ${providerId}::uuid, ${providerName}, ${visitType}, ${date}, ${time}, ${zone}, 'pending', ${expiresAt}::timestamptz)`
        } else {
          await sql`INSERT INTO slot_offers (waitlist_entry_id, provider_id, provider_name, visit_type, offered_date, offered_time, zone, status, expires_at)
            VALUES (${entry.id}::uuid, ${providerId}::uuid, ${providerName}, ${visitType}, ${date}, ${time}, ${zone}, 'pending', ${expiresAt}::timestamptz)`
        }

        const [fam] = await sql`SELECT email, display_name FROM family_profiles WHERE id = ${entry.family_id}::uuid`
        if (!fam?.email) continue

        const greeting = fam.display_name ? `Hi ${fam.display_name.split(' ')[0]},` : 'Hi there,'

        const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#FAFAF8;font-family:'DM Sans',system-ui,sans-serif;color:#1A1A2E;">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px;">
<table width="100%" style="max-width:520px;background:#fff;border-radius:16px;border:1px solid #E8E8E4;overflow:hidden;">
<tr><td style="background:#1A1A2E;padding:28px 32px;">
  <div style="font-size:20px;font-weight:600;color:#fff;">${logo('#1D9E75')}</div>
  <div style="font-size:12px;color:rgba(255,255,255,0.4);margin-top:4px;text-transform:uppercase;letter-spacing:0.06em;">A slot has opened up for you</div>
</td></tr>
<tr><td style="padding:32px;">
  <p style="font-size:15px;margin:0 0 20px;line-height:1.6;">${greeting}<br><br>
  Good news — a provider in your area has an opening and you're at the top of the waitlist!</p>
  <table width="100%" style="background:#FAFAF8;border-radius:12px;border:1px solid #E8E8E4;margin-bottom:24px;"><tr><td style="padding:20px;">
    <div style="font-size:18px;font-weight:600;margin-bottom:16px;">${visitType || 'In-home visit'}</div>
    ${row('👩‍⚕️', 'Provider', providerName)}
    ${row('📅', 'Date', dateFormatted)}
    ${row('🕐', 'Time', time)}
    ${row('📍', 'Area', zone || '')}
  </td></tr></table>
  <div style="background:#FAEEDA;border-radius:10px;padding:14px 16px;margin-bottom:24px;font-size:13px;color:#633806;">
    <strong>This offer expires in 24 hours.</strong> Log in to your portal to accept or decline. If you don't respond, the slot will be offered to the next family on the waitlist.
  </div>
  <a href="${PORTAL_URL}/family/dashboard" style="display:inline-block;background:#1D9E75;color:#fff;text-decoration:none;padding:12px 24px;border-radius:10px;font-size:14px;font-weight:500;">Claim this slot →</a>
</td></tr>
</table></td></tr></table></body></html>`

        await sendEmail(fam.email, `A slot opened up — ${dateFormatted} at ${time} with ${providerName}`, html).catch(e => console.error('Slot opened family email failed:', e))
      }

      return res.json({ ok: true, notified: entries.length })
    }

    // ── Slot offer accepted (family claims open slot) ─────────────────────────
    if (body.type === 'slot_offer_accepted') {
      const [offer] = await sql`SELECT * FROM slot_offers WHERE id = ${body.offerId}::uuid`

      if (!offer || offer.status !== 'pending') {
        return res.status(400).json({ ok: false, error: 'Offer not available' })
      }

      const [entry] = await sql`SELECT family_id, zip FROM waitlist_entries WHERE id = ${offer.waitlist_entry_id}::uuid`

      // Convert offered_time ("2:00 PM") to 24h
      const [t, ampm] = offer.offered_time.split(' ')
      let [h, m] = t.split(':').map(Number)
      if (ampm === 'PM' && h !== 12) h += 12
      if (ampm === 'AM' && h === 12) h = 0
      const time24 = `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`

      const offerPracticeId: string | null = offer.practice_id ?? null
      if (offerPracticeId) {
        await sql`INSERT INTO appointments (practice_id, provider_id, visit_type, zone, scheduled_time, scheduled_date, status, notes)
          VALUES (${offerPracticeId}::uuid, ${offer.provider_id}::uuid, ${offer.visit_type || 'In-home sick visit'}, ${offer.zone || ''}, ${time24}, ${offer.offered_date}, 'upcoming', ${`From waitlist slot offer · Zip: ${entry?.zip || ''}`})`
        await sql`INSERT INTO booking_requests (practice_id, family_id, child_ids, visit_type, zone, preferred_date, preferred_time, status, confirmed_provider_id, reference_code)
          VALUES (${offerPracticeId}::uuid, ${entry?.family_id}::uuid, '{}', ${offer.visit_type || 'In-home sick visit'}, ${offer.zone}, ${offer.offered_date}, ${offer.offered_time}, 'confirmed', ${offer.provider_id}::uuid, ${offer.id.slice(0, 8).toUpperCase()})`
      } else {
        await sql`INSERT INTO appointments (provider_id, visit_type, zone, scheduled_time, scheduled_date, status, notes)
          VALUES (${offer.provider_id}::uuid, ${offer.visit_type || 'In-home sick visit'}, ${offer.zone || ''}, ${time24}, ${offer.offered_date}, 'upcoming', ${`From waitlist slot offer · Zip: ${entry?.zip || ''}`})`
        await sql`INSERT INTO booking_requests (family_id, child_ids, visit_type, zone, preferred_date, preferred_time, status, confirmed_provider_id, reference_code)
          VALUES (${entry?.family_id}::uuid, '{}', ${offer.visit_type || 'In-home sick visit'}, ${offer.zone}, ${offer.offered_date}, ${offer.offered_time}, 'confirmed', ${offer.provider_id}::uuid, ${offer.id.slice(0, 8).toUpperCase()})`
      }

      await sql`UPDATE slot_offers SET status = 'accepted' WHERE id = ${offer.id}::uuid`
      await sql`UPDATE waitlist_entries SET status = 'converted' WHERE id = ${offer.waitlist_entry_id}::uuid`

      const [fam] = await sql`SELECT email, display_name, phone FROM family_profiles WHERE id = ${entry?.family_id}::uuid`
      const dateFormatted = formatDate(offer.offered_date)

      if (fam?.email) {
        const greeting = fam.display_name ? `Hi ${fam.display_name.split(' ')[0]},` : 'Hi there,'
        const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#FAFAF8;font-family:'DM Sans',system-ui,sans-serif;color:#1A1A2E;">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px;">
<table width="100%" style="max-width:520px;background:#fff;border-radius:16px;border:1px solid #E8E8E4;overflow:hidden;">
<tr><td style="background:#1A1A2E;padding:28px 32px;">
  <div style="font-size:20px;font-weight:600;color:#fff;">${logo('#1D9E75')}</div>
  <div style="font-size:12px;color:rgba(255,255,255,0.4);margin-top:4px;text-transform:uppercase;letter-spacing:0.06em;">Appointment confirmed</div>
</td></tr>
<tr><td style="padding:32px;">
  <p style="font-size:15px;margin:0 0 20px;line-height:1.6;">${greeting}<br><br>
  You're all set! Your appointment has been confirmed.</p>
  <table width="100%" style="background:#FAFAF8;border-radius:12px;border:1px solid #E8E8E4;margin-bottom:24px;"><tr><td style="padding:20px;">
    <div style="font-size:18px;font-weight:600;margin-bottom:16px;">${offer.visit_type || 'In-home visit'}</div>
    ${row('👩‍⚕️', 'Provider', offer.provider_name)}
    ${row('📅', 'Date', dateFormatted)}
    ${row('🕐', 'Time', offer.offered_time)}
    ${row('📍', 'Area', offer.zone || '')}
  </td></tr></table>
  <div style="background:#E1F5EE;border-radius:10px;padding:14px 16px;margin-bottom:24px;font-size:13px;color:#085041;">
    Your provider will be in touch before the visit. Please make sure you're available at the visit address with your child ready.
  </div>
  <a href="${PORTAL_URL}/family/dashboard" style="display:inline-block;background:#1A1A2E;color:#fff;text-decoration:none;padding:12px 24px;border-radius:10px;font-size:14px;font-weight:500;">View my appointments</a>
</td></tr>
<tr><td style="padding:20px 32px;border-top:1px solid #E8E8E4;font-size:11px;color:#999;text-align:center;">
  Booking reference: <strong style="font-family:monospace;">${offer.id.slice(0, 8).toUpperCase()}</strong>
</td></tr>
</table></td></tr></table></body></html>`

        await sendEmail(fam.email, `Confirmed: ${offer.visit_type || 'Appointment'} on ${dateFormatted}`, html).catch(e => console.error('Slot offer accepted family email failed:', e))
      }
      if (fam?.phone) {
        await sendSMS(fam.phone, `${PRACTICE_NAME}: Your appointment is confirmed — ${offer.visit_type || 'visit'} on ${dateFormatted} at ${offer.offered_time} with ${offer.provider_name}. View details: ${PORTAL_URL}/family/dashboard`).catch(e => console.error('Slot offer accepted family SMS failed:', e))
      }

      const [offerProv] = await sql`SELECT email, phone FROM providers WHERE id = ${offer.provider_id}::uuid`
      if (offerProv?.email) {
        await sendEmail(
          offerProv.email,
          `[Provider] Waitlist patient claimed your open slot — ${dateFormatted} at ${offer.offered_time}`,
          providerNotificationEmail({
            visitType: offer.visit_type || 'In-home visit',
            date: dateFormatted,
            time: offer.offered_time,
            zone: offer.zone || '',
            ref: offer.id.slice(0, 8).toUpperCase(),
            providerName: offer.provider_name,
          })
        ).catch(e => console.error('Slot offer accepted provider email failed:', e))
      }
      if (offerProv?.phone) {
        await sendSMS(offerProv.phone, `${PRACTICE_NAME}: A waitlist family has claimed your open slot on ${dateFormatted} at ${offer.offered_time}. View your schedule: ${PORTAL_URL}`).catch(e => console.error('Slot offer accepted provider SMS failed:', e))
      }

      await notifyAdmins(sql, `${PRACTICE_NAME}: Waitlist slot claimed — ${offer.visit_type || 'visit'} on ${dateFormatted} at ${offer.offered_time} with ${offer.provider_name}. View: ${PORTAL_URL}/admin/schedule`, offerPracticeId ?? undefined)

      const pickupDesc = `a waitlist slot (${offer.zone || 'unknown zone'}, ${dateFormatted} at ${offer.offered_time})`
      await notifyAllProviders(
        sql,
        `${PRACTICE_NAME}: A waitlist family claimed an open slot. View: ${PORTAL_URL}/admin/schedule`,
        `[Pickup] Waitlist family claimed ${offer.provider_name}'s open slot — ${dateFormatted}`,
        (name) => pickupNotificationEmail({ recipientName: name, acceptedBy: 'A waitlist family', description: pickupDesc }),
        offer.provider_id,
        offerPracticeId ?? undefined,
      )

      return res.json({ ok: true })
    }

    // ── Family or admin removed from waitlist — notify family + providers ────
    if (body.type === 'waitlist_removed') {
      const [entry] = await sql`SELECT family_id, zip, state, visit_type, practice_id FROM waitlist_entries WHERE id = ${body.waitlistEntryId}::uuid`
      if (!entry) return res.json({ ok: false, error: 'Entry not found' })

      // Notify family
      if (entry.family_id) {
        const [fam] = await sql`SELECT email, display_name, phone FROM family_profiles WHERE id = ${entry.family_id}::uuid`
        if (fam) {
          const greeting = fam.display_name ? `Hi ${fam.display_name.split(' ')[0]},` : 'Hi there,'
          const famHtml = `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#FAFAF8;font-family:'DM Sans',system-ui,sans-serif;color:#1A1A2E;">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px;">
<table width="100%" style="max-width:520px;background:#fff;border-radius:16px;border:1px solid #E8E8E4;overflow:hidden;">
<tr><td style="background:#1A1A2E;padding:28px 32px;">
  <div style="font-size:20px;font-weight:600;color:#fff;">${logo('#EF9F27')}</div>
  <div style="font-size:12px;color:rgba(255,255,255,0.4);margin-top:4px;text-transform:uppercase;letter-spacing:0.06em;">Waitlist update</div>
</td></tr>
<tr><td style="padding:32px;">
  <p style="font-size:15px;margin:0 0 20px;line-height:1.6;">${greeting}<br><br>
  We wanted to let you know that your spot on our waitlist has been removed. This may be because we were unable to reach you, or the request was no longer needed.</p>
  <p style="font-size:14px;line-height:1.6;color:#555;margin:0 0 24px;">If you'd still like to see a provider, you're welcome to rebook through your portal at any time.</p>
  <a href="${PORTAL_URL}/family/dashboard" style="display:inline-block;background:#1A1A2E;color:#fff;text-decoration:none;padding:12px 24px;border-radius:10px;font-size:14px;font-weight:500;">Go to my portal</a>
</td></tr>
</table></td></tr></table></body></html>`
          if (fam.email) await sendEmail(fam.email, `Waitlist update — ${PRACTICE_NAME}`, famHtml).catch(e => console.error('Waitlist removed family email failed:', e))
          if (fam.phone) await sendSMS(fam.phone, `${PRACTICE_NAME}: Your waitlist spot has been removed. If you still need a visit, you can rebook at ${PORTAL_URL}/family/dashboard`).catch(e => console.error('Waitlist removed family SMS failed:', e))
        }
      }

      // Notify providers in the patient's state
      const stateLabel = entry.state === 'NC' ? 'North Carolina' : entry.state === 'SC' ? 'South Carolina' : entry.state === 'VA' ? 'Virginia' : entry.state || 'your state'
      const removedProviders = await sql`SELECT name, email, phone, states, role FROM providers WHERE role != 'admin' AND is_active = true AND practice_id = ${entry.practice_id}::uuid`
      for (const prov of removedProviders) {
        const provStates: string[] = (prov.states ?? []) as string[]
        if (['MD', 'PNP'].includes(prov.role) && entry.state && provStates.length > 0 && !provStates.includes(entry.state)) continue
        const provHtml = `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#FAFAF8;font-family:'DM Sans',system-ui,sans-serif;color:#1A1A2E;">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px;">
<table width="100%" style="max-width:520px;background:#fff;border-radius:16px;border:1px solid #E8E8E4;overflow:hidden;">
<tr><td style="background:#1A1A2E;padding:28px 32px;">
  <div style="font-size:20px;font-weight:600;color:#fff;">${logo('#EF9F27')}</div>
  <div style="font-size:12px;color:rgba(255,255,255,0.4);margin-top:4px;text-transform:uppercase;letter-spacing:0.06em;">Waitlist update — ${stateLabel}</div>
</td></tr>
<tr><td style="padding:32px;">
  <p style="font-size:15px;margin:0 0 20px;line-height:1.6;">Hi ${prov.name},<br><br>
  A family has removed themselves from the waitlist in <strong>${stateLabel}</strong>${entry.zip ? ` (zip ${entry.zip})` : ''}.</p>
  <a href="${PORTAL_URL}/admin/waitlist" style="display:inline-block;background:#1A1A2E;color:#fff;text-decoration:none;padding:12px 24px;border-radius:10px;font-size:14px;font-weight:500;">View waitlist</a>
</td></tr>
</table></td></tr></table></body></html>`
        if (prov.email) await sendEmail(prov.email, `[Waitlist] Family removed — ${stateLabel}`, provHtml).catch(() => {})
        if (prov.phone) await sendSMS(prov.phone, `${PRACTICE_NAME}: A family has removed themselves from the waitlist in ${stateLabel}${entry.zip ? ` (zip ${entry.zip})` : ''}. View: ${PORTAL_URL}/admin/waitlist`).catch(() => {})
      }

      return res.json({ ok: true })
    }

    // ── Admin booked appointment from patient chart ───────────────────────────
    if (body.type === 'admin_booked' || body.type === 'chart_booked') {
      const [appt] = await sql`SELECT * FROM appointments WHERE id = ${body.appointmentId}::uuid LIMIT 1`
      if (!appt) return res.json({ ok: false, error: 'Appointment not found' })

      const [child] = appt.child_id
        ? await sql`SELECT first_name, last_name, family_id FROM children WHERE id = ${appt.child_id}::uuid LIMIT 1`
        : [null]
      const [family] = child?.family_id
        ? await sql`SELECT email, phone, display_name FROM family_profiles WHERE id = ${child.family_id}::uuid LIMIT 1`
        : [null]
      const [provider] = appt.provider_id
        ? await sql`SELECT name, email, phone FROM providers WHERE id = ${appt.provider_id}::uuid LIMIT 1`
        : [null]

      const childName = child ? `${child.first_name} ${child.last_name}`.trim() : 'your child'
      const providerName = provider?.name ?? 'Your provider'
      const dateFormatted = formatDate(appt.scheduled_date)
      const timeStr = (() => {
        const t = appt.scheduled_time ?? ''
        if (!t) return ''
        const [h, m] = t.split(':').map(Number)
        const ampm = h >= 12 ? 'PM' : 'AM'
        const hr = h % 12 || 12
        return `${hr}:${String(m).padStart(2, '0')} ${ampm}`
      })()

      const familyHtml = `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#FAFAF8;font-family:'DM Sans',system-ui,sans-serif;color:#1A1A2E;">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px;">
<table width="100%" style="max-width:520px;background:#fff;border-radius:16px;border:1px solid #E8E8E4;overflow:hidden;">
<tr><td style="background:#1A1A2E;padding:28px 32px;">
  <div style="font-size:20px;font-weight:600;color:#fff;letter-spacing:-0.3px;">${logo('#7F77DD')}</div>
  <div style="font-size:12px;color:rgba(255,255,255,0.4);margin-top:4px;text-transform:uppercase;letter-spacing:0.06em;">Appointment Confirmed</div>
</td></tr>
<tr><td style="padding:32px;">
  <p style="font-size:15px;margin:0 0 20px;line-height:1.6;">Hi ${family?.display_name ?? 'there'},<br><br>
  An appointment has been scheduled for <strong>${childName}</strong>. Here are the details:</p>
  <table width="100%" style="background:#FAFAF8;border-radius:12px;border:1px solid #E8E8E4;margin-bottom:24px;"><tr><td style="padding:20px;">
    <div style="margin-bottom:10px;"><span style="font-size:12px;color:#999;text-transform:uppercase;">Visit Type</span><br><span style="font-size:14px;font-weight:500;">${appt.visit_type}</span></div>
    <div style="margin-bottom:10px;"><span style="font-size:12px;color:#999;text-transform:uppercase;">Provider</span><br><span style="font-size:14px;font-weight:500;">${providerName}</span></div>
    <div style="margin-bottom:10px;"><span style="font-size:12px;color:#999;text-transform:uppercase;">Date</span><br><span style="font-size:14px;font-weight:500;">${dateFormatted}</span></div>
    ${timeStr ? `<div><span style="font-size:12px;color:#999;text-transform:uppercase;">Time</span><br><span style="font-size:14px;font-weight:500;">${timeStr}</span></div>` : ''}
  </td></tr></table>
  <div style="background:#E1F5EE;border-radius:10px;padding:14px 16px;margin-bottom:24px;font-size:13px;color:#085041;">
    Your provider will arrive within 15 minutes of your scheduled time. Please be available at your address with ${childName} ready.
  </div>
  <a href="${PORTAL_URL}/family/dashboard" style="display:inline-block;background:#1D9E75;color:#fff;text-decoration:none;padding:12px 24px;border-radius:10px;font-size:14px;font-weight:500;">View my appointments</a>
</td></tr>
</table></td></tr></table></body></html>`

      await notifyBookingParties(sql, {
        familyEmail: family?.email,
        familyPhone: family?.phone,
        provider: provider ? { id: appt.provider_id, email: provider.email, phone: provider.phone } : null,
        familySubject: `Appointment confirmed — ${dateFormatted}${timeStr ? ` at ${timeStr}` : ''} · ${PRACTICE_NAME}`,
        familyHtml,
        familySms: `${PRACTICE_NAME}: Appointment confirmed for ${childName} on ${dateFormatted}${timeStr ? ` at ${timeStr}` : ''} with ${providerName}. Log in for details: ${PORTAL_URL}/family/dashboard`,
        providerSubject: `New appointment: ${childName} — ${dateFormatted}${timeStr ? ` at ${timeStr}` : ''}`,
        providerHtml: providerNotificationEmail({ visitType: appt.visit_type, date: dateFormatted, time: timeStr, zone: appt.zone ?? '', ref: appt.id, providerName }),
        providerSms: `${PRACTICE_NAME}: New appointment — ${childName}, ${appt.visit_type}, ${dateFormatted}${timeStr ? ` at ${timeStr}` : ''}. View: ${PORTAL_URL}/today`,
        adminSms: `${PRACTICE_NAME}: Appointment booked from patient chart for ${childName}. View: ${PORTAL_URL}/admin/schedule`,
      })
      return res.json({ ok: true })
    }

    // ── Appointment rescheduled ───────────────────────────────────────────────
    if (body.type === 'appointment_rescheduled') {
      const [appt] = await sql`SELECT * FROM appointments WHERE id = ${body.appointmentId}::uuid LIMIT 1`
      if (!appt) return res.json({ ok: false, error: 'Appointment not found' })

      const [child] = appt.child_id
        ? await sql`SELECT first_name, last_name, family_id FROM children WHERE id = ${appt.child_id}::uuid LIMIT 1`
        : [null]
      const [family] = child?.family_id
        ? await sql`SELECT email, phone, display_name FROM family_profiles WHERE id = ${child.family_id}::uuid LIMIT 1`
        : [null]
      // appt.provider_id is the NEW provider after the update
      const [newProvider] = appt.provider_id
        ? await sql`SELECT id, name, email, phone FROM providers WHERE id = ${appt.provider_id}::uuid LIMIT 1`
        : [null]
      // oldProviderId passed from UI before the update — only present when provider changed
      const oldProviderId: string | null = body.oldProviderId ?? null
      const providerChanged = oldProviderId && oldProviderId !== appt.provider_id
      const [oldProvider] = providerChanged
        ? await sql`SELECT id, name, email, phone FROM providers WHERE id = ${oldProviderId}::uuid LIMIT 1`
        : [null]

      const childName = child ? `${child.first_name} ${child.last_name}`.trim() : 'your child'
      const newProviderName = newProvider?.name ?? 'Your provider'
      const dateFormatted = formatDate(appt.scheduled_date)
      const timeStr = (() => {
        const t = appt.scheduled_time ?? ''
        if (!t) return ''
        const [h, m] = t.split(':').map(Number)
        const ampm = h >= 12 ? 'PM' : 'AM'
        return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${ampm}`
      })()

      // 1. Family — one notification with the full updated picture
      const familyHtml = `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#FAFAF8;font-family:'DM Sans',system-ui,sans-serif;color:#1A1A2E;">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px;">
<table width="100%" style="max-width:520px;background:#fff;border-radius:16px;border:1px solid #E8E8E4;overflow:hidden;">
<tr><td style="background:#1A1A2E;padding:28px 32px;">
  <div style="font-size:20px;font-weight:600;color:#fff;letter-spacing:-0.3px;">${logo('#7F77DD')}</div>
  <div style="font-size:12px;color:rgba(255,255,255,0.4);margin-top:4px;text-transform:uppercase;letter-spacing:0.06em;">Appointment Rescheduled</div>
</td></tr>
<tr><td style="padding:32px;">
  <p style="font-size:15px;margin:0 0 20px;line-height:1.6;">Hi ${family?.display_name ?? 'there'},<br><br>
  Your appointment for <strong>${childName}</strong> has been rescheduled. Here are the updated details:</p>
  <table width="100%" style="background:#FAFAF8;border-radius:12px;border:1px solid #E8E8E4;margin-bottom:24px;"><tr><td style="padding:20px;">
    <div style="margin-bottom:10px;"><span style="font-size:12px;color:#999;text-transform:uppercase;">Visit Type</span><br><span style="font-size:14px;font-weight:500;">${appt.visit_type}</span></div>
    <div style="margin-bottom:10px;"><span style="font-size:12px;color:#999;text-transform:uppercase;">Provider</span><br><span style="font-size:14px;font-weight:500;">${newProviderName}</span></div>
    <div style="margin-bottom:10px;"><span style="font-size:12px;color:#999;text-transform:uppercase;">New Date</span><br><span style="font-size:14px;font-weight:500;">${dateFormatted}</span></div>
    ${timeStr ? `<div><span style="font-size:12px;color:#999;text-transform:uppercase;">New Time</span><br><span style="font-size:14px;font-weight:500;">${timeStr}</span></div>` : ''}
  </td></tr></table>
  <a href="${PORTAL_URL}/family/dashboard" style="display:inline-block;background:#1D9E75;color:#fff;text-decoration:none;padding:12px 24px;border-radius:10px;font-size:14px;font-weight:500;">View my appointments</a>
</td></tr>
</table></td></tr></table></body></html>`

      if (family?.email) await sendEmail(family.email, `Appointment rescheduled — ${dateFormatted}${timeStr ? ` at ${timeStr}` : ''} · ${PRACTICE_NAME}`, familyHtml).catch(e => console.error('Reschedule family email failed:', e))
      if (family?.phone) await sendSMS(family.phone, `${PRACTICE_NAME}: Your appointment for ${childName} has been rescheduled to ${dateFormatted}${timeStr ? ` at ${timeStr}` : ''} with ${newProviderName}.`).catch(e => console.error('Reschedule family SMS failed:', e))

      // 2. New provider
      if (newProvider?.email) {
        const provHtml = providerNotificationEmail({ visitType: appt.visit_type, date: dateFormatted, time: timeStr, zone: appt.zone ?? '', ref: appt.id, providerName: newProviderName })
        await sendEmail(newProvider.email, `Appointment rescheduled to you: ${childName} — ${dateFormatted}${timeStr ? ` at ${timeStr}` : ''}`, provHtml).catch(e => console.error('Reschedule new provider email failed:', e))
      }
      if (newProvider?.phone) await sendSMS(newProvider.phone, `${PRACTICE_NAME}: Appointment rescheduled to your schedule — ${childName}, ${appt.visit_type}, ${dateFormatted}${timeStr ? ` at ${timeStr}` : ''}. View: ${PORTAL_URL}/today`).catch(e => console.error('Reschedule new provider SMS failed:', e))

      // 3. Old provider — only when provider changed
      if (providerChanged && oldProvider) {
        const oldProvHtml = `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#FAFAF8;font-family:'DM Sans',system-ui,sans-serif;color:#1A1A2E;">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px;">
<table width="100%" style="max-width:520px;background:#fff;border-radius:16px;border:1px solid #E8E8E4;overflow:hidden;">
<tr><td style="background:#1A1A2E;padding:28px 32px;">
  <div style="font-size:20px;font-weight:600;color:#fff;">${logo('#7F77DD')}</div>
  <div style="font-size:12px;color:rgba(255,255,255,0.4);margin-top:4px;text-transform:uppercase;letter-spacing:0.06em;">Schedule update</div>
</td></tr>
<tr><td style="padding:32px;">
  <p style="font-size:15px;margin:0 0 16px;line-height:1.6;">Hi ${oldProvider.name},<br><br>
  <strong>${childName}</strong>'s ${appt.visit_type} on ${dateFormatted}${timeStr ? ` at ${timeStr}` : ''} has been moved to ${newProviderName}'s schedule.</p>
  <a href="${PORTAL_URL}/today" style="display:inline-block;background:#1A1A2E;color:#fff;text-decoration:none;padding:12px 24px;border-radius:10px;font-size:14px;font-weight:500;">View my schedule</a>
</td></tr>
</table></td></tr></table></body></html>`
        if (oldProvider.email) await sendEmail(oldProvider.email, `Patient moved off your schedule — ${childName}`, oldProvHtml).catch(e => console.error('Reschedule old provider email failed:', e))
        if (oldProvider.phone) await sendSMS(oldProvider.phone, `${PRACTICE_NAME}: ${childName}'s ${appt.visit_type} on ${dateFormatted}${timeStr ? ` at ${timeStr}` : ''} has been moved to ${newProviderName}'s schedule.`).catch(e => console.error('Reschedule old provider SMS failed:', e))
      }

      // 4. Admins
      const adminMsg = providerChanged
        ? `${PRACTICE_NAME}: Appointment rescheduled for ${childName} to ${dateFormatted}${timeStr ? ` at ${timeStr}` : ''} — moved from ${oldProvider?.name ?? 'previous provider'} to ${newProviderName}. View: ${PORTAL_URL}/admin/schedule`
        : `${PRACTICE_NAME}: Appointment rescheduled for ${childName} to ${dateFormatted}${timeStr ? ` at ${timeStr}` : ''}. View: ${PORTAL_URL}/admin/schedule`
      await notifyAdmins(sql, adminMsg, undefined)
      return res.json({ ok: true })
    }

    // ── Manual appointment added by provider ──────────────────────────────────
    if (body.type === 'appointment_added') {
      const { visitType, parentEmail, providerId, providerName, date, time } = body

      const [assignedProvider] = providerId
        ? await sql`SELECT name, email, phone FROM providers WHERE id = ${providerId}::uuid LIMIT 1`
        : [null]

      const dateFormatted = date ? formatDate(date) : ''
      const timeStr = (() => {
        if (!time) return ''
        const [h, m] = String(time).split(':').map(Number)
        const ampm = h >= 12 ? 'PM' : 'AM'
        return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${ampm}`
      })()

      if (assignedProvider?.email) {
        const html = providerNotificationEmail({ visitType, date: dateFormatted, time: timeStr, zone: body.zone ?? '', ref: '', providerName: assignedProvider.name })
        await sendEmail(assignedProvider.email, `New appointment added — ${dateFormatted}${timeStr ? ` at ${timeStr}` : ''}`, html).catch(e => console.error('Appt added provider email failed:', e))
      }
      if (assignedProvider?.phone) {
        await sendSMS(assignedProvider.phone, `${PRACTICE_NAME}: New appointment added to your schedule — ${visitType}, ${dateFormatted}${timeStr ? ` at ${timeStr}` : ''}. View: ${PORTAL_URL}/today`).catch(e => console.error('Appt added provider SMS failed:', e))
      }

      await notifyAdmins(sql, `${PRACTICE_NAME}: Appointment added for ${providerName ?? 'provider'}. View: ${PORTAL_URL}/admin/schedule`, undefined)

      if (visitType === 'In-home IV fluids' && parentEmail) {
        await sendEmail(parentEmail, `Your IV fluids request has been received — ${PRACTICE_NAME}`, ivFluidsEmailHtml()).catch(e => console.error('IV fluids parent email failed:', e))
      }

      return res.json({ ok: true })
    }

    // ── Broadcast created — notify all providers + admins ─────────────────────
    if (body.type === 'broadcast') {
      const [bc] = await sql`SELECT * FROM broadcasts WHERE id = ${body.broadcastId}::uuid`
      if (!bc) throw new Error('Broadcast not found')

      const stateLabel = bc.state === 'NC' ? 'North Carolina' : bc.state === 'SC' ? 'South Carolina' : bc.state === 'VA' ? 'Virginia' : bc.state || 'your state'
      const smsBody = `${PRACTICE_NAME}:${bc.is_urgent ? ' [URGENT]' : ''} New broadcast request. View: ${PORTAL_URL}/broadcasts`

      const providers = await sql`SELECT id, name, phone, email FROM providers WHERE is_active = true OR role = 'admin'`
      for (const prov of providers) {
        const firstName = prov.name.split(' ').slice(-2)[0]
        if (prov.email) {
          const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#FAFAF8;font-family:'DM Sans',system-ui,sans-serif;color:#1A1A2E;">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px;">
<table width="100%" style="max-width:520px;background:#fff;border-radius:16px;border:1px solid #E8E8E4;overflow:hidden;">
<tr><td style="background:#1A1A2E;padding:28px 32px;">
  <div style="font-size:20px;font-weight:600;color:#fff;">${logo('#7F77DD')}</div>
  <div style="font-size:12px;color:rgba(255,255,255,0.4);margin-top:4px;text-transform:uppercase;letter-spacing:0.06em;">
    ${bc.is_urgent ? '🚨 Urgent broadcast' : 'New broadcast'} — ${stateLabel}
  </div>
</td></tr>
<tr><td style="padding:32px;">
  <p style="font-size:15px;margin:0 0 20px;line-height:1.6;">Hi ${firstName},<br><br>
  ${bc.created_by_name} has sent a broadcast request for a patient in ${stateLabel}.</p>
  <table width="100%" style="background:#FAFAF8;border-radius:12px;border:1px solid #E8E8E4;margin-bottom:24px;"><tr><td style="padding:20px;">
    <div style="font-size:18px;font-weight:600;margin-bottom:16px;">${bc.patient_first_name} ${bc.patient_last_name}</div>
    ${bc.patient_dob ? row('🗓', 'DOB', bc.patient_dob) : ''}
    ${bc.patient_address ? row('📍', 'Address', bc.patient_address) : ''}
    ${row('🏥', 'Request', bc.request_type)}
    ${bc.complaint ? row('💬', 'Complaint', bc.complaint) : ''}
  </td></tr></table>
  <a href="${PORTAL_URL}/broadcasts" style="display:inline-block;background:#7F77DD;color:#fff;text-decoration:none;padding:12px 24px;border-radius:10px;font-size:14px;font-weight:500;">View &amp; accept broadcast</a>
</td></tr>
</table></td></tr></table></body></html>`
          await sendEmail(prov.email, `${bc.is_urgent ? '[URGENT] ' : ''}Broadcast: ${bc.patient_first_name} ${bc.patient_last_name} — ${bc.request_type}`, html).catch(e => console.error('Broadcast provider email failed:', e))
        }
        if (prov.phone) await sendSMS(prov.phone, smsBody).catch(e => console.error('Broadcast provider SMS failed:', e))
      }

      return res.json({ ok: true })
    }

    // ── Broadcast accepted — notify all providers ─────────────────────────────
    if (body.type === 'broadcast_accepted') {
      const [bc] = await sql`SELECT * FROM broadcasts WHERE id = ${body.broadcastId}::uuid`
      if (!bc) return res.json({ ok: true })

      const acceptedBy = body.acceptedByName || 'A provider'
      const patientName = `${bc.patient_first_name} ${bc.patient_last_name}`
      const pickupDesc = `the broadcast for ${patientName} (${bc.request_type})`
      const smsBody = `${PRACTICE_NAME}: A broadcast has been picked up. View: ${PORTAL_URL}/broadcasts`

      await notifyAllProviders(
        sql,
        smsBody,
        `[Pickup] ${acceptedBy} accepted a broadcast — ${patientName}`,
        (name) => pickupNotificationEmail({ recipientName: name, acceptedBy, description: pickupDesc }),
        body.acceptedById ?? null,
        bc.practice_id ?? undefined,
      )

      const familyPhone: string | null = bc.family_phone ?? null
      const familyEmail: string | null = bc.family_email ?? null
      const acceptedDate: string = body.acceptedDate || new Date().toISOString().split('T')[0]
      const acceptedTime: string = body.acceptedTime || '12:00'

      const [hRaw, mRaw] = acceptedTime.split(':').map(Number)
      const ampm = hRaw >= 12 ? 'PM' : 'AM'
      const h12 = hRaw % 12 || 12
      const timeFormatted = `${h12}:${mRaw.toString().padStart(2, '0')} ${ampm}`

      const today = new Date().toISOString().split('T')[0]
      const whenStr = acceptedDate === today ? 'today' : `on ${acceptedDate}`

      const isVirtual = bc.request_type !== 'In-person house call'

      if (isVirtual) {
        const parentSms = `${PRACTICE_NAME}: Your appointment is confirmed. Log in to view details: ${PORTAL_URL}/family/login`
        const parentEmailHtml = `<div style="font-family:sans-serif;font-size:14px;color:#1A1A2E;line-height:1.6;">
          <p>${acceptedBy} will evaluate your child by video telemedicine visit at <strong>${timeFormatted} ${whenStr}</strong>.</p>
          <p>At that time, please log into the ${PRACTICE_NAME} virtual waiting room and the provider will begin your video visit from there:</p>
          <p><a href="${TELEMEDICINE_URL}" style="color:#7F77DD;font-weight:600;">${TELEMEDICINE_URL}</a></p>
        </div>`
        if (familyPhone) await sendSMS(familyPhone, parentSms).catch(e => console.error('Broadcast accepted family SMS failed:', e))
        if (familyEmail) await sendEmail(familyEmail, `Your telemedicine visit is confirmed — ${timeFormatted} ${whenStr}`, parentEmailHtml).catch(e => console.error('Broadcast accepted family email failed:', e))
      } else {
        const parentSms = `${PRACTICE_NAME}: Your appointment is confirmed. Log in to view details: ${PORTAL_URL}/family/login`
        const parentEmailHtml = `<div style="font-family:sans-serif;font-size:14px;color:#1A1A2E;line-height:1.6;">
          <p>${acceptedBy} will come to your home for a house call visit at <strong>${timeFormatted} ${whenStr}</strong>.</p>
          <p>Please have your child ready at that time.</p>
        </div>`
        if (familyPhone) await sendSMS(familyPhone, parentSms).catch(e => console.error('Broadcast accepted family SMS failed:', e))
        if (familyEmail) await sendEmail(familyEmail, `Your house call visit is confirmed — ${timeFormatted} ${whenStr}`, parentEmailHtml).catch(e => console.error('Broadcast accepted family email failed:', e))
      }

      return res.json({ ok: true })
    }

    // ── Post-visit thank-you + Google review email ────────────────────────────
    if (body.type === 'post_visit_email') {
      const { appointmentId } = body
      const [appt] = await sql`SELECT * FROM appointments WHERE id = ${appointmentId}::uuid`
      if (!appt) return res.status(404).json({ ok: false, error: 'Appointment not found' })
      let instructions: string | null = body.instructions || appt.after_visit_instructions || null
      if (!instructions) {
        // Race condition guard: a concurrent PATCH may still be writing instructions — wait and retry
        await new Promise(r => setTimeout(r, 800))
        const [refreshed] = await sql`SELECT after_visit_instructions FROM appointments WHERE id = ${appointmentId}::uuid`
        instructions = refreshed?.after_visit_instructions || null
      }
      console.log('[post_visit_email] instructions:', instructions ? instructions.substring(0, 60) : 'NULL')

      const [prov] = await sql`SELECT name FROM providers WHERE id = ${appt.provider_id}::uuid`

      const notes: string = appt.notes || ''
      const parentEmailMatch = notes.split('|').find((p: string) => p.startsWith('PARENTEMAIL:'))
      const parentEmailFromNotes = parentEmailMatch?.replace('PARENTEMAIL:', '').trim() || null

      const patientMatch = notes.split('|').find((p: string) => p.startsWith('PATIENT:'))
      const childFirstName = patientMatch?.replace('PATIENT:', '').trim().split(' ')[0] || null

      let familyEmail: string | null = parentEmailFromNotes
      let familyDisplayName: string | null = null

      // Look up via booking reference code in notes (family-booked appointments)
      if (!familyEmail) {
        const refMatch = notes.match(/Ref: ([A-Z0-9-]+)/)
        if (refMatch) {
          const [br] = await sql`
            SELECT fp.email, fp.display_name FROM booking_requests br
            JOIN family_profiles fp ON fp.id = br.family_id
            WHERE br.reference_code = ${refMatch[1]} LIMIT 1`
          familyEmail = br?.email || null
          familyDisplayName = br?.display_name || null
        }
      }

      // Fall back to charm_appointment_id linkage
      if (!familyEmail && appt.charm_appointment_id) {
        const [br] = await sql`SELECT family_id FROM booking_requests
          WHERE charm_appointment_id = ${appt.charm_appointment_id} LIMIT 1`
        if (br?.family_id) {
          const [fam] = await sql`SELECT email, display_name FROM family_profiles WHERE id = ${br.family_id}::uuid`
          familyEmail = fam?.email || null
          familyDisplayName = fam?.display_name || null
        }
      }

      if (!familyEmail) {
        return res.json({ ok: false, error: 'No family email found' })
      }

      const dateFormatted = appt.scheduled_date ? formatDate(appt.scheduled_date) : ''
      await sendEmail(
        familyEmail,
        `Thank you for choosing ${PRACTICE_NAME} ⭐`,
        postVisitEmail({
          displayName: familyDisplayName,
          childName: childFirstName,
          providerName: prov?.name || 'Your provider',
          dateFormatted,
          instructions: instructions || null,
        })
      ).catch(e => console.error('Post-visit email failed:', e))

      return res.json({ ok: true })
    }

    // ── CPR class booking ─────────────────────────────────────────────────────
    if (body.type === 'cpr_booking') {
      const { bookingRequestId } = body
      const [booking] = await sql`SELECT * FROM booking_requests WHERE id = ${bookingRequestId}::uuid`
      if (!booking) throw new Error('Booking not found')

      const [family] = await sql`SELECT email, display_name FROM family_profiles WHERE id = ${booking.family_id}::uuid`

      const dateFormatted = formatDate(booking.preferred_date)

      const notesStr: string = booking.notes || ''
      const participantMatch = notesStr.match(/PARTICIPANTS:(\d+)/)
      const participantCount = participantMatch ? parseInt(participantMatch[1]) : 1
      const namesMatch = notesStr.match(/NAMES:([^|]+)/)
      const participantNames = namesMatch ? namesMatch[1].trim() : ''
      const addrMatch = notesStr.match(/ADDR:([^|]+)/)
      const address = addrMatch ? addrMatch[1].trim() : ''

      if (family?.email) {
        await sendEmail(
          family.email,
          `CPR class confirmed — ${dateFormatted} at ${booking.preferred_time}`,
          cprConfirmationEmail({
            displayName: family.display_name,
            visitType: booking.visit_type,
            date: dateFormatted,
            time: booking.preferred_time,
            address,
            participantCount,
            participantNames,
            ref: booking.reference_code,
          })
        ).catch(e => console.error('CPR family confirmation email failed:', e))
      }

      await sendEmail(
        'deeringmel@me.com',
        `[CPR Class] New booking — ${dateFormatted} at ${booking.preferred_time}`,
        cprMelissaEmail({
          visitType: booking.visit_type,
          date: dateFormatted,
          time: booking.preferred_time,
          address,
          participantCount,
          participantNames,
          familyName: family?.display_name || 'Unknown',
          familyEmail: family?.email || '',
          ref: booking.reference_code,
        })
      ).catch(e => console.error('CPR Melissa email failed:', e))

      await notifyAdmins(sql, `${PRACTICE_NAME}: New CPR class booked. View: ${PORTAL_URL}/admin/schedule`, booking.practice_id ?? undefined)

      return res.json({ ok: true })
    }

    // ── Provider cancels appointment — notify parent + admins ────────────────
    if (body.type === 'appointment_cancelled') {
      const { appointmentId } = body
      const [appt] = await sql`
        SELECT a.*, p.name AS provider_name, p.phone AS provider_phone, p.email AS provider_email
        FROM appointments a
        LEFT JOIN providers p ON p.id = a.provider_id
        WHERE a.id = ${appointmentId}::uuid`
      if (!appt) return res.status(404).json({ ok: false, error: 'Appointment not found' })

      const dateFormatted = formatDate(appt.scheduled_date)
      const timeFormatted = to12h(appt.scheduled_time)

      // Parse parent contact from notes blob
      const notes: string = appt.notes || ''
      const noteMap: Record<string, string> = {}
      notes.split('|').forEach((part: string) => {
        const colon = part.indexOf(':')
        if (colon > 0) noteMap[part.slice(0, colon).trim()] = part.slice(colon + 1).trim()
      })
      const parentEmail = noteMap['PARENTEMAIL'] || null
      const parentPhone = noteMap['PARENTPHONE'] || null
      const patientName = noteMap['PATIENT'] || null

      // Look up family via booking reference in notes
      let familyDisplayName: string | null = null
      const refMatch = notes.match(/Ref: ([A-Z0-9-]+)/)
      if (refMatch) {
        const [br] = await sql`
          SELECT fp.display_name FROM booking_requests br
          JOIN family_profiles fp ON fp.id = br.family_id
          WHERE br.reference_code = ${refMatch[1]} LIMIT 1`
        familyDisplayName = br?.display_name || null
      }

      const displayName = familyDisplayName || patientName
      const subject = `Your appointment has been cancelled — ${appt.visit_type} on ${dateFormatted}`
      const smsToParent = `${PRACTICE_NAME}: Your appointment has been cancelled. Please log in to rebook: ${PORTAL_URL}/family/login`

      // Notify parent
      if (parentEmail) await sendEmail(parentEmail, subject, appointmentCancelledByProviderEmail({ displayName, visitType: appt.visit_type, date: dateFormatted, time: timeFormatted, zone: appt.zone || '' })).catch(e => console.error('Appt cancelled parent email failed:', e))
      if (parentPhone) await sendSMS(parentPhone, smsToParent).catch(e => console.error('Appt cancelled parent SMS failed:', e))

      // Notify admins
      const adminSms = `${PRACTICE_NAME}: An appointment was cancelled. View: ${PORTAL_URL}/admin/schedule`
      const admins = await sql`SELECT id, phone, email FROM providers WHERE is_admin = true`
      const adminIds = admins.map((a: any) => a.id)
      for (const admin of admins) {
        if (admin.email) await sendEmail(admin.email, `[Admin] Provider cancelled: ${appt.visit_type} — ${dateFormatted}`, cancellationNotificationEmail({ recipientName: 'Admin', visitType: appt.visit_type, date: dateFormatted, time: timeFormatted, zone: appt.zone || '', familyName: displayName || 'Family' })).catch(e => console.error('Appt cancelled admin email failed:', e))
        if (admin.phone) await sendSMS(admin.phone, adminSms).catch(e => console.error('Appt cancelled admin SMS failed:', e))
      }

      // Notify assigned provider (if not already notified as admin)
      if (appt.provider_id && !adminIds.includes(appt.provider_id)) {
        if (appt.provider_email) await sendEmail(appt.provider_email, `Appointment cancelled: ${appt.visit_type} — ${dateFormatted}`, cancellationNotificationEmail({ recipientName: appt.provider_name || 'Provider', visitType: appt.visit_type, date: dateFormatted, time: timeFormatted, zone: appt.zone || '', familyName: displayName || 'Family' })).catch(e => console.error('Appt cancelled provider email failed:', e))
        if (appt.provider_phone) await sendSMS(appt.provider_phone, adminSms).catch(e => console.error('Appt cancelled provider SMS failed:', e))
      }

      return res.json({ ok: true })
    }

    // ── Appointment cancelled — notify provider + admins ──────────────────────
    if (body.type === 'booking_cancelled') {
      const { providerId, visitType, date, time, zone, familyName, parentEmail, parentPhone } = body
      const dateFormatted = formatDate(date)
      const subject = `Appointment cancelled — ${visitType} on ${dateFormatted}`
      const smsText = `${PRACTICE_NAME}: An appointment was cancelled. View: ${PORTAL_URL}/admin/schedule`

      // Notify parent (confirmation of their cancellation)
      if (parentEmail) await sendEmail(parentEmail, `Your appointment has been cancelled — ${visitType} on ${dateFormatted}`, appointmentCancelledByProviderEmail({ displayName: familyName, visitType, date: dateFormatted, time, zone: zone || '' })).catch(e => console.error('Booking cancelled parent email failed:', e))
      if (parentPhone) await sendSMS(parentPhone, `${PRACTICE_NAME}: Your appointment has been cancelled. Please log in to rebook: ${PORTAL_URL}/family/login`).catch(e => console.error('Booking cancelled parent SMS failed:', e))

      if (providerId) {
        const [prov] = await sql`SELECT name, phone, email FROM providers WHERE id = ${providerId}::uuid`
        const providerName = prov?.name || 'Provider'
        if (prov?.email) await sendEmail(prov.email, subject, cancellationNotificationEmail({ recipientName: providerName, visitType, date: dateFormatted, time, zone: zone || '', familyName })).catch(e => console.error('Booking cancelled provider email failed:', e))
        if (prov?.phone) await sendSMS(prov.phone, smsText).catch(e => console.error('Booking cancelled provider SMS failed:', e))
      }

      const admins = await sql`SELECT id, phone, email FROM providers WHERE is_admin = true`
      for (const admin of admins) {
        if (admin.email) await sendEmail(admin.email, `[Admin] ${subject}`, cancellationNotificationEmail({ recipientName: 'Admin', visitType, date: dateFormatted, time, zone: zone || '', familyName })).catch(e => console.error('Booking cancelled admin email failed:', e))
        if (admin.phone) await sendSMS(admin.phone, smsText).catch(e => console.error('Booking cancelled admin SMS failed:', e))
      }

      return res.json({ ok: true })
    }

    // ── Provider note to parent ───────────────────────────────────────────────
    if (body.type === 'provider_note') {
      const { appointmentId, message } = body
      if (!message?.trim()) return res.status(400).json({ ok: false, error: 'Message required' })

      const [appt] = await sql`
        SELECT a.*, p.name AS provider_name
        FROM appointments a
        LEFT JOIN providers p ON p.id = a.provider_id
        WHERE a.id = ${appointmentId}::uuid`
      if (!appt) return res.status(404).json({ ok: false, error: 'Appointment not found' })

      // Parse parent email from notes blob
      const notes: string = appt.notes || ''
      const noteMap: Record<string, string> = {}
      notes.split('|').forEach((part: string) => {
        const colon = part.indexOf(':')
        if (colon > 0) noteMap[part.slice(0, colon).trim()] = part.slice(colon + 1).trim()
      })
      let parentEmail: string | null = noteMap['PARENTEMAIL'] || null

      // Fall back to family_profiles via booking reference
      if (!parentEmail) {
        const refMatch = notes.match(/Ref: ([A-Z0-9-]+)/)
        if (refMatch) {
          const [br] = await sql`
            SELECT fp.email FROM booking_requests br
            JOIN family_profiles fp ON fp.id = br.family_id
            WHERE br.reference_code = ${refMatch[1]} LIMIT 1`
          parentEmail = br?.email || null
        }
      }

      if (!parentEmail) return res.status(400).json({ ok: false, error: 'No parent email on file for this appointment' })

      const dateFormatted = formatDate(appt.scheduled_date)
      const providerName = appt.provider_name || 'Your provider'
      const html = `
        <div style="font-family:sans-serif;max-width:560px;margin:0 auto;color:#1A1A2E;">
          <h2 style="font-size:20px;font-weight:600;margin-bottom:4px;">A note from ${providerName}</h2>
          <p style="color:#666;font-size:13px;margin-top:0;">Regarding your ${appt.visit_type} on ${dateFormatted}</p>
          <div style="background:#F9F9F7;border:1px solid #E8E8E4;border-radius:8px;padding:16px 20px;margin:20px 0;font-size:15px;line-height:1.6;white-space:pre-wrap;">${message.trim()}</div>
          <p style="font-size:13px;color:#999;">If you have questions, please reply to this email or contact us through the portal.</p>
        </div>`
      await sendEmail(parentEmail, `A note from ${providerName} — ${PRACTICE_NAME}`, html).catch(e => console.error('Provider note email failed:', e))
      return res.json({ ok: true })
    }

    // ── Appointment reassigned to a different provider ────────────────────────
    if (body.type === 'appointment_reassigned') {
      const { appointmentId, newProviderName, newProviderId, visitType, date, time } = body
      const dateFormatted = new Date(String(date) + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })

      // Get appointment notes for family contact
      const [appt] = await sql`SELECT notes FROM appointments WHERE id = ${String(appointmentId)}::uuid LIMIT 1`
      const notes: string = appt?.notes || ''
      const noteMap: Record<string, string> = {}
      notes.split('|').forEach((part: string) => {
        const colon = part.indexOf(':')
        if (colon > 0) noteMap[part.slice(0, colon).trim()] = part.slice(colon + 1).trim()
      })
      let parentEmail: string | null = noteMap['PARENTEMAIL'] || null
      let parentPhone: string | null = noteMap['PARENTPHONE'] || null

      // Fall back to family_profiles via booking reference
      const refMatch = notes.match(/Ref: ([A-Z0-9-]+)/)
      if (refMatch && (!parentEmail || !parentPhone)) {
        const [br] = await sql`
          SELECT fp.email, fp.phone FROM booking_requests br
          JOIN family_profiles fp ON fp.id = br.family_id
          WHERE br.reference_code = ${refMatch[1]} LIMIT 1`
        if (!parentEmail) parentEmail = br?.email || null
        if (!parentPhone) parentPhone = br?.phone || null
      }

      // Notify family
      const familySms = `${PRACTICE_NAME}: Your case has been assigned to ${newProviderName}. They will perform your ${visitType} at ${time}. Join the visit here: ${TELEMEDICINE_URL}`
      const familyHtml = `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#FAFAF8;font-family:'DM Sans',system-ui,sans-serif;color:#1A1A2E;">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px;">
<table width="100%" style="max-width:520px;background:#fff;border-radius:16px;border:1px solid #E8E8E4;overflow:hidden;">
<tr><td style="background:#1A1A2E;padding:28px 32px;">
  <div style="font-size:20px;font-weight:600;color:#fff;">${logo('#7F77DD')}</div>
  <div style="font-size:12px;color:rgba(255,255,255,0.4);margin-top:4px;text-transform:uppercase;letter-spacing:0.06em;">Your provider has been updated</div>
</td></tr>
<tr><td style="padding:32px;">
  <p style="font-size:15px;margin:0 0 20px;line-height:1.6;">
    Your case has been assigned to <strong>${newProviderName}</strong>. They will perform your <strong>${visitType}</strong> on ${dateFormatted} at <strong>${time}</strong>.
  </p>
  <div style="background:#EEEDFE;border-radius:10px;padding:16px 20px;margin-bottom:24px;">
    <div style="font-size:12px;color:#7F77DD;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:8px;">Join your visit</div>
    <a href="${TELEMEDICINE_URL}" style="font-size:14px;color:#3C3489;font-weight:500;">${TELEMEDICINE_URL}</a>
    <div style="font-size:12px;color:#666;margin-top:6px;">Use this link to meet your provider in the virtual waiting room at your appointment time.</div>
  </div>
  <p style="font-size:13px;color:#999;">Questions? Log in to your portal for details.</p>
</td></tr>
</table></td></tr></table></body></html>`

      if (parentEmail) await sendEmail(parentEmail, `Your provider update — ${visitType} on ${dateFormatted}`, familyHtml).catch(e => console.error('Reassigned family email failed:', e))
      if (parentPhone) await sendSMS(parentPhone, familySms).catch(e => console.error('Reassigned family SMS failed:', e))

      // Notify new provider
      const [newProv] = await sql`SELECT name, email, phone FROM providers WHERE id = ${String(newProviderId)}::uuid LIMIT 1`
      const providerSms = `${PRACTICE_NAME}: A case has been assigned to you — ${visitType} on ${dateFormatted} at ${time}. View: ${PORTAL_URL}/today`
      const providerHtml = `<div style="font-family:sans-serif;font-size:14px;color:#1A1A2E;line-height:1.6;max-width:520px;">
        <h2 style="font-size:18px;font-weight:600;">New case assigned to you</h2>
        <p>A <strong>${visitType}</strong> has been assigned to you for <strong>${dateFormatted} at ${time}</strong>.</p>
        <p>Please log in to the provider portal to view the patient details: <a href="${PORTAL_URL}/today" style="color:#7F77DD;">${PORTAL_URL}/today</a></p>
      </div>`
      if (newProv?.email) await sendEmail(newProv.email, `Case assigned to you — ${visitType} on ${dateFormatted}`, providerHtml).catch(e => console.error('Reassigned provider email failed:', e))
      if (newProv?.phone) await sendSMS(newProv.phone, providerSms).catch(e => console.error('Reassigned provider SMS failed:', e))

      return res.json({ ok: true })
    }

    // ── Shift claimed ─────────────────────────────────────────────────────────
    if (body.type === 'shift_claimed') {
      const { providerName, providerId, date, state } = body
      const dateFormatted = new Date(String(date) + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
      const stateLabel = state === 'NC' ? 'North Carolina' : state === 'SC' ? 'South Carolina' : state === 'VA' ? 'Virginia' : String(state)
      const [provRow] = await sql`SELECT practice_id FROM providers WHERE id = ${String(providerId)}::uuid LIMIT 1`
      const shiftPracticeId: string | undefined = provRow?.practice_id ?? undefined
      const desc = `the ${stateLabel} on-call shift for ${dateFormatted}`
      const shiftSms = `${PRACTICE_NAME}: ${providerName} picked up ${desc}. View: ${PORTAL_URL}/shifts`
      await notifyAllProviders(
        sql,
        shiftSms,
        `[Shift Pickup] ${providerName} claimed ${desc}`,
        (name) => pickupNotificationEmail({ recipientName: name, acceptedBy: String(providerName), description: desc }),
        String(providerId) ?? null,
        shiftPracticeId,
      )
      await notifyAdmins(sql, `${PRACTICE_NAME}: ${providerName} picked up ${desc}. View: ${PORTAL_URL}/admin/schedule`, shiftPracticeId)
      return res.json({ ok: true })
    }

    // ── Booking notification (default flow) ───────────────────────────────────
    const { bookingRequestId } = body

    const [booking] = await sql`SELECT * FROM booking_requests WHERE id = ${bookingRequestId}::uuid`
    if (!booking) throw new Error('Booking not found')

    const [family] = await sql`SELECT email, display_name, phone FROM family_profiles WHERE id = ${booking.family_id}::uuid`
    const [provider] = await sql`SELECT id, name, phone, email, practice_id FROM providers WHERE id = ${booking.confirmed_provider_id}::uuid`

    // Temporary debug — remove after confirming notifications work
    if (body._debug) {
      return res.json({ hasResend: !!RESEND_API_KEY, hasTwilioSid: !!TWILIO_SID, hasTwilioKey: !!TWILIO_API_KEY, hasTwilioSecret: !!TWILIO_API_SECRET, hasFrom: !!TWILIO_FROM, familyEmail: family?.email || null, providerEmail: provider?.email || null })
    }

    const dateFormatted = formatDate(booking.preferred_date)
    const practiceId = provider?.practice_id as string | undefined

    const notifSubject = `New appointment: ${booking.visit_type} — ${dateFormatted} at ${booking.preferred_time}`
    const notifHtml = providerNotificationEmail({
      visitType: booking.visit_type,
      date: dateFormatted,
      time: booking.preferred_time,
      zone: booking.zone || '',
      ref: booking.reference_code,
      providerName: provider?.name || 'Provider',
    })
    const notifSms = `${PRACTICE_NAME}: New appointment booked. View: ${PORTAL_URL}/today`

    // For CMA+telemedicine or In-home IV fluids: also notify the on-call MD/NP
    let onCallProviderId: string | null = null
    if (
      (booking.visit_type === 'CMA + telemedicine' || booking.visit_type === 'In-home IV fluids') &&
      booking.state && booking.preferred_date && booking.preferred_time && practiceId
    ) {
      const onCallRows = await sql`
        SELECT p.id, p.name, p.email, p.phone FROM on_call_schedule oc
        JOIN providers p ON p.id = oc.provider_id
        WHERE oc.practice_id = ${practiceId}::uuid
          AND oc.date = ${booking.preferred_date}::date
          AND oc.state = ${booking.state}
          AND (oc.start_time IS NULL OR oc.start_time <= ${booking.preferred_time}::time)
          AND (oc.end_time IS NULL OR oc.end_time > ${booking.preferred_time}::time)
        LIMIT 1`
      if (onCallRows.length) {
        const onCall = onCallRows[0]
        onCallProviderId = onCall.id as string
        if (onCall.id !== provider?.id) {
          if (onCall.email) await sendEmail(onCall.email as string, notifSubject, notifHtml).catch(e => console.error('On-call email failed:', e))
          if (onCall.phone) await sendSMS(onCall.phone as string, notifSms).catch(e => console.error('On-call SMS failed:', e))
        }
      }
    }

    // Unified booking notification rule: family + assigned provider + all admins (deduped)
    await notifyBookingParties(sql, {
      familyEmail: family?.email,
      familyPhone: family?.phone,
      provider: provider ? { id: provider.id, email: provider.email, phone: provider.phone } : null,
      practiceId,
      familySubject: `Confirmed: ${booking.visit_type} on ${dateFormatted}`,
      familyHtml: parentConfirmationEmail({
        visitType: booking.visit_type,
        date: dateFormatted,
        time: booking.preferred_time,
        provider: provider?.name || 'Your provider',
        zone: booking.zone || '',
        ref: booking.reference_code,
        displayName: family?.display_name,
      }),
      familySms: `${PRACTICE_NAME}: Your appointment is confirmed — ${booking.visit_type} on ${dateFormatted} at ${booking.preferred_time} with ${provider?.name || 'your provider'}. View details: ${PORTAL_URL}/family/dashboard`,
      providerSubject: notifSubject,
      providerHtml: notifHtml,
      providerSms: notifSms,
      adminSms: `${PRACTICE_NAME}: New appointment booked. View: ${PORTAL_URL}/admin/schedule`,
      excludeAdminIds: onCallProviderId ? [onCallProviderId] : [],
    })

    // IV fluids gets an extra family email with preparation instructions
    if (booking.visit_type === 'In-home IV fluids' && family?.email) {
      await sendEmail(family.email, `Your IV fluids request has been received — ${PRACTICE_NAME}`, ivFluidsEmailHtml()).catch(e => console.error('IV fluids email failed:', e))
    }

    return res.json({ ok: true })

  } catch (err) {
    console.error('Notification error:', err)
    return res.status(500).json({ ok: false, error: (err as Error).message })
  }
}
