// Display-only transforms for appointment visit types. Data model stays the
// same — both twins of a paired dual visit are stored with the shared dual
// visit_type (CMA+tele) or distinct per-side types (IV fluids). On the
// MD/NP's side of the pair, we relabel to make it crystal clear what that
// provider is doing AND who the in-home partner is, so Megan doesn't have
// to expand the card to see which RN is on-site. Sara 2026-10-06.

import { DUAL_VISIT_TYPES as DUAL_ALIASES } from './dualVisitTypes'

const DUAL_VISIT_TYPES = new Set(DUAL_ALIASES)

// The MD/NP's own row will have a PARTNER: tag pointing to the CMA/RN, e.g.
//   "PARTNER: Jane Smith (CMA)"
// The CMA/RN's row will have a PARTNER: tag pointing to the MD/NP, e.g.
//   "PARTNER: Dr. Odumond (MD/NP — telemedicine)"
// Only relabel when we're looking at the MD/NP side.
export function displayVisitType(appt: { visit_type?: string | null; notes?: string | null }): string {
  const vt = String(appt.visit_type ?? '')
  if (!DUAL_VISIT_TYPES.has(vt)) return vt
  const partnerLine = String(appt.notes ?? '').split('|').find(p => p.trim().startsWith('PARTNER:')) || ''
  const roleMatch = partnerLine.match(/\((CMA|RN)\)/)
  if (!roleMatch) return vt
  const partnerName = partnerLine.replace(/^.*?PARTNER:\s*/i, '').replace(/\s*\(.*$/, '').trim()
  if (roleMatch[1] === 'RN') {
    return partnerName
      ? `Telemedicine screening for IV Fluids · with RN ${partnerName}`
      : 'Telemedicine screening for IV Fluids'
  }
  // CMA partner
  return partnerName
    ? `Telemedicine screening · with CMA ${partnerName} on-site`
    : 'Telemedicine – paired'
}
