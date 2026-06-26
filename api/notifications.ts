import type { VercelRequest, VercelResponse } from '@vercel/node'
import { neon } from '@neondatabase/serverless'

const RESEND_API_KEY    = process.env.RESEND_API_KEY || ''
const TWILIO_SID        = process.env.TWILIO_ACCOUNT_SID || ''
const TWILIO_API_KEY    = process.env.TWILIO_API_KEY_SID || ''
const TWILIO_API_SECRET = process.env.TWILIO_API_KEY_SECRET || ''
const TWILIO_FROM       = process.env.TWILIO_FROM_NUMBER || ''
const FROM_EMAIL        = 'appointments@phcbooking.com'
const PORTAL_URL        = 'https://phcbooking.com'

// ── Email via Resend ──────────────────────────────────────────────────────────

async function sendEmail(to: string, subject: string, html: string) {
  if (!RESEND_API_KEY || RESEND_API_KEY === 'PLACEHOLDER') {
    console.log(`[EMAIL SKIPPED — no key] To: ${to} | Subject: ${subject}`)
    return
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: `Pediatric Housecalls <${FROM_EMAIL}>`, to, subject, html }),
  })
  if (!res.ok) {
    const msg = await res.text()
    console.error('Email error:', msg)
    throw new Error(`Email failed: ${msg}`)
  }
}

// ── SMS via Twilio ────────────────────────────────────────────────────────────

