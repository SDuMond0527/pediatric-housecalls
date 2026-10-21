import { neon } from '@neondatabase/serverless'
const sql = neon(process.env.DATABASE_URL)

await sql`ALTER TABLE providers ADD COLUMN IF NOT EXISTS last_provider_reply_seen_at timestamptz`

// Verify the badge SQL compiles against the current schema.
const [practice] = await sql`SELECT id FROM practices LIMIT 1`
if (!practice) { console.log('No practice'); process.exit(0) }

const items = await sql`
  SELECT cal.id, cal.claim_id, cal.created_at,
         cal.created_by_name AS provider_name, cal.body,
         c.patient_first_name, c.patient_last_name
  FROM claim_activity_log cal
  JOIN claims c ON c.id = cal.claim_id
  WHERE cal.kind = 'provider_response'
    AND c.practice_id = ${practice.id}::uuid
    AND cal.created_at > ${new Date(0)}
  ORDER BY cal.created_at DESC
  LIMIT 5`
console.log('schema OK — found', items.length, 'provider_response rows total')
for (const i of items) {
  const patient = [i.patient_first_name, i.patient_last_name].filter(Boolean).join(' ')
  console.log(` ${i.created_at.toISOString()}  ${i.provider_name} → ${patient || '(no patient)'}`)
}
