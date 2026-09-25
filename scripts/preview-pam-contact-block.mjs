// Preview the new "text Pam" booking-contact block across several
// parent-facing confirmation email templates. Renders each to a temp
// HTML file and opens them in the browser. Self-contained — no
// imports from api/ (Vercel forbids api/lib), so the template code
// below is duplicated from api/notifications.ts specifically for
// this preview. Delete this script anytime; it's only for visual QA.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const PORTAL_URL = 'https://phc-team.com'
const PRACTICE_NAME = 'Pediatric Housecalls'
const TELEMEDICINE_URL = 'https://doxy.me/pediatric-housecalls'
const VENMO_HANDLE = '@Melissa-Jesse'

function logo(accentColor) {
  return `<span style="display:inline-flex;align-items:center;gap:6px;">
    <span style="width:22px;height:22px;background:${accentColor};border-radius:5px;display:inline-block;"></span>
    <span>Pediatric Housecalls</span>
  </span>`
}

function row(icon, label, value) {
  return `<table width="100%" style="margin-bottom:10px;"><tr>
    <td width="24" style="font-size:16px;vertical-align:top;padding-top:1px;">${icon}</td>
    <td style="font-size:12px;color:#999;text-transform:uppercase;letter-spacing:0.05em;width:80px;vertical-align:top;padding-top:3px;">${label}</td>
    <td style="font-size:14px;font-weight:500;color:#1A1A2E;">${value}</td>
  </tr></table>`
}

// This is the block being previewed — identical to
// pamBookingContactBlock() in api/notifications.ts.
function pamBookingContactBlock() {
  return `<div style="margin-top:20px;padding:14px 16px;background:#FAFAF8;border:1px solid #E8E8E4;border-radius:10px;text-align:center;font-size:13px;color:#1A1A2E;line-height:1.6;">
    Have questions about this appointment booking or need help with something?<br>
    <strong>Text Pam at <a href="sms:+17045604169" style="color:#7F77DD;text-decoration:none;">704-560-4169</a></strong>
  </div>`
}

// ── parentConfirmationEmail (main appointment booking) ─────────────
function parentConfirmationEmail(data) {
  const greeting = data.displayName ? `Hi ${data.displayName.split(' ')[0]},` : 'Hi there,'
  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#FAFAF8;font-family:'DM Sans',system-ui,sans-serif;color:#1A1A2E;">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px;">
<table width="100%" style="max-width:520px;background:#fff;border-radius:16px;border:1px solid #E8E8E4;overflow:hidden;">
  <tr><td style="background:#1A1A2E;padding:28px 32px;">
    <div style="font-size:20px;font-weight:600;color:#fff;letter-spacing:-0.3px;">${logo('#7F77DD')}</div>
    <div style="font-size:12px;color:rgba(255,255,255,0.4);margin-top:4px;text-transform:uppercase;letter-spacing:0.06em;">Appointment confirmed</div>
  </td></tr>
  <tr><td style="padding:32px;">
    <p style="font-size:15px;margin:0 0 20px;line-height:1.6;">${greeting}<br><br>
    Your appointment is confirmed. We look forward to seeing you!</p>
    <table width="100%" style="background:#FAFAF8;border-radius:12px;border:1px solid #E8E8E4;margin-bottom:24px;">
      <tr><td style="padding:20px;">
        <div style="font-size:18px;font-weight:600;margin-bottom:16px;">${data.visitType}</div>
        ${row('📅', 'Date', data.date)}
        ${row('🕐', 'Time', data.time)}
        ${row('👩‍⚕️', 'Provider', data.provider)}
        ${row('📍', 'Zone', data.zone)}
      </td></tr>
    </table>
    <div style="background:#E1F5EE;border-radius:10px;padding:14px 16px;margin-bottom:20px;font-size:13px;color:#085041;">
      <strong>In-home visit:</strong> Your provider will arrive within 15 minutes of your scheduled time. Please be available at your address.
    </div>
    <div style="background:#FAEEDA;border-radius:10px;padding:14px 16px;margin-bottom:24px;font-size:12px;color:#633806;">
      <strong>Cancellation policy:</strong> Cancellations within 2 hours of an in-person visit are subject to a $75 fee. To cancel, log in to your account at <a href="${PORTAL_URL}/family/dashboard" style="color:#633806;">${PORTAL_URL}</a>.
    </div>
    <a href="${PORTAL_URL}/family/dashboard" style="display:inline-block;background:#1A1A2E;color:#fff;text-decoration:none;padding:12px 24px;border-radius:10px;font-size:14px;font-weight:500;">View my appointments</a>
    ${pamBookingContactBlock()}
  </td></tr>
  <tr><td style="padding:20px 32px;border-top:1px solid #E8E8E4;font-size:11px;color:#999;text-align:center;">
    Booking reference: <strong style="font-family:monospace;">${data.ref}</strong>
  </td></tr>
</table>
</td></tr></table>
</body></html>`
}

// ── cprApprovedEmail (Melissa's approval, sent to family) ──────────
function cprApprovedEmail(data) {
  const greeting = data.displayName ? `Hi ${data.displayName.split(' ')[0]},` : 'Hi there,'
  const totalCost = data.participantCount * 80
  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#FAFAF8;font-family:'DM Sans',system-ui,sans-serif;color:#1A1A2E;">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px;">
<table width="100%" style="max-width:560px;background:#fff;border-radius:16px;border:1px solid #E8E8E4;overflow:hidden;">
  <tr><td style="background:#1A1A2E;padding:28px 32px;">
    <div style="font-size:20px;font-weight:600;color:#fff;">${logo('#E74C3C')}</div>
    <div style="font-size:12px;color:rgba(255,255,255,0.4);margin-top:4px;text-transform:uppercase;letter-spacing:0.06em;">CPR class confirmed</div>
  </td></tr>
  <tr><td style="padding:32px;">
    <p style="font-size:15px;margin:0 0 8px;line-height:1.7;">${greeting}</p>
    <p style="font-size:15px;margin:0 0 20px;line-height:1.7;">Thank you for registering for an in-home CPR class.</p>
    <table width="100%" style="background:#FAFAF8;border-radius:12px;border:1px solid #E8E8E4;margin-bottom:28px;">
      <tr><td style="padding:20px;">
        ${row('📅', 'Date', data.date)}
        ${row('🕐', 'Time', data.time)}
        ${row('👩‍🏫', 'Instructor', 'Melissa Jesse')}
        ${row('📍', 'Address', data.address)}
        ${row('👥', 'Participants', `${data.participantCount} person${data.participantCount > 1 ? 's' : ''}`)}
      </td></tr>
    </table>
    <div style="background:#E8F8F5;border-radius:12px;border:1px solid #A9DFBF;padding:18px 20px;margin-bottom:28px;">
      <div style="font-size:14px;font-weight:600;color:#1E8449;margin-bottom:8px;">💳 Payment</div>
      <p style="font-size:13px;color:#1E8449;margin:0;line-height:1.55;">
        Please send <strong>$${totalCost}</strong> ($80 × ${data.participantCount} person${data.participantCount > 1 ? 's' : ''}) via Venmo to <strong>${VENMO_HANDLE}</strong> before your class.
      </p>
    </div>
    <p style="font-size:15px;margin:0 0 4px;line-height:1.7;">Thank you,</p>
    <p style="font-size:15px;font-weight:600;margin:0 0 2px;">Melissa Jesse</p>
    <p style="font-size:13px;color:#666;margin:0 0 24px;line-height:1.6;">Pediatric Nurse Practitioner and Certified BLS and Heartsaver CPR Instructor</p>
    <p style="font-size:13px;color:#888;margin:0;line-height:1.6;">Questions about the CPR class or content? Reach Melissa directly at <a href="mailto:deeringmel@me.com" style="color:#555;">deeringmel@me.com</a></p>
    ${pamBookingContactBlock()}
  </td></tr>
  <tr><td style="padding:20px 32px;border-top:1px solid #E8E8E4;font-size:11px;color:#999;text-align:center;">
    Booking reference: <strong style="font-family:monospace;">${data.ref}</strong>
  </td></tr>
</table>
</td></tr></table>
</body></html>`
}

