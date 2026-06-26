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

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const rows = await sql`
    SELECT code, description, category, charge_amount, place_of_service
    FROM fee_schedule
    WHERE is_active = true AND practice_id = ${practiceId}::uuid
    ORDER BY category, code
  `
  return res.json(rows.map(r => ({ ...r, charge_amount: parseFloat(r.charge_amount as string) })))
}
