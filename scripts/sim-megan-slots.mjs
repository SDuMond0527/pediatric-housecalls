// Simulate the exact parent-portal slot computation for Megan + Oct 22
// + In-home sick visit, 60-min duration. Should return 7 slots.

import { neon } from '@neondatabase/serverless'
const sql = neon(process.env.DATABASE_URL)

const [m] = await sql`SELECT id, practice_id FROM providers WHERE LOWER(name) LIKE '%megan%heilemann%' LIMIT 1`
const date = '2026-10-22'

const [override] = await sql`SELECT is_available, start_time, end_time FROM availability_overrides WHERE provider_id = ${m.id}::uuid AND date = ${date}::date LIMIT 1`
const [vta] = await sql`SELECT is_active, start_time, end_time FROM visit_type_availability WHERE provider_id = ${m.id}::uuid AND visit_type = 'In-home sick visit' LIMIT 1`
const booked = await sql`SELECT scheduled_time, COALESCE(duration_minutes, 60) AS duration_minutes FROM appointments WHERE provider_id = ${m.id}::uuid AND practice_id = ${m.practice_id}::uuid AND scheduled_date = ${date}::date AND status != 'cancelled'`

console.log('override:', override)
console.log('vta:', vta)
console.log('booked:', booked)

const toMin = s => { const [h, mm] = s.split(':').map(Number); return h * 60 + mm }
const dayWindow = override && override.is_available && override.start_time && override.end_time
  ? { start: override.start_time, end: override.end_time } : null
const vtaWindow = vta && vta.is_active && vta.start_time && vta.end_time
  ? { start: vta.start_time, end: vta.end_time } : null
const intersect = (a, b) => {
  if (!b) return a
  const s = Math.max(toMin(a.start), toMin(b.start))
  const e = Math.min(toMin(a.end), toMin(b.end))
  if (e <= s) return null
  const fmt = n => `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`
  return { start: fmt(s), end: fmt(e) }
}
const win = intersect(dayWindow, vtaWindow)
console.log('dayWindow:', dayWindow, '  vtaWindow:', vtaWindow, '  win:', win)
if (!win) { console.log('WINDOW NULL — bailout'); process.exit(0) }

const TIME_SLOTS = (() => {
  const out = []
  for (let h = 0; h < 24; h++) {
    for (let m2 = 0; m2 < 60; m2 += 15) {
      const hour = h % 12 === 0 ? 12 : h % 12
      const minute = String(m2).padStart(2, '0')
      const ampm = h < 12 ? 'AM' : 'PM'
      out.push(`${hour}:${minute} ${ampm}`)
    }
  }
  return out
})()
const slotMin = slot => {
  const [t, ampm] = slot.split(' ')
  let [h, mm] = t.split(':').map(Number)
  if (ampm === 'PM' && h !== 12) h += 12
  if (ampm === 'AM' && h === 12) h = 0
  return h * 60 + mm
}
const visitDur = 60
const [wsh, wsm] = win.start.split(':').map(Number)
const [weh, wem] = win.end.split(':').map(Number)
const windowStart = wsh * 60 + wsm
const windowEnd = weh * 60 + wem
console.log(`window: ${windowStart}–${windowEnd} min, visitDur=${visitDur}`)
const freeSlots = TIME_SLOTS.filter(slot => {
  const sm = slotMin(slot)
  if (sm < windowStart || sm + visitDur > windowEnd) return false
  return !booked.some(b => {
    const bm = toMin(b.scheduled_time.slice(0, 5))
    return sm < bm + b.duration_minutes && sm + visitDur > bm
  })
})
console.log(`freeSlots (${freeSlots.length}):`, freeSlots)
