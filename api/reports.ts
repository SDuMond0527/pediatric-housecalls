import type { VercelRequest, VercelResponse } from '@vercel/node'
import { verifyToken } from './_lib/verifyToken'
import sql from './_lib/db'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    await verifyToken(req.headers.authorization)
  } catch {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  const { start, end } = req.query as Record<string, string>
  const [appointments, providers] = await Promise.all([
    sql`SELECT id, provider_id, visit_type, scheduled_date, status, notes FROM appointments WHERE scheduled_date >= ${start}::date AND scheduled_date <= ${end}::date`,
    sql`SELECT id, name FROM providers WHERE role != 'admin'`,
  ])

  res.json({ appointments, providers })
}
