// Super-admin-only endpoints for editing a practice's settings blob.
//
// GET  /api/admin/practice-settings?practice_id=<uuid>  → settings + audit
// PATCH /api/admin/practice-settings                    → body { practice_id, patch }
//
// PATCH writes ONE audit row per field that actually changed. A no-op
// save (patch matches current) writes nothing.
//
// Everything inlined — Vercel does NOT bundle cross-imports from api/
// into src/lib/ as runtime deps. Keep defaults + validate list in sync
// with api/practice-settings/index.ts and src/lib/practiceSettings.ts.

import type { VercelRequest, VercelResponse } from '@vercel/node'
import { neon } from '@neondatabase/serverless'
import { createRemoteJWKSet, jwtVerify } from 'jose'

const DEFAULT_SETTINGS: Record<string, unknown> = {
  visits_are_in_home:          true,
  uses_office_locations:       false,
  uses_convenience_fees:       true,
  uses_hybrid_tele_visits:     true,
  uses_iv_fluids:              true,
  uses_cpr_classes:            true,
  uses_telemedicine:           true,
  uses_text_visits:            true,
  uses_sports_physicals:       true,
  uses_vaccine_administration: true,
  uses_sick_visits:            true,
  uses_ear_piercing:           false,
  accepts_insurance:           true,
  uses_self_pay_statements:    true,
  uses_stripe_card_on_file:    true,
  uses_square_auto_charge:     true,
  aetna_poc_swap_enabled:      true,
  bcbs_nc_dep_code_check:      true,
  uses_cosign_workflow:        true,
  uses_waitlist:               true,
  uses_broadcasts:             true,
  uses_payroll_module:         true,
  uses_bonus_leaderboard:      true,
  uses_dosespot_eprescribing:  true,
  uses_lab_orders:             true,
  uses_radiology_orders:       true,
  generates_superbills:        true,
  uses_supply_orders:          true,
  providers_can_order_supplies: false,
  uses_patient_portal:         true,
  uses_family_signup:          true,
  uses_booking_requests:       true,
  uses_phi_secure_links:       true,
  uses_pediatric_patients:     true,
  uses_referral_partners:      true,
  uses_specialist_directory:   true,
  uses_oncall_shifts:          true,
  uses_handbook:               true,
  uses_results_module:         false,
  uses_zones:                  true,
  uses_office_room_scheduling: false,
  availability_overrides_only: true,
  legal_name:            null,
  dba:                   null,
  tax_id:                null,
  group_npi:             null,
  taxonomy:              null,
  address_line1:         null,
  address_city:          null,
  address_state:         null,
  address_zip:           null,
  main_phone:            null,
  billing_phone:         null,
  timezone:              'America/New_York',
  business_hours:        null,
  brand_color_primary:   null,
  brand_color_accent:    null,
  statement_footer_text: null,
  email_signature_html:  null,
  dosespot_clinic_id:      null,
  stedi_api_key_ref:       null,
  labcorp_account_number:  null,
  stripe_account_id:       null,
  twilio_phone_number:     null,
  resend_from_domain:      null,
  resend_from_name:        null,
}

const ALLOWED_KEYS = new Set(Object.keys(DEFAULT_SETTINGS))

function parseSettings(raw: unknown): Record<string, unknown> {
  const merged = { ...DEFAULT_SETTINGS }
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      merged[k] = v
    }
  }
  return merged
}

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

