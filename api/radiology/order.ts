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

/**
 * POST /api/radiology/order — create a new radiology order.
 *
 * Mirrors the lab-order flow: provider submits, PDF is emailed to
 * patient, patient walks it into any imaging center. For PHC right
 * now the only test ordered through this flow is a PA/Lateral chest
 * x-ray (CPT 71046). The shape still carries a `tests` array so if
 * Sara wants more studies later we don't have to rebuild the schema.
 *
 * Sara 2026-10-02.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

    let sub: string
    try {
      sub = await verifyToken(req.headers.authorization)
    } catch {
      return res.status(401).json({ error: 'Unauthorized' })
    }

    const sql = neon(process.env.DATABASE_URL!)
    const [provider] = await sql`SELECT id, name FROM providers WHERE cognito_sub = ${sub} LIMIT 1`
    if (!provider) return res.status(403).json({ error: 'Provider not found' })

    // Idempotent bootstrap — same pattern used across the codebase so
    // preview branches / future resets just work.
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
      await sql`CREATE INDEX IF NOT EXISTS radiology_orders_child_idx ON radiology_orders(child_id)`
    } catch (e: any) {
      console.error('radiology_orders bootstrap failed:', e?.message)
    }

    const { child_id, appointment_id, tests, diagnoses, priority = 'routine', notes } = req.body as {
      child_id: string
      appointment_id?: string
      tests: { code: string; name: string }[]
      diagnoses: string[]
      priority?: string
      notes?: string
    }

    if (!child_id || !tests?.length) return res.status(400).json({ error: 'child_id and tests required' })

    const [order] = await sql`
      INSERT INTO radiology_orders (child_id, provider_id, appointment_id, tests, diagnoses, priority, notes, status)
      VALUES (
        ${child_id}::uuid,
        ${provider.id}::uuid,
        ${appointment_id ?? null}::uuid,
        ${JSON.stringify(tests)}::jsonb,
        ${diagnoses ?? []}::text[],
        ${priority},
        ${notes ?? null},
        'pending'
      )
      RETURNING *
    `

    return res.status(201).json(order)
  } catch (err: any) {
    console.error('radiology/order error:', err)
    return res.status(500).json({ error: err.message || 'Internal server error' })
  }
}
