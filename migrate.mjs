import { createClient } from '@supabase/supabase-js'
import { neon } from '@neondatabase/serverless'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

// Load migrate.env
const __dir = dirname(fileURLToPath(import.meta.url))
const env = Object.fromEntries(
  readFileSync(join(__dir, 'migrate.env'), 'utf8')
    .split('\n')
    .filter(l => l.includes('='))
    .map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()])
)

const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false }
})
const sql = neon(env.NEON_DATABASE_URL)

async function fetchAll(table) {
  const { data, error } = await supabase.from(table).select('*')
  if (error) throw new Error(`Supabase fetch ${table}: ${error.message}`)
  console.log(`  Fetched ${data.length} rows from ${table}`)
  return data
}

async function run() {
  console.log('\n=== Pediatric Housecalls → Roam Migration ===\n')

  // ── 1. Providers ──────────────────────────────────────────────────────────
  console.log('Migrating providers...')
  const providers = await fetchAll('providers')

  // Remove the placeholder Anna row we created manually
  await sql`DELETE FROM providers WHERE name = 'Anna Dumond' AND cognito_sub = 'c10be5c0-00e1-7054-f78a-074c3146ba29'`

  for (const p of providers) {
    await sql`
      INSERT INTO providers (id, cognito_sub, name, role, initials, zones, states,
        avatar_color, avatar_text_color, is_active, is_admin, created_at)
      VALUES (
        ${p.id},
        ${'migrated:' + p.id},
        ${p.name},
        ${p.role},
        ${p.initials},
        ${p.zones ?? []},
        ${p.states ?? []},
        ${p.avatar_color ?? '#EEEDFE'},
        ${p.avatar_text_color ?? '#3C3489'},
        ${p.is_active ?? true},
        ${p.role === 'admin'},
        ${p.created_at}
      )
      ON CONFLICT (id) DO NOTHING
    `
  }
  console.log(`  Inserted ${providers.length} providers`)

  // Update Anna's real cognito_sub so she can still log in
  await sql`
    UPDATE providers SET cognito_sub = 'c10be5c0-00e1-7054-f78a-074c3146ba29'
    WHERE name = 'Anna Dumond'
  `
  console.log('  Updated Anna Dumond cognito_sub to real value')

  // ── 2. Availability ───────────────────────────────────────────────────────
  console.log('Migrating availability...')
  const avail = await fetchAll('availability')
  for (const a of avail) {
    await sql`
      INSERT INTO availability (id, provider_id, day_of_week, is_active, start_time, end_time)
      VALUES (${a.id}, ${a.provider_id}, ${a.day_of_week}, ${a.is_active}, ${a.start_time}, ${a.end_time})
      ON CONFLICT DO NOTHING
    `
  }
  console.log(`  Inserted ${avail.length} availability rows`)

  // ── 3. Availability overrides ─────────────────────────────────────────────
  console.log('Migrating availability_overrides...')
  const overrides = await fetchAll('availability_overrides')
  for (const o of overrides) {
    await sql`
      INSERT INTO availability_overrides (id, provider_id, date, is_available, start_time, end_time, note, created_at)
      VALUES (${o.id}, ${o.provider_id}, ${o.date}, ${o.is_available}, ${o.start_time}, ${o.end_time}, ${o.note}, ${o.created_at})
      ON CONFLICT DO NOTHING
    `
  }
  console.log(`  Inserted ${overrides.length} override rows`)

  // ── 4. Zone restrictions ──────────────────────────────────────────────────
  console.log('Migrating zone_restrictions...')
  const zones = await fetchAll('zone_restrictions')
  for (const z of zones) {
    await sql`
      INSERT INTO zone_restrictions (id, provider_id, zone, start_time, end_time)
      VALUES (${z.id}, ${z.provider_id}, ${z.zone}, ${z.start_time}, ${z.end_time})
      ON CONFLICT DO NOTHING
    `
  }
  console.log(`  Inserted ${zones.length} zone restriction rows`)

  // ── 5. Time blocks ────────────────────────────────────────────────────────
  console.log('Migrating time_blocks...')
  const blocks = await fetchAll('time_blocks')
  for (const b of blocks) {
    await sql`
      INSERT INTO time_blocks (id, provider_id, label, days, time_range)
      VALUES (${b.id}, ${b.provider_id}, ${b.label}, ${b.days}, ${b.time_range})
      ON CONFLICT DO NOTHING
    `
  }
  console.log(`  Inserted ${blocks.length} time block rows`)

  // ── 6. Appointments (PHI columns omitted) ─────────────────────────────────
  console.log('Migrating appointments (no PHI)...')
  const appts = await fetchAll('appointments')
  for (const a of appts) {
    await sql`
      INSERT INTO appointments (id, provider_id, visit_type, zone, scheduled_time, scheduled_date, status, notes, created_at)
      VALUES (${a.id}, ${a.provider_id}, ${a.visit_type}, ${a.zone}, ${a.scheduled_time}, ${a.scheduled_date}, ${a.status}, ${a.notes}, ${a.created_at})
      ON CONFLICT DO NOTHING
    `
  }
  console.log(`  Inserted ${appts.length} appointments`)

  // ── 7. Broadcasts ─────────────────────────────────────────────────────────
  console.log('Migrating broadcasts...')
  const bcast = await fetchAll('broadcasts')
  for (const b of bcast) {
    // Old schema: patient_name, patient_age, zone, visit_type, complaint, requested_time, distance, is_urgent, is_open
    // New schema: patient_first_name, patient_last_name, zone, visit_type, complaint, is_urgent, is_open
    const nameParts = (b.patient_name ?? '').split(' ')
    const firstName = nameParts[0] ?? null
    const lastName = nameParts.slice(1).join(' ') || null
    await sql`
      INSERT INTO broadcasts (id, patient_first_name, patient_last_name, zone, visit_type, complaint, is_urgent, is_open, created_at)
      VALUES (${b.id}, ${firstName}, ${lastName}, ${b.zone}, ${b.visit_type}, ${b.complaint}, ${b.is_urgent}, ${b.is_open}, ${b.created_at})
      ON CONFLICT DO NOTHING
    `
  }
  console.log(`  Inserted ${bcast.length} broadcasts`)

  // ── 8. Family profiles ────────────────────────────────────────────────────
  console.log('Migrating family_profiles...')
  const families = await fetchAll('family_profiles')
  for (const f of families) {
    const displayName = [f.guardian_first, f.guardian_last].filter(Boolean).join(' ') || null
    await sql`
      INSERT INTO family_profiles (id, cognito_sub, email, display_name, phone, address_line1, state, zip, created_at)
      VALUES (
        ${f.id},
        ${'migrated:' + f.id},
        ${f.email},
        ${displayName},
        ${f.phone},
        ${f.address},
        ${f.state},
        ${f.zip},
        ${f.created_at}
      )
      ON CONFLICT DO NOTHING
    `
  }
  console.log(`  Inserted ${families.length} family profiles`)

  // ── 9. Children ───────────────────────────────────────────────────────────
  console.log('Migrating children...')
  const kids = await fetchAll('children')
  for (const k of kids) {
    const displayLabel = [k.first_name, k.last_name].filter(Boolean).join(' ') || 'Child'
    await sql`
      INSERT INTO children (id, family_id, display_label, created_at)
      VALUES (${k.id}, ${k.family_id}, ${displayLabel}, ${k.created_at})
      ON CONFLICT DO NOTHING
    `
  }
  console.log(`  Inserted ${kids.length} children`)

  // ── 10. Booking requests ──────────────────────────────────────────────────
  console.log('Migrating booking_requests...')
  const bookings = await fetchAll('booking_requests')
  for (const b of bookings) {
    await sql`
      INSERT INTO booking_requests (id, family_id, child_ids, visit_type, preferred_provider, zone, state,
        preferred_date, preferred_time, status, confirmed_provider_id, reference_code, created_at)
      VALUES (
        ${b.id}, ${b.family_id}, ${b.child_ids ?? []}, ${b.visit_type},
        ${b.preferred_provider}, ${b.zone}, ${b.state},
        ${b.preferred_date}, ${b.preferred_time}, ${b.status},
        ${b.confirmed_provider_id}, ${b.reference_code}, ${b.created_at}
      )
      ON CONFLICT DO NOTHING
    `
  }
  console.log(`  Inserted ${bookings.length} booking requests`)

  console.log('\n✓ Migration complete!\n')

  // Summary
  const [{ count: provCount }] = await sql`SELECT count(*)::int as count FROM providers`
  const [{ count: apptCount }] = await sql`SELECT count(*)::int as count FROM appointments`
  const [{ count: famCount }] = await sql`SELECT count(*)::int as count FROM family_profiles`
  console.log(`Neon now has: ${provCount} providers, ${apptCount} appointments, ${famCount} families`)

  // List providers so we can create their Cognito accounts
  const provList = await sql`SELECT id, name, role, initials FROM providers ORDER BY name`
  console.log('\nProviders to create Cognito accounts for:')
  for (const p of provList) {
    const needsCognito = p.name !== 'Anna Dumond'
    console.log(`  ${needsCognito ? '⚠ ' : '✓ '}${p.name} (${p.role}) — id: ${p.id}`)
  }
}

run().catch(e => { console.error('Migration failed:', e.message); process.exit(1) })
