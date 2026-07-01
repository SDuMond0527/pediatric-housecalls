import type { VercelRequest, VercelResponse } from '@vercel/node'
import { neon } from '@neondatabase/serverless'

const TWILIO_SID        = process.env.TWILIO_ACCOUNT_SID || ''
const TWILIO_API_KEY    = process.env.TWILIO_API_KEY_SID || ''
const TWILIO_API_SECRET = process.env.TWILIO_API_KEY_SECRET || ''
const TWILIO_FROM       = process.env.TWILIO_FROM_NUMBER || ''
const ALERT_PHONE       = process.env.COVERAGE_ALERT_PHONE || ''
const CRON_SECRET       = process.env.CRON_SECRET || ''

async function sendSMS(to: string, body: string) {
  const formData = new URLSearchParams({ From: TWILIO_FROM, To: to, Body: body })
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${Buffer.from(`${TWILIO_API_KEY}:${TWILIO_API_SECRET}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: formData,
  })
  if (!res.ok) throw new Error(`SMS failed: ${await res.text()}`)
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (CRON_SECRET && req.headers.authorization !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const sql = neon(process.env.DATABASE_URL!)

  const today = new Date()
  const dayOfWeek = today.getDay()
  const todayStr = today.toISOString().split('T')[0]

  // Get all non-waitlist zones across all practices
  const zones = await sql`
    SELECT pz.zone_name, pz.practice_id
    FROM practice_zones pz
    WHERE pz.is_waitlist_only = false
    ORDER BY pz.practice_id, pz.sort_order
  `

  const uncoveredZones: string[] = []

  for (const zone of zones) {
    const { zone_name, practice_id } = zone

    // A zone is covered if at least one active non-admin provider:
    // - has this zone in their zones[] array
    // - is available today via regular weekly schedule (not blocked by override)
    // - OR has a positive one-off override for today
    const [covered] = await sql`
      SELECT p.id
      FROM providers p
      WHERE p.practice_id = ${practice_id}::uuid
        AND p.is_active = true
        AND p.role != 'admin'
        AND ${zone_name} = ANY(p.zones)
        AND (
          EXISTS (
            SELECT 1 FROM availability_overrides ao
            WHERE ao.provider_id = p.id
              AND ao.date = ${todayStr}::date
              AND ao.is_available = true
          )
          OR (
            EXISTS (
              SELECT 1 FROM availability a
              WHERE a.provider_id = p.id
                AND a.day_of_week = ${dayOfWeek}
                AND a.is_active = true
            )
            AND NOT EXISTS (
              SELECT 1 FROM availability_overrides ao
              WHERE ao.provider_id = p.id
                AND ao.date = ${todayStr}::date
                AND ao.is_available = false
            )
          )
        )
      LIMIT 1
    `

    if (!covered) uncoveredZones.push(zone_name)
  }

  if (uncoveredZones.length > 0 && ALERT_PHONE) {
    const dateStr = today.toLocaleDateString('en-US', {
      timeZone: 'America/New_York',
      weekday: 'long', month: 'short', day: 'numeric',
    })
    const message = `GoRoam Alert: No provider coverage today (${dateStr}) for: ${uncoveredZones.join(', ')}.`
    await sendSMS(ALERT_PHONE, message)
  }

  res.json({ date: todayStr, uncovered: uncoveredZones })
}
