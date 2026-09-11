// Aliases for the two paired dual visit types. Sara's practice originally
// used the shorter DB names ('CMA + tele', 'RN IV fluids'); the code was
// hardcoded to the longer originals ('CMA + telemedicine', 'In-home IV
// fluids'); and on 2026-09-11 we renamed the DB entries to explicit strings
// that describe what the visit actually is. All three still need to match
// so that historical appointments render correctly and any code that hasn't
// been migrated yet still recognizes the dual-visit nature.

export const CMA_TELE_ALIASES = [
  'CMA + telemedicine',
  'CMA + tele',
  'CMA visit — paired with MD/NP telemedicine screening',
] as const

export const IV_FLUIDS_ALIASES = [
  'In-home IV fluids',
  'RN IV fluids',
  'RN IV fluid visit — paired with MD/NP screening',
] as const

export const DUAL_VISIT_TYPES: readonly string[] = [
  ...CMA_TELE_ALIASES,
  ...IV_FLUIDS_ALIASES,
]

export function isCmaTelePair(v?: string | null): boolean {
  return !!v && (CMA_TELE_ALIASES as readonly string[]).includes(v)
}

export function isIvFluidsPair(v?: string | null): boolean {
  return !!v && (IV_FLUIDS_ALIASES as readonly string[]).includes(v)
}

export function isDualVisit(v?: string | null): boolean {
  return !!v && DUAL_VISIT_TYPES.includes(v)
}

// Build a lookup map that maps every alias for a paired visit type to the
// same value. Callers can spread the result into their existing string→X map.
//   Object.fromEntries(CMA_TELE_ALIASES.map(k => [k, 30]))
// is the pattern used inline in several files.
export function dualAliasMap<T>(cma: T, iv: T): Record<string, T> {
  const out: Record<string, T> = {}
  for (const k of CMA_TELE_ALIASES) out[k] = cma
  for (const k of IV_FLUIDS_ALIASES) out[k] = iv
  return out
}
