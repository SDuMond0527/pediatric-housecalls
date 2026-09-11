import type { VercelRequest, VercelResponse } from '@vercel/node'
import { neon } from '@neondatabase/serverless'
import crypto from 'crypto'

const TWILIO_SID       = process.env.TWILIO_ACCOUNT_SID || ''
const TWILIO_KEY       = process.env.TWILIO_API_KEY_SID || ''
const TWILIO_SEC       = process.env.TWILIO_API_KEY_SECRET || ''
const TWILIO_FROM      = process.env.TWILIO_FROM_NUMBER || ''
const RESEND_KEY       = process.env.RESEND_API_KEY || ''
const FROM_EMAIL       = process.env.FROM_EMAIL || 'appointments@phcbooking.com'
const PORTAL_URL       = process.env.PORTAL_URL || 'https://phc-team.com'
const PRACTICE_NAME    = process.env.PRACTICE_NAME || 'Pediatric Housecalls'
const CRON_SECRET      = process.env.CRON_SECRET || ''

const BIZ_START_HOUR = 8
const BIZ_END_HOUR   = 18
const REMINDER_THRESHOLD_HOURS = 3
const MAX_PER_RUN = 20

// Only remind / auto-remove entries created after this timestamp. Anything
// on the waitlist before this line went live keeps its old, pre-feature
// behavior (no automated reminder, no automated EOD removal).
const FEATURE_LAUNCH_AT = '2026-09-11T17:45:00Z'

function easternHour(d: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }).formatToParts(d)
  const h = parseInt(parts.find(p => p.type === 'hour')?.value || '0', 10)
  return h === 24 ? 0 : h
}

function businessHoursElapsed(from: Date, to: Date): number {
  if (from >= to) return 0
  let total = 0
  const STEP_MIN = 5
  const stepMs = STEP_MIN * 60 * 1000
  let cursorMs = from.getTime()
  const endMs = to.getTime()
  const bailAt = REMINDER_THRESHOLD_HOURS + 0.5
  while (cursorMs < endMs && total < bailAt) {
    const h = easternHour(new Date(cursorMs))
    if (h >= BIZ_START_HOUR && h < BIZ_END_HOUR) total += STEP_MIN / 60
    cursorMs += stepMs
  }
  return total
}

async function sendSMS(to: string, body: string): Promise<void> {
  if (!TWILIO_SID || !TWILIO_KEY) { console.error('[waitlist-reminders] no Twilio creds'); return }
  const form = new URLSearchParams({ From: TWILIO_FROM, To: to, Body: body })
  const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${TWILIO_KEY}:${TWILIO_SEC}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: form,
  })
  if (!r.ok) console.error('[waitlist-reminders] SMS error:', await r.text())
}

