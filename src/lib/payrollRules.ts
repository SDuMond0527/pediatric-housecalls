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

// CV split — provider's share per unit. Same for all providers.
export const CV_SPLIT: Record<string, number> = {
  CV1:  15,
  CV2:  40,
  CV3:  60,
  CV4:  100,
  CV5:  40,
  CV6:  60,
  CV7:  80,
  CV8:  100,
  CV9:  60,
  CV10: 80,
  CV11: 100,
  CV12: 120,
  CV13: 150,
}

// VACV split — Virginia convenience fees. Only Santos and Niu bill these.
export const VACV_SPLIT: Record<string, { santos: number; niu: number }> = {
  VACV1:  { santos: 50,  niu: 40 },
  VACV2:  { santos: 65,  niu: 60 },
  VACV3:  { santos: 115, niu: 100 },
  VACV4:  { santos: 65,  niu: 60 },
  VACV5:  { santos: 90,  niu: 80 },
  VACV6:  { santos: 115, niu: 100 },
  VACV7:  { santos: 90,  niu: 80 },
  VACV8:  { santos: 115, niu: 100 },
  VACV9:  { santos: 135, niu: 120 },
  VACV10: { santos: 160, niu: 150 },
}

// Paired-visit fallback pay — when a row is on a paired appointment
// (CMA+tele or IV fluids) and no specific-code rule matched, pay by role.
export const PAIRED_ROLE_PAY: Record<string, { md: number; pnp: number; cma: number; rn: number }> = {
  'CMA + telemedicine': { md: 31, pnp: 31, cma: 35, rn: 0 },
  'In-home IV fluids':  { md: 31, pnp: 31, cma: 0,  rn: 90 },
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

  const vacv = VACV_SPLIT[code]
  if (vacv) {
    const share = providerName === 'Dr. Rebecca Santos' ? vacv.santos
      : providerName === 'Dr. Nina Niu' ? vacv.niu
      : 0
    return { pay: 0, rvu: 0, rvuRate: 0, rvuCount: 0, cvSplit: share * units }
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
