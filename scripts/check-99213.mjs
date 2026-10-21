import { neon } from '@neondatabase/serverless'
const sql = neon(process.env.DATABASE_URL)
const rows = await sql`
  SELECT code, description, charge_amount, category
  FROM fee_schedule
  WHERE code IN ('99213', 'SLFPAYVV', 'CVTech')
  ORDER BY code`
for (const r of rows) console.log(r.code, '|', '$' + r.charge_amount, '|', r.category, '|', r.description)
