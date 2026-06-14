import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
)

const GOOGLE_MAPS_API_KEY = Deno.env.get('GOOGLE_MAPS_API_KEY') || Deno.env.get('google_maps_api_key') || ''

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
  // weekday: 0=Sun, 1=Mon, ... 6=Sat
  // n: 1=first, -1=last
  if (n > 0) {
    const d = new Date(year, month - 1, 1)
    let count = 0
    while (d.getMonth() === month - 1) {
      if (d.getDay() === weekday) {
        count++
        if (count === n) break
      }
      d.setDate(d.getDate() + 1)
    }
    return `${year}-${month.toString().padStart(2, '0')}-${d.getDate().toString().padStart(2, '0')}`
  } else {
    // last occurrence
    const d = new Date(year, month, 0) // last day of month
    while (d.getDay() !== weekday) d.setDate(d.getDate() - 1)
    return `${year}-${month.toString().padStart(2, '0')}-${d.getDate().toString().padStart(2, '0')}`
  }
}

function isMajorHoliday(dateStr: string): boolean {
  const year = parseInt(dateStr.slice(0, 4))
  const holidays = [
    `${year}-01-01`,                              // New Year's Day
    easterSunday(year),                           // Easter Sunday
    nthWeekdayOfMonth(year, 5, 1, -1),           // Memorial Day (last Monday of May)
    `${year}-07-04`,                              // 4th of July
    nthWeekdayOfMonth(year, 9, 1, 1),            // Labor Day (first Monday of September)
    nthWeekdayOfMonth(year, 11, 4, 4),           // Thanksgiving (fourth Thursday of November)
    `${year}-12-25`,                              // Christmas Day
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
  // distance.value is in meters
  return element.distance.value / 1609.344
}

// ── Fee calculation ───────────────────────────────────────────────────────────

function calculateFee(miles: number, dateStr: string, time24: string, visitType: string): { fee: number; code: string } {
  // Flat fees by visit type
  if (visitType === 'In-home IV fluids') return { fee: 150, code: 'IV-flat' }
  if (visitType === 'CMA + telemedicine') return { fee: 50, code: 'CMA-flat' }

  // Holiday flat fee
  if (isMajorHoliday(dateStr)) return { fee: 200, code: 'CV13' }

  const date = new Date(dateStr + 'T12:00:00')
  const dow = date.getDay() // 0=Sun, 6=Sat
  const isWeekend = dow === 0 || dow === 6

  const [h] = time24.split(':').map(Number)
  const isPeakHours = h >= 8 && h < 15 // 8am–3pm

  if (isWeekend) {
    if (miles < 2)  return { fee: 100, code: 'CV9' }
    if (miles < 5)  return { fee: 125, code: 'CV10' }
    if (miles <= 15) return { fee: 150, code: 'CV11' }
    return { fee: 175, code: 'CV12' }
  }

  if (isPeakHours) {
    if (miles < 2)  return { fee: 50,  code: 'CV1' }
    if (miles < 5)  return { fee: 75,  code: 'CV2' }
    if (miles <= 15) return { fee: 100, code: 'CV3' }
    return { fee: 150, code: 'CV4' }
  }

  // Weekday off-peak (before 8am or after 3pm)
  if (miles < 2)  return { fee: 75,  code: 'CV5' }
  if (miles < 5)  return { fee: 100, code: 'CV6' }
  if (miles <= 15) return { fee: 125, code: 'CV7' }
  return { fee: 150, code: 'CV8' }
}

// ── Main handler ──────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const { providerId, appointmentAddress, date, time, visitType } = await req.json()

    if (!providerId || !appointmentAddress || !date || !time || !visitType) {
      return new Response(JSON.stringify({ ok: false, error: 'Missing required fields' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // Flat fees / no-fee types don't need distance calculation
    if (visitType === 'In-home IV fluids') {
      return new Response(JSON.stringify({ ok: true, fee: 150, code: 'IV-flat', basis: 'Flat rate for IV fluids' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }
    if (visitType === 'CMA + telemedicine') {
      return new Response(JSON.stringify({ ok: true, fee: 50, code: 'CMA-flat', basis: 'Flat rate for CMA visits' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }
    if (visitType.startsWith('In-home CPR class')) {
      return new Response(JSON.stringify({ ok: true, fee: 0, code: 'CPR-no-fee', basis: 'No convenience fee for CPR classes' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }
    if (isMajorHoliday(date)) {
      return new Response(JSON.stringify({ ok: true, fee: 200, code: 'CV13', basis: 'Major holiday flat rate' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // Find the provider's most recent appointment before this time on this date
    const { data: provider } = await supabase
      .from('providers').select('name, home_address').eq('id', providerId).single()

    if (!provider) throw new Error('Provider not found')

    const { data: priorAppts } = await supabase
      .from('appointments')
      .select('scheduled_time, notes')
      .eq('provider_id', providerId)
      .eq('scheduled_date', date)
      .lt('scheduled_time', time)
      .neq('status', 'cancelled')
      .order('scheduled_time', { ascending: false })
      .limit(1)

    // Extract address from prior appointment notes (ADDR: field), or fall back to home
    let originAddress = provider.home_address
    if (priorAppts?.length) {
      const notes: string = priorAppts[0].notes || ''
      const addrPart = notes.split('|').find((p: string) => p.startsWith('ADDR:'))
      if (addrPart) originAddress = addrPart.replace('ADDR:', '').trim()
    }

    if (!originAddress) {
      return new Response(JSON.stringify({ ok: false, error: 'No origin address available' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const miles = await getDrivingMiles(originAddress, appointmentAddress)

    if (miles === null) {
      return new Response(JSON.stringify({ ok: false, error: 'Could not calculate distance' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const { fee, code } = calculateFee(miles, date, time, visitType)
    const basis = priorAppts?.length ? 'Based on distance from prior appointment' : "Based on distance from provider's home"

    return new Response(JSON.stringify({ ok: true, fee, code, miles: Math.round(miles * 10) / 10, basis }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })

  } catch (err) {
    console.error('Fee calculation error:', err)
    return new Response(JSON.stringify({ ok: false, error: (err as Error).message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
