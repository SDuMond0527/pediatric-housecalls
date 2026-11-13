import type { VercelRequest, VercelResponse } from '@vercel/node'

// Sign-time + claim-create validation for visit_type ↔ CPT consistency.
// Sara 2026-11-13 (Emma Peters incident): Sara Schaefer typed 99214
// (office E/M, POS 10) over the 99349 default on an In-home sick
// visit, signed it, and $61.38 of UHC payment was lost.
//
// This helper is the server-side belt-and-suspenders that would have
// blocked the signature. It fires in TWO places:
//   - api/encounter-notes/[id].ts PUT (sign action — primary gate)
//   - api/claims/index.ts POST (claim create — defense in depth)
//
// It is deliberately NOT called from the claim PATCH path: billers
// occasionally need to override code/POS on a claim after the fact
// (corrections from an ERA, e.g.) and locking them out of edits
// would create a worse problem than the one it solves.

// Visit types that happen IN the patient's home. CPTs billed here
// MUST use POS 12 (patient home — in-person) and for the sick-visit
// specifically must include a home-visit E/M code.
const IN_HOME_VISIT_TYPES = new Set<string>([
  'In-home sick visit',
  'In-home vaccine administration',
  'In-home IV fluids',
  'In-home IV fluids – RN only',               // en-dash variant used by family-booking flow
  'RN in-home IV fluids administration',
  'RN IV fluids',
  'RN IV fluid visit — paired with MD/NP screening',
  'RN IV fluids (outside referral)',
])

// Visit types that happen over telemedicine. CPTs here MUST use
// POS 10 (patient home — telehealth). CMA+tele paired visits count
// — the MD/NP is billing a tele E/M regardless of where the CMA is.
const TELEHEALTH_VISIT_TYPES = new Set<string>([
  'Video telemedicine',
  'CMA + telemedicine',
  'CMA + tele',
  'CMA visit — paired with MD/NP telemedicine screening',
  'Video telemedicine screening for IV fluids',
  'Text visit',
])

// The valid home-visit E/M CPT family. 99341-99345 new patient,
// 99347-99350 established. Any one of these on an In-home sick
// visit note is acceptable — the provider picks the level.
const HOME_VISIT_EM_CODES = new Set<string>([
  '99341', '99342', '99344', '99345',
  '99347', '99348', '99349', '99350',
])

type CptEntry = {
  code?: string | null
  place_of_service?: string | null
  category?: string | null
  description?: string | null
}

export interface VisitCodingValidation {
  ok: boolean
  errors: string[]
}

/**
 * Validate that the CPT codes on a note/claim line up with the
 * appointment's visit_type. Returns an array of plain-English error
 * messages if anything looks wrong; callers refuse the action when
 * the array is non-empty.
 *
 * Convenience fees (category 'Non-Covered Services' — CV11, CV3,
 * etc.) are exempt from these checks — their POS can be 12 even
 * on a tele visit (they travel with the in-home half of a paired
 * visit), and they don't carry the E/M-shape expectation.
 *
 * Legacy claims where visit_type is null or empty pass unconditionally.
 * We don't have enough data to judge, and blocking historical fixups
 * would hurt more than it helps.
 */
export function validateCptsForVisitType(
  visitType: string | null | undefined,
  cptCodes: CptEntry[] | null | undefined,
): VisitCodingValidation {
  const errors: string[] = []
  const vt = String(visitType ?? '').trim()
  if (!vt) return { ok: true, errors }
  if (!Array.isArray(cptCodes) || cptCodes.length === 0) return { ok: true, errors }

  // Insurance-billable CPTs only. Convenience fees get their own
  // POS rules (CV11 on a paired CMA+tele visit is POS 12 even
  // though the primary visit_type is tele — the fee covers the
  // in-home half).
  const billable = cptCodes.filter(c => (c?.category ?? '') !== 'Non-Covered Services')

  if (IN_HOME_VISIT_TYPES.has(vt)) {
    for (const c of billable) {
      if (c?.place_of_service === '10') {
        errors.push(
          `CPT ${c.code ?? '(no code)'} is marked POS 10 (telehealth), but the appointment is "${vt}" which happens in the patient's home. Use POS 12.`
        )
      }
    }
  }
  if (TELEHEALTH_VISIT_TYPES.has(vt)) {
    for (const c of billable) {
      if (c?.place_of_service === '12') {
        errors.push(
          `CPT ${c.code ?? '(no code)'} is marked POS 12 (patient home — in-person), but the appointment is "${vt}" which happens over video/text. Use POS 10.`
        )
      }
    }
  }

  // Sick visit: must include at least one home-visit E/M code.
  // This is the rule that would have caught Emma Peters — the
  // default is 99349, but a provider typed over it with 99214
  // (office E/M). Office codes are not reimbursed at the same rate
  // on a home visit, so the mis-code is a direct revenue hit.
  if (vt === 'In-home sick visit') {
    const hasHomeVisitEm = billable.some(c => HOME_VISIT_EM_CODES.has(String(c?.code ?? '')))
    if (!hasHomeVisitEm) {
      const present = billable.map(c => c?.code).filter(Boolean).join(', ') || 'none'
      errors.push(
        `This is an in-home sick visit, but no home-visit E/M code is on the note. ` +
        `Current CPTs: ${present}. Use 99347–99350 for an established patient ` +
        `or 99341–99345 for a new patient. (Office codes 99212–99215 pay substantially less on a house call.)`
      )
    }
  }

  return { ok: errors.length === 0, errors }
}

// Stub default handler — present so Vercel bundles the file as a
// real function and the named exports above resolve at runtime. Any
// direct hit gets 404. See
// feedback_node_esm_js_extension_required.md.
export default function handler(_req: VercelRequest, res: VercelResponse) {
  return res.status(404).json({ error: 'Not found' })
}
