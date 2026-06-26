import type { VercelRequest, VercelResponse } from '@vercel/node'
import sql from '../_lib/db'
import { getProviderContext } from '../_lib/auth'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    const ctx = await getProviderContext(req.headers.authorization)

    const rows = await sql`SELECT * FROM providers WHERE cognito_sub = ${ctx.sub} AND practice_id = ${ctx.practiceId}::uuid LIMIT 1`
    if (rows.length === 0) return res.status(404).json({ error: 'Provider not found', sub: ctx.sub })
    const row = rows[0]
    row.zones = row.zones ?? []
    row.states = row.states ?? []
    res.json(row)
  } catch (e: unknown) {
    const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e)
    res.status(500).json({ error: msg })
  }
}
