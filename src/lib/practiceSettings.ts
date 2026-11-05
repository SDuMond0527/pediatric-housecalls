// Practice settings — the on/off switches and per-practice values that
// let one GoRoam codebase serve multiple practices without code changes.
//
// This is the Phase 1 scaffolding. Nothing in the app reads these flags
// yet (that's Phase 2). But the settings blob is populated, validated,
// and editable via the super-admin Settings tab so you can see the
// shape before features start branching on it.
//
// Design rule: defaults are "PHC behavior" (every flag ON). A practice
// row with no settings blob yet behaves exactly like PHC does today —
// so a missed seed can't accidentally hide features from PHC. When we
// onboard a lighter-weight practice like Sarah Cash, we explicitly
// seed a slimmer blob.
//
// Sara 2026-11-04.

import { z } from 'zod'

// ─── Feature flags ─────────────────────────────────────────────────────

const featureFlags = {
  // Visits & clinical workflow
  visits_are_in_home:          z.boolean().default(true),
  uses_office_locations:       z.boolean().default(false),
  uses_convenience_fees:       z.boolean().default(true),
  uses_hybrid_tele_visits:     z.boolean().default(true),
  uses_iv_fluids:              z.boolean().default(true),
  uses_cpr_classes:            z.boolean().default(true),
  uses_telemedicine:           z.boolean().default(true),
  uses_text_visits:            z.boolean().default(true),
  uses_sports_physicals:       z.boolean().default(true),
  uses_vaccine_administration: z.boolean().default(true),
  uses_sick_visits:            z.boolean().default(true),
  uses_ear_piercing:           z.boolean().default(false),

  // Billing & insurance
  accepts_insurance:           z.boolean().default(true),
  uses_self_pay_statements:    z.boolean().default(true),
  uses_stripe_card_on_file:    z.boolean().default(true),
  uses_square_auto_charge:     z.boolean().default(true),
  aetna_poc_swap_enabled:      z.boolean().default(true),
  bcbs_nc_dep_code_check:      z.boolean().default(true),

  // Provider workflow
  uses_cosign_workflow:        z.boolean().default(true),
  uses_waitlist:               z.boolean().default(true),
  uses_broadcasts:             z.boolean().default(true),
  uses_payroll_module:         z.boolean().default(true),
  uses_dosespot_eprescribing:  z.boolean().default(true),
  uses_lab_orders:             z.boolean().default(true),
  uses_radiology_orders:       z.boolean().default(true),

  // Family-facing
  uses_patient_portal:         z.boolean().default(true),
  uses_family_signup:          z.boolean().default(true),
  uses_booking_requests:       z.boolean().default(true),
  uses_phi_secure_links:       z.boolean().default(true),

  // Scheduling model
  uses_zones:                  z.boolean().default(true),
  uses_office_room_scheduling: z.boolean().default(false),
  availability_overrides_only: z.boolean().default(true),
}

// ─── Identity values ───────────────────────────────────────────────────
// Fields the practice row (practices table) doesn't already model.
// Nullable — a brand-new practice can leave these blank until someone
// fills them in.

const identityValues = {
  legal_name:            z.string().nullable().default(null),
  dba:                   z.string().nullable().default(null),
  tax_id:                z.string().nullable().default(null),
  group_npi:             z.string().nullable().default(null),
  taxonomy:              z.string().nullable().default(null),
  address_line1:         z.string().nullable().default(null),
  address_city:          z.string().nullable().default(null),
  address_state:         z.string().nullable().default(null),
  address_zip:           z.string().nullable().default(null),
  main_phone:            z.string().nullable().default(null),
  billing_phone:         z.string().nullable().default(null),
  timezone:              z.string().default('America/New_York'),
  business_hours:        z.record(z.string(), z.object({ open: z.string(), close: z.string() })).nullable().default(null),
  brand_color_primary:   z.string().nullable().default(null),
  brand_color_accent:    z.string().nullable().default(null),
  statement_footer_text: z.string().nullable().default(null),
  email_signature_html:  z.string().nullable().default(null),
}

// ─── Integration refs ──────────────────────────────────────────────────
// Per-practice vendor credentials or clinic IDs. Nullable — a flag might
// be ON (e.g. uses_dosespot_eprescribing=true) but the practice hasn't
// provided their ID yet. In that case the feature should fail gracefully
// and tell the admin what's missing. That gating is Phase 2's job.