async function sendEmail(to: string, subject: string, html: string): Promise<void> {
  if (!RESEND_KEY) { console.error('[waitlist-reminders] no RESEND_API_KEY'); return }
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: `${PRACTICE_NAME} <${FROM_EMAIL}>`, to, subject, html }),
  })
  if (!r.ok) console.error('[waitlist-reminders] Email error:', await r.text())
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (CRON_SECRET && req.headers.authorization !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const sql = neon(process.env.DATABASE_URL!)

  // Idempotent column bootstrap. Safe to run on every invocation.
  try {
    await sql`ALTER TABLE waitlist_entries ADD COLUMN IF NOT EXISTS reminder_sent_at timestamptz`
    await sql`ALTER TABLE waitlist_entries ADD COLUMN IF NOT EXISTS reminder_token text`
    await sql`ALTER TABLE waitlist_entries ADD COLUMN IF NOT EXISTS parent_response text`
    await sql`ALTER TABLE waitlist_entries ADD COLUMN IF NOT EXISTS parent_response_at timestamptz`
    await sql`CREATE UNIQUE INDEX IF NOT EXISTS waitlist_entries_reminder_token_idx ON waitlist_entries(reminder_token) WHERE reminder_token IS NOT NULL`
  } catch (e) {
    console.error('[waitlist-reminders] bootstrap err:', e)
  }

  const now = new Date()

  // ── 1. Reminder pass ────────────────────────────────────────────────────────
  const entries = await sql`
    SELECT
      we.id,
      we.family_id,
      we.notes,
      we.zip,
      we.state,
      we.created_at,
      fp.email  AS family_email,
      fp.phone  AS family_phone,
      COALESCE(fp.display_name, (SELECT first_name || ' ' || last_name FROM children WHERE family_id = fp.id LIMIT 1), fp.email) AS family_name
    FROM waitlist_entries we
    LEFT JOIN family_profiles fp ON fp.id = we.family_id
    WHERE we.status = 'waiting'
      AND we.reminder_sent_at IS NULL
      AND we.created_at > NOW() - INTERVAL '48 hours'
      AND we.created_at >= ${FEATURE_LAUNCH_AT}::timestamptz
    ORDER BY we.created_at ASC
  `

  let remindersSent = 0
  for (const entry of entries) {
    if (remindersSent >= MAX_PER_RUN) break
    try {
      const createdAt = new Date(entry.created_at as any)
      const elapsed = businessHoursElapsed(createdAt, now)
      if (elapsed < REMINDER_THRESHOLD_HOURS) continue

      const noteMap: Record<string, string> = {}
      ;((entry.notes || '') as string).split(' | ').forEach(part => {
        const colon = part.indexOf(': ')
        if (colon > 0) noteMap[part.slice(0, colon).trim()] = part.slice(colon + 2).trim()
      })
      const phone = (String(entry.family_phone || '') || noteMap['Phone'] || '').trim()
      const email = (String(entry.family_email || '') || noteMap['Email'] || '').trim()
      const patientLabel = noteMap['Patient'] || String(entry.family_name || 'your child')

      if (!phone && !email) {
        console.error('[waitlist-reminders] no contact for entry', entry.id, '— skipping')
        continue
      }

      const token = crypto.randomBytes(24).toString('base64url')
      await sql`
        UPDATE waitlist_entries
        SET reminder_sent_at = NOW(), reminder_token = ${token}
        WHERE id = ${entry.id}::uuid
      `

      const keepUrl   = `${PORTAL_URL}/api/waitlist/respond?t=${token}&a=keep`
      const removeUrl = `${PORTAL_URL}/api/waitlist/respond?t=${token}&a=remove`

      const bodyText = `Hi! We've been trying hard to find one of our ${PRACTICE_NAME} providers who might be able to add your child to their schedule today, but so far we have been unsuccessful. Let us know if you would like to continue to remain on the waitlist today or if you'd like to remove your child's name from the waitlist. If you choose to remain on the waitlist, we'll keep doing our best to find a provider for you. If we get to the end of the day today and still haven't found anyone to see your child, we will remove you from our waitlist so that you may make other plans to have your child seen elsewhere.

Keep us on the waitlist: ${keepUrl}
Remove us from the waitlist: ${removeUrl}`

      const emailHtml = `<!DOCTYPE html><html><body style="font-family:sans-serif;color:#1A1A2E;max-width:600px;margin:0 auto;padding:20px;">
<p style="font-size:16px;line-height:1.5;">Hi! We've been trying hard to find one of our ${PRACTICE_NAME} providers who might be able to add ${patientLabel} to their schedule today, but so far we have been unsuccessful.</p>
<p style="font-size:16px;line-height:1.5;">Let us know if you would like to continue to remain on the waitlist today or if you'd like to remove your child's name from the waitlist. If you choose to remain on the waitlist, we'll keep doing our best to find a provider for you.</p>
<p style="font-size:16px;line-height:1.5;">If we get to the end of the day today and still haven't found anyone to see your child, we will remove you from our waitlist so that you may make other plans to have your child seen elsewhere.</p>
<div style="margin:32px 0;text-align:center;">
  <a href="${keepUrl}" style="display:inline-block;padding:14px 28px;margin:0 8px 12px;background:#1D9E75;color:#fff;text-decoration:none;border-radius:8px;font-weight:600;">Keep us on the waitlist</a>
  <a href="${removeUrl}" style="display:inline-block;padding:14px 28px;margin:0 8px 12px;background:#DC2626;color:#fff;text-decoration:none;border-radius:8px;font-weight:600;">Remove us from the waitlist</a>
</div>
<p style="font-size:13px;color:#666;">— ${PRACTICE_NAME}</p>
</body></html>`

      if (phone) await sendSMS(phone, bodyText).catch(e => console.error('[waitlist-reminders] sms fail', entry.id, e))
      if (email) await sendEmail(email, `${PRACTICE_NAME} — Are you still hoping to be seen today?`, emailHtml).catch(e => console.error('[waitlist-reminders] email fail', entry.id, e))

      console.error('[waitlist-reminders] reminded', entry.id, 'phone:', !!phone, 'email:', !!email)
      remindersSent++
    } catch (e) {
      console.error('[waitlist-reminders] entry err', entry.id, e)
    }
  }

  // ── 2. End-of-day auto-remove ───────────────────────────────────────────────
  // Once it's past 6pm ET, remove any still-waiting entries created today
  // (matches the promise made in the reminder message).
  let autoRemoved = 0
  try {
    const hourNowEt = easternHour(now)
    if (hourNowEt >= BIZ_END_HOUR || hourNowEt < BIZ_START_HOUR) {
      // "Today" in ET
      const ymdParts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
      }).formatToParts(now)
      const y = ymdParts.find(p => p.type === 'year')?.value
      const m = ymdParts.find(p => p.type === 'month')?.value
      const d = ymdParts.find(p => p.type === 'day')?.value
      const etTodayISO = `${y}-${m}-${d}`
      // Auto-remove waiting entries whose created_at falls on today (ET)
      // — only after 6pm ET. Do NOT auto-remove entries created after 6pm
      // (those are for tomorrow's waitlist).
      const rows = await sql`
        UPDATE waitlist_entries
        SET status = 'removed',
            parent_response = COALESCE(parent_response, 'auto_eod'),
            parent_response_at = COALESCE(parent_response_at, NOW())
        WHERE status = 'waiting'
          AND (created_at AT TIME ZONE 'America/New_York')::date = ${etTodayISO}::date
          AND EXTRACT(HOUR FROM (created_at AT TIME ZONE 'America/New_York')) < ${BIZ_END_HOUR}
          AND created_at >= ${FEATURE_LAUNCH_AT}::timestamptz
        RETURNING id
      `
      autoRemoved = rows.length
      if (autoRemoved > 0) console.error('[waitlist-reminders] auto-removed', autoRemoved, 'entries at EOD')
    }
  } catch (e) {
    console.error('[waitlist-reminders] eod err:', e)
  }

  return res.json({ ok: true, checked: entries.length, sent: remindersSent, autoRemoved })
}
