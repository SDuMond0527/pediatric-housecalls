import type { VercelRequest, VercelResponse } from '@vercel/node'
import { neon } from '@neondatabase/serverless'

const PRACTICE_NAME = process.env.PRACTICE_NAME || 'Pediatric Housecalls'
const EAR_PIERCING  = 'In-home ear piercing'

/**
 * POST /api/admin/setup-ear-piercing
 * Service-token-gated. Idempotent setup for the ear-piercing visit type:
 *   - practice_visit_types row ($100, 60 min, has CV fee, in-home)
 *   - fee_schedule rows EarPierce ($100) and EarStudsX ($100)
 *   - visit_type_availability rows for Becca Jones + Megan Heilemann only
 *   - appointments.addons jsonb bootstrap
 *   - stud_options table bootstrap
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
  const expected = process.env.INTERNAL_SERVICE_TOKEN || ''
  const provided = String(req.headers['x-internal-service-token'] ?? '')
  if (!expected || provided !== expected) return res.status(401).json({ error: 'Unauthorized' })

  const sql = neon(process.env.DATABASE_URL!)

  const [practice] = await sql`
    SELECT id FROM practices WHERE LOWER(name) = LOWER(${PRACTICE_NAME}) ORDER BY created_at LIMIT 1`
  const [fallback] = practice ? [practice] : await sql`SELECT id FROM practices ORDER BY created_at LIMIT 1`
  const pid = (practice ?? fallback)?.id
  if (!pid) return res.status(500).json({ error: 'Practice not configured' })

  const results: Record<string, unknown> = {}

  // 1. Visit type on the practice catalog — check-then-upsert without
  // relying on an ON CONFLICT target constraint that may not exist.
  const [existingVt] = await sql`
    SELECT id FROM practice_visit_types
    WHERE practice_id = ${pid}::uuid AND visit_type = ${EAR_PIERCING} LIMIT 1`
  if (existingVt) {
    const [updated] = await sql`
      UPDATE practice_visit_types SET
        base_price = 100, duration_minutes = 60, lead_minutes = 60,
        has_convenience_fee = true, is_in_home = true, is_cpr = false,
        is_active = false, badge_label = 'Piercing'
      WHERE id = ${existingVt.id}::uuid
      RETURNING id, visit_type`
    results.visit_type = updated
  } else {
    const [created] = await sql`
      INSERT INTO practice_visit_types
        (practice_id, visit_type, base_price, badge_label, badge_color, badge_text_color,
         duration_minutes, lead_minutes, has_convenience_fee, per_child_extra_minutes,
         is_in_home, is_cpr, is_active, sort_order)
      VALUES
        (${pid}::uuid, ${EAR_PIERCING}, 100, 'Piercing', '#F1EFE8', '#1A1A2E',
         60, 60, true, 0, true, false, true, 50)
      RETURNING id, visit_type`
    results.visit_type = created
  }

  // 2. Fee schedule rows — same check-then-upsert pattern.
  const feeRows: any[] = []
  for (const [code, desc, amt] of [
    ['EarPierce', 'In-home ear piercing (includes medical-grade titanium starter studs)', 100.00],
    ['EarStudsX', 'Additional set of titanium studs', 100.00],
  ] as const) {
    const [existing] = await sql`
      SELECT id FROM fee_schedule WHERE practice_id = ${pid}::uuid AND code = ${code} LIMIT 1`
    if (existing) {
      const [u] = await sql`
        UPDATE fee_schedule SET description = ${desc}, charge_amount = ${amt}, category = 'Non-Covered Services'
        WHERE id = ${existing.id}::uuid RETURNING code, charge_amount`
      feeRows.push(u)
    } else {
      const [c] = await sql`
        INSERT INTO fee_schedule (practice_id, code, description, charge_amount, category)
        VALUES (${pid}::uuid, ${code}, ${desc}, ${amt}, 'Non-Covered Services')
        RETURNING code, charge_amount`
      feeRows.push(c)
    }
  }
  results.fee_schedule = feeRows

  // 3. visit_type_availability for Becca + Megan only.
  const providers = await sql`
    SELECT id, name FROM providers
    WHERE practice_id = ${pid}::uuid
      AND (name = 'Becca Jones' OR name = 'Megan Heilemann')
      AND is_active = true` as any[]
  for (const p of providers) {
    const [existingAvail] = await sql`
      SELECT id FROM visit_type_availability
      WHERE provider_id = ${p.id}::uuid AND visit_type = ${EAR_PIERCING} LIMIT 1`
    if (existingAvail) {
      await sql`
        UPDATE visit_type_availability SET is_active = false, start_time = '08:00', end_time = '17:00'
        WHERE id = ${existingAvail.id}::uuid`
    } else {
      await sql`
        INSERT INTO visit_type_availability (provider_id, visit_type, is_active, start_time, end_time)
        VALUES (${p.id}::uuid, ${EAR_PIERCING}, false, '08:00', '17:00')`
    }
  }
  results.providers_enabled = providers.map((p: any) => p.name)

  // 4. appointments.addons jsonb bootstrap so booking can stash stud choice.
  try { await sql`ALTER TABLE appointments ADD COLUMN IF NOT EXISTS addons jsonb` } catch {}

  // 5. stud_options table bootstrap.
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS stud_options (
        id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        practice_id     uuid NOT NULL,
        name            text NOT NULL,
        photo_url       text NOT NULL,
        price           numeric(10,2) NOT NULL DEFAULT 100.00,
        is_active       boolean NOT NULL DEFAULT true,
        sort_order      int NOT NULL DEFAULT 0,
        created_at      timestamptz NOT NULL DEFAULT NOW(),
        updated_at      timestamptz NOT NULL DEFAULT NOW()
      )`
    await sql`CREATE INDEX IF NOT EXISTS stud_options_practice_idx ON stud_options(practice_id)`
  } catch {}

  return res.json({ ok: true, ...results })
}
