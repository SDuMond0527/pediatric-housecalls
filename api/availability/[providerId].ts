import type { VercelRequest, VercelResponse } from '@vercel/node'
import sql from '../_lib/db'
import { getProviderContext } from '../_lib/auth'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  let practiceId: string
  try {
    const ctx = await getProviderContext(req.headers.authorization)
    practiceId = ctx.practiceId
  } catch {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const { providerId } = req.query as { providerId: string }

  if (req.method === 'GET') {
    const [days, overrides, zoneRestrictions, timeBlocks, visitTypes] = await Promise.all([
      sql`SELECT * FROM availability WHERE provider_id = ${providerId}::uuid AND practice_id = ${practiceId}::uuid ORDER BY day_of_week`,
      sql`SELECT * FROM availability_overrides WHERE provider_id = ${providerId}::uuid AND practice_id = ${practiceId}::uuid ORDER BY date`,
      sql`SELECT * FROM zone_restrictions WHERE provider_id = ${providerId}::uuid AND practice_id = ${practiceId}::uuid`,
      sql`SELECT * FROM time_blocks WHERE provider_id = ${providerId}::uuid AND practice_id = ${practiceId}::uuid`,
      sql`SELECT * FROM visit_type_availability WHERE provider_id = ${providerId}::uuid AND practice_id = ${practiceId}::uuid`,
    ])
    return res.json({ days, overrides, zoneRestrictions, timeBlocks, visitTypes })
  }

  // PUT: upsert all availability days
  if (req.method === 'PUT') {
    const days = req.body as Array<{
      id?: string; day_of_week: number; is_active: boolean; start_time: string; end_time: string
    }>
    const results = await Promise.all(days.map(async (d) => {
      if (d.id) {
        const [row] = await sql`
          UPDATE availability SET is_active=${d.is_active}, start_time=${d.start_time}, end_time=${d.end_time}
          WHERE id=${d.id}::uuid AND practice_id = ${practiceId}::uuid RETURNING *`
        return row
      } else {
        const [row] = await sql`
          INSERT INTO availability (provider_id, day_of_week, is_active, start_time, end_time, practice_id)
          VALUES (${providerId}::uuid, ${d.day_of_week}, ${d.is_active}, ${d.start_time}, ${d.end_time}, ${practiceId}::uuid)
          ON CONFLICT (provider_id, day_of_week) DO UPDATE
          SET is_active=EXCLUDED.is_active, start_time=EXCLUDED.start_time, end_time=EXCLUDED.end_time
          RETURNING *`
        return row
      }
    }))
    return res.json(results)
  }

  res.status(405).json({ error: 'Method not allowed' })
}
