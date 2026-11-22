import type { VercelRequest, VercelResponse } from '@vercel/node'
import { neon } from '@neondatabase/serverless'
import { createRemoteJWKSet, jwtVerify } from 'jose'

// POST /api/admin/activate-ear-piercing
//
// Super-admin only. Full one-shot activation for the ear-piercing
// visit type in the caller's practice. Does the same work the
// uses_ear_piercing settings-save side effect does, but synchronously
// and with per-step reporting in the response body so Sara can see
// exactly what hit. Sara 2026-11-22.
//
// Idempotent — every DB op is check-then-upsert.

async function verifyToken(authHeader: string | undefined): Promise<string> {
  if (!authHeader?.startsWith('Bearer ')) throw new Error('Missing token')
  const token = authHeader.slice(7)
  const region = process.env.VITE_AWS_REGION || 'us-east-2'
  const poolId = process.env.VITE_AWS_USER_POOL_ID || ''
  const JWKS = createRemoteJWKSet(new URL(`https://cognito-idp.${region}.amazonaws.com/${poolId}/.well-known/jwks.json`))
  const { payload } = await jwtVerify(token, JWKS, { issuer: `https://cognito-idp.${region}.amazonaws.com/${poolId}` })
  if (!payload.sub) throw new Error('No sub')
  return payload.sub as string
}

const EAR_PIERCING = 'In-home ear piercing'
const BECCA_NAME   = 'Becca Jones'
const MEGAN_NAME   = 'Megan Heilemann'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  let sub: string
  try { sub = await verifyToken(req.headers.authorization) }
  catch { return res.status(401).json({ error: 'Unauthorized' }) }

  const sql = neon(process.env.DATABASE_URL!)
  const [provider] = await sql`SELECT id, name, practice_id, is_super_admin FROM providers WHERE cognito_sub = ${sub} LIMIT 1`
  if (!provider) return res.status(403).json({ error: 'Provider not found' })
  if (!provider.is_super_admin) return res.status(403).json({ error: 'Super-admin only' })

  const practice_id = provider.practice_id as string
  const summary: Record<string, unknown> = { practice_id }

  // 1. Table / column bootstraps.
  try { await sql`ALTER TABLE appointments ADD COLUMN IF NOT EXISTS addons jsonb` }
  catch (e: any) { summary.appointments_bootstrap_error = e?.message }

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
    summary.stud_options_bootstrap = 'ok'
  } catch (e: any) { summary.stud_options_bootstrap_error = e?.message }

  // 2. Visit type — upsert.
  try {
    const [existing] = await sql`
      SELECT id FROM practice_visit_types
      WHERE practice_id = ${practice_id}::uuid AND visit_type = ${EAR_PIERCING}
      LIMIT 1`
    if (existing) {
      await sql`
        UPDATE practice_visit_types SET
          base_price = 100, duration_minutes = 60, lead_minutes = 60,
          has_convenience_fee = true, is_in_home = true, is_cpr = false,
          is_active = true, badge_label = 'Piercing'
        WHERE id = ${existing.id}::uuid`
      summary.visit_type = { action: 'updated', id: existing.id }
    } else {
      const [created] = await sql`
        INSERT INTO practice_visit_types
          (practice_id, visit_type, base_price, badge_label, badge_color, badge_text_color,
           duration_minutes, lead_minutes, has_convenience_fee, per_child_extra_minutes,
           is_in_home, is_cpr, is_active, sort_order)
        VALUES
          (${practice_id}::uuid, ${EAR_PIERCING}, 100, 'Piercing', '#F1EFE8', '#1A1A2E',
           60, 60, true, 0, true, false, true, 50)
        RETURNING id`
      summary.visit_type = { action: 'created', id: created?.id }
    }
  } catch (e: any) { summary.visit_type_error = e?.message }

  // 3. Fee schedule — upsert both codes.
  const feeResults: Array<{ code: string; action: string; charge_amount?: any; error?: string }> = []
  for (const [code, desc, amt] of [
    ['EarPierce', 'In-home ear piercing (includes medical-grade titanium starter studs)', 100.00],
    ['EarStudsX', 'Upgrade to titanium piercing studs', 60.00],
  ] as const) {
    try {
      const [existing] = await sql`
        SELECT code FROM fee_schedule WHERE practice_id = ${practice_id}::uuid AND code = ${code} LIMIT 1`
      if (existing) {
        const [u] = await sql`
          UPDATE fee_schedule SET description = ${desc}, charge_amount = ${amt}, category = 'Non-Covered Services'
          WHERE practice_id = ${practice_id}::uuid AND code = ${code}
          RETURNING charge_amount`
        feeResults.push({ code, action: 'updated', charge_amount: u?.charge_amount })
      } else {
        const [c] = await sql`
          INSERT INTO fee_schedule (practice_id, code, description, charge_amount, category)
          VALUES (${practice_id}::uuid, ${code}, ${desc}, ${amt}, 'Non-Covered Services')
          RETURNING charge_amount`
        feeResults.push({ code, action: 'created', charge_amount: c?.charge_amount })
      }
    } catch (e: any) { feeResults.push({ code, action: 'error', error: e?.message }) }
  }
  summary.fees = feeResults

  // 4. visit_type_availability for Becca + Megan.
  const providerResults: Array<{ name: string; action: string; provider_id?: string; error?: string }> = []
  try {
    const providers = await sql`
      SELECT id, name FROM providers
      WHERE practice_id = ${practice_id}::uuid
        AND name IN (${BECCA_NAME}, ${MEGAN_NAME})
        AND is_active = true` as any[]
    summary.providers_found = providers.map((p: any) => p.name)
    for (const p of providers) {
      try {
        const [existingAvail] = await sql`
          SELECT id FROM visit_type_availability
          WHERE provider_id = ${p.id}::uuid AND visit_type = ${EAR_PIERCING} LIMIT 1`
        if (existingAvail) {
          await sql`
            UPDATE visit_type_availability SET is_active = true, start_time = '08:00', end_time = '17:00'
            WHERE id = ${existingAvail.id}::uuid`
          providerResults.push({ name: p.name, action: 'updated', provider_id: p.id })
        } else {
          await sql`
            INSERT INTO visit_type_availability (provider_id, visit_type, is_active, start_time, end_time)
            VALUES (${p.id}::uuid, ${EAR_PIERCING}, true, '08:00', '17:00')`
          providerResults.push({ name: p.name, action: 'created', provider_id: p.id })
        }
      } catch (e: any) { providerResults.push({ name: p.name, action: 'error', error: e?.message }) }
    }
  } catch (e: any) { summary.availability_error = e?.message }
  summary.providers = providerResults

  // 5. Also flip the uses_ear_piercing setting ON in case it isn't already.
  try {
    const [p] = await sql`SELECT settings FROM practices WHERE id = ${practice_id}::uuid LIMIT 1`
    const current = (p?.settings ?? {}) as Record<string, unknown>
    const merged = { ...current, uses_ear_piercing: true }
    await sql`UPDATE practices SET settings = ${JSON.stringify(merged)}::jsonb WHERE id = ${practice_id}::uuid`
    summary.flag_set = true
  } catch (e: any) { summary.flag_error = e?.message }

  return res.status(200).json({ ok: true, ...summary })
}
