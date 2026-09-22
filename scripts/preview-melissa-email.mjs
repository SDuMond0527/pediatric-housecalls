// Local preview of the CPR-class request email that goes to Melissa Jesse.
// Renders the template to a temp HTML file and opens it in the browser.
// Update this whenever cprMelissaEmail changes in api/notifications.ts so
// we can visually verify the buttons render before Sara runs a real test.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const PORTAL_URL = 'https://phc-team.com'

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

function cprMelissaEmail(data) {
  const totalCost = data.participantCount * 80
  const approveUrl = `${PORTAL_URL}/cpr-requests?booking=${encodeURIComponent(data.bookingId)}&action=approve`
  const declineUrl = `${PORTAL_URL}/cpr-requests?booking=${encodeURIComponent(data.bookingId)}&action=decline`
  const bulletproofButton = (label, url, bg) => `
    <table cellpadding="0" cellspacing="0" border="0" align="center" style="margin:0 6px;">
      <tr>
        <td align="center" bgcolor="${bg}" style="border-radius:10px;">
          <a href="${url}" target="_blank" style="display:inline-block;padding:14px 26px;font-family:'DM Sans',system-ui,sans-serif;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:10px;">
            ${label}
          </a>
        </td>
      </tr>
    </table>`
  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#FAFAF8;font-family:'DM Sans',system-ui,sans-serif;color:#1A1A2E;">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px;">
<table width="100%" style="max-width:520px;background:#fff;border-radius:16px;border:1px solid #E8E8E4;overflow:hidden;">
  <tr><td style="background:#1A1A2E;padding:28px 32px;">
    <div style="font-size:20px;font-weight:600;color:#fff;">${logo('#E74C3C')}</div>
    <div style="font-size:12px;color:rgba(255,255,255,0.4);margin-top:4px;text-transform:uppercase;letter-spacing:0.06em;">CPR class request — needs your approval</div>
  </td></tr>
  <tr><td style="padding:28px 32px 20px;">
    <p style="font-size:15px;margin:0 0 20px;line-height:1.6;">Hi Melissa,<br><br>
    A new <strong>${data.visitType}</strong> has been <strong>requested</strong>. Approve or decline below — the family is waiting on your confirmation.</p>

    <table cellpadding="0" cellspacing="0" border="0" align="center" style="margin:0 auto 22px auto;">
      <tr>
        <td>${bulletproofButton('✓ Approve request', approveUrl, '#1D9E75')}</td>
        <td>${bulletproofButton('✕ Decline request', declineUrl, '#E74C3C')}</td>
      </tr>
    </table>
    <p style="font-size:12px;color:#666;margin:0 0 24px;line-height:1.5;text-align:center;">
      Both buttons open this request in your dashboard. Approve prompts you to enter the exact class start time; decline lets you add a note for the family.
    </p>

    <table width="100%" style="background:#FAFAF8;border-radius:12px;border:1px solid #E8E8E4;margin-bottom:24px;">
      <tr><td style="padding:20px;">
        ${row('📅', 'Requested date', data.date)}
        ${row('🕐', 'Requested time', data.time)}
        ${row('📍', 'Address', data.address)}
        ${row('👥', 'Participants', `${data.participantCount} person${data.participantCount > 1 ? 's' : ''} · $${totalCost} total`)}
        ${data.participantNames ? row('📋', 'Attendee names', data.participantNames) : ''}
        ${row('👤', 'Requested by', `${data.familyName} (${data.familyEmail})`)}
        ${data.familyPhone ? row('📞', 'Contact phone', data.familyPhone) : ''}
      </td></tr>
    </table>

    <div style="background:#FFF4E5;border-radius:10px;padding:14px 16px;font-size:13px;color:#8A4B00;margin-bottom:18px;">
      If you approve: the family gets the e-learning link + Venmo payment details in a follow-up email. If you decline: they get a short "can't accommodate" note with any reason you add.
    </div>

    <p style="font-size:12px;color:#888;text-align:center;margin:0;line-height:1.6;">
      Buttons not working? Open this link:<br>
      <a href="${approveUrl.replace('&action=approve','')}" style="color:#555;word-break:break-all;">${PORTAL_URL}/cpr-requests?booking=${data.bookingId}</a>
    </p>
  </td></tr>
  <tr><td style="padding:20px 32px;border-top:1px solid #E8E8E4;font-size:11px;color:#999;text-align:center;">
    Request reference: <strong style="font-family:monospace;">${data.ref}</strong>
  </td></tr>
</table>
</td></tr></table>
</body></html>`
}

const sample = cprMelissaEmail({
  visitType: 'CPR Class (in-home, up to 6 people)',
  date: 'Saturday, October 4, 2026',
  time: 'Morning',
  address: '4321 Willow Way, Charlotte NC 28210',
  participantCount: 4,
  participantNames: 'Marcus Reyes, Jenna Reyes, Cara Kim, Jonah Kim',
  familyName: 'Marcus Reyes',
  familyEmail: 'marcus.reyes@example.com',
  familyPhone: '704-555-0139',
  ref: 'CPR-8Z4X-7T2M',
  bookingId: '00000000-0000-4000-8000-000000000001',
})

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'melissa-preview-'))
const p = path.join(dir, 'melissa-cpr-request.html')
fs.writeFileSync(p, sample, 'utf8')
console.log('Wrote:', p)
try { execFileSync('open', [p]) } catch (e) { console.error('open failed:', e.message) }
