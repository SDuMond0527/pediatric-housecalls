// Backend twin of src/lib/dualVisitTypes.ts. Must be kept in sync; the two
// TS build roots (frontend vite / backend @vercel/node) can't share files.

export const CMA_TELE_ALIASES = [
  'CMA + telemedicine',
  'CMA + tele',
  'CMA visit — paired with MD/NP telemedicine screening',
] as const

export const IV_FLUIDS_ALIASES = [
  'In-home IV fluids',
  'RN IV fluids',
  'RN IV fluid visit — paired with MD/NP screening',
  'RN in-home IV fluids administration',
  'Video telemedicine screening for IV fluids',
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

export function dualAliasMap<T>(cma: T, iv: T): Record<string, T> {
  const out: Record<string, T> = {}
  for (const k of CMA_TELE_ALIASES) out[k] = cma
  for (const k of IV_FLUIDS_ALIASES) out[k] = iv
  return out
}
