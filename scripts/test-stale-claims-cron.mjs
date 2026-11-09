// Dry-run the stale-claims cron against prod data. Reports what the
// cron WOULD queue if it ran right now, without actually writing.
//
// Run: node --env-file=.env scripts/test-stale-claims-cron.mjs
import { neon } from '@neondatabase/serverless'
const sql = neon(process.env.DATABASE_URL)

const candidates = await sql`
  SELECT cl.id, cl.practice_id, cl.submitted_at, cl.service_date::text AS service_date,
         cl.payer_name, cl.stedi_claim_id, cl.payer_control_number,
         cl.patient_first_name, cl.patient_last_name,
         EXTRACT(DAY FROM NOW() - cl.submitted_at)::int AS days_waiting
  FROM claims cl
  WHERE cl.status = 'submitted'
    AND cl.era_received_at IS NULL
    AND cl.submitted_at IS NOT NULL
    AND cl.submitted_at < NOW() - INTERVAL '10 days'
  ORDER BY cl.submitted_at ASC`

console.log(`Would queue ${candidates.length} stale-claim items across all practices:\n`)
if (candidates.length === 0) {
  console.log('  (none — every submitted claim has an ERA within 10 days)')
} else {
  for (const c of candidates) {
    const name = [c.patient_first_name, c.patient_last_name].filter(Boolean).join(' ') || 'Unknown'
    const priority = c.days_waiting >= 31 ? 'URGENT (10)'
      : c.days_waiting >= 21 ? 'high (50)'
      : 'normal (100)'
    console.log(`  ${c.days_waiting}d — ${name.padEnd(28)} ${c.payer_name?.padEnd(28)} DOS ${c.service_date}  [${priority}]`)
  }
}
console.log('\n(nothing was written to the queue — this was a read-only dry-run)')
