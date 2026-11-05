// GET /api/practice-settings
// Returns the settings blob for the logged-in provider's practice.
//
// Everything is inlined — Vercel does NOT bundle cross-imports from
// api/ into src/lib/ or api/_lib/ as runtime dependencies. Learned
// the hard way 2026-11-05 after two deploys broke on
// ERR_MODULE_NOT_FOUND. The duplication with api/admin/practice-settings
// is intentional and must stay in sync when the settings shape changes.

import type { VercelRequest, VercelResponse } from '@vercel/node'
import { neon } from '@neondatabase/serverless'
import { createRemoteJWKSet, jwtVerify } from 'jose'

// ─── Settings defaults (PHC behavior = all ON) ──────────────────────────
// A practice row with an empty blob behaves identically to PHC does
// today. Flipping a flag false in the blob is what differentiates
// Sarah Cash / future practices. Keep this in sync with
// api/admin/practice-settings.ts and src/lib/practiceSettings.ts.
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

function parseSettings(raw: unknown): Record<string, unknown> {
  const merged = { ...DEFAULT_SETTINGS }
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      merged[k] = v
    }
  }
  return merged
}

// ─── 5-min in-memory cache per practice ─────────────────────────────────
const cache = new Map<string, { settings: Record<string, unknown>; loadedAt: number }>()
const CACHE_TTL_MS = 5 * 60 * 1000

async function getPracticeSettings(practiceId: string): Promise<Record<string, unknown>> {
  if (process.env.FORCE_PHC_LEGACY === 'true') return parseSettings({})

  const now = Date.now()
  const hit = cache.get(practiceId)
  if (hit && now - hit.loadedAt < CACHE_TTL_MS) return hit.settings

  const sql = neon(process.env.DATABASE_URL!)
  const [row] = await sql`SELECT settings FROM practices WHERE id = ${practiceId}::uuid LIMIT 1`
  const settings = parseSettings(row?.settings ?? null)
  cache.set(practiceId, { settings, loadedAt: now })
  return settings
}

// ─── Auth ────────────────────────────────────────────────────────────────
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
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  let sub: string
  try { sub = await verifyToken(req.headers.authorization) }
  catch { return res.status(401).json({ error: 'Unauthorized' }) }

  const sql = neon(process.env.DATABASE_URL!)
  const [provider] = await sql`
    SELECT id, practice_id FROM providers WHERE cognito_sub = ${sub} LIMIT 1`
  if (!provider) return res.status(403).json({ error: 'Provider not found' })

  const settings = await getPracticeSettings(provider.practice_id as string)
  return res.json({ practice_id: provider.practice_id, settings })
}
