import { neon } from '@neondatabase/serverless'
const sql = neon(process.env.DATABASE_URL)

await sql`ALTER TABLE family_profiles ADD COLUMN IF NOT EXISTS marketing_opt_out boolean DEFAULT false`
await sql`ALTER TABLE family_profiles ADD COLUMN IF NOT EXISTS marketing_opt_out_at timestamptz`

const [practice] = await sql`SELECT id FROM practices LIMIT 1`
const practiceId = practice.id

// Replica of resolveAudience with the same filter shape — proves the
// generated SQL parses + joins against the live schema.
const test = async (label, filters) => {
  const states = (filters.states ?? []).filter(s => ['NC','SC','VA'].includes(s))
  const hasState = states.length > 0
  const ageMin = filters.age_min ?? null
  const ageMax = filters.age_max ?? null
  const withinDays = filters.last_visit_within_days ?? null
  const olderThanDays = filters.last_visit_older_than_days ?? null
  const neverVisited = !!filters.never_visited
  const rows = await sql`
    WITH last_visits AS (
      SELECT ch.family_id, MAX(a.scheduled_date) AS last_visit
      FROM appointments a
      JOIN children ch ON ch.id = a.child_id
      WHERE a.practice_id = ${practiceId}::uuid AND a.status != 'cancelled'
      GROUP BY ch.family_id
    ),
    families AS (
      SELECT DISTINCT ON (fp.id)
        fp.id, fp.email, fp.display_name, fp.state,
        lv.last_visit,
        FLOOR(EXTRACT(EPOCH FROM AGE(CURRENT_DATE, MIN(ch.date_of_birth))) / (365.25 * 86400))::int AS oldest_child_years,
        FLOOR(EXTRACT(EPOCH FROM AGE(CURRENT_DATE, MAX(ch.date_of_birth))) / (365.25 * 86400))::int AS youngest_child_years
      FROM family_profiles fp
      LEFT JOIN children ch ON ch.family_id = fp.id AND ch.practice_id = ${practiceId}::uuid
      LEFT JOIN last_visits lv ON lv.family_id = fp.id
      WHERE fp.practice_id = ${practiceId}::uuid
        AND fp.email IS NOT NULL AND LENGTH(TRIM(fp.email)) > 0
        AND COALESCE(fp.marketing_opt_out, false) = false
      GROUP BY fp.id, fp.email, fp.display_name, fp.state, lv.last_visit
    )
    SELECT COUNT(*) AS n FROM families
    WHERE
      (${hasState}::boolean = false OR state = ANY(${states}))
      AND (${ageMin}::int IS NULL OR youngest_child_years >= ${ageMin}::int)
      AND (${ageMax}::int IS NULL OR oldest_child_years <= ${ageMax}::int)
      AND (
        ${neverVisited}::boolean = true AND last_visit IS NULL
        OR ${neverVisited}::boolean = false AND (
          (${withinDays}::int IS NULL AND ${olderThanDays}::int IS NULL)
          OR (${withinDays}::int IS NOT NULL AND last_visit >= CURRENT_DATE - (${withinDays}::int || ' days')::interval)
          OR (${olderThanDays}::int IS NOT NULL AND (last_visit IS NULL OR last_visit < CURRENT_DATE - (${olderThanDays}::int || ' days')::interval))
        )
      )`
  console.log(`${label}: ${rows[0].n}`)
}

await test('all families', {})
await test('NC only', { states: ['NC'] })
await test('kids under 2', { age_max: 2 })
await test('kids 5-12', { age_min: 5, age_max: 12 })
await test('visited within 90 days', { last_visit_within_days: 90 })
await test('dormant > 180 days', { last_visit_older_than_days: 180 })
await test('never visited', { never_visited: true })
await test('NC families with kids under 5, dormant > 90d', { states: ['NC'], age_max: 5, last_visit_older_than_days: 90 })
