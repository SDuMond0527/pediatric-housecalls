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
  try { sub = await verifyToken(req.headers.authorization) } catch {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const sql = neon(process.env.DATABASE_URL!)
  const [provider] = await sql`SELECT practice_id, is_super_admin FROM providers WHERE cognito_sub = ${sub} LIMIT 1`
  if (!provider) return res.status(403).json({ error: 'Provider not found' })

  if (req.method === 'GET') {
    const practiceId = (req.query.practice_id as string) || provider.practice_id
    const rows = await sql`
      SELECT * FROM practice_visit_types
      WHERE practice_id = ${practiceId}::uuid
      ORDER BY sort_order, visit_type`
    return res.json(rows)
  }

  if (req.method === 'POST') {
    const { practice_id, visit_type, base_price, badge_label, badge_color, badge_text_color,
            duration_minutes, lead_minutes, has_convenience_fee, per_child_extra_minutes,
            is_in_home, is_cpr, is_active, sort_order } = req.body
    const pid = practice_id || provider.practice_id
    const [row] = await sql`
      INSERT INTO practice_visit_types
        (practice_id, visit_type, base_price, badge_label, badge_color, badge_text_color,
         duration_minutes, lead_minutes, has_convenience_fee, per_child_extra_minutes,
         is_in_home, is_cpr, is_active, sort_order)
      VALUES (
        ${pid}::uuid, ${visit_type}, ${base_price ?? null}, ${badge_label ?? null},
        ${badge_color ?? '#EEEDFE'}, ${badge_text_color ?? '#3C3489'},
        ${duration_minutes ?? 60}, ${lead_minutes ?? 60},
        ${has_convenience_fee ?? true}, ${per_child_extra_minutes ?? 0},
        ${is_in_home ?? true}, ${is_cpr ?? false},
        ${is_active ?? true}, ${sort_order ?? 0}
      )
      ON CONFLICT (practice_id, visit_type) DO UPDATE SET
        base_price = EXCLUDED.base_price,
        badge_label = EXCLUDED.badge_label,
        badge_color = EXCLUDED.badge_color,
        badge_text_color = EXCLUDED.badge_text_color,
        duration_minutes = EXCLUDED.duration_minutes,
        lead_minutes = EXCLUDED.lead_minutes,
        has_convenience_fee = EXCLUDED.has_convenience_fee,
        per_child_extra_minutes = EXCLUDED.per_child_extra_minutes,
        is_in_home = EXCLUDED.is_in_home,
        is_cpr = EXCLUDED.is_cpr,
        is_active = EXCLUDED.is_active,
        sort_order = EXCLUDED.sort_order
      RETURNING *`
    return res.json(row)
  }

  if (req.method === 'DELETE') {
    const id = req.query.id as string
    if (!id) return res.status(400).json({ error: 'Missing id' })
    await sql`DELETE FROM practice_visit_types WHERE id = ${id}::uuid AND practice_id = ${provider.practice_id}::uuid`
    return res.status(204).end()
  }

  return res.status(405).json({ error: 'Method not allowed' })
}
