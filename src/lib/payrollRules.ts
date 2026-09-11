// Payroll pay rules — single source of truth for how each CPT code maps to
// provider pay. Update this file when rates change or new codes are added.

// Home visit E/M code → wRVU value.
export const RVU_CHART: Record<string, number> = {
  '99341': 1.00,
  '99342': 1.52,
  '99344': 3.38,
  '99345': 4.09,
  '99347': 1.01,
  '99348': 1.56,
  '99349': 2.33,
  '99350': 3.28,
}

// $/RVU by provider. Role-based defaults with per-provider overrides.
export function providerRvuRate(providerName: string, role: string): number {
  const r = (role ?? '').toUpperCase()
  if (r === 'MD') {
    return providerName === 'Dr. Sara DuMond' ? 38 : 36
  }
  if (r === 'PNP' || r === 'NP') {
    return providerName === 'Becca Jones' ? 22 : 20
  }
  return 0
}

// Flat pay per unit — same regardless of provider.
export const FLAT_PAY_BY_CODE: Record<string, number> = {
  SportsPh: 45,    // Sports physical
  Selfpay:  105,   // Self-pay in-person house call sick visit
  TextE:    35,    // Text e-visit
  selfvv:   31,    // Self-pay virtual visit (same as video)
  SLFPAYVV: 31,
  '98000':  31,
  '98001':  31,
  '98002':  31,
  '98003':  31,
  '98004':  31,
  '98005':  31,
  '98006':  31,
  '98007':  31,
}

// Office E/M codes that are treated as virtual visits when modifier 95 is
// present. Pays $31 flat regardless of provider (MD or NP).
export const TELEHEALTH_MOD95_PAY: Record<string, number> = {
  '99203': 31,
  '99204': 31,
  '99213': 31,
  '99214': 31,
}

// CV split — provider's share per unit. Codes match the fee_schedule DB
// exactly. Split rules come from Sara's authoritative CV structure document.
// All providers get the same share (no per-provider differential).
export const CV_SPLIT: Record<string, number> = {
  CV1:     15,   // Weekday 8am-3pm, 0-5 mi     ($50)
  CV2:     40,   // Weekday 8am-3pm, 5-15 mi    ($75)
  CV3:     60,   // Weekday 8am-3pm, >15 mi     ($100)
  CV4:     40,   // Weekday off-hours, 0-5 mi   ($75)
  CV5:     60,   // Weekday off-hours, 5-15 mi  ($100)
  CV6:     80,   // Weekday off-hours, >15 mi   ($125)
  CV7:     60,   // Weekend, 0-5 mi             ($100)
  CV8:     80,   // Weekend, 5-15 mi            ($125)
  CV9:     100,  // Weekend, >15 mi             ($150)
  CV10:    150,  // Major holiday               ($200)
  CV11:    0,    // IV fluids convenience       ($150, no provider cut)
  CVTech:  0,    // CMA visit convenience       ($50,  no provider cut)
}

// VACV split — Virginia convenience fees. Per new rules, no Santos/Niu
// differential — all providers get the same share.
export const VACV_SPLIT: Record<string, number> = {
  VACV1:   40,   // Weekday 8am-3pm, 0-5 mi     ($75)
  VACV2:   60,   // Weekday 8am-3pm, 5-15 mi    ($100)
  VACV3:   100,  // Weekday 8am-3pm, >15 mi     ($150)
  VACV4:   60,   // Weekday off-hours, 0-5 mi   ($100)
  VACV5:   80,   // Weekday off-hours, 5-15 mi  ($125)
  VACV6:   100,  // Weekday off-hours, >15 mi   ($150)
  VACV7:   80,   // Weekend, 0-5 mi             ($125)
  VACV8:   100,  // Weekend, 5-15 mi            ($150)
  VACV9:   140,  // Weekend, >15 mi             ($175)
  VACV10:  150,  // Major holiday               ($200)
  VACV11:  15,   // Weekday <2 mi               ($50)
}

// Paired-visit fallback pay — when a row is on a paired appointment
// (CMA+tele or IV fluids) and no specific-code rule matched, pay by role.
// Every alias name for each pair maps to the same value.
import { CMA_TELE_ALIASES, IV_FLUIDS_ALIASES } from './dualVisitTypes'

const CMA_TELE_PAY = { md: 31, pnp: 31, cma: 35, rn: 0 }
const IV_FLUIDS_PAY = { md: 31, pnp: 31, cma: 0, rn: 90 }

export const PAIRED_ROLE_PAY: Record<string, { md: number; pnp: number; cma: number; rn: number }> = {
  ...Object.fromEntries(CMA_TELE_ALIASES.map(k => [k, CMA_TELE_PAY])),
  ...Object.fromEntries(IV_FLUIDS_ALIASES.map(k => [k, IV_FLUIDS_PAY])),
}

export interface PayComputation {
  pay: number
  rvu: number
  rvuRate: number
  rvuCount: number
  cvSplit: number
}

export function computeProviderPay(input: {
  code: string
  quantity: number
  visitType: string
  providerName: string
  providerRole: string
  modifier?: string
}): PayComputation {
  const { code, quantity, visitType, providerName, providerRole, modifier } = input
  const units = quantity > 0 ? quantity : 1

  const rvu = RVU_CHART[code]
  if (rvu !== undefined) {
    const rvuRate  = providerRvuRate(providerName, providerRole)
    const rvuCount = rvu * units
    return { pay: rvuCount * rvuRate, rvu, rvuRate, rvuCount, cvSplit: 0 }
  }

  // Office E/M code billed as telehealth (modifier 95) — flat $31 to any provider.
  const telehealthPay = TELEHEALTH_MOD95_PAY[code]
  if (telehealthPay !== undefined && /(^|\W)95(\W|$)/.test(String(modifier ?? ''))) {
    return { pay: telehealthPay * units, rvu: 0, rvuRate: 0, rvuCount: 0, cvSplit: 0 }
  }

  if (CV_SPLIT[code] !== undefined) {
    return { pay: 0, rvu: 0, rvuRate: 0, rvuCount: 0, cvSplit: CV_SPLIT[code] * units }
  }

  if (VACV_SPLIT[code] !== undefined) {
    return { pay: 0, rvu: 0, rvuRate: 0, rvuCount: 0, cvSplit: VACV_SPLIT[code] * units }
  }

  const flat = FLAT_PAY_BY_CODE[code]
  if (flat !== undefined) {
    return { pay: flat * units, rvu: 0, rvuRate: 0, rvuCount: 0, cvSplit: 0 }
  }

  const pair = PAIRED_ROLE_PAY[visitType]
  if (pair) {
    const r = (providerRole ?? '').toUpperCase()
    if (r === 'MD')  return { pay: pair.md,  rvu: 0, rvuRate: 0, rvuCount: 0, cvSplit: 0 }
    if (r === 'PNP' || r === 'NP') return { pay: pair.pnp, rvu: 0, rvuRate: 0, rvuCount: 0, cvSplit: 0 }
    if (r === 'CMA') return { pay: pair.cma, rvu: 0, rvuRate: 0, rvuCount: 0, cvSplit: 0 }
    if (r === 'RN')  return { pay: pair.rn,  rvu: 0, rvuRate: 0, rvuCount: 0, cvSplit: 0 }
  }

  return { pay: 0, rvu: 0, rvuRate: 0, rvuCount: 0, cvSplit: 0 }
}
