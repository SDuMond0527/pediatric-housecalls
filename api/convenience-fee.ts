import type { VercelRequest, VercelResponse } from '@vercel/node'
import { neon } from '@neondatabase/serverless'

const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY || ''

// ── Holiday detection ─────────────────────────────────────────────────────────

function easterSunday(year: number): string {
  const a = year % 19, b = Math.floor(year / 100), c = year % 100
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25)
  const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30
  const i = Math.floor(c / 4), k = c % 4
  const l = (32 + 2 * e + 2 * i - h - k) % 7
  const m = Math.floor((a + 11 * h + 22 * l) / 451)
  const month = Math.floor((h + l - 7 * m + 114) / 31)
  const day = ((h + l - 7 * m + 114) % 31) + 1
  return `${year}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`
}

function nthWeekdayOfMonth(year: number, month: number, weekday: number, n: number): string {
  if (n > 0) {
    const d = new Date(year, month - 1, 1)
    let count = 0
    while (d.getMonth() === month - 1) {
      if (d.getDay() === weekday) { count++; if (count === n) break }
      d.setDate(d.getDate() + 1)
    }
    return `${year}-${month.toString().padStart(2, '0')}-${d.getDate().toString().padStart(2, '0')}`
  } else {
    const d = new Date(year, month, 0)
    while (d.getDay() !== weekday) d.setDate(d.getDate() - 1)
    return `${year}-${month.toString().padStart(2, '0')}-${d.getDate().toString().padStart(2, '0')}`
  }
}

function isMajorHoliday(dateStr: string): boolean {
  const year = parseInt(dateStr.slice(0, 4))
  const holidays = [
    `${year}-01-01`,
    easterSunday(year),
    nthWeekdayOfMonth(year, 5, 1, -1),
    `${year}-07-04`,
    nthWeekdayOfMonth(year, 9, 1, 1),
    nthWeekdayOfMonth(year, 11, 4, 4),
    `${year}-12-25`,
  ]
  return holidays.includes(dateStr)
}

// ── Distance via Google Maps ──────────────────────────────────────────────────

