/**
 * Pre-submit claim scrubber. Runs client-side before the biller hits
 * "Submit to insurance" (AdminClaims.tsx handleSubmit) and surfaces
 * problems so Andrea doesn't send a claim that'll come back as a
 * denial, rejection, or outright API error.
 *
 * The server (api/claims/[id].ts, action='submit') independently
 * enforces the ERROR-tier rules — the client scrubber is for UX
 * (block the button, explain why), not for safety.
 *
 * ERRORS block submit entirely. WARNINGS pop a confirmation the
 * biller must acknowledge ("I know, submit anyway").
 *
 * Sara 2026-10-05.
 */

export type ScrubIssue = {
  code: string
  message: string
}

export type ScrubResult = {
  errors: ScrubIssue[]
  warnings: ScrubIssue[]
}

export type ScrubbableClaim = {
  id?: string
  service_date: string | Date | null
  diagnoses: Array<{ code: string }> | null
  cpt_codes: Array<{ code: string; charge_amount?: number | string; units?: number | string }> | null
  patient_dob: string | null
  rendering_provider_npi: string | null
  payer_id: string | null
  payer_name: string | null
  child_id?: string | null
}

export type ScrubContext = {
  // Other submitted claims for this child, used for duplicate detection.
  // Caller should pre-filter to the same child_id to keep this cheap.
  otherSubmittedClaims?: Array<{
    id: string
    service_date: string | Date | null
    cpt_codes: Array<{ code: string }> | null
    status: string
  }>
  // Last successful Stedi eligibility check (any time, any payer)
  // for this child. ISO string or null.
  lastEligibilityCheckAt?: string | null
}

// Timely filing windows (days from DOS) by payer family. Conservative
// values; most practices submit well within these. Pulled from the
// current public payer policies — override here if a payer updates.
const TIMELY_FILING_DAYS: Record<string, number> = {
  BCBS: 90,
  UHC:  90,
  CIGNA: 90,
  AETNA: 120,
  MEDICARE: 365,
  MEDICAID: 365,
}

function daysBetween(from: Date, to: Date): number {
  const ms = to.getTime() - from.getTime()
  return Math.floor(ms / (1000 * 60 * 60 * 24))
}

function normalizePayerFamily(payerName: string | null): keyof typeof TIMELY_FILING_DAYS | null {
  if (!payerName) return null
  const n = payerName.toLowerCase().replace(/\s+/g, '')
  if (n.includes('bcbs') || n.includes('bluecross') || n.includes('blueshield')) return 'BCBS'
  if (n.includes('united') || n === 'uhc' || n.includes('unitedhealthcare')) return 'UHC'
  if (n.includes('cigna')) return 'CIGNA'
  if (n.includes('aetna')) return 'AETNA'
  if (n.includes('medicare')) return 'MEDICARE'
  if (n.includes('medicaid')) return 'MEDICAID'
  return null
}

const ELIGIBILITY_STALENESS_DAYS = 30

/**
 * Persistent badge for the claim card in Pending Review / Rework / Draft
 * tabs so Andrea sees timely-filing urgency without having to click
 * into Submit. Returns null when the claim is already submitted, has
 * an ERA back, or is still comfortably far from the filing deadline.
 *
 * `urgent`  = ≤ 14 days left — orange
 * `expired` = past the deadline — red
 */
export type FilingBadge = {
  variant: 'urgent' | 'expired'
  daysLeft: number
  window: number
  payerFamily: string
  label: string
}

export function getFilingBadge(claim: {
  service_date: string | Date | null
  payer_name: string | null
  status?: string | null
  era_received_at?: string | Date | null
}): FilingBadge | null {
  // Already submitted or already adjudicated — timely filing concern
  // is in the past.
  if (!claim.service_date) return null
  if (claim.status === 'submitted') return null
  if (claim.era_received_at) return null

  const dos = new Date(claim.service_date)
  if (isNaN(dos.getTime())) return null

  const daysSince = daysBetween(dos, new Date())
  const family = normalizePayerFamily(claim.payer_name)
  const window = family ? TIMELY_FILING_DAYS[family] : 90
  const daysLeft = window - daysSince

  if (daysLeft < 0) {
    return {
      variant: 'expired',
      daysLeft,
      window,
      payerFamily: family ?? 'Payer',
      label: 'FILING EXPIRED',
    }
  }
  if (daysLeft <= 14) {
    return {
      variant: 'urgent',
      daysLeft,
      window,
      payerFamily: family ?? 'Payer',
      label: daysLeft === 0 ? 'FILE TODAY' : `${daysLeft}d TO FILE`,
    }
  }
  return null
}