const integrationRefs = {
  dosespot_clinic_id:      z.string().nullable().default(null),
  stedi_api_key_ref:       z.string().nullable().default(null),
  labcorp_account_number:  z.string().nullable().default(null),
  stripe_account_id:       z.string().nullable().default(null),
  twilio_phone_number:     z.string().nullable().default(null),
  resend_from_domain:      z.string().nullable().default(null),
  resend_from_name:        z.string().nullable().default(null),
}

// ─── Full schema ───────────────────────────────────────────────────────

export const practiceSettingsSchema = z.object({
  ...featureFlags,
  ...identityValues,
  ...integrationRefs,
}).passthrough()
// passthrough so unknown keys survive round-trips (forward-compat for
// future-added flags that exist in prod but not yet in this schema).

export type PracticeSettings = z.infer<typeof practiceSettingsSchema>

/**
 * Parse a raw settings blob from the DB, filling in every missing field
 * with its PHC-default value. Safe to call with `{}`, `null`, or a
 * partially-filled object. Returns a complete, typed settings object.
 */
export function parsePracticeSettings(raw: unknown): PracticeSettings {
  if (raw == null) return practiceSettingsSchema.parse({})
  return practiceSettingsSchema.parse(raw)
}

/**
 * Name + group of each setting field — used by the super-admin Settings
 * tab UI to render toggles and inputs in sensible sections. The group
 * labels mirror the plan doc (§2 Feature toggles).
 */