async function getDrivingMiles(origin: string, destination: string): Promise<number | null> {
  if (!GOOGLE_MAPS_API_KEY) return null
  const url = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${encodeURIComponent(origin)}&destinations=${encodeURIComponent(destination)}&mode=driving&units=imperial&key=${GOOGLE_MAPS_API_KEY}`
  const res = await fetch(url)
  const data = await res.json()
  const element = data?.rows?.[0]?.elements?.[0]
  if (element?.status !== 'OK') return null
  return element.distance.value / 1609.344
}

// ── Fee calculation ───────────────────────────────────────────────────────────

function calculateFee(miles: number, dateStr: string, time24: string, visitType: string, state?: string): { fee: number; code: string } {
  if (visitType === 'In-home IV fluids') return { fee: 150, code: 'IV-flat' }
  if (visitType === 'CMA + telemedicine') return { fee: 50, code: 'CMA-flat' }
  if (isMajorHoliday(dateStr)) return state === 'VA' ? { fee: 200, code: 'VACV10' } : { fee: 200, code: 'CV13' }

  const date = new Date(dateStr + 'T12:00:00')
  const dow = date.getDay()
  const isWeekend = dow === 0 || dow === 6
  const [h] = time24.split(':').map(Number)
  const isPeakHours = h >= 8 && h < 15

  if (state === 'VA') {
    if (isWeekend) {
      if (miles < 5)   return { fee: 125, code: 'VACV7' }
      if (miles <= 15) return { fee: 150, code: 'VACV8' }
      return { fee: 175, code: 'VACV9' }
    }
    if (isPeakHours) {
      if (miles < 2)   return { fee: 50,  code: 'VACV11' }
      if (miles < 5)   return { fee: 75,  code: 'VACV1' }
      if (miles <= 15) return { fee: 100, code: 'VACV2' }
      return { fee: 150, code: 'VACV3' }
    }
    // Off-peak weekday
    if (miles < 5)   return { fee: 100, code: 'VACV4' }
    if (miles <= 15) return { fee: 125, code: 'VACV5' }
    return { fee: 150, code: 'VACV6' }
  }

  // NC / SC (default)
  if (isWeekend) {
    if (miles < 2)   return { fee: 100, code: 'CV9' }
    if (miles < 5)   return { fee: 125, code: 'CV10' }
    if (miles <= 15) return { fee: 150, code: 'CV11' }
    return { fee: 175, code: 'CV12' }
  }

  if (isPeakHours) {
    if (miles < 2)   return { fee: 50,  code: 'CV1' }
    if (miles < 5)   return { fee: 75,  code: 'CV2' }
    if (miles <= 15) return { fee: 100, code: 'CV3' }
    return { fee: 150, code: 'CV4' }
  }

  if (miles < 2)   return { fee: 75,  code: 'CV5' }
  if (miles < 5)   return { fee: 100, code: 'CV6' }
  if (miles <= 15) return { fee: 125, code: 'CV7' }
  return { fee: 150, code: 'CV8' }
}

// ── Handler ───────────────────────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' })

  const { providerId, appointmentAddress, date, time, visitType, state } = req.body

  if (!providerId || !appointmentAddress || !date || !time || !visitType) {
    return res.status(400).json({ ok: false, error: 'Missing required fields' })
  }

  const isVA = state === 'VA'

  // Flat fees — no distance needed
  if (visitType === 'In-home IV fluids') {
    return res.json({ ok: true, fee: 150, code: 'IV-flat', basis: 'Flat rate for IV fluids' })
  }
  if (visitType === 'CMA + telemedicine') {
    return res.json({ ok: true, fee: 50, code: 'CMA-flat', basis: 'Flat rate for CMA visits' })
  }
  if (visitType.startsWith('In-home CPR class')) {
    return res.json({ ok: true, fee: 0, code: 'CPR-no-fee', basis: 'No convenience fee for CPR classes' })
  }
  if (isMajorHoliday(date)) {
    return res.json({ ok: true, fee: 200, code: isVA ? 'VACV10' : 'CV13', basis: 'Major holiday flat rate' })
  }

  if (!GOOGLE_MAPS_API_KEY) {
    return res.json({ ok: false, error: 'Distance calculation not configured' })
  }

  try {
    const sql = neon(process.env.DATABASE_URL!)

    const [provider] = await sql`SELECT name, role, home_address, practice_id FROM providers WHERE id = ${providerId}::uuid LIMIT 1`
    if (!provider) return res.status(404).json({ ok: false, error: 'Provider not found' })

    // CMA and RN providers always have a flat $50 convenience fee
    if (provider.role === 'CMA' || provider.role === 'RN') {
      return res.json({ ok: true, fee: 50, code: 'CMA-RN-flat', basis: 'Flat rate for CMA/RN providers' })
    }

    // Most recent prior appointment on same date — its address becomes the origin
    const priorAppts = await sql`
      SELECT notes FROM appointments
      WHERE provider_id = ${providerId}::uuid
        AND practice_id = ${provider.practice_id}::uuid
        AND scheduled_date = ${date}::date
        AND scheduled_time < ${time}
        AND status != 'cancelled'
      ORDER BY scheduled_time DESC
      LIMIT 1`

    let originAddress: string | null = provider.home_address || null
    if (priorAppts.length) {
      const notes: string = priorAppts[0].notes || ''
      const addrPart = notes.split('|').find((p: string) => p.startsWith('ADDR:'))
      if (addrPart) originAddress = addrPart.replace('ADDR:', '').trim()
    }

    if (!originAddress) {
      return res.json({ ok: false, error: 'No origin address on file for this provider' })
    }

    const miles = await getDrivingMiles(originAddress, appointmentAddress)
    if (miles === null) {
      return res.json({ ok: false, error: 'Could not calculate distance' })
    }

    const { fee, code } = calculateFee(miles, date, time, visitType, state)
    const basis = priorAppts.length
      ? 'Based on distance from prior appointment'
      : "Based on distance from provider's home"

    return res.json({ ok: true, fee, code, miles: Math.round(miles * 10) / 10, basis })

  } catch (err: any) {
    return res.status(500).json({ ok: false, error: err.message ?? String(err) })
  }
}
