// Display-only transforms for appointment visit types. Data model stays the
// same — both twins of a paired dual visit are stored with the shared
// dual visit_type ('CMA + telemedicine' or 'In-home IV fluids'). On the
// MD/NP's side of the pair, we relabel to make it clear what that provider
// is actually doing (video screening while a CMA/RN handles in-home work).

const DUAL_VISIT_TYPES = new Set(['CMA + telemedicine', 'In-home IV fluids'])

// The MD/NP's own row will have a PARTNER: tag pointing to the CMA/RN, e.g.
//   "PARTNER: Jane Smith (CMA)"
// The CMA/RN's row will have a PARTNER: tag pointing to the MD/NP, e.g.
//   "PARTNER: Dr. Odumond (MD/NP — telemedicine)"
// Only relabel when we're looking at the MD/NP side.
export function displayVisitType(appt: { visit_type?: string | null; notes?: string | null }): string {
  const vt = String(appt.visit_type ?? '')
  if (!DUAL_VISIT_TYPES.has(vt)) return vt
  const partnerLine = String(appt.notes ?? '').split('|').find(p => p.trim().startsWith('PARTNER:')) || ''
  if (/\((CMA|RN)\)/.test(partnerLine)) return 'Telemedicine – paired'
  return vt
}