export const SETTINGS_GROUPS: Array<{
  group: string
  fields: Array<{ key: keyof PracticeSettings; label: string; kind: 'flag' | 'string' | 'timezone' }>
}> = [
  {
    group: 'Visits & clinical workflow',
    fields: [
      { key: 'visits_are_in_home',          label: 'Visits are in-home',                 kind: 'flag' },
      { key: 'uses_office_locations',       label: 'Uses office locations',              kind: 'flag' },
      { key: 'uses_convenience_fees',       label: 'Uses convenience fees (CV11 etc.)',  kind: 'flag' },
      { key: 'uses_hybrid_tele_visits',     label: 'Uses hybrid tele visits (CMA+tele)', kind: 'flag' },
      { key: 'uses_iv_fluids',              label: 'Uses IV fluids visit type',          kind: 'flag' },
      { key: 'uses_cpr_classes',            label: 'Uses CPR classes',                   kind: 'flag' },
      { key: 'uses_telemedicine',           label: 'Uses video telemedicine',            kind: 'flag' },
      { key: 'uses_text_visits',            label: 'Uses text visits',                   kind: 'flag' },
      { key: 'uses_sports_physicals',       label: 'Uses sports physicals',              kind: 'flag' },
      { key: 'uses_vaccine_administration', label: 'Uses vaccine administration',        kind: 'flag' },
      { key: 'uses_sick_visits',            label: 'Uses sick visits',                   kind: 'flag' },
      { key: 'uses_ear_piercing',           label: 'Uses ear piercing',                  kind: 'flag' },
    ],
  },
  {
    group: 'Billing & insurance',
    fields: [
      { key: 'accepts_insurance',        label: 'Accepts insurance (claims pipeline)',       kind: 'flag' },
      { key: 'uses_self_pay_statements', label: 'Uses self-pay patient statements',          kind: 'flag' },
      { key: 'uses_stripe_card_on_file', label: 'Uses Stripe card on file',                  kind: 'flag' },
      { key: 'uses_square_auto_charge',  label: 'Uses Square auto-charge (legacy)',          kind: 'flag' },
      { key: 'aetna_poc_swap_enabled',   label: 'Auto-swap Aetna POC labs to self-pay',      kind: 'flag' },
      { key: 'bcbs_nc_dep_code_check',   label: 'Warn when BCBS NC dep code missing',        kind: 'flag' },
    ],
  },
  {
    group: 'Provider workflow',
    fields: [
      { key: 'uses_cosign_workflow',       label: 'Uses NP → MD co-signature',   kind: 'flag' },
      { key: 'uses_waitlist',              label: 'Uses waitlist',               kind: 'flag' },
      { key: 'uses_broadcasts',            label: 'Uses shift broadcasts',       kind: 'flag' },
      { key: 'uses_payroll_module',        label: 'Uses payroll module',         kind: 'flag' },
      { key: 'uses_dosespot_eprescribing', label: 'Uses DoseSpot e-prescribing', kind: 'flag' },
      { key: 'uses_lab_orders',            label: 'Uses outside lab orders',     kind: 'flag' },
      { key: 'uses_radiology_orders',      label: 'Uses radiology orders',       kind: 'flag' },
    ],
  },
  {
    group: 'Family-facing',
    fields: [
      { key: 'uses_patient_portal',    label: 'Uses family patient portal', kind: 'flag' },
      { key: 'uses_family_signup',     label: 'Uses family self-signup',    kind: 'flag' },
      { key: 'uses_booking_requests',  label: 'Uses booking requests',      kind: 'flag' },
      { key: 'uses_phi_secure_links',  label: 'Uses PHI secure links',      kind: 'flag' },
    ],
  },
  {
    group: 'Scheduling model',
    fields: [
      { key: 'uses_zones',                  label: 'Uses geographic zones',         kind: 'flag' },
      { key: 'uses_office_room_scheduling', label: 'Uses office room scheduling',   kind: 'flag' },
      { key: 'availability_overrides_only', label: 'Availability is overrides-only', kind: 'flag' },
    ],
  },
  {
    group: 'Practice identity',
    fields: [
      { key: 'legal_name',    label: 'Legal name',           kind: 'string' },
      { key: 'dba',           label: 'DBA / Doing business as', kind: 'string' },
      { key: 'tax_id',        label: 'Tax ID (EIN)',         kind: 'string' },
      { key: 'group_npi',     label: 'Group NPI',            kind: 'string' },
      { key: 'taxonomy',      label: 'Taxonomy code',        kind: 'string' },
      { key: 'address_line1', label: 'Address line 1',       kind: 'string' },
      { key: 'address_city',  label: 'City',                 kind: 'string' },
      { key: 'address_state', label: 'State',                kind: 'string' },
      { key: 'address_zip',   label: 'ZIP',                  kind: 'string' },
      { key: 'main_phone',    label: 'Main phone',           kind: 'string' },
      { key: 'billing_phone', label: 'Billing phone',        kind: 'string' },
      { key: 'timezone',      label: 'Timezone',             kind: 'timezone' },
      { key: 'brand_color_primary', label: 'Brand color — primary', kind: 'string' },
      { key: 'brand_color_accent',  label: 'Brand color — accent',  kind: 'string' },
      { key: 'statement_footer_text', label: 'Statement footer text', kind: 'string' },
    ],
  },
  {
    group: 'Integrations',
    fields: [
      { key: 'dosespot_clinic_id',     label: 'DoseSpot clinic ID',      kind: 'string' },
      { key: 'stedi_api_key_ref',      label: 'Stedi API key reference', kind: 'string' },
      { key: 'labcorp_account_number', label: 'Labcorp account number',  kind: 'string' },
      { key: 'stripe_account_id',      label: 'Stripe account ID',       kind: 'string' },
      { key: 'twilio_phone_number',    label: 'Twilio phone number',     kind: 'string' },
      { key: 'resend_from_domain',     label: 'Resend FROM domain',      kind: 'string' },
      { key: 'resend_from_name',       label: 'Resend FROM name',        kind: 'string' },
    ],
  },
]

/**
 * Convenience helper — produce a skeleton settings blob for a lightweight
 * office-based, cash-pay-only practice (Sarah Cash, MD's try-it-out shell).
 * Used by the onboarding script in Phase 4. Overrides the PHC defaults
 * with a minimal set of flags off.
 */
export function skeletonCashPayOfficeSettings(): Partial<PracticeSettings> {
  return {
    visits_are_in_home:          false,
    uses_office_locations:       true,
    uses_convenience_fees:       false,
    uses_hybrid_tele_visits:     false,
    uses_iv_fluids:              false,
    uses_cpr_classes:            false,
    uses_text_visits:            false,
    uses_vaccine_administration: false,
    accepts_insurance:           false,
    uses_square_auto_charge:     false,
    aetna_poc_swap_enabled:      false,
    bcbs_nc_dep_code_check:      false,
    uses_cosign_workflow:        false,
    uses_broadcasts:             false,
    uses_payroll_module:         false,
    uses_zones:                  false,
    availability_overrides_only: false,
    // Everything else inherits the schema's PHC default.
  }
}
