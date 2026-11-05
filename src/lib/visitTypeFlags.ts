// Maps every known visit_type string to the practice-settings flag
// that controls whether it's available. Used by:
//   - api/practice-visit-types.ts to filter the list by the practice's
//     enabled flags before returning rows
//   - Family BookVisit + any admin visit-type picker to filter the
//     client-side VISIT_TYPE_INFO map
//
// Leaving a visit_type out of this map (= undefined) means it is NOT
// flag-gated — it's always allowed regardless of settings. "In-home
// sick visit" is the one example: it's PHC's core, not a feature flag.
//
// Keep in sync with practiceSettings.ts flag keys. Sara 2026-11-05.

import type { PracticeSettings } from './practiceSettings'

type FlagKey = keyof PracticeSettings

const VISIT_TYPE_FLAGS: Record<string, FlagKey> = {
  // Telemedicine
  'Video telemedicine':                               'uses_telemedicine',
  'Video telemedicine screening for IV fluids':       'uses_iv_fluids',

  // Text visits
  'Text visit':                                        'uses_text_visits',

  // Sports physicals
  'Sports physical':                                   'uses_sports_physicals',

  // Vaccines
  'In-home vaccine administration':                    'uses_vaccine_administration',

  // CMA + tele (hybrid)
  'CMA + telemedicine':                                'uses_hybrid_tele_visits',
  'CMA + tele':                                        'uses_hybrid_tele_visits',
  'CMA visit — paired with MD/NP telemedicine screening': 'uses_hybrid_tele_visits',

  // IV fluids (all variants)
  'In-home IV fluids':                                 'uses_iv_fluids',
  'In-home IV fluids – RN only':                       'uses_iv_fluids',
  'RN IV fluids':                                      'uses_iv_fluids',
  'RN IV fluid visit — paired with MD/NP screening':   'uses_iv_fluids',
  'RN in-home IV fluids administration':               'uses_iv_fluids',
  'RN IV fluids (outside referral)':                   'uses_iv_fluids',

  // CPR classes (short and long names)
  'In-home CPR class (Heartsaver)':                    'uses_cpr_classes',
  'In-home CPR class (BLS)':                           'uses_cpr_classes',
  'In-home CPR class (Heartsaver Child and Infant First Aid, CPR, AED, choking, injury/environmental emergencies, opioid-associated emergencies (including how to use Narcan) with optional modules in adult CPR/AED)': 'uses_cpr_classes',
  'In-home CPR class (BLS - Adult CPR/AED use, first aid basics, medical/injury/environmental emergencies, choking, opioid-associated emergencies (including how to use Narcan), recognizing mental health crisis signs in the workplace, with optional modules for child & infant CPR/AED)': 'uses_cpr_classes',

  // Ear piercing
  'In-home ear piercing':                              'uses_ear_piercing',

  // Note: 'In-home sick visit' is intentionally NOT in this map —
  // it's PHC's core visit type, never flag-gated.
}

/**
 * Returns true when this visit_type is allowed for a practice with
 * the given settings. Unknown / unmapped visit_types are allowed by
 * default (opt-in gating).
 */
export function isVisitTypeAllowed(visitType: string, settings: PracticeSettings): boolean {
  const flag = VISIT_TYPE_FLAGS[visitType]
  if (!flag) return true
  return !!settings[flag]
}

/**
 * Filter an array of visit types (rows or strings) down to the ones
 * allowed by the practice's settings.
 */
export function filterVisitTypes<T extends { visit_type: string }>(
  rows: T[],
  settings: PracticeSettings,
): T[] {
  return rows.filter(r => isVisitTypeAllowed(r.visit_type, settings))
}
