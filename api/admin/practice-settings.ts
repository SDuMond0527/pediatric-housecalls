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
  uses_dosespot_eprescribing:  true,
  uses_lab_orders:             true,
  uses_radiology_orders:       true,
  uses_patient_portal:         true,
  uses_family_signup:          true,
  uses_booking_requests:       true,
  uses_phi_secure_links:       true,
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

    return res.json({ ok: true, changed: changes.length, settings: merged })
  }

  return res.status(405).json({ error: 'Method not allowed' })
}
