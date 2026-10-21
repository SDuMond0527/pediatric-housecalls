import { neon } from '@neondatabase/serverless'
const sql = neon(process.env.DATABASE_URL)

const cols = await sql`
  SELECT column_name FROM information_schema.columns
  WHERE table_name = 'providers' ORDER BY column_name`
console.log('provider columns:', cols.map(c => c.column_name).join(', '))

const rows = await sql`SELECT * FROM providers WHERE LOWER(name) LIKE '%santos%'`
console.log('\nmatches:', rows.length)
for (const r of rows) console.log(JSON.stringify(r, null, 2))
