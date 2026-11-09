import type { VercelRequest, VercelResponse } from '@vercel/node'
import { neon } from '@neondatabase/serverless'
import { createRemoteJWKSet, jwtVerify } from 'jose'

// Billing-agent review queue — Stage 1 skeleton.
//
// Sara 2026-11-09: approved the plan. "Each type of work has its own
// on/off setting. All start OFF, and only I can turn them on." This
// endpoint only reads + decides on queue rows. The agent-logic jobs
// that CREATE queue rows ship in a later commit once the shell + UX
// are confirmed.

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

// Keep the ALTER / CREATE statements colocated here so the first cold
// request to /api/review-queue on any deploy ensures both tables exist.
// See memory feedback_bootstrap_columns_on_every_read_path.md.
async function bootstrap(sql: any): Promise<void> {
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS review_queue_items (
        id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        practice_id     uuid NOT NULL,
        item_type       text NOT NULL,        -- new_claim | stale_claim | underpayment | rejection_fix | denial_fix | appeal_draft
        work_category   text NOT NULL,        -- claim_submission | rejections | denials — groups item_types for per-type toggles
        claim_id        uuid,
        patient_name    text,
        payer_name      text,
        service_date    date,
        priority        int NOT NULL DEFAULT 100, -- lower = higher priority
        summary         text NOT NULL,        -- one-sentence plain-English the biller sees
        agent_reasoning jsonb,                -- full "why this was proposed" payload
        proposed_change jsonb,                -- structured before/after for Edit flow
        status          text NOT NULL DEFAULT 'open',  -- open | approved | edited | rejected
        decided_at      timestamptz,
        decided_by      uuid,
        decided_by_name text,
        decision_note   text,
        created_at      timestamptz NOT NULL DEFAULT NOW()
      )`
    await sql`CREATE INDEX IF NOT EXISTS idx_review_queue_practice_open ON review_queue_items(practice_id, status, priority, created_at)`
    await sql`CREATE INDEX IF NOT EXISTS idx_review_queue_claim          ON review_queue_items(claim_id)`
    await sql`
      CREATE TABLE IF NOT EXISTS billing_agent_settings (
        practice_id     uuid NOT NULL,
        work_category   text NOT NULL,
        auto_enabled    boolean NOT NULL DEFAULT false,
        updated_at      timestamptz NOT NULL DEFAULT NOW(),
        updated_by      uuid,
        updated_by_name text,
        PRIMARY KEY (practice_id, work_category)
      )`
  } catch (e: any) {
    console.error('review-queue bootstrap error (non-fatal):', e?.message)
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  let sub: string
  try { sub = await verifyProviderToken(req.headers.authorization) }
  catch { return res.status(401).json({ error: 'Unauthorized' }) }

  const sql = neon(process.env.DATABASE_URL!)
  await bootstrap(sql)

  // Super-admin only until Sara green-lights wider visibility — she's
  // choosing when to loop Andrea / Pam in. 2026-11-09.
  const [provider] = await sql`SELECT id, name, practice_id, is_super_admin FROM providers WHERE cognito_sub = ${sub} LIMIT 1`
  if (!provider) return res.status(403).json({ error: 'Provider not found' })
  if (!provider.is_super_admin) return res.status(403).json({ error: 'Not available' })
  const practiceId = provider.practice_id as string

  if (req.method === 'GET') {
    // Open items — sorted by priority (lower first) then oldest first.
    const items = await sql`
      SELECT id, item_type, work_category, claim_id, patient_name, payer_name,
             service_date::text AS service_date,
             priority, summary, agent_reasoning, proposed_change,
             status, created_at
      FROM review_queue_items
      WHERE practice_id = ${practiceId}::uuid AND status = 'open'
      ORDER BY priority ASC, created_at ASC`

    // Approval-rate stats over the last 30 days, grouped by work_category.
    const stats = await sql`
      SELECT work_category,
             COUNT(*) FILTER (WHERE status = 'approved') AS approved,
             COUNT(*) FILTER (WHERE status = 'edited')   AS edited,
             COUNT(*) FILTER (WHERE status = 'rejected') AS rejected,
             COUNT(*)                                     AS total
      FROM review_queue_items
      WHERE practice_id = ${practiceId}::uuid
        AND status IN ('approved', 'edited', 'rejected')
        AND decided_at > NOW() - INTERVAL '30 days'
      GROUP BY work_category`

    return res.status(200).json({ items, stats })
  }

  if (req.method === 'POST') {
    // Batch decision — body { ids: string[], action: 'approve' | 'reject', note?: string }
    const body = req.body as { ids?: string[]; action?: string; note?: string }
    const ids = Array.isArray(body?.ids) ? body.ids.filter(x => typeof x === 'string') : []
    const action = String(body?.action ?? '')
    if (!ids.length) return res.status(400).json({ error: 'ids required' })
    if (action !== 'approve' && action !== 'reject') return res.status(400).json({ error: 'action must be approve or reject' })

    const newStatus = action === 'approve' ? 'approved' : 'rejected'
    const note = typeof body?.note === 'string' ? body.note.trim() || null : null

    await sql`
      UPDATE review_queue_items
      SET status          = ${newStatus},
          decided_at      = NOW(),
          decided_by      = ${provider.id}::uuid,
          decided_by_name = ${provider.name ?? 'Admin'},
          decision_note   = ${note}
      WHERE practice_id = ${practiceId}::uuid
        AND id = ANY(${ids}::uuid[])
        AND status = 'open'`

    return res.status(200).json({ ok: true, count: ids.length })
  }

  return res.status(405).json({ error: 'Method not allowed' })
}
