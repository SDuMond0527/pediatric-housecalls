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
 * GET  /api/communications?child_id=X  — list communications for a child
 * POST /api/communications               — create a new entry
 *
 * Lightweight phone-call / text-message log that lives inside the patient
 * chart. NOT a text visit — no billing, no claim, no encounter note. Just
 * documentation ("mom called about dosage, told her to continue 5ml BID").
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  let sub: string
  try { sub = await verifyToken(req.headers.authorization) }
  catch { return res.status(401).json({ error: 'Unauthorized' }) }

  const sql = neon(process.env.DATABASE_URL!)
  const [provider] = await sql`SELECT id, name, practice_id FROM providers WHERE cognito_sub = ${sub} LIMIT 1`
  if (!provider) return res.status(403).json({ error: 'Provider not found' })

  // Idempotent bootstrap — ships without a separate migration.
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS patient_communications (
        id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        practice_id        uuid NOT NULL,
        child_id           uuid NOT NULL REFERENCES children(id) ON DELETE CASCADE,
        provider_id        uuid REFERENCES providers(id),
        provider_name      text,
        communication_type text NOT NULL,
        occurred_at        timestamptz NOT NULL,
        notes              text NOT NULL,
        created_at         timestamptz NOT NULL DEFAULT NOW()
      )`
    await sql`CREATE INDEX IF NOT EXISTS patient_communications_child_idx ON patient_communications(child_id)`
  } catch (e: any) {
    console.error('patient_communications bootstrap failed:', e?.message)
  }

  if (req.method === 'GET') {
    const childId = String(req.query.child_id ?? '')
    if (!childId) return res.status(400).json({ error: 'child_id required' })

    // Confirm the child belongs to this practice before returning any rows.
    const [child] = await sql`SELECT id FROM children WHERE id = ${childId}::uuid AND practice_id = ${provider.practice_id}::uuid LIMIT 1`
    if (!child) return res.status(404).json({ error: 'Child not found' })

    const rows = await sql`
      SELECT id, child_id, provider_id, provider_name, communication_type,
             occurred_at, notes, created_at
      FROM patient_communications
      WHERE child_id = ${childId}::uuid AND practice_id = ${provider.practice_id}::uuid
      ORDER BY occurred_at DESC, created_at DESC`
    return res.json(rows)
  }

  if (req.method === 'POST') {
    const { child_id, communication_type, occurred_at, notes } = (req.body ?? {}) as {
      child_id?: string
      communication_type?: 'phone' | 'text'
      occurred_at?: string
      notes?: string
    }
    if (!child_id) return res.status(400).json({ error: 'child_id required' })
    if (communication_type !== 'phone' && communication_type !== 'text') {
      return res.status(400).json({ error: "communication_type must be 'phone' or 'text'" })
    }
    if (!occurred_at) return res.status(400).json({ error: 'occurred_at required' })
    if (!notes?.trim()) return res.status(400).json({ error: 'notes required' })

    const [child] = await sql`SELECT id FROM children WHERE id = ${child_id}::uuid AND practice_id = ${provider.practice_id}::uuid LIMIT 1`
    if (!child) return res.status(404).json({ error: 'Child not found' })

    const [row] = await sql`
      INSERT INTO patient_communications (practice_id, child_id, provider_id, provider_name, communication_type, occurred_at, notes)
      VALUES (${provider.practice_id}::uuid, ${child_id}::uuid, ${provider.id}::uuid, ${provider.name}, ${communication_type}, ${occurred_at}::timestamptz, ${notes.trim()})
      RETURNING *`
    return res.status(201).json(row)
  }

  return res.status(405).json({ error: 'Method not allowed' })
}
