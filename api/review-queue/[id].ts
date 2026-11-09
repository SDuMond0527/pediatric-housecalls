import type { VercelRequest, VercelResponse } from '@vercel/node'
import { neon } from '@neondatabase/serverless'
import { createRemoteJWKSet, jwtVerify } from 'jose'

// Single-item decision endpoint. Approve / Edit / Reject.
// Edit stores the biller's modified payload on the item row so downstream
// jobs (when the agent-logic ships) can commit the edited version rather
// than the agent's original proposal.

async function verifyProviderToken(authHeader: string | undefined): Promise<string> {
  if (!authHeader?.startsWith('Bearer ')) throw new Error('Missing token')
  const token = authHeader.slice(7)
  const region = process.env.VITE_AWS_REGION || 'us-east-2'
  const poolId = process.env.VITE_AWS_USER_POOL_ID || ''
  const JWKS = createRemoteJWKSet(new URL(`https://cognito-idp.${region}.amazonaws.com/${poolId}/.well-known/jwks.json`))
  const { payload } = await jwtVerify(token, JWKS, { issuer: `https://cognito-idp.${region}.amazonaws.com/${poolId}` })
  if (!payload.sub) throw new Error('No sub in token')
  return payload.sub as string
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
  let sub: string
  try { sub = await verifyProviderToken(req.headers.authorization) }
  catch { return res.status(401).json({ error: 'Unauthorized' }) }

  const sql = neon(process.env.DATABASE_URL!)
  const [provider] = await sql`SELECT id, name, practice_id, is_admin FROM providers WHERE cognito_sub = ${sub} LIMIT 1`
  if (!provider) return res.status(403).json({ error: 'Provider not found' })
  if (!provider.is_admin) return res.status(403).json({ error: 'Admin only' })
  const practiceId = provider.practice_id as string
  const { id } = req.query as { id: string }
  if (!id) return res.status(400).json({ error: 'id required' })

  const body = req.body as { action?: string; note?: string; edited_payload?: unknown }
  const action = String(body?.action ?? '')
  const note = typeof body?.note === 'string' ? body.note.trim() || null : null

  if (action === 'approve') {
    await sql`
      UPDATE review_queue_items
      SET status = 'approved', decided_at = NOW(),
          decided_by = ${provider.id}::uuid, decided_by_name = ${provider.name ?? 'Admin'},
          decision_note = ${note}
      WHERE id = ${id}::uuid AND practice_id = ${practiceId}::uuid AND status = 'open'`
    return res.status(200).json({ ok: true })
  }

  if (action === 'reject') {
    await sql`
      UPDATE review_queue_items
      SET status = 'rejected', decided_at = NOW(),
          decided_by = ${provider.id}::uuid, decided_by_name = ${provider.name ?? 'Admin'},
          decision_note = ${note}
      WHERE id = ${id}::uuid AND practice_id = ${practiceId}::uuid AND status = 'open'`
    return res.status(200).json({ ok: true })
  }

  if (action === 'edit') {
    // Store the biller's modified payload under proposed_change so a later
    // commit job can pick up the edited version instead of the original.
    const edited = body?.edited_payload
    if (edited == null) return res.status(400).json({ error: 'edited_payload required for edit action' })
    await sql`
      UPDATE review_queue_items
      SET status = 'edited', decided_at = NOW(),
          decided_by = ${provider.id}::uuid, decided_by_name = ${provider.name ?? 'Admin'},
          decision_note = ${note},
          proposed_change = ${JSON.stringify(edited)}::jsonb
      WHERE id = ${id}::uuid AND practice_id = ${practiceId}::uuid AND status = 'open'`
    return res.status(200).json({ ok: true })
  }

  return res.status(400).json({ error: 'action must be approve, edit, or reject' })
}
