import { neon } from '@neondatabase/serverless'
const sql = neon(process.env.DATABASE_URL)

const [megan] = await sql`SELECT id, practice_id FROM providers WHERE LOWER(name) LIKE '%megan%heilemann%' LIMIT 1`
const megId = megan.id
const practiceId = megan.practice_id
const date = '2026-10-22'

const vta = await sql`SELECT * FROM visit_type_availability WHERE provider_id = ${megId}::uuid`
console.log(`visit_type_availability rows: ${vta.length}`)
for (const v of vta) console.log(' ', JSON.stringify(v))

const zr = await sql`SELECT * FROM zone_restrictions WHERE provider_id = ${megId}::uuid`
console.log(`\nzone_restrictions rows: ${zr.length}`)
for (const z of zr) console.log(' ', JSON.stringify(z))

const tb = await sql`SELECT * FROM time_blocks WHERE provider_id = ${megId}::uuid`
console.log(`\ntime_blocks total: ${tb.length}`)
for (const t of tb) console.log(' ', JSON.stringify(t))

// Simulate the exact parent-portal query
console.log(`\n── Simulated parent query ──`)
const overrideRows = await sql`SELECT is_available, start_time, end_time FROM availability_overrides WHERE provider_id = ${megId}::uuid AND date = ${date}::date LIMIT 1`
const vtaRow = await sql`SELECT is_active, start_time, end_time FROM visit_type_availability WHERE provider_id = ${megId}::uuid AND visit_type = 'In-person sick visit' LIMIT 1`
const booked = await sql`SELECT scheduled_time, COALESCE(duration_minutes, 60) AS duration_minutes FROM appointments WHERE provider_id = ${megId}::uuid AND practice_id = ${practiceId}::uuid AND scheduled_date = ${date}::date AND status != 'cancelled'`
console.log('override:', JSON.stringify(overrideRows[0] ?? null))
console.log('visitTypeAvail:', JSON.stringify(vtaRow[0] ?? null))
console.log('bookedSlots:', JSON.stringify(booked))

// Zone list check
const zoneRows = await sql`
  SELECT id, name, role, is_active, zones
  FROM providers
  WHERE is_active = true AND role != 'admin' AND 'Huntersville / Davidson / Cornelius' = ANY(zones) AND practice_id = ${practiceId}::uuid
  ORDER BY name`
console.log(`\nproviders with zone 'Huntersville / Davidson / Cornelius' (parent portal fetch): ${zoneRows.length}`)
for (const p of zoneRows) console.log(` - ${p.name} (${p.role})`)