async function sendSMS(to: string, body: string) {
  if (!TWILIO_SID || !TWILIO_API_KEY) {
    console.log(`[SMS SKIPPED — no credentials] To: ${to} | Body: ${body}`)
    return
  }
  const formData = new URLSearchParams({ From: TWILIO_FROM, To: to, Body: body })
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

  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#FAFAF8;font-family:'DM Sans',system-ui,sans-serif;color:#1A1A2E;">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px;">
<table width="100%" style="max-width:520px;background:#fff;border-radius:16px;border:1px solid #E8E8E4;overflow:hidden;">

  <!-- Header -->
  <tr><td style="background:#1A1A2E;padding:28px 32px;">
    <div style="font-size:20px;font-weight:600;color:#fff;letter-spacing:-0.3px;">Pediatric<span style="color:#7F77DD;">Housecalls</span></div>
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
      <strong>Video visit:</strong> When it is time for your scheduled video visit, please click on the following link to log into the secure Pediatric Housecalls telemedicine waiting room:<br><br>
      <a href="https://doxy.me/v2/check-in/pediatrichousecalls/" style="display:inline-block;background:#7F77DD;color:#fff;text-decoration:none;padding:10px 20px;border-radius:8px;font-size:13px;font-weight:600;">Join telemedicine waiting room →</a><br><br>
      <span style="font-size:12px;color:#5550A0;">Or copy this link: https://doxy.me/v2/check-in/pediatrichousecalls/</span>
    </div>` : isVirtual ? `
    <div style="background:#EEEDFE;border-radius:10px;padding:14px 16px;margin-bottom:20px;font-size:13px;color:#3C3489;">
      <strong>Text visit:</strong> Your provider will send you a text message at your scheduled time.
    </div>` : `
    <div style="background:#E1F5EE;border-radius:10px;padding:14px 16px;margin-bottom:20px;font-size:13px;color:#085041;">
      <strong>In-home visit:</strong> Your provider will arrive within 15 minutes of your scheduled time. Please be available at your address.
    </div>`}

    <div style="background:#FAEEDA;border-radius:10px;padding:14px 16px;margin-bottom:24px;font-size:12px;color:#633806;">
      <strong>Cancellation policy:</strong> Cancellations within 2 hours of an in-person visit are subject to a $75 fee. To cancel, log in to your account at <a href="${PORTAL_URL}/family/dashboard" style="color:#633806;">${PORTAL_URL}</a>.
    </div>

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
    <div style="font-size:20px;font-weight:600;color:#fff;letter-spacing:-0.3px;">Pediatric<span style="color:#7F77DD;">Housecalls</span></div>
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
  const REVIEW_URL = 'https://g.page/r/CeBMcqioHWlQEBM/review'

  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#FAFAF8;font-family:'DM Sans',system-ui,sans-serif;color:#1A1A2E;">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px;">
<table width="100%" style="max-width:520px;background:#fff;border-radius:16px;border:1px solid #E8E8E4;overflow:hidden;">

  <!-- Header -->
  <tr><td style="background:#1A1A2E;padding:28px 32px;">
    <div style="font-size:20px;font-weight:600;color:#fff;letter-spacing:-0.3px;">Pediatric<span style="color:#1D9E75;">Housecalls</span></div>
    <div style="font-size:12px;color:rgba(255,255,255,0.4);margin-top:4px;text-transform:uppercase;letter-spacing:0.06em;">Thank you for your visit</div>
  </td></tr>

  <!-- Body -->
  <tr><td style="padding:32px;">
    <p style="font-size:15px;margin:0 0 20px;line-height:1.65;">${greeting}<br><br>
    Thank you so much for trusting Pediatric Housecalls with ${childPhrase} care${data.dateFormatted ? ` on ${data.dateFormatted}` : ' today'}. It is truly our honor to be there for your family right in the comfort of your own home.</p>

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
        <a href="${REVIEW_URL}" style="display:inline-block;background:#F9AB00;color:#1A1A2E;text-decoration:none;padding:14px 28px;border-radius:10px;font-size:15px;font-weight:600;">
          ⭐&nbsp; Leave a Google Review
        </a>
      </td></tr>
    </table>

    <p style="font-size:13px;color:#888;margin:0;line-height:1.6;">With gratitude,<br><strong style="color:#1A1A2E;">The Pediatric Housecalls Team</strong></p>
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
    <div style="font-size:20px;font-weight:600;color:#fff;letter-spacing:-0.3px;">Pediatric<span style="color:#7F77DD;">Housecalls</span></div>
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
    <div style="font-size:20px;font-weight:600;color:#fff;letter-spacing:-0.3px;">Pediatric<span style="color:#7F77DD;">Housecalls</span></div>
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
      To reschedule, please visit <a href="https://phcbooking.com/family/book" style="color:#993556;">phcbooking.com</a> or reply to this email.
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
  const isHeartsaver = data.visitType === 'In-home CPR class (Heartsaver)'
  const elearningUrl = isHeartsaver
    ? 'https://elearning.heart.org/course/777'
    : 'https://elearning.heart.org/course/437'
  const courseLabel = isHeartsaver ? 'Heartsaver' : 'BLS'
  const totalCost = data.participantCount * 80

  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#FAFAF8;font-family:'DM Sans',system-ui,sans-serif;color:#1A1A2E;">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px;">
<table width="100%" style="max-width:520px;background:#fff;border-radius:16px;border:1px solid #E8E8E4;overflow:hidden;">

  <!-- Header -->
  <tr><td style="background:#1A1A2E;padding:28px 32px;">
    <div style="font-size:20px;font-weight:600;color:#fff;letter-spacing:-0.3px;">Pediatric<span style="color:#E74C3C;">Housecalls</span></div>
    <div style="font-size:12px;color:rgba(255,255,255,0.4);margin-top:4px;text-transform:uppercase;letter-spacing:0.06em;">CPR class confirmed</div>
  </td></tr>

  <!-- Body -->
  <tr><td style="padding:32px;">
    <p style="font-size:15px;margin:0 0 20px;line-height:1.6;">${greeting}<br><br>
    Your <strong>${data.visitType}</strong> is confirmed! We're excited to teach CPR skills to you and your family.</p>

    <!-- Appointment details -->
    <table width="100%" style="background:#FAFAF8;border-radius:12px;border:1px solid #E8E8E4;margin-bottom:24px;">
      <tr><td style="padding:20px;">
        <div style="font-size:18px;font-weight:600;margin-bottom:16px;">${data.visitType}</div>
        ${row('📅', 'Date', data.date)}
        ${row('🕐', 'Time', data.time)}
        ${row('👩‍🏫', 'Instructor', 'Melissa Jesse')}
        ${row('📍', 'Address', data.address)}
        ${row('👥', 'Participants', `${data.participantCount} person${data.participantCount > 1 ? 's' : ''}`)}
        ${data.participantNames ? row('📋', 'Attendees', data.participantNames) : ''}
      </td></tr>
    </table>

    <!-- E-learning -->
    <div style="background:#FDEDEC;border-radius:12px;border:1px solid #F5B7B1;padding:18px 20px;margin-bottom:20px;">
      <div style="font-size:14px;font-weight:600;color:#922B21;margin-bottom:8px;">📚 Complete your ${courseLabel} e-learning first</div>
      <p style="font-size:13px;color:#922B21;margin:0 0 12px;line-height:1.55;">
        <strong>All attendees must complete the online portion before class day.</strong> This typically takes about 1.5–2 hours. Please plan accordingly.
      </p>
      <a href="${elearningUrl}" style="display:inline-block;background:#E74C3C;color:#fff;text-decoration:none;padding:10px 20px;border-radius:8px;font-size:13px;font-weight:600;">
        Start ${courseLabel} e-learning →
      </a>
    </div>

    <!-- Payment -->
    <div style="background:#E8F8F5;border-radius:12px;border:1px solid #A9DFBF;padding:18px 20px;margin-bottom:20px;">
      <div style="font-size:14px;font-weight:600;color:#1E8449;margin-bottom:8px;">💳 Payment</div>
      <p style="font-size:13px;color:#1E8449;margin:0;line-height:1.55;">
        Please send <strong>$${totalCost}</strong> ($80 × ${data.participantCount} person${data.participantCount > 1 ? 's' : ''}) via Venmo to <strong>@Pediatric-Housecalls</strong> before your class.
      </p>
    </div>

    <!-- Email Melissa -->
    <div style="background:#EBF5FB;border-radius:12px;border:1px solid #AED6F1;padding:18px 20px;margin-bottom:24px;">
      <div style="font-size:14px;font-weight:600;color:#1A5276;margin-bottom:8px;">📧 Send attendee names to Melissa</div>
      <p style="font-size:13px;color:#1A5276;margin:0;line-height:1.55;">
        Please email the full names of all attendees to Melissa at <a href="mailto:deeringmel@me.com" style="color:#1A5276;font-weight:600;">deeringmel@me.com</a> so she can prepare the right number of completion cards.
      </p>
    </div>

    <!-- Instructor note -->
    <div style="background:#F4ECF7;border-radius:10px;padding:14px 16px;margin-bottom:24px;font-size:13px;color:#6C3483;">
      <strong>Note:</strong> Melissa will arrive <strong>30 minutes early</strong> to set up equipment. Please have a clear space in your home (a living room or large room works great).
    </div>

    <p style="font-size:13px;color:#888;margin:0;line-height:1.6;">Questions? Reply to this email or reach Melissa directly at <a href="mailto:deeringmel@me.com" style="color:#555;">deeringmel@me.com</a></p>
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
    <div style="font-size:20px;font-weight:600;color:#fff;">Pediatric<span style="color:#E74C3C;">Housecalls</span></div>
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
  <div style="font-size:20px;font-weight:600;color:#fff;">Pediatric<span style="color:#1D9E75;">Housecalls</span></div>
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
  <div style="font-size:20px;font-weight:600;color:#fff;">Pediatric<span style="color:#1D9E75;">Housecalls</span></div>
  <div style="font-size:12px;color:rgba(255,255,255,0.4);margin-top:4px;text-transform:uppercase;letter-spacing:0.06em;">IV fluids request received</div>
</td></tr>
<tr><td style="padding:32px;">
  <p style="font-size:15px;margin:0 0 16px;line-height:1.6;">Your request for in-home IV fluids has been received.</p>
  <p style="font-size:14px;margin:0 0 16px;line-height:1.7;color:#444;">One of our physicians or nurse practitioners will review the request and will schedule to consult with you via video telemedicine visit shortly. You will receive another email with the link to log into the Pediatric Housecalls virtual visit room.</p>
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
    <div style="font-size:20px;font-weight:600;color:#fff;">Pediatric<span style="color:#EF9F27;">Housecalls</span></div>
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

// ── Admin helpers ─────────────────────────────────────────────────────────────

async function notifyAdmins(sql: any, smsBody: string, practiceId?: string) {
  const admins = practiceId
    ? await sql`SELECT id, phone, email FROM providers WHERE role = 'admin' AND practice_id = ${practiceId}::uuid`
    : await sql`SELECT id, phone, email FROM providers WHERE role = 'admin'`
  for (const admin of admins) {
    if (admin.email) await sendEmail(admin.email, '[PHC Admin] ' + smsBody, `<p style="font-family:sans-serif;font-size:14px;color:#1A1A2E;">${smsBody}</p>`)
    if (admin.phone) await sendSMS(admin.phone, smsBody)
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
    if (prov.email) await sendEmail(prov.email, emailSubject, makeHtml(prov.name))
    if (prov.phone) await sendSMS(prov.phone, smsBody)
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
      const [entry] = await sql`SELECT * FROM waitlist_entries WHERE id = ${body.waitlistEntryId}::uuid`
      if (!entry) throw new Error('Waitlist entry not found')

      const stateLabel = entry.state === 'NC' ? 'North Carolina' : entry.state === 'SC' ? 'South Carolina' : entry.state === 'VA' ? 'Virginia' : entry.state || 'your state'
      const smsBody = `PediatricHousecalls: New waitlist entry. View: ${PORTAL_URL}/admin/waitlist`

      const stateProviders = await sql`SELECT id, name, role, phone, email, states FROM providers WHERE role != 'admin' AND is_active = true`
      for (const prov of stateProviders) {
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
          )
        }
        if (prov.phone) await sendSMS(prov.phone, smsBody)
      }

      const admins = await sql`SELECT id, phone, email FROM providers WHERE role = 'admin'`
      for (const admin of admins) {
        if (admin.email) await sendEmail(admin.email, `[Admin Waitlist] New entry — zip ${entry.zip}, ${stateLabel}`, waitlistProviderEmail({ zip: entry.zip, state: entry.state, visitType: entry.visit_type, preferredTime: entry.preferred_time_window, providerName: 'Admin' }))
        if (admin.phone) await sendSMS(admin.phone, smsBody)
      }

      return res.json({ ok: true })
    }

    // ── Waitlist accepted notification ────────────────────────────────────────
    if (body.type === 'waitlist_accepted') {
      const [entry] = await sql`SELECT * FROM waitlist_entries WHERE id = ${body.waitlistEntryId}::uuid`
      if (!entry) throw new Error('Entry not found')

      const [family] = await sql`SELECT email, display_name FROM family_profiles WHERE id = ${entry.family_id}::uuid`

      const greeting = family?.display_name ? `Hi ${family.display_name.split(' ')[0]},` : 'Hi there,'
      const dateFormatted = new Date(body.date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })

      const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#FAFAF8;font-family:'DM Sans',system-ui,sans-serif;color:#1A1A2E;">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px;">
<table width="100%" style="max-width:520px;background:#fff;border-radius:16px;border:1px solid #E8E8E4;overflow:hidden;">
<tr><td style="background:#1A1A2E;padding:28px 32px;">
  <div style="font-size:20px;font-weight:600;color:#fff;">Pediatric<span style="color:#1D9E75;">Housecalls</span></div>
  <div style="font-size:12px;color:rgba(255,255,255,0.4);margin-top:4px;text-transform:uppercase;letter-spacing:0.06em;">Good news — a provider has accepted your request</div>
</td></tr>
<tr><td style="padding:32px;">
  <p style="font-size:15px;margin:0 0 20px;line-height:1.6;">${greeting}<br><br>
  A Pediatric Housecalls provider has accepted your waitlist request and scheduled an appointment for you!</p>
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

      if (family?.email) {
        await sendEmail(family.email, `Your appointment is confirmed — ${dateFormatted} at ${body.time}`, html)
      }

      const waitlistPracticeId: string | undefined = entry.practice_id ?? undefined
      await notifyAdmins(sql, `PediatricHousecalls: Waitlist patient booked. View: ${PORTAL_URL}/admin/waitlist`, waitlistPracticeId)

      const pickupDesc = `a waitlist patient (zip ${entry.zip}${entry.state ? `, ${entry.state}` : ''})`
      const pickupSms = `PediatricHousecalls: A waitlist patient has been picked up. View: ${PORTAL_URL}/broadcasts`
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

      if (!matchingZips?.length) {
        return res.json({ ok: true, notified: 0 })
      }

      const entries = slotPracticeId
        ? await sql`SELECT id, family_id, zip FROM waitlist_entries WHERE zip = ANY(${matchingZips}::text[]) AND status = 'waiting' AND practice_id = ${slotPracticeId}::uuid`
        : await sql`SELECT id, family_id, zip FROM waitlist_entries WHERE zip = ANY(${matchingZips}::text[]) AND status = 'waiting'`

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
  <div style="font-size:20px;font-weight:600;color:#fff;">Pediatric<span style="color:#1D9E75;">Housecalls</span></div>
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

        await sendEmail(fam.email, `A slot opened up — ${dateFormatted} at ${time} with ${providerName}`, html)
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

      const [fam] = await sql`SELECT email, display_name FROM family_profiles WHERE id = ${entry?.family_id}::uuid`
      const dateFormatted = formatDate(offer.offered_date)

      if (fam?.email) {
        const greeting = fam.display_name ? `Hi ${fam.display_name.split(' ')[0]},` : 'Hi there,'
        const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#FAFAF8;font-family:'DM Sans',system-ui,sans-serif;color:#1A1A2E;">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px;">
<table width="100%" style="max-width:520px;background:#fff;border-radius:16px;border:1px solid #E8E8E4;overflow:hidden;">
<tr><td style="background:#1A1A2E;padding:28px 32px;">
  <div style="font-size:20px;font-weight:600;color:#fff;">Pediatric<span style="color:#1D9E75;">Housecalls</span></div>
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

        await sendEmail(fam.email, `Confirmed: ${offer.visit_type || 'Appointment'} on ${dateFormatted}`, html)
      }

      const [offerProv] = await sql`SELECT email FROM providers WHERE id = ${offer.provider_id}::uuid`
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
        )
      }

      await notifyAdmins(sql, `PediatricHousecalls: Waitlist slot claimed. View: ${PORTAL_URL}/admin/schedule`, offerPracticeId ?? undefined)

      return res.json({ ok: true })
    }

    // ── Manual appointment added by provider ──────────────────────────────────
    if (body.type === 'appointment_added') {
      const { providerName, visitType, zone, date, time, parentEmail } = body
      const dateFormatted = formatDate(date)
      await notifyAdmins(sql, `PediatricHousecalls: Appointment added. View: ${PORTAL_URL}/admin/schedule`, undefined)

      if (visitType === 'In-home IV fluids' && parentEmail) {
        await sendEmail(parentEmail, 'Your IV fluids request has been received — Pediatric Housecalls', ivFluidsEmailHtml())
      }

      return res.json({ ok: true })
    }

    // ── Broadcast created — notify all providers + admins ─────────────────────
    if (body.type === 'broadcast') {
      const [bc] = await sql`SELECT * FROM broadcasts WHERE id = ${body.broadcastId}::uuid`
      if (!bc) throw new Error('Broadcast not found')

      const stateLabel = bc.state === 'NC' ? 'North Carolina' : bc.state === 'SC' ? 'South Carolina' : bc.state === 'VA' ? 'Virginia' : bc.state || 'your state'
      const smsBody = `PediatricHousecalls:${bc.is_urgent ? ' [URGENT]' : ''} New broadcast request. View: ${PORTAL_URL}/broadcasts`

      const providers = await sql`SELECT id, name, phone, email FROM providers WHERE is_active = true OR role = 'admin'`
      for (const prov of providers) {
        const firstName = prov.name.split(' ').slice(-2)[0]
        if (prov.email) {
          const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#FAFAF8;font-family:'DM Sans',system-ui,sans-serif;color:#1A1A2E;">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px;">
<table width="100%" style="max-width:520px;background:#fff;border-radius:16px;border:1px solid #E8E8E4;overflow:hidden;">
<tr><td style="background:#1A1A2E;padding:28px 32px;">
  <div style="font-size:20px;font-weight:600;color:#fff;">Pediatric<span style="color:#7F77DD;">Housecalls</span></div>
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
          await sendEmail(prov.email, `${bc.is_urgent ? '[URGENT] ' : ''}Broadcast: ${bc.patient_first_name} ${bc.patient_last_name} — ${bc.request_type}`, html)
        }
        if (prov.phone) await sendSMS(prov.phone, smsBody)
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
      const smsBody = `PediatricHousecalls: A broadcast has been picked up. View: ${PORTAL_URL}/broadcasts`

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
        const parentSms = `PediatricHousecalls: Your appointment is confirmed. Log in to view details: ${PORTAL_URL}/family/login`
        const parentEmailHtml = `<div style="font-family:sans-serif;font-size:14px;color:#1A1A2E;line-height:1.6;">
          <p>${acceptedBy} will evaluate your child by video telemedicine visit at <strong>${timeFormatted} ${whenStr}</strong>.</p>
          <p>At that time, please log into the Pediatric Housecalls virtual waiting room and the provider will begin your video visit from there:</p>
          <p><a href="https://doxy.me/v2/check-in/pediatrichousecalls/" style="color:#7F77DD;font-weight:600;">https://doxy.me/v2/check-in/pediatrichousecalls/</a></p>
        </div>`
        if (familyPhone) await sendSMS(familyPhone, parentSms)
        if (familyEmail) await sendEmail(familyEmail, `Your telemedicine visit is confirmed — ${timeFormatted} ${whenStr}`, parentEmailHtml)
      } else {
        const parentSms = `PediatricHousecalls: Your appointment is confirmed. Log in to view details: ${PORTAL_URL}/family/login`
        const parentEmailHtml = `<div style="font-family:sans-serif;font-size:14px;color:#1A1A2E;line-height:1.6;">
          <p>${acceptedBy} will come to your home for a house call visit at <strong>${timeFormatted} ${whenStr}</strong>.</p>
          <p>Please have your child ready at that time.</p>
        </div>`
        if (familyPhone) await sendSMS(familyPhone, parentSms)
        if (familyEmail) await sendEmail(familyEmail, `Your house call visit is confirmed — ${timeFormatted} ${whenStr}`, parentEmailHtml)
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
        'Thank you for choosing Pediatric Housecalls ⭐',
        postVisitEmail({
          displayName: familyDisplayName,
          childName: childFirstName,
          providerName: prov?.name || 'Your provider',
          dateFormatted,
          instructions: instructions || null,
        })
      )

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
        )
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
      )

      await notifyAdmins(sql, `PediatricHousecalls: New CPR class booked. View: ${PORTAL_URL}/admin/schedule`, booking.practice_id ?? undefined)

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
      const smsToParent = `PediatricHousecalls: Your appointment has been cancelled. Please log in to rebook: ${PORTAL_URL}/family/login`

      // Notify parent
      if (parentEmail) await sendEmail(parentEmail, subject, appointmentCancelledByProviderEmail({ displayName, visitType: appt.visit_type, date: dateFormatted, time: timeFormatted, zone: appt.zone || '' }))
      if (parentPhone) await sendSMS(parentPhone, smsToParent)

      // Notify admins (Pam)
      const adminSms = `PediatricHousecalls: An appointment was cancelled. View: ${PORTAL_URL}/admin/schedule`
      const admins = await sql`SELECT id, phone, email FROM providers WHERE role = 'admin'`
      for (const admin of admins) {
        if (admin.email) await sendEmail(admin.email, `[Admin] Provider cancelled: ${appt.visit_type} — ${dateFormatted}`, cancellationNotificationEmail({ recipientName: 'Admin', visitType: appt.visit_type, date: dateFormatted, time: timeFormatted, zone: appt.zone || '', familyName: displayName || 'Family' }))
        if (admin.phone) await sendSMS(admin.phone, adminSms)
      }

      return res.json({ ok: true })
    }

    // ── Appointment cancelled — notify provider + admins ──────────────────────
    if (body.type === 'booking_cancelled') {
      const { providerId, visitType, date, time, zone, familyName } = body
      const dateFormatted = formatDate(date)
      const subject = `Appointment cancelled — ${visitType} on ${dateFormatted}`
      const smsText = `PediatricHousecalls: An appointment was cancelled. View: ${PORTAL_URL}/admin/schedule`

      if (providerId) {
        const [prov] = await sql`SELECT name, phone, email FROM providers WHERE id = ${providerId}::uuid`
        const providerName = prov?.name || 'Provider'
        if (prov?.email) await sendEmail(prov.email, subject, cancellationNotificationEmail({ recipientName: providerName, visitType, date: dateFormatted, time, zone: zone || '', familyName }))
        if (prov?.phone) await sendSMS(prov.phone, smsText)
      }

      const admins = await sql`SELECT id, phone, email FROM providers WHERE role = 'admin'`
      for (const admin of admins) {
        if (admin.email) await sendEmail(admin.email, `[Admin] ${subject}`, cancellationNotificationEmail({ recipientName: 'Admin', visitType, date: dateFormatted, time, zone: zone || '', familyName }))
        if (admin.phone) await sendSMS(admin.phone, smsText)
      }

      return res.json({ ok: true })
    }

    // ── Booking notification (default flow) ───────────────────────────────────
    const { bookingRequestId } = body

    const [booking] = await sql`SELECT * FROM booking_requests WHERE id = ${bookingRequestId}::uuid`
    if (!booking) throw new Error('Booking not found')

    const [family] = await sql`SELECT email, display_name FROM family_profiles WHERE id = ${booking.family_id}::uuid`
    const [provider] = await sql`SELECT id, name, phone, email FROM providers WHERE id = ${booking.confirmed_provider_id}::uuid`

    // Temporary debug — remove after confirming notifications work
    if (body._debug) {
      return res.json({ hasResend: !!RESEND_API_KEY, hasTwilioSid: !!TWILIO_SID, hasTwilioKey: !!TWILIO_API_KEY, hasTwilioSecret: !!TWILIO_API_SECRET, hasFrom: !!TWILIO_FROM, familyEmail: family?.email || null, providerEmail: provider?.email || null })
    }

    const providerEmail = provider?.email || ''
    const dateFormatted = formatDate(booking.preferred_date)

    if (family?.email) {
      await sendEmail(
        family.email,
        `Confirmed: ${booking.visit_type} on ${dateFormatted}`,
        parentConfirmationEmail({
          visitType: booking.visit_type,
          date: dateFormatted,
          time: booking.preferred_time,
          provider: provider?.name || 'Your provider',
          zone: booking.zone || '',
          ref: booking.reference_code,
          displayName: family.display_name,
        })
      )
      if (booking.visit_type === 'In-home IV fluids') {
        await sendEmail(family.email, 'Your IV fluids request has been received — Pediatric Housecalls', ivFluidsEmailHtml())
      }
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
      await sendEmail(parentEmail, `A note from ${providerName} — Pediatric Housecalls`, html)
      return res.json({ ok: true })
    }

    const notifSubject = `New appointment: ${booking.visit_type} — ${dateFormatted} at ${booking.preferred_time}`
    const notifHtml = providerNotificationEmail({
      visitType: booking.visit_type,
      date: dateFormatted,
      time: booking.preferred_time,
      zone: booking.zone || '',
      ref: booking.reference_code,
      providerName: provider?.name || 'Provider',
    })
    const smsBody = `PediatricHousecalls: New appointment booked. View: ${PORTAL_URL}/today`

    // Assigned provider
    if (providerEmail) await sendEmail(providerEmail, notifSubject, notifHtml)
    if (provider?.phone) await sendSMS(provider.phone, smsBody)

    // All admins (including Pam) — every booking, every provider
    const admins = await sql`SELECT id, phone, email FROM providers WHERE role = 'admin'`
    for (const admin of admins) {
      if (admin.id === provider?.id) continue  // don't double-notify if admin is also the assigned provider
      if (admin.email) await sendEmail(admin.email, notifSubject, notifHtml)
      if (admin.phone) await sendSMS(admin.phone, smsBody)
    }

    return res.json({ ok: true })

  } catch (err) {
    console.error('Notification error:', err)
    return res.status(500).json({ ok: false, error: (err as Error).message })
  }
}
