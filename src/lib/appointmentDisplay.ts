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
  if (!partnerLine) return vt
  const partnerName = partnerLine.replace(/^.*?PARTNER:\s*/i, '').replace(/\s*\(.*$/, '').trim()
  if (!partnerName) return vt

  const partnerIsRn    = /\(RN\)/.test(partnerLine)
  const partnerIsCma   = /\(CMA\)/.test(partnerLine)
  const partnerIsMdNp  = /\(MD\/NP|\bNP\b/.test(partnerLine)

  // IV fluids pair — differentiate by this row's own visit_type.
  // 'Video telemedicine screening for IV fluids' is uniquely the NP side.
  // Any other IV_FLUIDS_ALIAS vt is the RN side.
  if (vt === 'Video telemedicine screening for IV fluids') {
    return `Telemedicine screening for IV Fluids w/ ${partnerName}`
  }
  if (/iv\s*fluid/i.test(vt)) {
    return `In-home IV fluids w/ ${partnerName}`
  }

  // CMA+tele pair — both sides share the same visit_type, so differentiate
  // by partner role.
  if (partnerIsCma) return `Telemedicine screening w/ ${partnerName} on-site`
  if (partnerIsMdNp) return `CMA visit w/ ${partnerName}`
  if (partnerIsRn)   return `Telemedicine screening w/ ${partnerName}` // defensive fallback

  return vt
}
