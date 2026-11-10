import type { VercelRequest, VercelResponse } from '@vercel/node'
import { neon } from '@neondatabase/serverless'
import { createRemoteJWKSet, jwtVerify } from 'jose'

// Standalone surface for eligibility-check failures from the pre-submit
// auto-eligibility hook. Sara 2026-11-10: separate tab from the Billing
// agent page so Pam (the new biller) can see fails prominently with a
// red count badge on the nav entry, without needing super-admin access
// to the full Billing agent queue.
//
// Backing data is the same `review_queue_items` table used by the
// Billing agent — this endpoint just filters to item_type =
// 'eligibility_blocked'. One source of truth; two views.
//
// GET /api/eligibility-fails
//   → { items, count }
//
// GET /api/eligibility-fails?count=1
//   → { count }    (lightweight — used by the sidebar badge poll)
//
// POST /api/eligibility-fails
//   body { id, action: 'approve' | 'reject', note?: string }
//   → marks a single item handled or dismissed

async function verifyToken(authHeader: string | undefined): Promise<string> {
  if (!authHeader?.startsWith('Bearer ')) throw new Error('Missing token')
  const token = authHeader.slice(7)
  const region = process.env.VITE_AWS_REGION || 'us-east-2'
  const poolId = process.env.VITE_AWS_USER_POOL_ID || ''
  const JWKS = createRemoteJWKSet(new URL(`https://cognito-idp.${region}.amazonaws.com/${poolId}/.well-known/jwks.json`))
  const { payload } = await jwtVerify(token, JWKS, { issuer: `https://cognito-idp.${region}.amazonaws.com/${poolId}` })
  if (!payload.sub) throw new Error('No sub in token')
  return payload.sub as string
}

async function bootstrap(sql: any): Promise<void> {
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS review_queue_items (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        practice_id uuid NOT NULL, item_type text NOT NULL,
        work_category text NOT NULL, claim_id uuid,
        patient_name text, payer_name text, service_date date,
        priority int NOT NULL DEFAULT 100, summary text NOT NULL,
        agent_reasoning jsonb, proposed_change jsonb,
        status text NOT NULL DEFAULT 'open',
        decided_at timestamptz, decided_by uuid,
        decided_by_name text, decision_note text,
        created_at timestamptz NOT NULL DEFAULT NOW()
      )`
  } catch {}
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  let sub: string
  try { sub = await verifyToken(req.headers.authorization) }
  catch { return res.status(401).json({ error: 'Unauthorized' }) }

  const sql = neon(process.env.DATABASE_URL!)
  await bootstrap(sql)

  const [provider] = await sql`SELECT id, name, practice_id, is_admin FROM providers WHERE cognito_sub = ${sub} LIMIT 1`
  if (!provider) return res.status(403).json({ error: 'Provider not found' })
  if (!provider.is_admin) return res.status(403).json({ error: 'Admin only' })
  const practiceId = provider.practice_id as string

  if (req.method === 'GET') {
    // Lightweight count-only path for the sidebar badge poll.
    if (String(req.query.count ?? '') === '1') {
      const [row] = await sql`
        SELECT COUNT(*)::int AS count
        FROM review_queue_items
        WHERE practice_id = ${practiceId}::uuid
          AND item_type   = 'eligibility_blocked'
          AND status      = 'open'`
      return res.status(200).json({ count: row?.count ?? 0 })
    }
    const items = await sql`
      SELECT id, item_type, work_category, claim_id, patient_name, payer_name,
             service_date::text AS service_date,
             priority, summary, agent_reasoning, proposed_change,
             status, created_at
      FROM review_queue_items
      WHERE practice_id = ${practiceId}::uuid
        AND item_type   = 'eligibility_blocked'
        AND status      = 'open'
      ORDER BY created_at DESC`
    return res.status(200).json({ items, count: items.length })
  }

  if (req.method === 'POST') {
    const body = req.body as { id?: string; action?: string; note?: string }
    const id = String(body?.id ?? '')
    const action = String(body?.action ?? '')
    if (!id) return res.status(400).json({ error: 'id required' })
    if (action !== 'approve' && action !== 'reject') return res.status(400).json({ error: 'action must be approve or reject' })
    const note = typeof body?.note === 'string' ? body.note.trim() || null : null
    const newStatus = action === 'approve' ? 'approved' : 'rejected'

    await sql`
      UPDATE review_queue_items
      SET status          = ${newStatus},
          decided_at      = NOW(),
          decided_by      = ${provider.id}::uuid,
          decided_by_name = ${provider.name ?? 'Admin'},
          decision_note   = ${note}
      WHERE practice_id = ${practiceId}::uuid
        AND id          = ${id}::uuid
        AND item_type   = 'eligibility_blocked'
        AND status      = 'open'`
    return res.status(200).json({ ok: true })
  }

  return res.status(405).json({ error: 'Method not allowed' })
}
