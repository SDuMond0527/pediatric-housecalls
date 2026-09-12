// Single source of truth for payer name → Stedi payer ID mapping. Used by
// every claim-generation path (api/claims/index.ts, api/_lib/generateClaim.ts,
// and any future callers). See memory:
// feedback_extract_shared_code_first_try.md — this mapping drifted between
// two copies until we consolidated.
//
// Add new payers here ONCE and every consumer picks them up.

export const PAYER_IDS: Record<string, string> = {
  // Self-pay maps to "PP" (Private Pay) on claims per Sara's practice
  // billing setup. Every synonym goes here so downstream code doesn't have
  // to normalize.
  'self pay': 'PP', 'self-pay': 'PP', 'selfpay': 'PP', 'self': 'PP',

  // Blue Cross Blue Shield
  'bcbs': 'UPICO', 'bcbs of nc': 'UPICO', 'bcbs nc': 'UPICO',
  'blue cross': 'UPICO', 'blue cross nc': 'UPICO',
  'blue cross blue shield': 'UPICO', 'blue cross blue shield of nc': 'UPICO',
  'blue cross blue shield nc': 'UPICO',

  // Major national carriers
  'aetna': '60054', 'cigna': '62308',
  'united healthcare': '87726', 'united health care': '87726', 'uhc': '87726',
  'umr': '39026', 'humana': '61101',

  // Regional / secondary
  'phcs': '52133', 'multiplan': '52133',
  'coventry': '38217', 'select health': '53589',
  'medcost': '56196', 'healthgram': '56162',
  'bright health': '98798', 'bright healthcare': '98798',
}

export function resolvePayer(name: string | null): string | null {
  if (!name) return null
  return PAYER_IDS[name.toLowerCase().trim()] ?? null
}
