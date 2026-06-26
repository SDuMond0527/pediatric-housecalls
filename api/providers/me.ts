import type { VercelRequest, VercelResponse } from '@vercel/node'
import sql from '../_lib/db'
import { verifyToken } from '../_lib/verifyToken'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  let sub: string
  try {
    sub = await verifyToken(req.headers.authorization)
  } catch {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  try {
    const [row] = await sql`SELECT * FROM providers WHERE cognito_sub = ${sub} LIMIT 1`
    if (!row) return res.status(404).json({ error: 'Provider not found', sub })
    row.zones = row.zones ?? []
    row.states = row.states ?? []
    return res.json(row)
  } catch (e: unknown) {
    const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e)
    return res.status(500).json({ error: msg })
  }
}
