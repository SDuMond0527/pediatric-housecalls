// Quick look at Megan Heilemann: role, zones, visit types, availability
// for 2026-10-22, overrides, time blocks, schedule blocks. Reveals what
// filter is excluding her from the parent portal.

import { neon } from '@neondatabase/serverless'
const sql = neon(process.env.DATABASE_URL)

const [megan] = await sql`
  SELECT id, name, role, is_active, is_admin, zones, states, taxonomy_code, home_address
  FROM providers
  WHERE LOWER(name) LIKE '%megan%heilemann%'
  LIMIT 1`
if (!megan) { console.log('No Megan row'); process.exit(0) }
console.log('Megan:', megan.id)
console.log('  role:', megan.role, '  active:', megan.is_active, '  states:', megan.states)
console.log('  zones:', (megan.zones ?? []).join(', ') || '(none)')
console.log('  home:', megan.home_address)

// Day-of-week availability (Thursday = 4 for Oct 22 2026)
const dow = new Date('2026-10-22T12:00:00').getDay()
console.log(`\nDay of week 2026-10-22 = ${dow} (0=Sun..6=Sat)`)

const avail = await sql`SELECT * FROM availability WHERE provider_id = ${megan.id}::uuid ORDER BY day_of_week, start_time`
console.log(`\nStanding availability rows: ${avail.length}`)
for (const a of avail) {
  console.log(`  dow=${a.day_of_week}  ${a.start_time}–${a.end_time}  visit_types=${JSON.stringify(a.visit_types)}  zones=${JSON.stringify(a.zones)}`)
}

// Overrides on 2026-10-22
const overrides = await sql`
  SELECT * FROM availability_overrides
  WHERE provider_id = ${megan.id}::uuid AND date = '2026-10-22'::date`
console.log(`\nOverrides on 2026-10-22: ${overrides.length}`)
for (const o of overrides) console.log(` ${JSON.stringify(o)}`)

const timeBlocks = await sql`
  SELECT * FROM time_blocks
  WHERE provider_id = ${megan.id}::uuid
    AND (date = '2026-10-22'::date OR (start_date <= '2026-10-22'::date AND end_date >= '2026-10-22'::date))`
console.log(`\nTime blocks covering 2026-10-22: ${timeBlocks.length}`)
for (const t of timeBlocks) console.log(` ${JSON.stringify(t)}`)

const scheduleBlocks = await sql`
  SELECT * FROM schedule_blocks
  WHERE provider_id = ${megan.id}::uuid
    AND block_date = '2026-10-22'::date`
console.log(`\nSchedule blocks on 2026-10-22: ${scheduleBlocks.length}`)
for (const s of scheduleBlocks) console.log(` ${JSON.stringify(s)}`)

const vta = await sql`SELECT * FROM visit_type_availability WHERE provider_id = ${megan.id}::uuid`
console.log(`\nVisit type availability rows: ${vta.length}`)
for (const v of vta) console.log(` ${JSON.stringify(v)}`)

const zoneRestr = await sql`SELECT * FROM zone_restrictions WHERE provider_id = ${megan.id}::uuid`
console.log(`\nZone restrictions: ${zoneRestr.length}`)
for (const z of zoneRestr) console.log(` ${JSON.stringify(z)}`)

const appts = await sql`
  SELECT id, scheduled_time, duration_minutes, visit_type, status, child_id
  FROM appointments
  WHERE provider_id = ${megan.id}::uuid AND scheduled_date = '2026-10-22'::date
  ORDER BY scheduled_time`
console.log(`\nAppointments already on 2026-10-22: ${appts.length}`)
for (const a of appts) console.log(`  ${a.scheduled_time}  ${a.duration_minutes}min  ${a.visit_type}  ${a.status}`)
