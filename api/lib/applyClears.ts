import type { NeonQueryFunction } from '@neondatabase/serverless'

// Shared server-side helper for the `_clear: string[]` PATCH extension.
// Every table using COALESCE-based UPDATE preserves the old value when
// the client sends null, which means a user can't wipe a stale field
// through the UI. The `_clear` array lets the client explicitly nullify
// whitelisted columns AFTER the COALESCE-based UPDATE runs.
//
// Each caller passes:
//   - sql — Neon query function
//   - table — the SQL table name (whitelisted string constant)
//   - id — the row's UUID
//   - practiceIdSql — a `sql` fragment like `AND practice_id = ${pid}::uuid`
//     or an empty string; every table has slightly different scoping
//   - requestedClears — the raw `_clear` array from the request body
//   - whitelist — a Set of columns that are safe to clear on this table
//
// Because tagged-template SQL doesn't allow interpolating column NAMES
// as identifiers, each field name is a string-literal branch. Callers
// must keep the switch statement in sync with the whitelist — this is
// verified at review time.
//
// See feedback_extract_shared_code_first_try.md.

export function normalizeClears(requested: unknown, whitelist: ReadonlySet<string>): string[] {
  if (!Array.isArray(requested)) return []
  return (requested as unknown[]).filter(
    (k): k is string => typeof k === 'string' && whitelist.has(k),
  )
}

/**
 * Apply _clear against api/appointments/[id].ts columns.
 */
export const APPOINTMENTS_CLEARABLE = new Set<string>([
  'notes', 'after_visit_instructions', 'zone',
  'duration_minutes', 'second_provider_id',
])
export async function applyAppointmentClears(
  sql: NeonQueryFunction<false, false>,
  id: string,
  practiceId: string,
  requested: unknown,
): Promise<void> {
  const clears = normalizeClears(requested, APPOINTMENTS_CLEARABLE)
  for (const field of clears) {
    switch (field) {
      case 'notes':                    await sql`UPDATE appointments SET notes                    = NULL WHERE id = ${id}::uuid AND practice_id = ${practiceId}::uuid`; break
      case 'after_visit_instructions': await sql`UPDATE appointments SET after_visit_instructions = NULL WHERE id = ${id}::uuid AND practice_id = ${practiceId}::uuid`; break
      case 'zone':                     await sql`UPDATE appointments SET zone                     = NULL WHERE id = ${id}::uuid AND practice_id = ${practiceId}::uuid`; break
      case 'duration_minutes':         await sql`UPDATE appointments SET duration_minutes         = NULL WHERE id = ${id}::uuid AND practice_id = ${practiceId}::uuid`; break
      case 'second_provider_id':       await sql`UPDATE appointments SET second_provider_id       = NULL WHERE id = ${id}::uuid AND practice_id = ${practiceId}::uuid`; break
    }
  }
}

/**
 * Apply _clear against api/note-templates/[id].ts columns.
 */
export const NOTE_TEMPLATES_CLEARABLE = new Set<string>([
  'subjective', 'objective', 'plan',
])
export async function applyNoteTemplateClears(
  sql: NeonQueryFunction<false, false>,
  id: string,
  practiceId: string,
  requested: unknown,
): Promise<void> {
  const clears = normalizeClears(requested, NOTE_TEMPLATES_CLEARABLE)
  for (const field of clears) {
    switch (field) {
      case 'subjective': await sql`UPDATE note_templates SET subjective = NULL WHERE id = ${id}::uuid AND practice_id = ${practiceId}::uuid`; break
      case 'objective':  await sql`UPDATE note_templates SET objective  = NULL WHERE id = ${id}::uuid AND practice_id = ${practiceId}::uuid`; break
      case 'plan':       await sql`UPDATE note_templates SET plan       = NULL WHERE id = ${id}::uuid AND practice_id = ${practiceId}::uuid`; break
    }
  }
}

/**
 * Apply _clear against api/encounter-notes/[id].ts columns.
 * This is the biggest one — providers can miswrite a whole SOAP section
 * and need to be able to blank it out.
 */
export const ENCOUNTER_NOTES_CLEARABLE = new Set<string>([
  'chief_complaint', 'subjective', 'objective', 'assessment', 'plan',
  'vaccine_administrations', 'iv_administration',
])
export async function applyEncounterNoteClears(
  sql: NeonQueryFunction<false, false>,
  id: string,
  practiceId: string,
  requested: unknown,
): Promise<void> {
  const clears = normalizeClears(requested, ENCOUNTER_NOTES_CLEARABLE)
  for (const field of clears) {
    switch (field) {
      case 'chief_complaint':          await sql`UPDATE encounter_notes SET chief_complaint          = NULL WHERE id = ${id}::uuid AND practice_id = ${practiceId}::uuid`; break
      case 'subjective':               await sql`UPDATE encounter_notes SET subjective               = NULL WHERE id = ${id}::uuid AND practice_id = ${practiceId}::uuid`; break
      case 'objective':                await sql`UPDATE encounter_notes SET objective                = NULL WHERE id = ${id}::uuid AND practice_id = ${practiceId}::uuid`; break
      case 'assessment':               await sql`UPDATE encounter_notes SET assessment               = NULL WHERE id = ${id}::uuid AND practice_id = ${practiceId}::uuid`; break
      case 'plan':                     await sql`UPDATE encounter_notes SET plan                     = NULL WHERE id = ${id}::uuid AND practice_id = ${practiceId}::uuid`; break
      case 'vaccine_administrations':  await sql`UPDATE encounter_notes SET vaccine_administrations  = NULL WHERE id = ${id}::uuid AND practice_id = ${practiceId}::uuid`; break
      case 'iv_administration':        await sql`UPDATE encounter_notes SET iv_administration        = NULL WHERE id = ${id}::uuid AND practice_id = ${practiceId}::uuid`; break
    }
  }
}

/**
 * Apply _clear against api/families/me.ts columns. Scoped by cognito_sub
 * (not practice_id) since family_profiles has no direct practice_id
 * on the row — it uses cognito auth for scoping.
 */
export const FAMILY_PROFILE_CLEARABLE = new Set<string>([
  'display_name', 'phone',
  'address_line1', 'city', 'state', 'zip',
  'referral_source',
])
export async function applyFamilyProfileClears(
  sql: NeonQueryFunction<false, false>,
  cognitoSub: string,
  requested: unknown,
): Promise<void> {
  const clears = normalizeClears(requested, FAMILY_PROFILE_CLEARABLE)
  for (const field of clears) {
    switch (field) {
      case 'display_name':    await sql`UPDATE family_profiles SET display_name    = NULL WHERE cognito_sub = ${cognitoSub}`; break
      case 'phone':           await sql`UPDATE family_profiles SET phone           = NULL WHERE cognito_sub = ${cognitoSub}`; break
      case 'address_line1':   await sql`UPDATE family_profiles SET address_line1   = NULL WHERE cognito_sub = ${cognitoSub}`; break
      case 'city':            await sql`UPDATE family_profiles SET city            = NULL WHERE cognito_sub = ${cognitoSub}`; break
      case 'state':           await sql`UPDATE family_profiles SET state           = NULL WHERE cognito_sub = ${cognitoSub}`; break
      case 'zip':             await sql`UPDATE family_profiles SET zip             = NULL WHERE cognito_sub = ${cognitoSub}`; break
      case 'referral_source': await sql`UPDATE family_profiles SET referral_source = NULL WHERE cognito_sub = ${cognitoSub}`; break
    }
  }
}