export default async function handler(req: VercelRequest, res: VercelResponse) {
  let sub: string
  try { sub = await verifyToken(req.headers.authorization) }
  catch { return res.status(401).json({ error: 'Unauthorized' }) }

  const sql = neon(process.env.DATABASE_URL!)
  const [caller] = await sql`
    SELECT id, name, is_super_admin FROM providers WHERE cognito_sub = ${sub} LIMIT 1`
  if (!caller) return res.status(403).json({ error: 'Provider not found' })
  if (!caller.is_super_admin) return res.status(403).json({ error: 'Super admin access required' })

  if (req.method === 'GET') {
    const practiceId = String(req.query.practice_id ?? '')
    if (!practiceId) return res.status(400).json({ error: 'practice_id required' })

    const [practice] = await sql`
      SELECT id, name, settings FROM practices WHERE id = ${practiceId}::uuid LIMIT 1`
    if (!practice) return res.status(404).json({ error: 'Practice not found' })

    const settings = parseSettings(practice.settings)
    const audit = await sql`
      SELECT field_path, old_value, new_value, changed_by_name, changed_at
      FROM practice_settings_audit
      WHERE practice_id = ${practiceId}::uuid
      ORDER BY changed_at DESC
      LIMIT 200`

    return res.json({
      practice_id: practice.id,
      practice_name: practice.name,
      settings,
      audit,
    })
  }

  if (req.method === 'PATCH') {
    const { practice_id, patch } = (req.body ?? {}) as { practice_id?: string; patch?: unknown }
    if (!practice_id || typeof practice_id !== 'string') return res.status(400).json({ error: 'practice_id required' })
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return res.status(400).json({ error: 'patch required' })

    const [practice] = await sql`
      SELECT id, settings FROM practices WHERE id = ${practice_id}::uuid LIMIT 1`
    if (!practice) return res.status(404).json({ error: 'Practice not found' })

    const current = parseSettings(practice.settings)

    // Whitelist incoming keys. Silently drop anything not in the schema
    // (unknown keys should never reach prod via the UI; this is a safety
    // net against malformed patches or future deprecations).
    const cleanPatch: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
      if (ALLOWED_KEYS.has(k)) cleanPatch[k] = v
    }

    // Compute the merged blob + the diff for audit logging.
    const merged = { ...current, ...cleanPatch }
    const changes: Array<{ field: string; oldValue: unknown; newValue: unknown }> = []
    for (const [field, newValue] of Object.entries(cleanPatch)) {
      const oldValue = current[field]
      if (JSON.stringify(oldValue) !== JSON.stringify(newValue)) {
        changes.push({ field, oldValue, newValue })
      }
    }

    if (changes.length === 0) {
      return res.json({ ok: true, changed: 0, settings: current })
    }

    // Write the merged blob + one audit row per changed field, in one
    // transaction. Neon HTTP driver autocommits per sql call, so without
    // transaction() a mid-batch failure could leave settings updated
    // without audit rows.
    await sql.transaction([
      sql`
        UPDATE practices SET settings = ${JSON.stringify(merged)}::jsonb
        WHERE id = ${practice_id}::uuid`,
      ...changes.map(change => sql`
        INSERT INTO practice_settings_audit
          (practice_id, changed_by_provider_id, changed_by_name, field_path, old_value, new_value)
        VALUES
          (${practice_id}::uuid, ${caller.id}::uuid, ${caller.name},
           ${change.field},
           ${JSON.stringify(change.oldValue ?? null)}::jsonb,
           ${JSON.stringify(change.newValue ?? null)}::jsonb)`),
    ])

    // ── Ear-piercing activation side effect ───────────────────────────
    // Infrastructure (practice_visit_types + visit_type_availability
    // rows for Becca Jones + Megan Heilemann) was scaffolded with
    // is_active=false by /api/admin/setup-ear-piercing. Flipping the
    // uses_ear_piercing setting from off → on in one click activates
    // the visit type + the two providers' availability so parents can
    // book it immediately. Scope: PHC-named providers only (Becca +
    // Megan). Sara 2026-11-22.
    const earToggle = changes.find(c => c.field === 'uses_ear_piercing')
    const activationSummary: Record<string, unknown> = {}
    if (earToggle && earToggle.newValue === true) {
      const EAR_PIERCING = 'In-home ear piercing'

      // 1. Column + table bootstraps so first-run on a fresh practice
      // doesn't blow up on missing schema. Sara 2026-11-22.
      try { await sql`ALTER TABLE appointments ADD COLUMN IF NOT EXISTS addons jsonb` } catch {}
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

      // 2. Visit type — upsert so the row exists AND is_active=true
      // regardless of whether setup-ear-piercing ever ran.
      try {
        const [existingVt] = await sql`
          SELECT id FROM practice_visit_types
          WHERE practice_id = ${practice_id}::uuid AND visit_type = ${EAR_PIERCING}
          LIMIT 1`
        if (existingVt) {
          await sql`
            UPDATE practice_visit_types SET
              base_price = 100, duration_minutes = 60, lead_minutes = 60,
              has_convenience_fee = true, is_in_home = true, is_cpr = false,
              is_active = true, badge_label = 'Piercing', updated_at = NOW()
            WHERE id = ${existingVt.id}::uuid`
          activationSummary.visit_type = 'updated'
        } else {
          await sql`
            INSERT INTO practice_visit_types
              (practice_id, visit_type, base_price, badge_label, badge_color, badge_text_color,
               duration_minutes, lead_minutes, has_convenience_fee, per_child_extra_minutes,
               is_in_home, is_cpr, is_active, sort_order)
            VALUES
              (${practice_id}::uuid, ${EAR_PIERCING}, 100, 'Piercing', '#F1EFE8', '#1A1A2E',
               60, 60, true, 0, true, false, true, 50)`
          activationSummary.visit_type = 'created'
        }
      } catch (e: any) {
        activationSummary.visit_type_error = e?.message ?? 'unknown'
      }

      // 3. Fee schedule — upsert so rows exist with the correct name + price.
      const FEE_UPSERTS: Array<[string, string, number]> = [
        ['EarPierce', 'In-home ear piercing (includes medical-grade titanium starter studs)', 100.00],
        ['EarStudsX', 'Upgrade to titanium piercing studs', 60.00],
      ]
      const feeResults: Array<{ code: string; action: 'created' | 'updated' | 'error'; charge_amount: number | null }> = []
      for (const [code, desc, amt] of FEE_UPSERTS) {
        try {
          const [existing] = await sql`
            SELECT code FROM fee_schedule WHERE practice_id = ${practice_id}::uuid AND code = ${code} LIMIT 1`
          if (existing) {
            const [u] = await sql`
              UPDATE fee_schedule SET description = ${desc}, charge_amount = ${amt}, category = 'Non-Covered Services'
              WHERE practice_id = ${practice_id}::uuid AND code = ${code}
              RETURNING charge_amount`
            feeResults.push({ code, action: 'updated', charge_amount: u?.charge_amount ?? null })
          } else {
            const [c] = await sql`
              INSERT INTO fee_schedule (practice_id, code, description, charge_amount, category)
              VALUES (${practice_id}::uuid, ${code}, ${desc}, ${amt}, 'Non-Covered Services')
              RETURNING charge_amount`
            feeResults.push({ code, action: 'created', charge_amount: c?.charge_amount ?? null })
          }
        } catch {
          feeResults.push({ code, action: 'error', charge_amount: null })
        }
      }
      activationSummary.fees = feeResults

      // 4. Provider availability — upsert for Becca + Megan.
      try {
        const providers = await sql`
          SELECT id, name FROM providers
          WHERE practice_id = ${practice_id}::uuid
            AND name IN ('Becca Jones','Megan Heilemann')
            AND is_active = true` as any[]
        const providerResults: Array<{ name: string; action: 'created' | 'updated' }> = []
        for (const p of providers) {
          const [existingAvail] = await sql`
            SELECT id FROM visit_type_availability
            WHERE provider_id = ${p.id}::uuid AND visit_type = ${EAR_PIERCING} LIMIT 1`
          if (existingAvail) {
            await sql`
              UPDATE visit_type_availability SET is_active = true, start_time = '08:00', end_time = '17:00'
              WHERE id = ${existingAvail.id}::uuid`
            providerResults.push({ name: p.name, action: 'updated' })
          } else {
            await sql`
              INSERT INTO visit_type_availability (provider_id, visit_type, is_active, start_time, end_time)
              VALUES (${p.id}::uuid, ${EAR_PIERCING}, true, '08:00', '17:00')`
            providerResults.push({ name: p.name, action: 'created' })
          }
        }
        activationSummary.providers = providerResults
      } catch (e: any) {
        activationSummary.availability_error = e?.message ?? 'unknown'
      }
    }

    return res.json({ ok: true, changed: changes.length, settings: merged, ...(Object.keys(activationSummary).length ? { ear_piercing: activationSummary } : {}) })
  }

  return res.status(405).json({ error: 'Method not allowed' })
}
