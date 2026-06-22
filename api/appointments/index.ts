import type { VercelRequest, VercelResponse } from '@vercel/node'
import { verifyToken } from '../_lib/verifyToken'
import sql from '../_lib/db'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    await verifyToken(req.headers.authorization)
  } catch {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  if (req.method === 'GET') {
    const { provider_id, date, date_gte, date_lte } = req.query as Record<string, string>
    let rows: unknown[]
    if (provider_id && date) {
      rows = await sql`SELECT * FROM appointments WHERE provider_id = ${provider_id}::uuid AND scheduled_date = ${date}::date ORDER BY scheduled_time`
    } else if (provider_id && date_gte && date_lte) {
      rows = await sql`SELECT * FROM appointments WHERE provider_id = ${provider_id}::uuid AND scheduled_date >= ${date_gte}::date AND scheduled_date <= ${date_lte}::date`
    } else if (date) {
      rows = await sql`SELECT * FROM appointments WHERE scheduled_date = ${date}::date ORDER BY scheduled_time`
    } else if (provider_id) {
      rows = await sql`SELECT * FROM appointments WHERE provider_id = ${provider_id}::uuid ORDER BY scheduled_date, scheduled_time`
    } else {
      rows = await sql`SELECT id, status, visit_type, scheduled_date, provider_id, notes FROM appointments`
    }
    return res.json(rows)
  }

  if (req.method === 'POST') {
    const { provider_id, visit_type, zone, scheduled_time, scheduled_date, status, notes, duration_minutes } = req.body
    const [row] = await sql`
      INSERT INTO appointments (provider_id, visit_type, zone, scheduled_time, scheduled_date, status, notes, duration_minutes)
      VALUES (${provider_id}::uuid, ${visit_type}, ${zone}, ${scheduled_time}, ${scheduled_date}::date, ${status ?? 'upcoming'}, ${notes ?? null}, ${duration_minutes ?? null})
      RETURNING *`
    return res.json(row)
  }

  res.status(405).json({ error: 'Method not allowed' })
}
