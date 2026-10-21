import { neon } from '@neondatabase/serverless'
const sql = neon(process.env.DATABASE_URL)
const rows = await sql`
  SELECT code, description, category, charge_amount
  FROM fee_schedule
  WHERE LOWER(code) LIKE '%slfpay%' OR LOWER(code) LIKE '%selfpay%'
  ORDER BY code`
for (const r of rows) console.log(r.code, '|', r.category, '|', '$' + r.charge_amount, '|', r.description)