export function scrubClaim(claim: ScrubbableClaim, ctx: ScrubContext = {}): ScrubResult {
  const errors: ScrubIssue[] = []
  const warnings: ScrubIssue[] = []

  // ── TIER 1 — hard blocks ─────────────────────────────────────────────────
  const dxList = Array.isArray(claim.diagnoses) ? claim.diagnoses : []
  const cptList = Array.isArray(claim.cpt_codes) ? claim.cpt_codes : []

  if (dxList.length === 0) {
    errors.push({ code: 'NO_DIAGNOSES', message: 'Claim has no diagnoses. Add at least one ICD-10 code before submitting.' })
  }

  if (cptList.length === 0) {
    errors.push({ code: 'NO_CPT_CODES', message: 'Claim has no CPT codes. Add at least one procedure before submitting.' })
  }

  const npi = (claim.rendering_provider_npi ?? '').replace(/\D/g, '')
  if (!npi || npi.length !== 10) {
    errors.push({ code: 'BAD_NPI', message: `Rendering provider NPI is missing or malformed (got "${claim.rendering_provider_npi ?? ''}"). NPI must be exactly 10 digits.` })
  }

  if (!claim.patient_dob) {
    errors.push({ code: 'NO_PATIENT_DOB', message: 'Patient date of birth is missing. Fix the chart record before submitting.' })
  }

  // Fat-finger catcher: any line with charge × units == 0.
  const zeroLines = cptList.filter(c => {
    const charge = parseFloat(String(c.charge_amount ?? 0)) || 0
    const units = parseInt(String(c.units ?? 1), 10) || 1
    return charge * units <= 0
  })
  if (zeroLines.length > 0) {
    const codes = zeroLines.map(c => c.code).join(', ')
    errors.push({
      code: 'ZERO_CHARGE_LINE',
      message: `${zeroLines.length === 1 ? 'Line' : 'Lines'} ${codes} ${zeroLines.length === 1 ? 'has' : 'have'} a $0 charge. Set a valid charge amount before submitting.`,
    })
  }

  // ── TIER 2 — warnings (biller must acknowledge) ──────────────────────────

  // Timely filing countdown
  if (claim.service_date) {
    const dos = new Date(claim.service_date)
    if (!isNaN(dos.getTime())) {
      const now = new Date()
      const daysSince = daysBetween(dos, now)
      const family = normalizePayerFamily(claim.payer_name)
      const window = family ? TIMELY_FILING_DAYS[family] : 90 // default conservative
      const daysLeft = window - daysSince

      if (daysLeft < 0) {
        warnings.push({
          code: 'TIMELY_FILING_EXPIRED',
          message: `This claim is ${daysSince} days past service date. ${family ?? 'Most payers'} timely filing window (${window} days) is CLOSED — this will almost certainly be denied. Submit anyway only if you've confirmed an extension.`,
        })
      } else if (daysLeft <= 14) {
        warnings.push({
          code: 'TIMELY_FILING_URGENT',
          message: `This claim is ${daysSince} days past service date. ${family ?? 'Payer'} timely filing window closes in ${daysLeft} days (${window}-day limit). Submit today or lose it.`,
        })
      }
    }
  }

  // Duplicate submission guard
  if (ctx.otherSubmittedClaims && ctx.otherSubmittedClaims.length > 0 && claim.service_date) {
    const sameDos = ctx.otherSubmittedClaims.filter(other => {
      if (other.id === claim.id) return false
      if (!other.service_date) return false
      const otherDate = String(other.service_date).slice(0, 10)
      const thisDate  = String(claim.service_date).slice(0, 10)
      return otherDate === thisDate && other.status === 'submitted'
    })
    if (sameDos.length > 0) {
      const thisCpts = new Set(cptList.map(c => String(c.code).toUpperCase()))
      const overlapping = sameDos.filter(other => {
        const otherCpts = new Set((other.cpt_codes ?? []).map(c => String(c.code).toUpperCase()))
        for (const code of thisCpts) if (otherCpts.has(code)) return true
        return false
      })
      if (overlapping.length > 0) {
        warnings.push({
          code: 'POSSIBLE_DUPLICATE',
          message: `Another submitted claim exists for this patient on ${String(claim.service_date).slice(0, 10)} with overlapping CPT codes. Submitting this one will likely be denied as a duplicate.`,
        })
      }
    }
  }

  // Eligibility freshness — skip for self-pay. There's no insurance to
  // verify, so flagging "no eligibility on file" is noise. Sara 2026-10-05.
  const isSelfPay = claim.payer_id === 'PP' || /self[\s-]*pay/i.test(claim.payer_name ?? '')
  if (!isSelfPay) {
    if (ctx.lastEligibilityCheckAt) {
      const last = new Date(ctx.lastEligibilityCheckAt)
      if (!isNaN(last.getTime())) {
        const age = daysBetween(last, new Date())
        if (age > ELIGIBILITY_STALENESS_DAYS) {
          warnings.push({
            code: 'STALE_ELIGIBILITY',
            message: `Eligibility was last verified ${age} days ago. If the patient's insurance has changed since, this claim will be denied. Re-run eligibility before submitting.`,
          })
        }
      }
    } else {
      warnings.push({
        code: 'NO_ELIGIBILITY_CHECK',
        message: 'No eligibility check on file for this patient. If their insurance has changed, this will be denied. Re-verify eligibility before submitting.',
      })
    }
  }

  return { errors, warnings }
}