// ── Waitlist family confirmation (inline in handler) ───────────────
function waitlistFamilyConfirmation(data) {
  const greeting = data.displayName ? `Hi ${data.displayName.split(' ')[0]},` : 'Hi there,'
  const stateLabel = data.state === 'NC' ? 'North Carolina' : data.state === 'SC' ? 'South Carolina' : 'your state'
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
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
    <div style="margin-bottom:8px;"><span style="font-size:11px;color:#999;text-transform:uppercase;">Visit type</span><br><span style="font-size:14px;font-weight:500;">${data.visitType}</span></div>
    <div><span style="font-size:11px;color:#999;text-transform:uppercase;">Preferred time</span><br><span style="font-size:14px;font-weight:500;">${data.preferredTime}</span></div>
  </div>
  <div style="background:#FAEEDA;border-radius:10px;padding:14px 16px;font-size:13px;color:#633806;">
    You'll receive a text and email the moment a provider picks up your request. No action is needed from you in the meantime.
  </div>
  ${pamBookingContactBlock()}
</td></tr>
</table></td></tr></table></body></html>`
}

const samples = [
  { name: 'main-appointment-confirmation.html', html: parentConfirmationEmail({
      visitType: 'In-home sick visit',
      date: 'Wednesday, September 24, 2026',
      time: '2:30 PM',
      provider: 'Dr. Sara DuMond',
      zone: 'Charlotte South',
      ref: 'PHC-A7F3K2',
      displayName: 'Marcus Reyes',
  }) },
  { name: 'cpr-class-approved.html', html: cprApprovedEmail({
      displayName: 'Jenna Chen',
      visitType: 'CPR Class (in-home)',
      date: 'Saturday, October 4, 2026',
      time: '10:00 AM',
      address: '4321 Willow Way, Charlotte NC 28210',
      participantCount: 4,
      participantNames: 'Marcus Reyes, Jenna Chen, Cara Kim, Jonah Kim',
      ref: 'CPR-8Z4X-7T2M',
  }) },
  { name: 'waitlist-confirmation.html', html: waitlistFamilyConfirmation({
      displayName: 'Cara Kim',
      state: 'NC',
      visitType: 'In-home sick visit',
      preferredTime: 'Afternoon',
  }) },
]

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pam-contact-preview-'))
const files = samples.map(s => {
  const p = path.join(dir, s.name)
  fs.writeFileSync(p, s.html, 'utf8')
  return p
})
console.log('Wrote:', files.join('\n       '))
try { execFileSync('open', files) } catch (e) { console.error('open failed:', e.message) }
