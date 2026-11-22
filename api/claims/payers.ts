import type { VercelRequest, VercelResponse } from '@vercel/node'

// Canonical payer-name lookup, keyed by payer_id.
//
// Why this file exists: before 2026-11-13, claims.payer_name was
// whatever free-text the parent typed during intake ("BCBS", "Blue
// Cross", "Bcbs", "united healthcare", "UMR ", etc.). That meant any
// payer-keyed logic (denial-reason routing, appeal templates,
// underpayment tolerance per payer) had to defeature-match a dozen
// spellings to catch one actual payer. We fix it by normalizing the
// DISPLAY name from the payer_id, which is already clean because
// intake maps the typed string to a payer_id at claim creation.
//
// Rules Sara approved 2026-11-13:
//   - UPICO → "BCBS of NC" (absorbs BCBS / Blue Cross / Anthem BCBS
//     / Anthem PPO, since those all bill to UPICO)
//   - VABLS → "Anthem BCBS of VA" (stays distinct even though it's
//     an Anthem brand — different payer ID, different contract)
//   - 87726 → "United Healthcare"
//   - 62308 → "Cigna"
//   - 60054 → "Aetna"
//   - 39026 → "UMR"
//   - 98798 → "Bright Health"
//   - 56162 → "Medcost"
//   - 41124 → "Meritain"
//   - PP    → "Self Pay"
//
// Unknown payer_id → return null and let the caller fall back to the
// raw string. We don't want to overwrite a payer_name we can't
// confidently map.

const CANONICAL_BY_PAYER_ID: Record<string, string> = {
  'UPICO': 'BCBS of NC',
  'VABLS': 'Anthem BCBS of VA',
  '87726': 'United Healthcare',
  '62308': 'Cigna',
  '60054': 'Aetna',
  '39026': 'UMR',
  '98798': 'Bright Health',
  '56162': 'Medcost',
  '41124': 'Meritain',
  // Interactive Medical Systems — TPA for several self-funded plans
  // (NCDS Healthcare Plan etc.). Used ONLY for eligibility 270 lookups
  // where the claims filer (MedCost) doesn't carry the member database.
  // Claims still route to the claims-side payer per the member's card.
  // See children.insurance_eligibility_payer_id override. Sara 2026-11-20.
  '87765': 'Interactive Medical Systems',
  // Anthem's eligibility-side payer ID. Claims for Anthem patients
  // still route to UPICO via BlueCard, but the 270 inquiry goes
  // directly to Anthem (00601) at Stedi. Sara 2026-11-22.
  '00601': 'Anthem',
  'PP':    'Self Pay',
}

// Provider-appeal window in days, counted from era_received_at. These
// are the industry-standard provider filing limits; if Sara's actual
// contract allows longer or requires shorter, override here. Self Pay
// is N/A (no payer to appeal). Unknown payers default to 90 days
// (conservative) so the biller gets warned sooner rather than later.
const APPEAL_WINDOW_DAYS: Record<string, number> = {
  'UPICO': 180,
  'VABLS': 180,
  '87726': 180,
  '62308': 180,
  '60054': 180,
  '39026': 180,
  '98798': 180,
  '56162': 180,
  '41124': 180,
  'PP':    0,   // self-pay: no appeal path
}
const DEFAULT_APPEAL_WINDOW_DAYS = 90

/**
 * Canonical display name for a claim's payer, keyed by its payer_id.
 * Returns null if the payer_id isn't in the canonical map — the
 * caller should fall back to the raw payer_name rather than
 * silently writing an empty string.
 */
export function canonicalPayerName(payerId: string | null | undefined): string | null {
  if (!payerId) return null
  return CANONICAL_BY_PAYER_ID[String(payerId).trim()] ?? null
}

/** Full canonical list — handy for appeal-template routing + UI. */
export function allCanonicalPayers(): Array<{ payer_id: string; canonical_name: string }> {
  return Object.entries(CANONICAL_BY_PAYER_ID).map(([payer_id, canonical_name]) => ({ payer_id, canonical_name }))
}

// Stub handler so Vercel treats this as a real function file (per
// feedback_node_esm_js_extension_required.md). Direct hits get 404.
export default function handler(_req: VercelRequest, res: VercelResponse) {
  return res.status(404).json({ error: 'Not found' })
}
