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
  try {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

    let sub: string
    try {
      sub = await verifyToken(req.headers.authorization)
    } catch {
      return res.status(401).json({ error: 'Unauthorized' })
    }

    const sql = neon(process.env.DATABASE_URL!)
    const [provider] = await sql`SELECT id FROM providers WHERE cognito_sub = ${sub} LIMIT 1`
    if (!provider) return res.status(403).json({ error: 'Provider not found' })

    const { child_id } = req.query as { child_id: string }
    if (!child_id) return res.status(400).json({ error: 'child_id required' })

    // Bootstrap in the read path too — the first call to any radiology
    // endpoint on a fresh branch creates the table.
    try {
      await sql`
        CREATE TABLE IF NOT EXISTS radiology_orders (
          id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          child_id        uuid NOT NULL REFERENCES children(id)   ON DELETE CASCADE,
          provider_id     uuid NOT NULL REFERENCES providers(id),
          appointment_id  uuid,
          tests           jsonb NOT NULL DEFAULT '[]'::jsonb,
          diagnoses       text[] NOT NULL DEFAULT '{}',
          priority        text   NOT NULL DEFAULT 'routine',
          notes           text,
          status          text   NOT NULL DEFAULT 'pending',
          created_at      timestamptz NOT NULL DEFAULT NOW()
        )`
    } catch (e: any) {
      console.error('radiology_orders bootstrap failed:', e?.message)
    }

    const orders = await sql`
      SELECT
        o.id,
        o.tests,
        o.diagnoses,
        o.priority,
        o.status,
        o.notes,
        o.created_at,
        p.name AS provider_name
      FROM radiology_orders o
      JOIN providers p ON p.id = o.provider_id
      WHERE o.child_id = ${child_id}::uuid
      ORDER BY o.created_at DESC
    `

    return res.status(200).json(orders)
  } catch (err: any) {
    console.error('radiology/results error:', err)
    return res.status(500).json({ error: err.message || 'Internal server error' })
  }
}
