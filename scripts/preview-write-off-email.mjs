// Local preview for the "write-off reviewed" email (approved + denied variants).
// Renders each template to a temp HTML file and opens in the browser via `open`.
// Uses inline copies of the tiny helpers from api/notifications.ts so this stays
// self-contained (no build/tsx runtime needed).
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

function writeOffReviewedEmail(data) {
  const greeting = data.requesterFirstName ? `Hi ${data.requesterFirstName},` : 'Hi,'
  const sideLabel = data.side === 'statement' ? 'patient statement' : 'claim'
  const accent = data.approved ? '#1D9E75' : '#E74C3C'
  const headerLabel = data.approved ? 'Write-off approved' : 'Write-off denied'
  const bodyLead = data.approved
    ? `${data.reviewerName} approved your ${sideLabel} write-off request. The ${sideLabel} has been voided${data.side === 'statement' ? ' — the patient owes $0 and it has dropped off AR' : ' — the claim has been written off and dropped off AR'}.`
    : `${data.reviewerName} denied your ${sideLabel} write-off request. The ${sideLabel} remains active — please review and re-submit if appropriate, or take a different action.`
  const banner = data.approved
    ? `<div style="background:#E1F5EE;border-radius:10px;border:1px solid #A6E0CC;padding:14px 16px;font-size:13px;color:#085041;margin-bottom:24px;">Voided by ${data.reviewerName} — no further action needed.</div>`
    : `<div style="background:#FDEDEC;border-radius:10px;border:1px solid #F5B7B1;padding:14px 16px;font-size:13px;color:#922B21;margin-bottom:24px;">${data.reviewerName} left this ${sideLabel} active. Follow up as needed.</div>`
  const noteBlock = data.reviewNote ? `<div style="background:#FAFAF8;border-radius:10px;border:1px solid #E8E8E4;padding:14px 16px;font-size:13px;color:#1A1A2E;margin-bottom:24px;">
        <div style="font-weight:600;margin-bottom:4px;">${data.reviewerName}'s note:</div>
        <div style="white-space:pre-wrap;">${data.reviewNote}</div>
      </div>` : ''
  const requestNoteBlock = data.requestNote
    ? `<div style="font-size:12px;color:#666;margin-top:4px;font-style:italic;">Your original note: "${data.requestNote}"</div>`
    : ''
  const linkPath = data.side === 'statement' ? '/admin/statements' : '/admin/claims'
  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#FAFAF8;font-family:'DM Sans',system-ui,sans-serif;color:#1A1A2E;">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px;">
<table width="100%" style="max-width:520px;background:#fff;border-radius:16px;border:1px solid #E8E8E4;overflow:hidden;">

  <tr><td style="background:#1A1A2E;padding:28px 32px;">
    <div style="font-size:20px;font-weight:600;color:#fff;letter-spacing:-0.3px;">${logo(accent)}</div>
    <div style="font-size:12px;color:rgba(255,255,255,0.4);margin-top:4px;text-transform:uppercase;letter-spacing:0.06em;">${headerLabel}</div>
  </td></tr>

  <tr><td style="padding:32px;">
    <p style="font-size:15px;margin:0 0 16px;line-height:1.7;">${greeting}</p>
    <p style="font-size:15px;margin:0 0 20px;line-height:1.7;">${bodyLead}</p>

    ${banner}

    <table width="100%" style="background:#FAFAF8;border-radius:12px;border:1px solid #E8E8E4;margin-bottom:24px;">
      <tr><td style="padding:20px;">
        ${row('👤', 'Patient', `${data.patientName}${data.chartNumber ? ` (${data.chartNumber})` : ''}`)}
        ${row('💵', 'Amount', data.amount)}
        ${data.serviceDate ? row('📅', 'Service date', data.serviceDate) : ''}
        ${data.reasonLabel ? row('🏷️', 'Reason', data.reasonLabel) : ''}
      </td></tr>
    </table>

    ${noteBlock}
    ${requestNoteBlock}

    <a href="${PORTAL_URL}${linkPath}" style="display:inline-block;background:${accent};color:#fff;text-decoration:none;padding:10px 20px;border-radius:8px;font-size:13px;font-weight:600;margin-top:12px;">Open ${sideLabel}s</a>
  </td></tr>

  <tr><td style="padding:20px 32px;border-top:1px solid #E8E8E4;font-size:11px;color:#999;text-align:center;">
    You're getting this because you submitted the write-off request.
  </td></tr>

</table>
</td></tr></table>
</body></html>`
}

const samples = [
  { name: 'approved-statement.html', data: {
    approved: true, requesterFirstName: 'Andrea', reviewerName: 'Sara DuMond', side: 'statement',
    patientName: 'Marta Chen', chartNumber: 'PHC-01423', amount: '$185.00',
    serviceDate: 'Monday, August 4, 2026', reasonLabel: 'Courtesy / hardship',
    requestNote: 'Family expressed hardship; single mom, lost insurance mid-July.',
    reviewNote: null,
  }},
  { name: 'denied-statement.html', data: {
    approved: false, requesterFirstName: 'Andrea', reviewerName: 'Sara DuMond', side: 'statement',
    patientName: 'Marta Chen', chartNumber: 'PHC-01423', amount: '$185.00',
    serviceDate: 'Monday, August 4, 2026', reasonLabel: 'Bad debt',
    requestNote: '90 days past due, no response to 3 statements.',
    reviewNote: 'Please try one more call before writing off — mom mentioned at last visit she was between jobs.',
  }},
  { name: 'approved-claim.html', data: {
    approved: true, requesterFirstName: 'Andrea', reviewerName: 'Sara DuMond', side: 'claim',
    patientName: 'Kai Patel', chartNumber: 'PHC-01288', amount: '$247.00',
    serviceDate: 'Tuesday, July 22, 2026', reasonLabel: 'Timely filing exceeded',
    requestNote: 'BCBS denied — past 180-day filing window; we caught it too late.',
    reviewNote: null,
  }},
  { name: 'denied-claim.html', data: {
    approved: false, requesterFirstName: 'Andrea', reviewerName: 'Sara DuMond', side: 'claim',
    patientName: 'Kai Patel', chartNumber: 'PHC-01288', amount: '$247.00',
    serviceDate: 'Tuesday, July 22, 2026', reasonLabel: 'Billing error',
    requestNote: 'Wrong CPT — we billed a 99213 but should have been 99214.',
    reviewNote: "Don't write off — corrected claim with the right CPT and let's resubmit.",
  }},
]

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'writeoff-preview-'))
const files = samples.map(s => {
  const p = path.join(dir, s.name)
  fs.writeFileSync(p, writeOffReviewedEmail(s.data), 'utf8')
  return p
})
console.log('Wrote:', files.join('\n       '))
try { execFileSync('open', files) } catch (e) { console.error('open failed:', e.message) }
