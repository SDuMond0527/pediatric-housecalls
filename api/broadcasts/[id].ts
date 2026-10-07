import type { VercelRequest, VercelResponse } from '@vercel/node'
import { neon } from '@neondatabase/serverless'
import { createRemoteJWKSet, jwtVerify } from 'jose'

async function verifyToken(authHeader: string | undefined): Promise<string> {
  if (!authHeader?.startsWith('Bearer ')) throw new Error('Missing token')
  const token = authHeader.slice(7)
  const region = process.env.VITE_AWS_REGION || 'us-east-2'
  const userPoolId = process.env.VITE_AWS_USER_POOL_ID || ''
  const JWKS = createRemoteJWKSet(new URL(`https://cognito-idp.${region}.amazonaws.com/${userPoolId}/.well-known/jwks.json`))
  const { payload } = await jwtVerify(token, JWKS, { issuer: `https://cognito-idp.${region}.amazonaws.com/${userPoolId}` })
  if (!payload.sub) throw new Error('No sub in token')
  return payload.sub
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  let sub: string
  try {
    sub = await verifyToken(req.headers.authorization)
  } catch {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const sql = neon(process.env.DATABASE_URL!)

  const providerRows = await sql`SELECT practice_id FROM providers WHERE cognito_sub = ${sub} LIMIT 1`
  if (!providerRows.length) return res.status(403).json({ error: 'Provider not found' })
  const practiceId = providerRows[0].practice_id as string

  const { id } = req.query as { id: string }

  if (req.method === 'PATCH') {
    const { is_open, accepted_by_id, accepted_by_name } = req.body ?? {}
    // Persist WHO accepted the broadcast so the Bonus leaderboard can
    // attribute pickups to the right provider. Previously inferred from
    // broadcasts.related_appointment_id, which points to the pair's
    // INITIATOR (NP for IV fluids, MD/NP for CMA) — not the picker-upper
    // (RN/CMA). Sara 2026-10-07 (Karen Hinkle's IV fluids pickup for
    // Mackenzie Twigg was being credited to Megan Heilemann).
    try { await sql`ALTER TABLE broadcasts ADD COLUMN IF NOT EXISTS accepted_by_provider_id uuid` } catch {}
    try { await sql`ALTER TABLE broadcasts ADD COLUMN IF NOT EXISTS accepted_by_name text` } catch {}
    try { await sql`ALTER TABLE broadcasts ADD COLUMN IF NOT EXISTS accepted_at timestamptz` } catch {}

    if (is_open === false && accepted_by_id) {
      const [row] = await sql`
        UPDATE broadcasts SET
          is_open = false,
          accepted_by_provider_id = COALESCE(accepted_by_provider_id, ${accepted_by_id}::uuid),
          accepted_by_name        = COALESCE(accepted_by_name, ${accepted_by_name ?? null}),
          accepted_at             = COALESCE(accepted_at, NOW())
        WHERE id = ${id}::uuid AND practice_id = ${practiceId}::uuid
        RETURNING *`
      return res.json(row)
    }
    if (is_open === true) {
      // Reopen — clear acceptance (someone un-accepted via admin).
      const [row] = await sql`
        UPDATE broadcasts SET
          is_open = true,
          accepted_by_provider_id = NULL,
          accepted_by_name        = NULL,
          accepted_at             = NULL
        WHERE id = ${id}::uuid AND practice_id = ${practiceId}::uuid
        RETURNING *`
      return res.json(row)
    }
    const [row] = await sql`UPDATE broadcasts SET is_open=${is_open} WHERE id=${id}::uuid AND practice_id=${practiceId}::uuid RETURNING *`
    return res.json(row)
  }

  if (req.method === 'DELETE') {
    await sql`DELETE FROM broadcasts WHERE id = ${id}::uuid AND practice_id = ${practiceId}::uuid`
    return res.status(204).end()
  }

  res.status(405).json({ error: 'Method not allowed' })
}
