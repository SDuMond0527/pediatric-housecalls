import type { VercelRequest, VercelResponse } from '@vercel/node'
import sql from '../_lib/db'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  const { exclude_admin, name, role, is_active, zone, names, has_secure_text, practice_slug } = req.query as Record<string, string>

  // Resolve practiceId from slug if provided
  let practiceId: string | null = null
  if (practice_slug) {
    const [practice] = await sql`SELECT id FROM practices WHERE slug = ${practice_slug} LIMIT 1`
    if (!practice) return res.json([])
    practiceId = practice.id
  }

  if (name) {
    const [row] = practiceId
      ? await sql`SELECT * FROM providers WHERE name = ${name} AND practice_id = ${practiceId}::uuid LIMIT 1`
      : await sql`SELECT * FROM providers WHERE name = ${name} LIMIT 1`
    return res.json(row ?? null)
  }

  if (role && is_active && zone) {
    const rows = practiceId
      ? await sql`SELECT * FROM providers WHERE role = ${role} AND is_active = true AND ${zone} = ANY(zones) AND practice_id = ${practiceId}::uuid`
      : await sql`SELECT * FROM providers WHERE role = ${role} AND is_active = true AND ${zone} = ANY(zones)`
    return res.json(rows)
  }

  if (names && has_secure_text === 'true') {
    const nameList = names.split(',').filter(Boolean)
    const rows = practiceId
      ? await sql`SELECT name, role, secure_text_number FROM providers WHERE name = ANY(${nameList}::text[]) AND secure_text_number IS NOT NULL AND practice_id = ${practiceId}::uuid`
      : await sql`SELECT name, role, secure_text_number FROM providers WHERE name = ANY(${nameList}::text[]) AND secure_text_number IS NOT NULL`
    return res.json(rows)
  }

  let rows: unknown[]
  if (exclude_admin === 'true') {
    rows = practiceId
      ? await sql`SELECT * FROM providers WHERE role != 'admin' AND practice_id = ${practiceId}::uuid ORDER BY name`
      : await sql`SELECT * FROM providers WHERE role != 'admin' ORDER BY name`
  } else {
    rows = practiceId
      ? await sql`SELECT * FROM providers WHERE practice_id = ${practiceId}::uuid ORDER BY role, name`
      : await sql`SELECT * FROM providers ORDER BY role, name`
  }
  res.json(rows)
}
