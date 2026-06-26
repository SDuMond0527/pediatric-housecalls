import type { VercelRequest, VercelResponse } from '@vercel/node'
import { neon } from '@neondatabase/serverless'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  const sql = neon(process.env.DATABASE_URL!)
  const { exclude_admin, name, role, is_active, zone, names, has_secure_text } = req.query as Record<string, string>

  if (name) {
    const [row] = await sql`SELECT * FROM providers WHERE name = ${name} LIMIT 1`
    return res.json(row ?? null)
  }

  if (role && is_active && zone) {
    const rows = await sql`SELECT * FROM providers WHERE role = ${role} AND is_active = true AND ${zone} = ANY(zones)`
    return res.json(rows)
  }

  if (names && has_secure_text === 'true') {
    const nameList = names.split(',').filter(Boolean)
    const rows = await sql`SELECT name, role, secure_text_number FROM providers WHERE name = ANY(${nameList}::text[]) AND secure_text_number IS NOT NULL`
    return res.json(rows)
  }

  let rows: unknown[]
  if (exclude_admin === 'true') {
    rows = await sql`SELECT * FROM providers WHERE role != 'admin' ORDER BY name`
  } else {
    rows = await sql`SELECT * FROM providers ORDER BY role, name`
  }
  res.json(rows)
}
