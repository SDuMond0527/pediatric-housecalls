import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
)

const RESEND_API_KEY   = Deno.env.get('RESEND_API_KEY') || ''
const TWILIO_SID       = Deno.env.get('TWILIO_ACCOUNT_SID') || ''
const TWILIO_API_KEY   = Deno.env.get('TWILIO_API_KEY_SID') || ''
const TWILIO_API_SECRET = Deno.env.get('TWILIO_API_KEY_SECRET') || ''
const TWILIO_FROM      = Deno.env.get('TWILIO_FROM_NUMBER') || ''
const FROM_EMAIL       = Deno.env.get('FROM_EMAIL') || 'appointments@phcbooking.com'
const PORTAL_URL       = Deno.env.get('PORTAL_URL') || 'https://phcbooking.com'

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
  if (!res.ok) console.error('Email error:', await res.text())
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
      'Authorization': `Basic ${btoa(`${TWILIO_API_KEY}:${TWILIO_API_SECRET}`)}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: formData,
  })
  if (!res.ok) console.error('SMS error:', await res.text())
}

// ── Email templates ───────────────────────────────────────────────────────────

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

function row(icon: string, label: string, value: string) {
  return `<table width="100%" style="margin-bottom:10px;"><tr>
    <td width="24" style="font-size:16px;vertical-align:top;padding-top:1px;">${icon}</td>
    <td style="font-size:12px;color:#999;text-transform:uppercase;letter-spacing:0.05em;width:80px;vertical-align:top;padding-top:3px;">${label}</td>
    <td style="font-size:14px;font-weight:500;color:#1A1A2E;">${value}</td>
  </tr></table>`
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr + 'T12:00:00')
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
}

// ── Admin SMS helper ──────────────────────────────────────────────────────────

async function notifyAdmins(smsBody: string) {
  const { data: admins } = await supabase
    .from('providers').select('id, phone, email').eq('role', 'admin')
  for (const admin of admins || []) {
    if (admin.email) await sendEmail(admin.email, '[PHC Admin] ' + smsBody, `<p style="font-family:sans-serif;font-size:14px;color:#1A1A2E;">${smsBody}</p>`)
    if (admin.phone) await sendSMS(admin.phone, smsBody)
  }
}

// ── Notify all active providers ───────────────────────────────────────────────

async function notifyAllProviders(
  smsBody: string,
  emailSubject: string,
  makeHtml: (providerName: string) => string,
  excludeId?: string | null,
) {
  const { data: providers } = await supabase
    .from('providers').select('id, name, phone, email').or('is_active.eq.true,role.eq.admin')
  for (const prov of providers || []) {
    if (excludeId && prov.id === excludeId) continue
    if (prov.email) await sendEmail(prov.email, emailSubject, makeHtml(prov.name))
    if (prov.phone) await sendSMS(prov.phone, smsBody)
  }
}

// ── Pickup notification email (waitlist or broadcast) ─────────────────────────

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

// ── Main handler ──────────────────────────────────────────────────────────────

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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const body = await req.json()

    // ── Waitlist notification ──────────────────────────────────────────────────
    if (body.type === 'waitlist') {
      const { data: entry } = await supabase
        .from('waitlist_entries').select('*').eq('id', body.waitlistEntryId).single()
      if (!entry) throw new Error('Waitlist entry not found')

      const stateLabel = entry.state === 'NC' ? 'North Carolina' : entry.state === 'SC' ? 'South Carolina' : entry.state === 'VA' ? 'Virginia' : entry.state || 'your state'
      const smsBody = `PediatricHousecalls: New waitlist entry in ${stateLabel} (zip ${entry.zip})${entry.visit_type ? ` — ${entry.visit_type}` : ''}. View: ${PORTAL_URL}/admin/waitlist`

      // Get all active providers (excluding admins)
      const { data: stateProviders } = await supabase
        .from('providers').select('id, name, role, phone, email, states').neq('role', 'admin').eq('is_active', true)

      for (const prov of stateProviders || []) {
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

      // Also notify admins
      const { data: admins } = await supabase.from('providers').select('id, phone, email').eq('role', 'admin')
      for (const admin of admins || []) {
        if (admin.email) await sendEmail(admin.email, `[Admin Waitlist] New entry — zip ${entry.zip}, ${stateLabel}`, waitlistProviderEmail({ zip: entry.zip, state: entry.state, visitType: entry.visit_type, preferredTime: entry.preferred_time_window, providerName: 'Admin' }))
        if (admin.phone) await sendSMS(admin.phone, smsBody)
      }

      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // ── Waitlist accepted notification ────────────────────────────────────────
    if (body.type === 'waitlist_accepted') {
      const { data: entry } = await supabase
        .from('waitlist_entries').select('*').eq('id', body.waitlistEntryId).single()
      if (!entry) throw new Error('Entry not found')

      const { data: family } = await supabase
        .from('family_profiles').select('email, display_name').eq('id', entry.family_id).single()

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

      await notifyAdmins(`[PHC] Waitlist patient booked: ${body.providerName} · ${dateFormatted} at ${body.time}`)

      // Notify all providers that this patient was picked up
      const pickupDesc = `a waitlist patient (zip ${entry.zip}${entry.state ? `, ${entry.state}` : ''})`
      const pickupSms = `PediatricHousecalls: ${body.providerName} has picked up ${pickupDesc}.`
      await notifyAllProviders(
        pickupSms,
        `[Pickup] ${body.providerName} accepted a waitlist patient — zip ${entry.zip}`,
        (name) => pickupNotificationEmail({ recipientName: name, acceptedBy: body.providerName, description: pickupDesc }),
        body.providerId ?? null,
      )

      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // ── Slot opened (appointment cancelled → notify waitlist families) ─────────
    if (body.type === 'slot_opened') {
      const { providerId, zone, visitType, date, time, matchingZips } = body
      let providerName: string = body.providerName || ''
      if (!providerName && providerId) {
        const { data: prov } = await supabase.from('providers').select('name').eq('id', providerId).single()
        providerName = prov?.name || 'Your provider'
      }

      if (!matchingZips?.length) {
        return new Response(JSON.stringify({ ok: true, notified: 0 }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        })
      }

      const { data: entries } = await supabase
        .from('waitlist_entries')
        .select('id, family_id, zip')
        .in('zip', matchingZips)
        .eq('status', 'waiting')

      if (!entries?.length) {
        return new Response(JSON.stringify({ ok: true, notified: 0 }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        })
      }

      const dateFormatted = formatDate(date)

      for (const entry of entries) {
        await supabase.from('slot_offers').insert({
          waitlist_entry_id: entry.id,
          provider_id: providerId,
          provider_name: providerName,
          visit_type: visitType,
          offered_date: date,
          offered_time: time,
          zone,
          status: 'pending',
        })

        const { data: fam } = await supabase
          .from('family_profiles')
          .select('email, display_name')
          .eq('id', entry.family_id)
          .single()

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

      return new Response(JSON.stringify({ ok: true, notified: entries.length }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // ── Slot offer accepted (family claims open slot) ─────────────────────────
    if (body.type === 'slot_offer_accepted') {
      const { data: offer } = await supabase
        .from('slot_offers')
        .select('*')
        .eq('id', body.offerId)
        .single()

      if (!offer || offer.status !== 'pending') {
        return new Response(JSON.stringify({ ok: false, error: 'Offer not available' }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        })
      }

      const { data: entry } = await supabase
        .from('waitlist_entries')
        .select('family_id, zip')
        .eq('id', offer.waitlist_entry_id)
        .single()

      // Convert offered_time ("2:00 PM") to 24h for appointment
      const [t, ampm] = offer.offered_time.split(' ')
      let [h, m] = t.split(':').map(Number)
      if (ampm === 'PM' && h !== 12) h += 12
      if (ampm === 'AM' && h === 12) h = 0
      const time24 = `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`

      // Create provider-side appointment
      await supabase.from('appointments').insert({
        provider_id: offer.provider_id,
        visit_type: offer.visit_type || 'In-home sick visit',
        zone: offer.zone || '',
        scheduled_time: time24,
        scheduled_date: offer.offered_date,
        status: 'upcoming',
        notes: `From waitlist slot offer · Zip: ${entry?.zip || ''}`,
      })

      // Create family-side booking record so it shows in their dashboard
      await supabase.from('booking_requests').insert({
        family_id: entry?.family_id,
        child_ids: [],
        visit_type: offer.visit_type || 'In-home sick visit',
        zone: offer.zone,
        preferred_date: offer.offered_date,
        preferred_time: offer.offered_time,
        status: 'confirmed',
        confirmed_provider_id: offer.provider_id,
        reference_code: offer.id.slice(0, 8).toUpperCase(),
      })

      // Mark offer and waitlist entry
      await supabase.from('slot_offers').update({ status: 'accepted' }).eq('id', offer.id)
      await supabase.from('waitlist_entries').update({ status: 'converted' }).eq('id', offer.waitlist_entry_id)

      // Notify family
      const { data: fam } = await supabase
        .from('family_profiles')
        .select('email, display_name')
        .eq('id', entry?.family_id)
        .single()

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

      // Notify provider
      const { data: offerProv } = await supabase.from('providers').select('email').eq('id', offer.provider_id).single()
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

      await notifyAdmins(`[PHC] Waitlist slot claimed: ${offer.provider_name} · ${offer.visit_type || 'Visit'} · ${dateFormatted} at ${offer.offered_time} · ${offer.zone || ''}`)

      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // ── Manual appointment added by provider ─────────────────────────────────
    if (body.type === 'appointment_added') {
      const { providerName, visitType, zone, date, time, parentEmail } = body
      const dateFormatted = formatDate(date)
      await notifyAdmins(`[PHC] Appointment added: ${providerName} · ${visitType} · ${dateFormatted} at ${time} · ${zone}`)

      if (visitType === 'In-home IV fluids' && parentEmail) {
        const ivHtml = ivFluidsEmailHtml()
        await sendEmail(parentEmail, 'Your IV fluids request has been received — Pediatric Housecalls', ivHtml)
      }

      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // ── Broadcast created — notify all providers + admins ────────────────────
    if (body.type === 'broadcast') {
      const { data: bc } = await supabase.from('broadcasts').select('*').eq('id', body.broadcastId).single()
      if (!bc) throw new Error('Broadcast not found')

      const stateLabel = bc.state === 'NC' ? 'North Carolina' : bc.state === 'SC' ? 'South Carolina' : bc.state === 'VA' ? 'Virginia' : bc.state || 'your state'
      const smsBody = `PediatricHousecalls: Broadcast from ${bc.created_by_name}${bc.is_urgent ? ' [URGENT]' : ''} — ${bc.patient_first_name} ${bc.patient_last_name}, ${bc.request_type}. Complaint: ${bc.complaint}. View: ${PORTAL_URL}/broadcasts`

      // Include all active providers AND all admins (admins may have is_active=false but still need to receive)
      const { data: providers } = await supabase
        .from('providers').select('id, name, phone, email').or('is_active.eq.true,role.eq.admin')

      for (const prov of providers || []) {
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

      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // ── Broadcast accepted — notify all providers ─────────────────────────────
    if (body.type === 'broadcast_accepted') {
      const { data: bc } = await supabase.from('broadcasts').select('*').eq('id', body.broadcastId).single()
      if (!bc) {
        return new Response(JSON.stringify({ ok: true }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
      }

      const acceptedBy = body.acceptedByName || 'A provider'
      const patientName = `${bc.patient_first_name} ${bc.patient_last_name}`
      const pickupDesc = `the broadcast for ${patientName} (${bc.request_type})`
      const smsBody = `PediatricHousecalls: ${acceptedBy} has picked up ${pickupDesc}.`

      await notifyAllProviders(
        smsBody,
        `[Pickup] ${acceptedBy} accepted a broadcast — ${patientName}`,
        (name) => pickupNotificationEmail({ recipientName: name, acceptedBy, description: pickupDesc }),
        body.acceptedById ?? null,
      )

      // Notify parent if contact info was provided on the broadcast
      const familyPhone: string | null = bc.family_phone ?? null
      const familyEmail: string | null = bc.family_email ?? null
      const acceptedDate: string = body.acceptedDate || new Date().toISOString().split('T')[0]
      const acceptedTime: string = body.acceptedTime || '12:00'

      // Format time as 12hr for the message
      const [hRaw, mRaw] = acceptedTime.split(':').map(Number)
      const ampm = hRaw >= 12 ? 'PM' : 'AM'
      const h12 = hRaw % 12 || 12
      const timeFormatted = `${h12}:${mRaw.toString().padStart(2, '0')} ${ampm}`

      // Determine if today
      const today = new Date().toISOString().split('T')[0]
      const whenStr = acceptedDate === today ? 'today' : `on ${acceptedDate}`

      const isVirtual = bc.request_type !== 'In-person house call'

      if (isVirtual) {
        const parentSms = `PediatricHousecalls: ${acceptedBy} will evaluate your child by video telemedicine visit at ${timeFormatted} ${whenStr}. At that time, please log into the Pediatric Housecalls virtual waiting room and the provider will begin your video visit from there: https://doxy.me/v2/check-in/pediatrichousecalls/`
        const parentEmailHtml = `<div style="font-family:sans-serif;font-size:14px;color:#1A1A2E;line-height:1.6;">
          <p>${acceptedBy} will evaluate your child by video telemedicine visit at <strong>${timeFormatted} ${whenStr}</strong>.</p>
          <p>At that time, please log into the Pediatric Housecalls virtual waiting room and the provider will begin your video visit from there:</p>
          <p><a href="https://doxy.me/v2/check-in/pediatrichousecalls/" style="color:#7F77DD;font-weight:600;">https://doxy.me/v2/check-in/pediatrichousecalls/</a></p>
        </div>`
        if (familyPhone) await sendSMS(familyPhone, parentSms)
        if (familyEmail) await sendEmail(familyEmail, `Your telemedicine visit is confirmed — ${timeFormatted} ${whenStr}`, parentEmailHtml)
      } else {
        const parentSms = `PediatricHousecalls: ${acceptedBy} will come to your home for a house call visit at ${timeFormatted} ${whenStr}. Please have your child ready at that time.`
        const parentEmailHtml = `<div style="font-family:sans-serif;font-size:14px;color:#1A1A2E;line-height:1.6;">
          <p>${acceptedBy} will come to your home for a house call visit at <strong>${timeFormatted} ${whenStr}</strong>.</p>
          <p>Please have your child ready at that time.</p>
        </div>`
        if (familyPhone) await sendSMS(familyPhone, parentSms)
        if (familyEmail) await sendEmail(familyEmail, `Your house call visit is confirmed — ${timeFormatted} ${whenStr}`, parentEmailHtml)
      }

      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // ── Post-visit thank-you + Google review email ────────────────────────────
    if (body.type === 'post_visit_email') {
      const { appointmentId } = body
      const { data: appt } = await supabase
        .from('appointments').select('*').eq('id', appointmentId).single()
      if (!appt) return new Response(JSON.stringify({ ok: false, error: 'Appointment not found' }), { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })

      const { data: prov } = await supabase
        .from('providers').select('name').eq('id', appt.provider_id).single()

      // Try to get family email from notes first (PARENTEMAIL field)
      const notes: string = appt.notes || ''
      const parentEmailMatch = notes.split('|').find((p: string) => p.startsWith('PARENTEMAIL:'))
      const parentEmailFromNotes = parentEmailMatch?.replace('PARENTEMAIL:', '').trim() || null

      const patientMatch = notes.split('|').find((p: string) => p.startsWith('PATIENT:'))
      const childFirstName = patientMatch?.replace('PATIENT:', '').trim().split(' ')[0] || null

      let familyEmail: string | null = parentEmailFromNotes
      let familyDisplayName: string | null = null

      // Fall back to looking up via booking_request
      if (!familyEmail && appt.charm_appointment_id) {
        const { data: br } = await supabase
          .from('booking_requests')
          .select('family_id')
          .or(`charm_appointment_id.eq.${appt.charm_appointment_id},charm_appointment_id.like.%${appt.charm_appointment_id}%`)
          .limit(1).single()
        if (br?.family_id) {
          const { data: fam } = await supabase
            .from('family_profiles').select('email, display_name').eq('id', br.family_id).single()
          familyEmail = fam?.email || null
          familyDisplayName = fam?.display_name || null
        }
      }

      if (!familyEmail) {
        return new Response(JSON.stringify({ ok: false, error: 'No family email found' }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        })
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
        })
      )

      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // ── CPR class booking ─────────────────────────────────────────────────────
    if (body.type === 'cpr_booking') {
      const { bookingRequestId } = body
      const { data: booking } = await supabase
        .from('booking_requests').select('*').eq('id', bookingRequestId).single()
      if (!booking) throw new Error('Booking not found')

      const { data: family } = await supabase
        .from('family_profiles').select('email, display_name').eq('id', booking.family_id).single()

      const dateFormatted = formatDate(booking.preferred_date)

      // Parse participant info from notes (stored as PARTICIPANTS:N|NAMES:... in booking notes)
      const notesStr: string = booking.notes || ''
      const participantMatch = notesStr.match(/PARTICIPANTS:(\d+)/)
      const participantCount = participantMatch ? parseInt(participantMatch[1]) : 1
      const namesMatch = notesStr.match(/NAMES:([^|]+)/)
      const participantNames = namesMatch ? namesMatch[1].trim() : ''
      const addrMatch = notesStr.match(/ADDR:([^|]+)/)
      const address = addrMatch ? addrMatch[1].trim() : ''

      // Send confirmation to family
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

      // Send notification to Melissa
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

      // Notify admins
      await notifyAdmins(`[PHC] CPR class booked: ${booking.visit_type} · ${dateFormatted} at ${booking.preferred_time} · ${participantCount} person(s). Ref: ${booking.reference_code}`)

      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // ── Appointment cancelled — notify provider + admins ─────────────────────
    if (body.type === 'booking_cancelled') {
      const { providerId, visitType, date, time, zone, familyName } = body
      const dateFormatted = formatDate(date)
      const subject = `Appointment cancelled — ${visitType} on ${dateFormatted}`
      const smsText = `PediatricHousecalls: ${familyName} cancelled their ${visitType} on ${dateFormatted} at ${time}${zone ? `, ${zone}` : ''}.`

      // Email + SMS to assigned provider
      if (providerId) {
        const { data: prov } = await supabase.from('providers').select('name, phone, email').eq('id', providerId).single()
        const providerName = prov?.name || 'Provider'
        if (prov?.email) await sendEmail(prov.email, subject, cancellationNotificationEmail({ recipientName: providerName, visitType, date: dateFormatted, time, zone: zone || '', familyName }))
        if (prov?.phone) await sendSMS(prov.phone, smsText)
      }

      // Email + SMS to all admins
      const { data: admins } = await supabase.from('providers').select('id, phone, email').eq('role', 'admin')
      for (const admin of admins || []) {
        if (admin.email) await sendEmail(admin.email, `[Admin] ${subject}`, cancellationNotificationEmail({ recipientName: 'Admin', visitType, date: dateFormatted, time, zone: zone || '', familyName }))
        if (admin.phone) await sendSMS(admin.phone, smsText)
      }

      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // ── Booking notification (existing flow) ──────────────────────────────────
    const { bookingRequestId } = body

    // Load booking
    const { data: booking } = await supabase
      .from('booking_requests').select('*').eq('id', bookingRequestId).single()
    if (!booking) throw new Error('Booking not found')

    // Load family
    const { data: family } = await supabase
      .from('family_profiles').select('email, display_name').eq('id', booking.family_id).single()

    // Load provider
    const { data: provider } = await supabase
      .from('providers').select('id, name, phone, email').eq('id', booking.confirmed_provider_id).single()

    const providerEmail = provider?.email || ''

    const dateFormatted = formatDate(booking.preferred_date)

    // ── Parent confirmation email ──
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

    const notifSubject = `New appointment: ${booking.visit_type} — ${dateFormatted} at ${booking.preferred_time}`
    const notifHtml = providerNotificationEmail({
      visitType: booking.visit_type,
      date: dateFormatted,
      time: booking.preferred_time,
      zone: booking.zone || '',
      ref: booking.reference_code,
      providerName: provider?.name || 'Provider',
    })
    const smsBody = `PediatricHousecalls: New booking — ${booking.visit_type}, ${dateFormatted} at ${booking.preferred_time}, ${booking.zone}. Provider: ${provider?.name || '—'}. Ref: ${booking.reference_code}. View: ${PORTAL_URL}/admin/schedule`

    // ── Assigned provider email + SMS ──
    if (providerEmail) {
      await sendEmail(providerEmail, notifSubject, notifHtml)
    }
    if (provider?.phone) {
      await sendSMS(provider.phone, smsBody.replace(`View: ${PORTAL_URL}/admin/schedule`, `View: ${PORTAL_URL}/today`))
    }

    // ── Admin notifications — every booking, every provider ──
    const { data: admins } = await supabase
      .from('providers').select('id, phone, email').eq('role', 'admin')

    for (const admin of admins || []) {
      if (admin.email) await sendEmail(admin.email, `[Admin] ${notifSubject}`, notifHtml)
      if (admin.phone) await sendSMS(admin.phone, smsBody)
    }

    return new Response(JSON.stringify({ ok: true }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  } catch (err) {
    console.error('Notification error:', err)
    return new Response(JSON.stringify({ ok: false, error: (err as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
