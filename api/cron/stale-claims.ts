import type { VercelRequest, VercelResponse } from '@vercel/node'
import { neon } from '@neondatabase/serverless'

// Daily watcher — surfaces claims that have been "submitted" for 10+
// days without an ERA back, so Sara can call the payer. Per Sara's
// decision 2026-11-09: Option A — queue them + notify Sara only, no
// outbound Stedi 276 inquiry for now. See memory
// project_billing_agent_stage1_decisions.md.
//
// The cron is idempotent: if an open stale_claim row already exists
// for the same claim, it's updated (priority may shift as days-waiting
// grows) rather than duplicated. Priority ladder:
//   10–20 days → 100 (normal)
//   21–30 days → 50
//   31+ days    → 10 (urgent, bubbles to the top of the queue)

const CRON_SECRET = process.env.CRON_SECRET || ''

function daysSinceSubmit(submittedAt: Date): number {
  const ms = Date.now() - submittedAt.getTime()
  return Math.floor(ms / (1000 * 60 * 60 * 24))
}

function priorityFromDays(days: number): number {
  if (days >= 31) return 10
  if (days >= 21) return 50
  return 100
}

function stalenessPhrase(days: number): string {
  if (days >= 31) return `URGENT — ${days} days`
  if (days >= 21) return `${days} days`
  return `${days} days`
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (CRON_SECRET && req.headers.authorization !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' })
  }
  const sql = neon(process.env.DATABASE_URL!)

  // Ensure the queue table + its (claim, type, status) partial unique
  // index exists. Same-shape bootstrap as /api/review-queue — one place
  // can always cold-start the table. Partial index lets us use
  // ON CONFLICT DO UPDATE without locking out multiple past rows for
  // the same claim that are already resolved.
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS review_queue_items (
        id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        practice_id     uuid NOT NULL,
        item_type       text NOT NULL,
        work_category   text NOT NULL,
        claim_id        uuid,
        patient_name    text,
        payer_name      text,
        service_date    date,
        priority        int NOT NULL DEFAULT 100,
        summary         text NOT NULL,
        agent_reasoning jsonb,
        proposed_change jsonb,
        status          text NOT NULL DEFAULT 'open',
        decided_at      timestamptz,
        decided_by      uuid,
        decided_by_name text,
        decision_note   text,
        created_at      timestamptz NOT NULL DEFAULT NOW()
      )`
    await sql`CREATE INDEX IF NOT EXISTS idx_review_queue_practice_open ON review_queue_items(practice_id, status, priority, created_at)`
    await sql`CREATE INDEX IF NOT EXISTS idx_review_queue_claim          ON review_queue_items(claim_id)`
    await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_review_queue_open_per_claim_type
              ON review_queue_items(practice_id, claim_id, item_type) WHERE status = 'open'`
  } catch (e: any) {
    console.error('[stale-claims] bootstrap error (non-fatal):', e?.message)
  }

  // Self-clean: close any open stale_claim items whose underlying claim
  // no longer matches the stale criteria. Happens when the biller posts
  // a manual payment (sets era_received_at) or when a Stedi ERA lands.
  // Keeps the queue honest without requiring humans to Reject rows the
  // system itself has resolved. Sara 2026-11-09 (Peter Gagliano case).
  const closed = await sql`
    UPDATE review_queue_items
    SET status          = 'auto_resolved',
        decided_at      = NOW(),
        decided_by_name = 'system (stale-claims cron)',
        decision_note   = 'Claim no longer stale — ERA received or status changed.'
    WHERE item_type = 'stale_claim'
      AND status    = 'open'
      AND claim_id IN (
        SELECT id FROM claims
        WHERE era_received_at IS NOT NULL
           OR status NOT IN ('submitted')
      )
    RETURNING id`

  // Pull every candidate across every practice so this cron doubles as
  // the multi-tenant watcher the platform will eventually need.
  const candidates = await sql`
    SELECT cl.id, cl.practice_id, cl.submitted_at, cl.service_date, cl.payer_id,
           cl.payer_name, cl.stedi_claim_id, cl.payer_control_number,
           cl.patient_first_name, cl.patient_last_name
    FROM claims cl
    WHERE cl.status = 'submitted'
      AND cl.era_received_at IS NULL
      AND cl.submitted_at IS NOT NULL
      AND cl.submitted_at < NOW() - INTERVAL '10 days'
    ORDER BY cl.submitted_at ASC`

  let inserted = 0
  let updated = 0
  let skipped = 0

  for (const c of candidates as any[]) {
    const submittedAt = new Date(c.submitted_at)
    const days = daysSinceSubmit(submittedAt)
    const priority = priorityFromDays(days)
    const patientName = [c.patient_first_name, c.patient_last_name].filter(Boolean).join(' ') || 'Unknown patient'
    const summary = `${stalenessPhrase(days)} since this claim was submitted to ${c.payer_name ?? 'payer'} with no ERA back. Consider calling to check claim status.`
    const reasoning = {
      days_waiting: days,
      submitted_at: c.submitted_at,
      stedi_claim_id: c.stedi_claim_id,
      payer_control_number: c.payer_control_number,
      source: 'stale-claims cron',
    }

    try {
      const result = await sql`
        INSERT INTO review_queue_items
          (practice_id, item_type, work_category, claim_id, patient_name,
           payer_name, service_date, priority, summary, agent_reasoning)
        VALUES
          (${c.practice_id}::uuid, 'stale_claim', 'claim_submission', ${c.id}::uuid,
           ${patientName}, ${c.payer_name ?? null}, ${c.service_date ?? null}::date,
           ${priority}, ${summary}, ${JSON.stringify(reasoning)}::jsonb)
        ON CONFLICT (practice_id, claim_id, item_type) WHERE status = 'open' DO UPDATE SET
          priority        = EXCLUDED.priority,
          summary         = EXCLUDED.summary,
          agent_reasoning = EXCLUDED.agent_reasoning
        RETURNING (xmax = 0) AS was_insert`
      if (result[0]?.was_insert) inserted++
      else updated++
    } catch (e: any) {
      // The partial-unique-index UPSERT is narrow enough that Postgres
      // occasionally refuses it on older schemas. Fall back to
      // check-then-insert so a transient conflict doesn't cost us a row.
      try {
        const [existing] = await sql`
          SELECT id FROM review_queue_items
          WHERE practice_id = ${c.practice_id}::uuid
            AND claim_id    = ${c.id}::uuid
            AND item_type   = 'stale_claim'
            AND status      = 'open'
          LIMIT 1`
        if (existing) {
          await sql`
            UPDATE review_queue_items
            SET priority = ${priority}, summary = ${summary},
                agent_reasoning = ${JSON.stringify(reasoning)}::jsonb
            WHERE id = ${existing.id}::uuid`
          updated++
        } else {
          await sql`
            INSERT INTO review_queue_items
              (practice_id, item_type, work_category, claim_id, patient_name,
               payer_name, service_date, priority, summary, agent_reasoning)
            VALUES
              (${c.practice_id}::uuid, 'stale_claim', 'claim_submission', ${c.id}::uuid,
               ${patientName}, ${c.payer_name ?? null}, ${c.service_date ?? null}::date,
               ${priority}, ${summary}, ${JSON.stringify(reasoning)}::jsonb)`
          inserted++
        }
      } catch (e2: any) {
        console.error('[stale-claims] fallback write failed:', e2?.message, 'claim:', c.id)
        skipped++
      }
    }
  }

  return res.status(200).json({
    ran_at: new Date().toISOString(),
    auto_closed: closed.length,
    candidates: candidates.length,
    inserted,
    updated,
    skipped,
  })
}
