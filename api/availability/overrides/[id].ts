import type { VercelRequest, VercelResponse } from '@vercel/node'
import sql from '../../_lib/db'
import { getProviderContext } from '../../_lib/auth'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  let practiceId: string
  try {
    const ctx = await getProviderContext(req.headers.authorization)
    practiceId = ctx.practiceId
  } catch {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  if (req.method !== 'DELETE') return res.status(405).json({ error: 'Method not allowed' })

  const { id } = req.query as { id: string }
  await sql`DELETE FROM availability_overrides WHERE id = ${id}::uuid AND practice_id = ${practiceId}`
  res.status(204).end()
}
