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
  if (!RESEND_API_KEY || RESEND_API_KEY === 'PLACEHOLDER') return
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: `${PRACTICE_NAME} <${FROM_EMAIL}>`, to, subject, html }),
  })
  if (!res.ok) console.error('[notifySlotOpened] email error:', await res.text())
}

async function sendSMS(to: string, body: string) {
  if (!TWILIO_SID || !TWILIO_KEY) return
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${TWILIO_KEY}:${TWILIO_SECRET}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ From: TWILIO_FROM, To: to, Body: body }),
  })
  if (!res.ok) console.error('[notifySlotOpened] SMS error:', await res.text())
}

function to12h(time24: string): string {
  const [hStr, mStr] = time24.split(':')
  let h = parseInt(hStr, 10)
  const m = mStr || '00'
  const ampm = h >= 12 ? 'PM' : 'AM'
  h = h % 12 || 12
  return `${h}:${m} ${ampm}`
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr + 'T12:00:00')
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
}

function logo(): string {
  const parts = PRACTICE_NAME.trim().split(/\s+/)
  if (parts.length === 1) return `<span style="color:#fff;">${PRACTICE_NAME}</span>`
  return `${parts.slice(0, -1).join(' ')}<span style="color:#1D9E75;">${parts[parts.length - 1]}</span>`
}

function rowHtml(icon: string, label: string, value: string) {
  return `<table width="100%" style="margin-bottom:10px;"><tr>
    <td width="24" style="font-size:16px;vertical-align:top;padding-top:1px;">${icon}</td>
    <td style="font-size:12px;color:#999;text-transform:uppercase;letter-spacing:0.05em;width:80px;vertical-align:top;padding-top:3px;">${label}</td>
    <td style="font-size:14px;font-weight:500;color:#1A1A2E;">${value}</td>
  </tr></table>`
}

export interface SlotOpenedArgs {
  practiceId: string
  providerId: string
  zone: string
  visitType: string
  date: string        // YYYY-MM-DD
  scheduledTime: string  // 24h "14:00" — converted to 12h for display + storage
}

/**
 * Called when an appointment is cancelled. Finds waitlist entries in the same
 * zone, creates a slot_offer record for each, and notifies the families by
 * email and SMS. Returns the number of families notified.
 */
export async function notifySlotOpened(args: SlotOpenedArgs): Promise<number> {
  const { practiceId, providerId, zone, visitType, date, scheduledTime } = args
  const sql = neon(process.env.DATABASE_URL!)

  const time12h = scheduledTime.includes(' ') ? scheduledTime : to12h(scheduledTime)

  // Look up provider name
  const [prov] = await sql`SELECT name FROM providers WHERE id = ${providerId}::uuid LIMIT 1`
  const providerName: string = prov?.name || 'Your provider'

  // Find all zip codes in this zone
  const [zoneRow] = await sql`
    SELECT zip_codes FROM practice_zones
    WHERE zone_name = ${zone} AND practice_id = ${practiceId}::uuid
    LIMIT 1
  `
  const matchingZips: string[] = zoneRow?.zip_codes ?? []
  if (!matchingZips.length) {
    console.log('[notifySlotOpened] no zips found for zone:', zone)
    return 0
  }

  // Find families currently waiting in this zone
  const entries = await sql`
    SELECT id, family_id, zip FROM waitlist_entries
    WHERE zip = ANY(${matchingZips}::text[])
      AND status = 'waiting'
      AND practice_id = ${practiceId}::uuid
    ORDER BY created_at ASC
  `
  if (!entries.length) return 0

  const dateFormatted = formatDate(date)
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()

  let notified = 0
  for (const entry of entries) {
    try {
      await sql`
        INSERT INTO slot_offers
          (practice_id, waitlist_entry_id, provider_id, provider_name, visit_type, offered_date, offered_time, zone, status, expires_at)
        VALUES
          (${practiceId}::uuid, ${entry.id}::uuid, ${providerId}::uuid, ${providerName}, ${visitType}, ${date}::date, ${time12h}, ${zone}, 'pending', ${expiresAt}::timestamptz)
      `
      await sql`UPDATE waitlist_entries SET status = 'offered' WHERE id = ${entry.id}::uuid`

      const [fam] = await sql`SELECT email, display_name, phone FROM family_profiles WHERE id = ${entry.family_id}::uuid`
      if (!fam) continue

      const greeting = fam.display_name ? `Hi ${fam.display_name.split(' ')[0]},` : 'Hi there,'

      const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#FAFAF8;font-family:'DM Sans',system-ui,sans-serif;color:#1A1A2E;">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px;">
<table width="100%" style="max-width:520px;background:#fff;border-radius:16px;border:1px solid #E8E8E4;overflow:hidden;">
<tr><td style="background:#1A1A2E;padding:28px 32px;">
  <div style="font-size:20px;font-weight:600;color:#fff;">${logo()}</div>
  <div style="font-size:12px;color:rgba(255,255,255,0.4);margin-top:4px;text-transform:uppercase;letter-spacing:0.06em;">A slot has opened up for you</div>
</td></tr>
<tr><td style="padding:32px;">
  <p style="font-size:15px;margin:0 0 20px;line-height:1.6;">${greeting}<br><br>
  Good news — a provider in your area has an opening and you're at the top of the waitlist!</p>
  <table width="100%" style="background:#FAFAF8;border-radius:12px;border:1px solid #E8E8E4;margin-bottom:24px;"><tr><td style="padding:20px;">
    <div style="font-size:18px;font-weight:600;margin-bottom:16px;">${visitType || 'In-home visit'}</div>
    ${rowHtml('👩‍⚕️', 'Provider', providerName)}
    ${rowHtml('📅', 'Date', dateFormatted)}
    ${rowHtml('🕐', 'Time', time12h)}
    ${rowHtml('📍', 'Area', zone)}
  </td></tr></table>
  <div style="background:#FAEEDA;border-radius:10px;padding:14px 16px;margin-bottom:24px;font-size:13px;color:#633806;">
    <strong>This offer expires in 24 hours.</strong> If you don't respond, the slot will be offered to the next family on the waitlist.
  </div>
  <a href="${PORTAL_URL}/family/dashboard" style="display:inline-block;background:#1D9E75;color:#fff;text-decoration:none;padding:12px 24px;border-radius:10px;font-size:14px;font-weight:500;">Claim this slot →</a>
</td></tr>
</table></td></tr></table></body></html>`

      if (fam.email) await sendEmail(fam.email, `A slot opened up — ${dateFormatted} at ${time12h} with ${providerName}`, html)
      if (fam.phone) await sendSMS(fam.phone, `${PRACTICE_NAME}: A spot opened up on ${dateFormatted} at ${time12h} with ${providerName}. Log in to claim it: ${PORTAL_URL}/family/dashboard`)
      notified++
    } catch (err: any) {
      console.error('[notifySlotOpened] failed for entry', entry.id, ':', err?.message)
    }
  }

  console.log(`[notifySlotOpened] zone=${zone} date=${date} time=${time12h} — notified ${notified} of ${entries.length} waitlist families`)
  return notified
}
