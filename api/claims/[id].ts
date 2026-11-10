import type { VercelRequest, VercelResponse } from '@vercel/node'
import { neon } from '@neondatabase/serverless'
import { createRemoteJWKSet, jwtVerify } from 'jose'

async function verifyToken(authHeader: string | undefined): Promise<string> {
  if (!authHeader?.startsWith('Bearer ')) throw new Error('Missing token')
  const token = authHeader.slice(7)
  const region = process.env.VITE_AWS_REGION || 'us-east-2'
  const userPoolId = process.env.VITE_AWS_USER_POOL_ID || ''
  const JWKS = createRemoteJWKSet(new URL(`https://cognito-idp.${region}.amazonaws.com/${userPoolId}/.well-known/jwks.json`))
  const { payload } = await jwtVerify(token, JWKS, { issuer: `https://cognito-idp.${region}.amazonaws.com/${userPoolId}` })
  if (!payload.sub) throw new Error('No sub in token')
  return payload.sub
}

const PRACTICE_NAME  = process.env.PRACTICE_NAME || 'Pediatric House Calls PLLC'
const PRACTICE_NPI   = process.env.PRACTICE_NPI  || '1093250904'
const PRACTICE_TAX   = (process.env.PRACTICE_TAX_ID || '814038809').replace('-', '')
const PRACTICE_ADDR  = process.env.PRACTICE_ADDRESS || ''
const PRACTICE_CITY  = process.env.PRACTICE_CITY  || 'Charlotte'
const PRACTICE_STATE = process.env.PRACTICE_STATE || 'NC'
const PRACTICE_ZIP   = process.env.PRACTICE_ZIP   || '28202'
const PRACTICE_PHONE = (process.env.PRACTICE_PHONE || '7045550000').replace(/\D/g, '')
const PRACTICE_CLIA  = process.env.PRACTICE_CLIA_NUMBER || ''

// Payer-name → payer-id lookup. Duplicated from api/encounter-notes/[id].ts
// because Vercel's api/lib exclusion blocks shared imports (established
// pattern). Any change to the inline map or Anthem routing MUST happen in
// both files. Sara 2026-10-14.
const PAYER_IDS_INLINE: Record<string, string> = {
  'self pay': 'PP', 'self-pay': 'PP', 'selfpay': 'PP', 'self': 'PP',
  'bcbs': 'UPICO', 'bcbs of nc': 'UPICO', 'bcbs nc': 'UPICO',
  'blue cross': 'UPICO', 'blue cross nc': 'UPICO',
  'blue cross blue shield': 'UPICO', 'blue cross blue shield of nc': 'UPICO',
  'blue cross blue shield nc': 'UPICO',
  'aetna': '60054', 'cigna': '62308',
  'united healthcare': '87726', 'united health care': '87726', 'uhc': '87726',
  'umr': '39026', 'humana': '61101',
  'meritain': '41124', 'meritain health': '41124',
  'phcs': '52133', 'multiplan': '52133',
  'coventry': '38217', 'select health': '53589',
  'medcost': '56162', 'healthgram': '56162',
  'bright health': '98798', 'bright healthcare': '98798',
}
// Plain-English translations for the top CARC/RARC codes we see.
// Not exhaustive — raw codes are still included in the queue reasoning,
// so a code not in the dictionary just shows as "CO-99" to Sara instead
// of "CO-99: <friendly label>". Extend as new codes appear.
const CARC_LABEL: Record<string, string> = {
  '1':   'Deductible amount',
  '2':   'Coinsurance amount',
  '3':   'Co-payment amount',
  '45':  'Charge exceeds fee schedule / contracted allowable',
  '50':  'Non-covered — not deemed medically necessary',
  '96':  'Non-covered charges',
  '97':  'Benefit included in payment for another service (bundled)',
  '119': 'Benefit maximum has been reached',
  '197': 'Prior authorization missing or invalid',
  '204': 'Not covered under the patient\'s plan',
  '253': 'Sequestration — federal payment reduction',
}
const GROUP_LABEL: Record<string, string> = {
  'CO': 'Contractual Obligation (payer writes off per contract)',
  'PR': 'Patient Responsibility (family owes)',
  'OA': 'Other Adjustment',
  'PI': 'Payer Initiated reduction',
}
function describeDenialCodes(codes: any): string[] {
  if (!Array.isArray(codes)) return []
  return codes.map((c: any) => {
    const grp = String(c?.group_code ?? '')
    const rsn = String(c?.reason_code ?? '')
    const amt = Number(c?.amount ?? 0)
    const grpLabel = GROUP_LABEL[grp] ? ` [${GROUP_LABEL[grp]}]` : ''
    const rsnLabel = CARC_LABEL[rsn] ? `: ${CARC_LABEL[rsn]}` : ''
    return `${grp}-${rsn}${rsnLabel} — $${amt.toFixed(2)}${grpLabel}`
  })
}
function interpretGap(contractRateSource: string, denialCodes: any): string {
  const hasCO45 = Array.isArray(denialCodes) && denialCodes.some((c: any) =>
    String(c?.group_code) === 'CO' && String(c?.reason_code) === '45')
  if (hasCO45 && contractRateSource === 'era_median_seed') {
    return (
      'Payer applied CO-45 (charge exceeds fee schedule). The seeded ' +
      'contract rate is a median across prior ERAs for this payer × CPT, ' +
      'which may be noisy across plan variants. This "underpayment" may ' +
      'simply reflect this specific plan\'s fee schedule. Confirm against ' +
      'the payer contract document before escalating.'
    )
  }
  if (hasCO45) {
    return (
      'Payer applied CO-45 (charge exceeds fee schedule) but your stored ' +
      'contract rate is from a signed contract document. Real candidate ' +
      'for a call to the payer — they paid below their own schedule.'
    )
  }
  const hasBundling = Array.isArray(denialCodes) && denialCodes.some((c: any) =>
    String(c?.reason_code) === '97')
  if (hasBundling) {
    return 'Payer bundled this line into another service (CO-97). Confirm whether an unbundling modifier (e.g. 25, 59) belongs on the paired code.'
  }
  return 'No obvious CARC/RARC explanation for the gap — worth a direct call to the payer.'
}

// After any path that writes insurance_payment_era, check whether the
// payment is at least $5 below the contracted rate stored in
// payer_contract_rates for (practice_id, payer_id, primary CPT). If so,
// queue a review-queue item with type 'underpayment'. Scope limited to
// single-CPT claims because the ERA payment total isn't line-split in
// our schema — multi-CPT claims would be flagged against the wrong
// denominator. Threshold + Sara-only notification per decisions
// 2026-11-09. Non-fatal — failures don't block the main write.
async function flagUnderpaymentIfAny(
  sql: any,
  claimId: string,
  practiceId: string,
): Promise<void> {
  try {
    const [c] = await sql`
      SELECT id, payer_id, payer_name, cpt_codes,
             insurance_payment_era, patient_copay_era, patient_deductible_era,
             patient_coinsurance_era, patient_non_covered_era,
             denial_codes, remark_codes,
             patient_first_name, patient_last_name,
             service_date, stedi_claim_id, payer_control_number
      FROM claims
      WHERE id = ${claimId}::uuid AND practice_id = ${practiceId}::uuid`
    if (!c) return
    if (!c.payer_id || c.payer_id === 'PP') return
    if (!Array.isArray(c.cpt_codes) || c.cpt_codes.length !== 1) return
    const cptCode = (c.cpt_codes[0] as any)?.code
    if (!cptCode) return
    // TOTAL ALLOWED = payer payment + the family's responsibility. That's
    // the payer's contract rate for the service; the insurance_payment
    // column alone is just the payer's cut, systematically lower. Sara
    // caught this 2026-11-09 — the original math produced 100% false
    // positives on the first live run.
    const insurancePaid = parseFloat(String(c.insurance_payment_era ?? 0)) || 0
    const patientResp =
      (parseFloat(String(c.patient_copay_era ?? 0)) || 0) +
      (parseFloat(String(c.patient_deductible_era ?? 0)) || 0) +
      (parseFloat(String(c.patient_coinsurance_era ?? 0)) || 0) +
      (parseFloat(String(c.patient_non_covered_era ?? 0)) || 0)
    const totalAllowed = +(insurancePaid + patientResp).toFixed(2)
    if (insurancePaid <= 0) return

    const [rate] = await sql`
      SELECT contracted_amount, source, sample_size
      FROM payer_contract_rates
      WHERE practice_id    = ${practiceId}::uuid
        AND payer_id       = ${c.payer_id}
        AND cpt_code       = ${cptCode}
        AND effective_from <= CURRENT_DATE
        AND (effective_to IS NULL OR effective_to >= CURRENT_DATE)
      ORDER BY effective_from DESC
      LIMIT 1`
    if (!rate) return
    const contracted = parseFloat(String(rate.contracted_amount)) || 0
    const gap = +(contracted - totalAllowed).toFixed(2)
    if (gap < 5) return

    const [existing] = await sql`
      SELECT id FROM review_queue_items
      WHERE practice_id = ${practiceId}::uuid
        AND claim_id    = ${claimId}::uuid
        AND item_type   = 'underpayment'
        AND status      = 'open'
      LIMIT 1`
    if (existing) return

    const priority = gap > 100 ? 10 : gap > 25 ? 50 : 100
    const patientName = [c.patient_first_name, c.patient_last_name].filter(Boolean).join(' ') || 'Unknown patient'
    const denialDescriptions = describeDenialCodes(c.denial_codes)
    const remarkList = Array.isArray(c.remark_codes) ? c.remark_codes.filter((r: any) => typeof r === 'string') : []
    const interpretation = interpretGap(String(rate.source), c.denial_codes)
    const summary =
      `${c.payer_name ?? 'Payer'} total allowed $${totalAllowed.toFixed(2)} on CPT ${cptCode} vs expected $${contracted.toFixed(2)} (gap $${gap.toFixed(2)}). ` +
      `${denialDescriptions.length > 0 ? 'Payer says: ' + denialDescriptions.slice(0, 2).join('; ') + '.' : 'No reason code supplied by payer.'}`
    const reasoning = {
      cpt_code: cptCode,
      contracted_amount: contracted,
      total_allowed: totalAllowed,
      insurance_payment_era: insurancePaid,
      patient_responsibility: +patientResp.toFixed(2),
      gap_amount: gap,
      contract_source: rate.source,
      contract_sample_size: rate.sample_size,
      confidence_note: rate.source === 'era_median_seed'
        ? `Seed rate from ${rate.sample_size} prior ERAs — verify before escalating with the payer.`
        : 'Rate confirmed from contract document.',
      payer_reason_codes: denialDescriptions,
      payer_remark_codes: remarkList,
      interpretation,
      stedi_claim_id: c.stedi_claim_id,
      payer_control_number: c.payer_control_number,
      source: 'underpayment-flagger',
    }
    await sql`
      INSERT INTO review_queue_items
        (practice_id, item_type, work_category, claim_id, patient_name,
         payer_name, service_date, priority, summary, agent_reasoning)
      VALUES
        (${practiceId}::uuid, 'underpayment', 'denials', ${claimId}::uuid,
         ${patientName}, ${c.payer_name ?? null}, ${c.service_date ?? null}::date,
         ${priority}, ${summary}, ${JSON.stringify(reasoning)}::jsonb)`
  } catch (e: any) {
    console.error('[flagUnderpaymentIfAny] non-fatal:', e?.message)
  }
}

// Deterministic jsonb equality via canonical stringify — same shape in,
// same string out. Order matters (diagnosis_pointers are ordered arrays),
// so plain JSON.stringify is correct here. Null/undefined are equivalent
// for diff purposes.
function sameJsonb(a: unknown, b: unknown): boolean {
  if (a == null && b == null) return true
  if (a == null || b == null) return false
  try { return JSON.stringify(a) === JSON.stringify(b) } catch { return false }
}

// Log before/after snapshots of cpt_codes + diagnoses to claim_history.
// Called after any UPDATE that may have changed those fields. Captures
// the denial + rejection context at edit time so pattern-learning (Stage
// 2) can correlate "edit X happened immediately after denial Y."
// Non-fatal — failures are swallowed with a console log so the caller
// response path never breaks for an audit write. Sara 2026-11-09.
async function logClaimCodeHistory(
  sql: any,
  before: {
    id: string; practice_id: string;
    cpt_codes: unknown; diagnoses: unknown;
    payer_id: string | null; payer_name: string | null;
    status: string | null;
    denial_codes: unknown; claim_rejection_reasons: unknown;
  },
  after: { cpt_codes: unknown; diagnoses: unknown },
  actor: { id: string | null; name: string | null },
  triggerSource: string,
): Promise<void> {
  const changes: { field: string; oldVal: unknown; newVal: unknown }[] = []
  if (!sameJsonb(before.cpt_codes, after.cpt_codes)) {
    changes.push({ field: 'cpt_codes', oldVal: before.cpt_codes, newVal: after.cpt_codes })
  }
  if (!sameJsonb(before.diagnoses, after.diagnoses)) {
    changes.push({ field: 'diagnoses', oldVal: before.diagnoses, newVal: after.diagnoses })
  }
  if (changes.length === 0) return
  for (const c of changes) {
    try {
      await sql`
        INSERT INTO claim_history (
          claim_id, practice_id, created_by, created_by_name,
          field_name, old_value, new_value,
          payer_id, payer_name, claim_status_at_edit,
          denial_codes_at_edit, rejection_reasons_at_edit, trigger_source
        ) VALUES (
          ${before.id}::uuid, ${before.practice_id}::uuid,
          ${actor.id}::uuid, ${actor.name},
          ${c.field},
          ${c.oldVal == null ? null : JSON.stringify(c.oldVal)}::jsonb,
          ${c.newVal == null ? null : JSON.stringify(c.newVal)}::jsonb,
          ${before.payer_id}, ${before.payer_name}, ${before.status},
          ${before.denial_codes == null ? null : JSON.stringify(before.denial_codes)}::jsonb,
          ${before.claim_rejection_reasons == null ? null : JSON.stringify(before.claim_rejection_reasons)}::jsonb,
          ${triggerSource}
        )`
    } catch (e: any) {
      console.error('claim_history insert failed (non-fatal):', e?.message)
    }
  }
}

function resolvePayer(name: string | null): string | null {
  if (!name) return null
  const normalized = name.toLowerCase().trim()
  if (/anthem/.test(normalized)) {
    if (/\b(va|virginia)\b/.test(normalized)) return 'VABLS'
    return 'UPICO'
  }
  return PAYER_IDS_INLINE[normalized] ?? null
}

function getFacilityAddress(renderingProviderName: string | null) {
  const name = (renderingProviderName ?? '').toLowerCase()
  if (name.includes('niu') || name.includes('santos')) {
    return { address1: '11710 Plaza America Dr #200', city: 'Reston', state: 'VA', postalCode: '20190' }
  }
  return { address1: '5960 Fairview Rd Suite 400', city: 'Charlotte', state: 'NC', postalCode: '28210' }
}

function buildStediPayload(claim: any, testMode = false): object {
  const diagnoses = Array.isArray(claim.diagnoses) ? claim.diagnoses : []
  const AUTO_MODIFIERS: Record<string, string> = { '87880': 'QW', '87812': 'QW', '94640': '25', 'A7003': 'NU' }
  // Codes that are universally bundled by payers and never pay out when
  // billed alongside a procedure. Keeping them on the encounter note
  // for internal tracking / self-pay collection is fine; sending them
  // to Stedi just wastes a line and produces noise in the ERA.
  //   99001 — Lab handling fee. Observed denied CARC 97 (bundled) by
  //           BCBS, BCBS NC, and Cigna in Sept 2026 (every single
  //           time). CIGNA also denied once with CARC 246 ("non-payable,
  //           for reporting only") — same practical outcome. Sara
  //           confirmed 2026-10-05.
  const NEVER_BILL_TO_INSURANCE = new Set(['99001'])
  // Strip every convenience / self-pay / internal code before the
  // Stedi payload is built. Filter on category — matches the post-
  // submit stored-claim filter at the bottom of this file
  // (line ~547). Previously this used a regex that only excluded
  // codes starting with "CV" — that missed custom codes like VAXCV,
  // Selfpay, SlfpayIV, SLFUrine, etc. that don't start with "CV",
  // so they were sent to Stedi and rejected as invalid HCPCS.
  // Format sanity check kept as a belt-and-suspenders: a Procedure-
  // category code that isn't 5 alphanumeric chars is data-entry
  // corruption we shouldn't silently ship.
  const cptCodes  = (Array.isArray(claim.cpt_codes) ? claim.cpt_codes : [])
    .filter((c: any) => c.category !== 'Non-Covered Services')
    .filter((c: any) => !NEVER_BILL_TO_INSURANCE.has(String(c.code ?? '')))
    .filter((c: any) => /^[A-Z0-9]{5}$/i.test(String(c.code ?? '')))
    .map((c: any) => AUTO_MODIFIERS[String(c.code)] ? { ...c, modifier: AUTO_MODIFIERS[String(c.code)] } : c)
  const billableTotal = cptCodes.reduce((s: number, c: any) => {
    const charge = parseFloat(c.charge_amount) || 0
    const units = parseInt(c.units, 10) || 1
    return s + charge * units
  }, 0)

  const fmtDate8 = (d: any) => {
    if (!d) return ''
    const s = d instanceof Date ? d.toISOString() : String(d)
    return s.split('T')[0].replace(/-/g, '')
  }

  // Parse "Last, First" or "First Last" subscriber name formats.
  // Strips trailing generational suffixes (Jr, Sr, II-VI) so that
  // "Edward J Wood IV" splits into first="Edward J", last="Wood",
  // not last="IV". Payer subscriber lookups do not include suffixes.
  const SUFFIXES = new Set(['JR', 'JR.', 'SR', 'SR.', 'II', 'III', 'IV', 'V', 'VI'])
  const parseSubName = (name: string) => {
    if (!name?.trim()) return { first: '', last: '' }
    if (name.includes(', ')) {
      const [last, first] = name.split(', ')
      return { first: first ?? '', last: last ?? '' }
    }
    let parts = name.trim().split(/\s+/)
    if (parts.length > 1 && SUFFIXES.has(parts[parts.length - 1].toUpperCase())) {
      parts = parts.slice(0, -1)
    }
    if (parts.length === 1) return { first: '', last: parts[0] }
    return { first: parts.slice(0, -1).join(' '), last: parts[parts.length - 1] }
  }

  const mapGender = (g: string | null | undefined) => {
    if (!g) return 'U'
    const v = g.toLowerCase()
    if (v === 'f' || v === 'female') return 'F'
    if (v === 'm' || v === 'male') return 'M'
    return 'U'
  }

  const mapRelationship = (r: string | null | undefined): string => {
    if (!r) return '19'
    switch (r.toLowerCase()) {
      case 'self':   return '18'
      case 'spouse': return '01'
      case 'child':  return '19'
      default:       return 'G8'
    }
  }

  // BCBS payers require BL; others use CI
  const BCBS_PAYER_IDS = ['UPICO', 'BCSNC', 'NCBCBS', 'NCBLS', 'NCPNHP']
  const claimFilingCode = BCBS_PAYER_IDS.includes(claim.payer_id ?? '') ? 'BL' : 'CI'

  // Patient control number — prefer the short, sequential PEDS####
  // number if one has been assigned to this claim (assigned in the
  // submit handler before buildStediPayload runs; falls back to the
  // 20-char UUID prefix for legacy claims submitted before the short
  // format shipped).
  const patientControlNumber = claim.payer_control_number
    ? String(claim.payer_control_number)
    : (claim.id ?? '').replace(/-/g, '').slice(0, 20)

  // X12 837P HI segment caps a claim at 12 diagnoses total.
  const claimDiagnoses = diagnoses.slice(0, 12)
  const healthCareCodeInformation = claimDiagnoses.map((d: any, i: number) => ({
    diagnosisTypeCode: i === 0 ? 'ABK' : 'ABF',
    diagnosisCode: d.code,
  }))

  const isTelehealth = (claim.place_of_service ?? '12') === '10'
  const CLIA_CPT_CODES = new Set(['87880', '87812', '81002', '82962'])
  const needsClia = PRACTICE_CLIA && cptCodes.some((c: any) => CLIA_CPT_CODES.has(String(c.code)))

  const providerParts = (claim.rendering_provider_name ?? '').split(' ')
  const provFirst = providerParts[0] ?? ''
  const provLast  = providerParts.slice(1).join(' ') || provFirst

  // X12 837P caps each service line at 4 diagnosis pointers, even
  // though the claim itself can carry up to 12 diagnoses. If the
  // encounter has 5+ diagnoses stored, we still only reference the
  // first 4 per line — otherwise Stedi rejects with "The length of
  // the items must be `<= 4`."
  const defaultDiagnosisPointers = diagnoses.slice(0, 4).map((_: any, i: number) => String(i + 1))
  // Per-CPT-line diagnosis pointer resolver. If the CPT entry has an
  // explicit diagnosis_pointers array (set by the biller via the "Dx"
  // per-line picker in AdminClaims), use those — filtered to valid
  // indices (1..diagnoses.length) and capped at 4. Otherwise fall
  // back to "all diagnoses up to 4" so pre-existing claims and
  // freshly-generated ones both work.
  const pointersForLine = (cp: any): string[] => {
    if (Array.isArray(cp?.diagnosis_pointers) && cp.diagnosis_pointers.length) {
      const valid = cp.diagnosis_pointers
        .map((n: any) => parseInt(n, 10))
        .filter((n: number) => Number.isInteger(n) && n >= 1 && n <= diagnoses.length)
        .slice(0, 4)
        .map(String)
      if (valid.length) return valid
    }
    return defaultDiagnosisPointers
  }

  // Normalize a raw NDC (as the biller/provider typed it, e.g.
  // "49281-590-58" or "0487-9501-25") to the 11-digit no-dash format
  // that X12 837P requires. Each segment gets left-padded with zeros
  // to the standard 5-4-2 shape, then dashes are stripped. Returns
  // null if the input can't be split into 3 segments totaling <= 11
  // digits (safer to omit than to send garbage).
  const normalizeNdc = (raw: any): string | null => {
    if (!raw) return null
    const parts = String(raw).trim().split('-')
    if (parts.length !== 3) return null
    const [a, b, c] = parts
    if (a.length > 5 || b.length > 4 || c.length > 2) return null
    const padded = a.padStart(5, '0') + b.padStart(4, '0') + c.padStart(2, '0')
    return /^\d{11}$/.test(padded) ? padded : null
  }

  const serviceLines = cptCodes.map((c: any) => {
    const units = parseInt(c.units, 10) || 1
    const lineCharge = (parseFloat(c.charge_amount ?? 0) * units).toFixed(2)
    const normalizedNdc = normalizeNdc(c.ndc_code)
    // Line-level modifiers: whatever the CPT carries (either auto-set
    // via AUTO_MODIFIERS above — e.g. QW on 87880 rapid strep — or
    // manually entered by the biller) PLUS 95 for telehealth. The
    // modifier field is a single string up to 4 chars; split every 2
    // chars so a biller who types "QWSA" gets ["QW","SA"] not "QWSA".
    // Previously only the telehealth 95 was included, which silently
    // stripped every CLIA-waived QW modifier — UHC rejected those
    // strep tests with SmartEdit pattern 53845.
    const rawMods = c.modifier ? String(c.modifier).toUpperCase().match(/.{1,2}/g) ?? [] : []
    const procedureModifiers = [...rawMods, ...(isTelehealth ? ['95'] : [])]
    return {
    serviceDate: fmtDate8(claim.service_date),
    professionalService: {
      procedureIdentifier: 'HC',
      procedureCode: c.code,
      ...(procedureModifiers.length > 0 ? { procedureModifiers } : {}),
      lineItemChargeAmount: lineCharge,
      measurementUnit: 'UN',
      serviceUnitCount: String(units),
      compositeDiagnosisCodePointers: {
        diagnosisCodePointers: pointersForLine(c),
      },
    },
    renderingProvider: {
      providerType: 'RenderingProvider',
      npi: claim.rendering_provider_npi ?? '',
      firstName: provFirst,
      lastName: provLast,
      ...(claim.rendering_provider_taxonomy ? { taxonomyCode: claim.rendering_provider_taxonomy } : {}),
    },
    // NDC (National Drug Code) attached when the CPT/HCPCS has one
    // seeded on fee_schedule.ndc_code. Location: service-line level
    // (sibling to professionalService + renderingProvider) — Stedi
    // confirmed this via 277CA on 2026-09-14. Also required inside
    // the block per Stedi's schema: `nationalDrugUnitCount`. Sara
    // preferred not to surface unit count in the UI, so it's set
    // here silently from the CPT's units value (1 for vaccines, N
    // for J-codes with variable dosing).
    ...(normalizedNdc ? {
      drugIdentification: {
        serviceIdQualifier: 'N4',
        nationalDrugCode: normalizedNdc,
        // Per-dose mL amount × number of CPT units administered.
        // ndc_unit_count comes from fee_schedule (0.5 for vaccines,
        // 3 for J7613 albuterol nebulizer). If a code has no per-
        // dose amount seeded, fall back to CPT units so we still
        // send something valid.
        nationalDrugUnitCount: String(
          c.ndc_unit_count != null
            ? Number(c.ndc_unit_count) * units
            : units
        ),
        // 'ML' = milliliters. Fits all three currently-seeded codes
        // (90619 Menveo, 90715 Adacel, J7613 albuterol nebulizer
        // solution) — all dosed in mL. If a future code needs a
        // different unit (F2 IU, GR grams, ME mg, UN units),
        // move this to a per-code column in fee_schedule.
        measurementUnitCode: 'ML',
      },
    } : {}),
    }
  })

  const { first: subFirstName, last: subLastName } = parseSubName(claim.subscriber_name ?? '')

  return {
    ...(testMode ? { usageIndicator: 'T' } : {}),
    tradingPartnerServiceId: claim.payer_id ?? '',
    submitter: {
      organizationName: PRACTICE_NAME,
      contactInformation: { name: 'Billing', phoneNumber: PRACTICE_PHONE },
    },
    receiver: { organizationName: claim.payer_name ?? '' },
    subscriber: {
      // BCBS NC requires exactly 14-position member IDs — the 12-char
      // base (3 alpha + 9 digits) on the card plus a 2-digit dependent
      // suffix that identifies which family member the claim is for.
      //
      // Parents / billers enter either (a) just the 12-char base from
      // the card with the dep code stored separately, or (b) the full
      // 14-char ID that already includes the suffix. Old code assumed
      // (a) always and blindly concatenated — any (b) entry got a 16-char
      // ID with the suffix duplicated at the end, which BCBS rejected
      // with "FULL 14 POSITION BCBSNC MEMBER ID REQUIRED". Hit 4 claims
      // (Claire Nelson, Graham Gerloff x2, Sean Doyle) 2026-09-21..30
      // before Sara noticed.
      //
      // Fix: BCBS NC output must always be 12-char base + 2-char dep.
      // The suffix at the end of a parent-entered 14-char ID is the
      // SUBSCRIBER's own suffix (e.g. "01" for self) — not the right
      // one for this patient's claim. So: for UPICO with a dep code,
      // always strip to the first 12 chars and append the stored dep
      // code. First attempt only de-duplicated when the suffix matched
      // and left Graham Gerloff still broken because his dad's "01"
      // suffix is different from Graham's "04". Caught by smoke test.
      memberId: (() => {
        // BCBS NC output must always be 12-char base + 2-char dep.
        // Previously the transform only ran on length 12 or 14, which
        // silently skipped 13 / 15-char IDs — Sophie Slutzker 10/30
        // submitted with a 13-char ID and dep=01, Stedi got the raw ID
        // with no suffix. Now: any ID ≥ 12 chars gets truncated to 12
        // and the stored dep appended. IDs < 12 chars (e.g. Medicare
        // / short-format plans) are left alone — truncating them would
        // destroy a valid ID. Sara 2026-11-01.
        //
        // ALSO: Anthem patients (except Anthem of VA, which has its own
        // payer ID) route to UPICO but Anthem does NOT use a dependent
        // suffix. Skip the transform when payer_name reads as Anthem so
        // we don't glue a bogus suffix onto an Anthem member ID. Sara
        // 2026-11-01.
        // Simple rule per Sara 2026-11-09: if a dependent code is stored,
        // concatenate it onto the end of the member ID as-is. Otherwise
        // send the member ID unchanged. No length math, no slicing — the
        // chart holds the member ID the parent provided, and the dep code
        // (when present) is the 2-digit suffix to append.
        //
        // Replaces the prior "slice to 12 then append" logic, which
        // mangled 15-char member IDs (Sophie Slutzker 10/29 claim, sent
        // as 13 chars). Only path to a longer ID is now the human-entered
        // one, which is what the payer expects anyway.
        const raw = String(claim.member_id ?? '').trim()
        if (claim.payer_id !== 'UPICO') return raw
        if (/anthem/i.test(String(claim.payer_name ?? ''))) return raw
        const dep = String(claim.insurance_dependent_code ?? '').replace(/\D/g, '').slice(0, 2)
        if (!dep) return raw
        return raw + dep
      })(),
      paymentResponsibilityLevelCode: 'P',
      ...(subFirstName ? { firstName: subFirstName } : {}),
      lastName: subLastName,
      gender: mapGender(claim.subscriber_gender),
      dateOfBirth: fmtDate8(claim.subscriber_dob),
      ...(claim.group_number ? { groupNumber: claim.group_number } : {}),
      // Guarantor (subscriber) address. In pediatric practice the
      // subscriber is a parent living at the same address as the
      // child, so we reuse claim.patient_* here — which the submit-
      // time refresh already populates via COALESCE across
      // claim.patient_address → family_profiles.address_line1 →
      // children.parent_address. If a future edge case has the
      // subscriber at a different address (divorced parents, etc.),
      // add explicit subscriber_address_* columns to the claims
      // table and swap them in here.
      ...(claim.patient_address ? {
        address: {
          address1: claim.patient_address,
          ...(claim.patient_city ? { city: claim.patient_city } : {}),
          state: claim.patient_state ?? '',
          postalCode: (claim.patient_zip ?? '').replace(/\D/g, '').slice(0, 9),
        },
      } : {}),
    },
    dependent: {
      firstName: claim.patient_first_name ?? '',
      lastName:  claim.patient_last_name  ?? '',
      gender: mapGender(claim.patient_gender),
      dateOfBirth: fmtDate8(claim.patient_dob),
      relationshipToSubscriberCode: mapRelationship(claim.subscriber_relationship),
      ...(claim.patient_address ? {
        address: {
          address1: claim.patient_address,
          ...(claim.patient_city ? { city: claim.patient_city } : {}),
          state: claim.patient_state ?? '',
          postalCode: (claim.patient_zip ?? '').replace(/\D/g, '').slice(0, 9),
        },
      } : {}),
    },
    billing: {
      providerType: 'BillingProvider',
      npi: PRACTICE_NPI,
      employerId: PRACTICE_TAX,
      organizationName: PRACTICE_NAME,
      ...(PRACTICE_ADDR ? {
        address: {
          address1: PRACTICE_ADDR,
          city: PRACTICE_CITY,
          state: PRACTICE_STATE,
          postalCode: PRACTICE_ZIP,
        },
      } : {}),
    },
    claimInformation: {
      claimFilingCode,
      patientControlNumber,
      claimChargeAmount: billableTotal.toFixed(2),
      placeOfServiceCode: claim.place_of_service ?? '12',
      claimFrequencyCode: '1',
      signatureIndicator: 'Y',
      planParticipationCode: 'A',
      benefitsAssignmentCertificationIndicator: 'Y',
      releaseInformationCode: 'Y',
      healthCareCodeInformation,
      serviceLines,
      serviceFacilityLocation: {
        organizationName: PRACTICE_NAME,
        address: getFacilityAddress(claim.rendering_provider_name),
      },
      ...(needsClia ? {
        claimSupplementalInformation: {
          cliaNumber: PRACTICE_CLIA,
        },
      } : {}),
    },
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  let sub: string
  try { sub = await verifyToken(req.headers.authorization) } catch {
    return res.status(401).json({ error: 'Unauthorized' })
  }
  const sql = neon(process.env.DATABASE_URL!)
  // Idempotent bootstraps for insurance_dependent_code — BCBS NC needs
  // a 2-digit dependent suffix on the member ID; other payers ignore it.
  try { await sql`ALTER TABLE claims   ADD COLUMN IF NOT EXISTS insurance_dependent_code text` } catch {}
  try { await sql`ALTER TABLE children ADD COLUMN IF NOT EXISTS insurance_dependent_code text` } catch {}
  // Manual status override. The claim-card "status" badge is a derived
  // state that promotes a claim to "Completed" when any downstream
  // signal is present (rework_resolved_at set, submitted + ERA back,
  // attached statement paid/sent). That derivation is wrong for cases
  // where the ERA was actually a rejection the system misread, or the
  // statement was auto-generated against a payment that never happened.
  // When this flag is true, the client-side derivation defers to the
  // raw status column — the biller's explicit choice wins. Sara 2026-11-09.
  try { await sql`ALTER TABLE claims ADD COLUMN IF NOT EXISTS manual_status_override boolean DEFAULT false` } catch {}
  // Claim-history table. Every edit that mutates cpt_codes or diagnoses
  // on an existing claim logs an immutable before/after row here, along
  // with the payer + denial context at the time of edit. The billing
  // agent's pattern-learning layer (Stage 2) reads this to discover
  // things like "BCBS denies 87880 with J02.0 third but accepts it
  // first." Nothing uses this table today — we're just starting the
  // collection now so the data exists when the agent is ready. Sara
  // 2026-11-09.
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS claim_history (
        id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        claim_id               uuid NOT NULL,
        practice_id            uuid NOT NULL,
        created_at             timestamptz NOT NULL DEFAULT NOW(),
        created_by             uuid,
        created_by_name        text,
        field_name             text NOT NULL,  -- 'cpt_codes' | 'diagnoses'
        old_value              jsonb,
        new_value              jsonb,
        payer_id               text,
        payer_name             text,
        claim_status_at_edit   text,
        denial_codes_at_edit   jsonb,
        rejection_reasons_at_edit jsonb,
        trigger_source         text  -- 'biller_edit' | 'submit_strip' | 'resolve_rework' | ...
      )`
  } catch {}
  try { await sql`CREATE INDEX IF NOT EXISTS idx_claim_history_claim        ON claim_history(claim_id, created_at)` } catch {}
  try { await sql`CREATE INDEX IF NOT EXISTS idx_claim_history_payer_field  ON claim_history(payer_id, field_name, created_at)` } catch {}
  const { id } = req.query as Record<string, string>
  if (!id) return res.status(400).json({ error: 'id required' })

  const providerRows = await sql`SELECT practice_id FROM providers WHERE cognito_sub = ${sub} LIMIT 1`
  if (!providerRows.length) return res.status(403).json({ error: 'Provider not found' })
  const practiceId = providerRows[0].practice_id as string

  if (req.method === 'GET') {
    // Include linked patient statement info so the ClaimReviewModal can
    // detect a terminal state — a paid or sent statement means the claim
    // isn't actually "in flight" even if cl.status is still e.g.
    // pending_review. Andrea 2026-09-28 (Matthew Porcelli case).
    const [claim] = await sql`
      SELECT cl.*,
             ps.id       AS statement_id,
             ps.status   AS statement_status,
             ps.sent_at  AS statement_sent_at,
             ps.paid_at  AS statement_paid_at
      FROM claims cl
      LEFT JOIN patient_statements ps ON ps.claim_id = cl.id
      WHERE cl.id = ${id}::uuid AND cl.practice_id = ${practiceId}::uuid
      LIMIT 1`
    return res.json(claim ?? null)
  }

  if (req.method === 'PUT') {
    const { action, ...fields } = req.body ?? {}

    // Toggle the "ready for biller" flag. Anyone can mark or unmark; the
    // person who marks it is captured in ready_for_biller_by for the badge.
    if (action === 'mark_ready' || action === 'unmark_ready') {
      const [me] = await sql`SELECT name FROM providers WHERE cognito_sub = ${sub} LIMIT 1`
      const markerName = me?.name ?? 'Unknown'
      if (action === 'mark_ready') {
        const [updated] = await sql`
          UPDATE claims SET
            ready_for_biller_at = now(),
            ready_for_biller_by = ${markerName},
            updated_at          = now()
          WHERE id = ${id}::uuid AND practice_id = ${practiceId}::uuid RETURNING *`
        return res.json(updated)
      } else {
        const [updated] = await sql`
          UPDATE claims SET
            ready_for_biller_at = NULL,
            ready_for_biller_by = NULL,
            updated_at          = now()
          WHERE id = ${id}::uuid AND practice_id = ${practiceId}::uuid RETURNING *`
        return res.json(updated)
      }
    }

    // Manual status override — Sara 2026-10-07. For cases where she
    // handles something outside GoRoam (e.g., resubmits in the Stedi
    // portal directly) and needs the claim's tab to reflect reality.
    // target_status: 'ready_for_biller' | 'submitted' | 'rework'
    //
    // Each target wipes the fields that would route the claim elsewhere
    // AND sets the fields that route it to the target. No audit-trail
    // enforcement — biller is the authoritative actor on this call.
    if (action === 'force_status') {
      const target = String((fields as any).target_status ?? '')
      const allowed = new Set(['ready_for_biller', 'submitted', 'rework'])
      if (!allowed.has(target)) {
        return res.status(400).json({ error: 'target_status must be one of ready_for_biller, submitted, rework' })
      }
      const [me] = await sql`SELECT name FROM providers WHERE cognito_sub = ${sub} LIMIT 1`
      const whoName = me?.name ?? 'Biller'

      if (target === 'submitted') {
        // Mark as submitted in our system. Clear every rework trigger so
        // isInRework drops it out; preserve submitted_at if we have one
        // (actual payer submission time), otherwise stamp now.
        const [updated] = await sql`
          UPDATE claims SET
            status                   = 'submitted',
            submitted_at             = COALESCE(submitted_at, NOW()),
            denial_codes             = NULL,
            claim_rejection_at       = NULL,
            claim_rejection_response = NULL,
            claim_rejection_reasons  = NULL,
            submission_error         = NULL,
            rework_resolved_at       = NULL,
            ready_for_biller_at      = NULL,
            ready_for_biller_by      = NULL,
            manual_status_override   = true,
            updated_at               = NOW()
          WHERE id = ${id}::uuid AND practice_id = ${practiceId}::uuid
          RETURNING *`
        try {
          await sql`
            INSERT INTO claim_activity_log (claim_id, created_by_name, kind, body)
            VALUES (${id}::uuid, ${whoName}, 'force_status_submitted',
                   'Manually set status → Submitted (biller resubmitted outside GoRoam).')`
        } catch {}
        return res.status(200).json(updated)
      }

      if (target === 'ready_for_biller') {
        // Pending review + marked ready. Must clear submitted_at and
        // every rework trigger — otherwise isInRework pulls it back.
        const [updated] = await sql`
          UPDATE claims SET
            status                   = 'pending_review',
            denial_codes             = NULL,
            claim_rejection_at       = NULL,
            claim_rejection_response = NULL,
            claim_rejection_reasons  = NULL,
            submission_error         = NULL,
            rework_resolved_at       = NULL,
            ready_for_biller_at      = NOW(),
            ready_for_biller_by      = ${whoName},
            manual_status_override   = true,
            updated_at               = NOW()
          WHERE id = ${id}::uuid AND practice_id = ${practiceId}::uuid
          RETURNING *`
        try {
          await sql`
            INSERT INTO claim_activity_log (claim_id, created_by_name, kind, body)
            VALUES (${id}::uuid, ${whoName}, 'force_status_ready_for_biller',
                   'Manually set status → Ready for Biller.')`
        } catch {}
        return res.status(200).json(updated)
      }

      // target === 'rework' — flip the claim back into Rework by setting
      // an active trigger. Uses claim_rejection_at = NOW() with a note so
      // isInRework picks it up. This is a last-resort override.
      const [updated] = await sql`
        UPDATE claims SET
          claim_rejection_at       = COALESCE(claim_rejection_at, NOW()),
          claim_rejection_reasons  = COALESCE(claim_rejection_reasons, ${JSON.stringify([{ category: 'MANUAL', code: '0', entity: 'biller', action: '', amount: 0, message: 'Manually flagged as rework by biller.' }])}::jsonb),
          rework_resolved_at       = NULL,
          ready_for_biller_at      = NULL,
          ready_for_biller_by      = NULL,
          manual_status_override   = true,
          updated_at               = NOW()
        WHERE id = ${id}::uuid AND practice_id = ${practiceId}::uuid
        RETURNING *`
      try {
        await sql`
          INSERT INTO claim_activity_log (claim_id, created_by_name, kind, body)
          VALUES (${id}::uuid, ${whoName}, 'force_status_rework',
                 'Manually flagged → Rework.')`
      } catch {}
      return res.status(200).json(updated)
    }

    // Refresh insurance from chart — re-pulls every insurance field
    // (payer_name, payer_id, member_id, dep_code, group_number, subscriber
    // name/DOB/gender) from the child record and overwrites the claim
    // snapshot. For when a family corrects the insurance in the chart
    // after a claim was already generated with stale data. Sara
    // 2026-10-14. Gated to editable states (pending_review / rework /
    // error / draft) — do NOT allow after submission because the payer
    // already has the stale version.
    if (action === 'refresh_insurance_from_chart') {
      const [current] = await sql`
        SELECT c.id, c.status, c.child_id, c.payer_name, c.payer_id, c.member_id,
               c.insurance_dependent_code, c.group_number,
               c.subscriber_name, c.subscriber_dob, c.subscriber_gender
        FROM claims c
        WHERE c.id = ${id}::uuid AND c.practice_id = ${practiceId}::uuid
        LIMIT 1`
      if (!current) return res.status(404).json({ error: 'Claim not found' })
      const editable = new Set(['pending_review', 'error', 'draft'])
      const isRework = !!(current as any).claim_rejection_at // mirrored by isInRework on the client
      if (!editable.has(String(current.status)) && !isRework) {
        return res.status(409).json({
          error: `Can't refresh insurance on a ${current.status} claim. If this claim really needs new insurance, unlock it first (e.g. move to Rework) or create a corrected claim.`,
        })
      }
      if (!current.child_id) {
        return res.status(400).json({ error: 'Claim has no linked patient — cannot refresh insurance from a chart.' })
      }
      const [child] = await sql`
        SELECT insurance_provider, insurance_member_id, insurance_group_number,
               insurance_dependent_code, insurance_subscriber_name,
               insurance_subscriber_dob, insurance_subscriber_gender
        FROM children
        WHERE id = ${current.child_id}::uuid AND practice_id = ${practiceId}::uuid
        LIMIT 1`
      if (!child) return res.status(404).json({ error: 'Patient chart not found' })

      const providerLower = String(child.insurance_provider || '').toLowerCase().trim()
      const isSelfPay = providerLower === 'self-pay' || providerLower === 'selfpay' || providerLower === 'self pay' || providerLower === 'self'
      const newPayerName = isSelfPay ? 'Self Pay' : (child.insurance_provider ?? null)
      const newPayerId   = isSelfPay ? 'PP' : resolvePayer(child.insurance_provider ?? null)
      const newMemberId  = isSelfPay ? null : (child.insurance_member_id ?? null)
      const newDepCode   = isSelfPay ? null : (child.insurance_dependent_code ?? null)
      const newGroup     = isSelfPay ? null : (child.insurance_group_number ?? null)
      const newSubName   = isSelfPay ? null : (child.insurance_subscriber_name ?? null)
      const newSubDob    = isSelfPay ? null : (child.insurance_subscriber_dob ?? null)
      const newSubGender = isSelfPay ? null : (child.insurance_subscriber_gender ?? null)

      const [me] = await sql`SELECT name FROM providers WHERE cognito_sub = ${sub} LIMIT 1`
      const whoName = (me as any)?.name ?? 'Biller'

      const [updated] = await sql`
        UPDATE claims SET
          payer_name                = ${newPayerName},
          payer_id                  = ${newPayerId},
          member_id                 = ${newMemberId},
          insurance_dependent_code  = ${newDepCode},
          group_number              = ${newGroup},
          subscriber_name           = ${newSubName},
          subscriber_dob            = ${newSubDob}::date,
          subscriber_gender         = ${newSubGender},
          updated_at                = NOW()
        WHERE id = ${id}::uuid AND practice_id = ${practiceId}::uuid
        RETURNING *`

      // Human-readable diff so Andrea can see exactly what changed on the
      // claim card's activity log, instead of having to compare rows.
      const diffs: string[] = []
      const line = (label: string, before: any, after: any) => {
        const b = before == null || before === '' ? '(empty)' : String(before)
        const a = after  == null || after  === '' ? '(empty)' : String(after)
        if (b !== a) diffs.push(`${label}: ${b} → ${a}`)
      }
      line('Payer',       (current as any).payer_name,              newPayerName)
      line('Payer ID',    (current as any).payer_id,                newPayerId)
      line('Member ID',   (current as any).member_id,               newMemberId)
      line('Dep code',    (current as any).insurance_dependent_code,newDepCode)
      line('Group',       (current as any).group_number,            newGroup)
      line('Subscriber',  (current as any).subscriber_name,         newSubName)
      line('Sub DOB',     String((current as any).subscriber_dob ?? '').slice(0, 10), String(newSubDob ?? '').slice(0, 10))
      line('Sub gender',  (current as any).subscriber_gender,       newSubGender)
      const body = diffs.length
        ? 'Refreshed insurance from chart. Changes: ' + diffs.join(' · ')
        : 'Refreshed insurance from chart. No changes — claim already matched the chart.'
      try {
        await sql`
          INSERT INTO claim_activity_log (claim_id, created_by_name, kind, body)
          VALUES (${id}::uuid, ${whoName}, 'insurance_refreshed', ${body})`
      } catch { /* non-fatal */ }

      return res.status(200).json(updated)
    }

    // Fix + resubmit — clears every rework trigger, marks ready for
    // biller, appends a resubmission_log entry. Previously lived at
    // POST /api/claims/[id]/fix-resubmit but Vercel's file-based
    // routing collided with the [id].ts file (same 405 pattern as the
    // convenience-fees endpoint earlier today). Moved inline here as a
    // PUT action; client updated to match. Sara 2026-10-07.
    if (action === 'fix_resubmit') {
      const noteStr = String(fields.note ?? '').trim()
      try { await sql`ALTER TABLE claims ADD COLUMN IF NOT EXISTS reopened_at timestamptz` } catch {}
      try { await sql`ALTER TABLE claims ADD COLUMN IF NOT EXISTS reopened_by uuid` } catch {}
      try { await sql`ALTER TABLE claims ADD COLUMN IF NOT EXISTS reopen_reason text` } catch {}
      try { await sql`ALTER TABLE claims ADD COLUMN IF NOT EXISTS reopen_note text` } catch {}
      try { await sql`ALTER TABLE claims ADD COLUMN IF NOT EXISTS ready_for_biller_at timestamptz` } catch {}
      try { await sql`ALTER TABLE claims ADD COLUMN IF NOT EXISTS ready_for_biller_by text` } catch {}
      try { await sql`ALTER TABLE claims ADD COLUMN IF NOT EXISTS resubmission_log jsonb DEFAULT '[]'::jsonb` } catch {}

      const [provider] = await sql`SELECT id, name FROM providers WHERE cognito_sub = ${sub} LIMIT 1`
      if (!provider) return res.status(403).json({ error: 'Provider not found' })

      const [existing] = await sql`
        SELECT id, status, submitted_at, claim_rejection_at, denial_codes, resubmission_log
        FROM claims
        WHERE id = ${id}::uuid AND practice_id = ${practiceId}::uuid
        LIMIT 1`
      if (!existing) return res.status(404).json({ error: 'Claim not found' })
      if (!existing.submitted_at) {
        return res.status(400).json({ error: "This claim has never been submitted — there's nothing to resubmit. Edit it in Ready for Biller instead." })
      }
      if (existing.status === 'written_off') {
        return res.status(400).json({ error: 'This claim is written off. Resubmitting would resurrect a closed AR item.' })
      }

      const prevLog: any[] = Array.isArray(existing.resubmission_log) ? existing.resubmission_log : []
      const entry = {
        at: new Date().toISOString(),
        by: provider.id,
        by_name: provider.name ?? 'Biller',
        note: noteStr || null,
        prior_denial_codes: existing.denial_codes ?? null,
        prior_claim_rejection_at: existing.claim_rejection_at ?? null,
      }
      const nextLog = [...prevLog, entry]

      const [updated] = await sql`
        UPDATE claims SET
          denial_codes             = NULL,
          claim_rejection_at       = NULL,
          claim_rejection_response = NULL,
          claim_rejection_reasons  = NULL,
          submission_error         = NULL,
          status                   = 'pending_review',
          reopened_at              = NOW(),
          reopened_by              = ${provider.id}::uuid,
          reopen_reason            = 'payer_denied_other',
          reopen_note              = ${noteStr || 'Fix + resubmit from Rework tab'},
          ready_for_biller_at      = NOW(),
          ready_for_biller_by      = ${provider.name ?? 'Biller'},
          resubmission_log         = ${JSON.stringify(nextLog)}::jsonb,
          updated_at               = NOW()
        WHERE id = ${id}::uuid AND practice_id = ${practiceId}::uuid
        RETURNING *`

      try {
        await sql`
          CREATE TABLE IF NOT EXISTS claim_activity_log (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            claim_id uuid NOT NULL,
            created_at timestamptz NOT NULL DEFAULT NOW(),
            created_by uuid,
            created_by_name text,
            kind text NOT NULL DEFAULT 'note',
            body text NOT NULL
          )`
        const body = noteStr
          ? `Fix + resubmit from Rework tab. Note: ${noteStr}`
          : 'Fix + resubmit from Rework tab. No note provided.'
        await sql`
          INSERT INTO claim_activity_log (claim_id, created_by, created_by_name, kind, body)
          VALUES (${id}::uuid, ${provider.id}::uuid, ${provider.name ?? 'Biller'}, 'fix_resubmit', ${body})`
      } catch (logErr: any) {
        console.error('fix-resubmit activity log insert failed (non-fatal):', logErr?.message)
      }

      return res.status(200).json(updated)
    }

    // ── Manual insurance payment posting ─────────────────────────────────
    // Andrea needs to post payments that arrived outside the Stedi ERA
    // pipeline — paper EOB, EFT without ERA, manually keyed check. Writes
    // the same claim columns the ERA pipeline writes (so downstream
    // "payment received" logic — Completed-tab routing, patient-statement
    // generation — behaves identically), plus a payment_source + audit
    // trail so we can tell this came from Andrea, not Stedi. Sara 2026-10-19.
    if (action === 'post_insurance_payment') {
      // Bootstrap source + audit columns idempotently.
      try { await sql`ALTER TABLE claims ADD COLUMN IF NOT EXISTS payment_source text` } catch {}
      try { await sql`ALTER TABLE claims ADD COLUMN IF NOT EXISTS payment_posted_at timestamptz` } catch {}
      try { await sql`ALTER TABLE claims ADD COLUMN IF NOT EXISTS payment_posted_by text` } catch {}
      try { await sql`ALTER TABLE claims ADD COLUMN IF NOT EXISTS payment_reference text` } catch {}

      const num = (v: any): number => {
        const n = parseFloat(String(v ?? '').trim().replace(/[^0-9.-]/g, ''))
        return Number.isFinite(n) ? n : 0
      }
      const amountBilled    = num((fields as any).amount_billed)
      const insurancePayment = num((fields as any).insurance_payment)
      const contractualAdj   = num((fields as any).contractual_adjustment)
      const copay            = num((fields as any).patient_copay)
      const deductible       = num((fields as any).patient_deductible)
      const coinsurance      = num((fields as any).patient_coinsurance)
      const nonCovered       = num((fields as any).patient_non_covered)
      const paymentReference = String((fields as any).payment_reference ?? '').trim() || null
      const paymentDateIn    = String((fields as any).payment_date ?? '').trim()
      const paymentDate      = paymentDateIn ? new Date(paymentDateIn + 'T12:00:00Z') : new Date()
      if (isNaN(paymentDate.getTime())) return res.status(400).json({ error: 'Invalid payment_date — use YYYY-MM-DD' })

      const [claim] = await sql`
        SELECT id, status, practice_id, child_id, appointment_id, service_date,
               cpt_codes, patient_first_name, patient_last_name, patient_dob,
               total_charge, era_received_at
        FROM claims
        WHERE id = ${id}::uuid AND practice_id = ${practiceId}::uuid LIMIT 1`
      if (!claim) return res.status(404).json({ error: 'Claim not found' })
      if (claim.status === 'written_off') {
        return res.status(400).json({ error: 'This claim is written off. Posting a payment would resurrect a closed AR item — reopen it first.' })
      }
      if (claim.era_received_at) {
        // Not a 400 — just surface it so Andrea doesn't accidentally
        // double-post on top of a Stedi ERA that already landed.
        return res.status(409).json({ error: 'A payment has already been posted to this claim (Stedi ERA received ' + new Date(claim.era_received_at).toLocaleDateString() + '). If this is a correction, reach out and we will handle it separately.' })
      }

      // Use the claim's total_charge as the billed amount if Andrea
      // didn't type one — avoids blank-amount statements.
      const billedForStatement = amountBilled > 0 ? amountBilled : (parseFloat(String(claim.total_charge ?? 0)) || 0)
      const patientResp = +(copay + deductible + coinsurance + nonCovered).toFixed(2)
      const remaining   = +(billedForStatement - insurancePayment - contractualAdj).toFixed(2)

      const [me] = await sql`SELECT name FROM providers WHERE cognito_sub = ${sub} LIMIT 1`
      const whoName = (me as any)?.name ?? 'Biller'

      // Update the claim row. era_received_at being set is what moves it
      // to Completed on the Submitted tab; payment_source distinguishes
      // manually-posted from Stedi-ERA for reporting.
      const [updated] = await sql`
        UPDATE claims SET
          amount_billed_era          = ${billedForStatement},
          insurance_payment_era      = ${insurancePayment},
          contractual_adjustment_era = ${contractualAdj},
          patient_copay_era          = ${copay},
          patient_deductible_era     = ${deductible},
          patient_coinsurance_era    = ${coinsurance},
          patient_non_covered_era    = ${nonCovered},
          era_received_at            = ${paymentDate}::timestamptz,
          -- Stamp era_seen_at at the same time as the manual post. The
          -- biller IS the one who saw this payment — she typed it in
          -- from a paper EOB. Without this, the "NEW ERA" flashing
          -- purple badge keeps pinging her about an ERA she already
          -- handled. Sara 2026-11-09.
          era_seen_at                = NOW(),
          payment_source             = 'manual',
          payment_posted_at          = NOW(),
          payment_posted_by          = ${whoName},
          payment_reference          = ${paymentReference},
          updated_at                 = NOW()
        WHERE id = ${id}::uuid AND practice_id = ${practiceId}::uuid
        RETURNING *`

      // Create a patient_statement if none exists, same shape as the ERA
      // path. Autopaid shortcut: insurance paid >$0 AND patient owes $0 →
      // mark statement as already paid (mirrors ensureStatementForClaim
      // in api/cron/stedi-era-poll.ts).
      try {
        // Voided statements don't count — mirrors the fix in
        // ensureStatementForClaim (3 files). Twigg case 2026-10-24.
        const [existingStmt] = await sql`SELECT id FROM patient_statements WHERE claim_id = ${id}::uuid AND voided_at IS NULL LIMIT 1`
        if (!existingStmt) {
          const [contactRow] = await sql`
            SELECT ch.parent_email, ch.parent_phone, fp.email AS family_email, fp.phone AS family_phone
            FROM claims cl
            LEFT JOIN children ch ON ch.id = COALESCE(cl.child_id, (SELECT child_id FROM appointments WHERE id = cl.appointment_id LIMIT 1))
            LEFT JOIN family_profiles fp ON fp.id = ch.family_id
            WHERE cl.id = ${id}::uuid LIMIT 1`
          const email = (contactRow as any)?.parent_email ?? (contactRow as any)?.family_email ?? null
          const phone = (contactRow as any)?.parent_phone ?? (contactRow as any)?.family_phone ?? null
          const autoPaid = patientResp === 0 && insurancePayment > 0
          await sql`
            INSERT INTO patient_statements (
              practice_id, claim_id,
              patient_first_name, patient_last_name, patient_dob,
              date_of_service, cpt_codes,
              patient_email, patient_phone,
              amount_billed, insurance_payment, contractual_adjustment,
              patient_copay, patient_deductible, patient_coinsurance, patient_non_covered,
              remaining_balance, prior_balance, total_amount_due, total_amount_due_text,
              status, paid_at, created_at, updated_at
            ) VALUES (
              ${claim.practice_id}::uuid, ${claim.id},
              ${claim.patient_first_name}, ${claim.patient_last_name}, ${claim.patient_dob},
              ${claim.service_date}, ${JSON.stringify(claim.cpt_codes ?? [])}::jsonb,
              ${email}, ${phone},
              ${billedForStatement}, ${insurancePayment}, ${contractualAdj},
              ${copay}, ${deductible}, ${coinsurance}, ${nonCovered},
              ${remaining}, 0, ${patientResp}, ${String(patientResp)},
              ${autoPaid ? 'paid' : 'draft'}, ${autoPaid ? new Date() : null}, NOW(), NOW()
            )`
        }
      } catch (stmtErr: any) {
        console.error('[post_insurance_payment] statement creation failed (non-fatal):', stmtErr?.message)
      }

      // Underpayment check — compare insurance_payment_era against the
      // contracted rate for this payer × primary CPT. Queues a review
      // item if gap ≥ $5. Sara 2026-11-09.
      await flagUnderpaymentIfAny(sql, id, practiceId)

      const summary =
        `Manual insurance payment posted: billed $${billedForStatement.toFixed(2)}, ` +
        `insurance paid $${insurancePayment.toFixed(2)}, ` +
        `contractual adj $${contractualAdj.toFixed(2)}, ` +
        `patient resp $${patientResp.toFixed(2)} (copay $${copay.toFixed(2)}, ded $${deductible.toFixed(2)}, coins $${coinsurance.toFixed(2)}, non-covered $${nonCovered.toFixed(2)})` +
        (paymentReference ? `. Ref: ${paymentReference}` : '')
      try {
        await sql`
          INSERT INTO claim_activity_log (claim_id, created_by_name, kind, body)
          VALUES (${id}::uuid, ${whoName}, 'manual_payment_posted', ${summary})`
      } catch { /* non-fatal */ }

      return res.status(200).json(updated)
    }

    // Edit a previously-posted MANUAL payment. Only allowed on claims
    // where payment_source = 'manual' — Stedi ERAs are the source of
    // truth and shouldn't be hand-edited from the UI (if an ERA is
    // wrong, the fix is to re-fetch it, not to overwrite). Statement
    // amounts are updated too, but only if the statement is still in
    // 'draft' — once sent to the family we leave the statement alone
    // so the family version and the server version don't disagree.
    // Sara 2026-11-09.
    if (action === 'edit_insurance_payment') {
      const num = (v: any): number => {
        const n = parseFloat(String(v ?? '').trim().replace(/[^0-9.-]/g, ''))
        return Number.isFinite(n) ? n : 0
      }
      const amountBilled    = num((fields as any).amount_billed)
      const insurancePayment = num((fields as any).insurance_payment)
      const contractualAdj   = num((fields as any).contractual_adjustment)
      const copay            = num((fields as any).patient_copay)
      const deductible       = num((fields as any).patient_deductible)
      const coinsurance      = num((fields as any).patient_coinsurance)
      const nonCovered       = num((fields as any).patient_non_covered)
      const paymentReference = String((fields as any).payment_reference ?? '').trim() || null
      const paymentDateIn    = String((fields as any).payment_date ?? '').trim()
      const paymentDate      = paymentDateIn ? new Date(paymentDateIn + 'T12:00:00Z') : null
      if (paymentDateIn && (!paymentDate || isNaN(paymentDate.getTime()))) {
        return res.status(400).json({ error: 'Invalid payment_date — use YYYY-MM-DD' })
      }

      const [claim] = await sql`
        SELECT id, status, practice_id, payment_source, era_received_at, total_charge
        FROM claims
        WHERE id = ${id}::uuid AND practice_id = ${practiceId}::uuid LIMIT 1`
      if (!claim) return res.status(404).json({ error: 'Claim not found' })
      if (claim.status === 'written_off') {
        return res.status(400).json({ error: 'This claim is written off. Reopen it before editing the payment.' })
      }
      if (claim.payment_source !== 'manual') {
        return res.status(400).json({ error: 'Can only edit payments that were posted manually. Stedi ERAs are the source of truth — re-fetch instead of editing.' })
      }
      if (!claim.era_received_at) {
        return res.status(400).json({ error: 'No payment to edit — post one first.' })
      }

      const billedForStatement = amountBilled > 0 ? amountBilled : (parseFloat(String(claim.total_charge ?? 0)) || 0)
      const patientResp = +(copay + deductible + coinsurance + nonCovered).toFixed(2)
      const remaining   = +(billedForStatement - insurancePayment - contractualAdj).toFixed(2)

      const [meEdit] = await sql`SELECT name FROM providers WHERE cognito_sub = ${sub} LIMIT 1`
      const whoNameEdit = (meEdit as any)?.name ?? 'Biller'

      const [updated] = await sql`
        UPDATE claims SET
          amount_billed_era          = ${billedForStatement},
          insurance_payment_era      = ${insurancePayment},
          contractual_adjustment_era = ${contractualAdj},
          patient_copay_era          = ${copay},
          patient_deductible_era     = ${deductible},
          patient_coinsurance_era    = ${coinsurance},
          patient_non_covered_era    = ${nonCovered},
          era_received_at            = COALESCE(${paymentDate}::timestamptz, era_received_at),
          era_seen_at                = NOW(),
          payment_reference          = ${paymentReference},
          updated_at                 = NOW()
        WHERE id = ${id}::uuid AND practice_id = ${practiceId}::uuid
        RETURNING *`

      // Statement sync — only update draft statements. Once sent/paid,
      // the family has seen the number and we don't rewrite under them.
      try {
        const [existingStmt] = await sql`
          SELECT id, status FROM patient_statements WHERE claim_id = ${id}::uuid AND voided_at IS NULL LIMIT 1`
        if (existingStmt && existingStmt.status === 'draft') {
          await sql`
            UPDATE patient_statements SET
              amount_billed          = ${billedForStatement},
              insurance_payment      = ${insurancePayment},
              contractual_adjustment = ${contractualAdj},
              patient_copay          = ${copay},
              patient_deductible     = ${deductible},
              patient_coinsurance    = ${coinsurance},
              patient_non_covered    = ${nonCovered},
              remaining_balance      = ${remaining},
              total_amount_due       = ${patientResp},
              total_amount_due_text  = ${String(patientResp)},
              updated_at             = NOW()
            WHERE id = ${existingStmt.id}::uuid`
        }
      } catch (stmtErr: any) {
        console.error('[edit_insurance_payment] statement update failed (non-fatal):', stmtErr?.message)
      }

      // Re-run the underpayment flagger — gap may have changed.
      await flagUnderpaymentIfAny(sql, id, practiceId)

      const editSummary =
        `Manual insurance payment edited: billed $${billedForStatement.toFixed(2)}, ` +
        `insurance paid $${insurancePayment.toFixed(2)}, contractual adj $${contractualAdj.toFixed(2)}, ` +
        `patient resp $${patientResp.toFixed(2)}` +
        (paymentReference ? `. Ref: ${paymentReference}` : '')
      try {
        await sql`
          INSERT INTO claim_activity_log (claim_id, created_by_name, kind, body)
          VALUES (${id}::uuid, ${whoNameEdit}, 'manual_payment_edited', ${editSummary})`
      } catch { /* non-fatal */ }

      return res.status(200).json(updated)
    }

    // Submit to Stedi (live or test)
    if (action === 'submit' || action === 'test') {
      const testMode = action === 'test'
      const [claim] = await sql`SELECT * FROM claims WHERE id = ${id}::uuid AND practice_id = ${practiceId}::uuid`
      if (!claim) return res.status(404).json({ error: 'Claim not found' })
      if (claim.status === 'submitted') return res.status(400).json({ error: 'Already submitted' })
      if (!claim.payer_id) return res.status(400).json({ error: 'No payer ID — cannot submit. Verify payer and update claim.' })

      // Server-side Tier-1 scrubber — mirrors the client scrubber in
      // src/lib/claimScrubber.ts. The client blocks the submit button
      // but we re-check here so a crafted request can't bypass. See
      // CLAUDE.md pre-push discipline rule 3 (safety nets before
      // features): these catch classes of errors that otherwise bounce
      // off Stedi as cryptic field-level rejections (e.g. "patientInfo
      // dateOfBirth is required").
      const scrubDxs  = Array.isArray(claim.diagnoses) ? claim.diagnoses : []
      const scrubCpts = Array.isArray(claim.cpt_codes) ? claim.cpt_codes : []
      if (scrubDxs.length === 0) {
        return res.status(400).json({ error: 'Claim has no diagnoses. Add at least one ICD-10 code before submitting.' })
      }
      if (scrubCpts.length === 0) {
        return res.status(400).json({ error: 'Claim has no CPT codes. Add at least one procedure before submitting.' })
      }
      const scrubNpi = String(claim.rendering_provider_npi ?? '').replace(/\D/g, '')
      if (scrubNpi.length !== 10) {
        return res.status(400).json({ error: `Rendering provider NPI is missing or malformed (got "${claim.rendering_provider_npi ?? ''}"). NPI must be exactly 10 digits.` })
      }
      if (!claim.patient_dob) {
        return res.status(400).json({ error: 'Patient date of birth is missing. Fix the chart record before submitting.' })
      }
      const scrubZeroLines = scrubCpts.filter((c: any) => {
        const charge = parseFloat(String(c.charge_amount ?? 0)) || 0
        const units = parseInt(String(c.units ?? 1), 10) || 1
        return charge * units <= 0
      })
      if (scrubZeroLines.length > 0) {
        const codes = scrubZeroLines.map((c: any) => c.code).join(', ')
        return res.status(400).json({ error: `Line(s) ${codes} have a $0 charge. Set a valid charge amount before submitting.` })
      }

      // Auto-eligibility pre-submit check. Stage 1 billing agent — Sara
      // 2026-11-09 decision: run eligibility automatically on every claim
      // and hold any that fail. Only fires on live submits (not tests),
      // only for insurance-billable payers, only when we have a child_id
      // to check. If the payer tells us the member is NOT active, block
      // the submit and queue a review_queue_item for Sara. Any other
      // outcome (active, ambiguous, infrastructure error) → proceed.
      // Infrastructure glitches should never block billing.
      if (!testMode && claim.payer_id !== 'PP' && claim.child_id) {
        try {
          const protocol = String(req.headers['x-forwarded-proto'] ?? 'https')
          const host = String(req.headers.host ?? process.env.VERCEL_URL ?? '')
          if (host) {
            const eligRes = await fetch(`${protocol}://${host}/api/eligibility`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': String(req.headers.authorization ?? ''),
              },
              body: JSON.stringify({ child_id: claim.child_id }),
            })
            if (eligRes.ok) {
              const elig = await eligRes.json() as any
              if (elig?.active === false) {
                // Record on the claim's activity log so the audit trail
                // shows the auto-check fired and what it found.
                try {
                  await sql`
                    INSERT INTO claim_activity_log (claim_id, created_by_name, kind, body)
                    VALUES (${id}::uuid, 'system (auto-eligibility)', 'eligibility_blocked',
                           ${`Pre-submit eligibility check reported member not active for ${claim.payer_name ?? 'payer'}. Claim held for review.`})`
                } catch {}
                // Queue a review item so Sara sees this surface in the
                // Billing agent UI alongside stale claims + underpayments.
                try {
                  await sql`
                    CREATE TABLE IF NOT EXISTS review_queue_items (
                      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
                      practice_id uuid NOT NULL, item_type text NOT NULL,
                      work_category text NOT NULL, claim_id uuid,
                      patient_name text, payer_name text, service_date date,
                      priority int NOT NULL DEFAULT 100, summary text NOT NULL,
                      agent_reasoning jsonb, proposed_change jsonb,
                      status text NOT NULL DEFAULT 'open',
                      decided_at timestamptz, decided_by uuid,
                      decided_by_name text, decision_note text,
                      created_at timestamptz NOT NULL DEFAULT NOW()
                    )`
                } catch {}
                try {
                  // Only insert if there isn't already an open
                  // eligibility_blocked item for this claim — avoids
                  // flooding the queue if Sara re-tries submit multiple
                  // times before fixing coverage.
                  const [existing] = await sql`
                    SELECT id FROM review_queue_items
                    WHERE practice_id = ${practiceId}::uuid
                      AND claim_id    = ${id}::uuid
                      AND item_type   = 'eligibility_blocked'
                      AND status      = 'open'
                    LIMIT 1`
                  if (!existing) {
                    const patientName = [claim.patient_first_name, claim.patient_last_name].filter(Boolean).join(' ') || 'Unknown patient'
                    const summary =
                      `${claim.payer_name ?? 'Payer'} reports member not active as of DOS ${claim.service_date}. ` +
                      `Claim held — verify coverage with family or payer before resubmit.`
                    const reasoning = {
                      payer_name: claim.payer_name,
                      payer_id: claim.payer_id,
                      member_id: claim.member_id,
                      eligibility_response: elig,
                      source: 'auto-eligibility pre-submit',
                    }
                    await sql`
                      INSERT INTO review_queue_items
                        (practice_id, item_type, work_category, claim_id, patient_name,
                         payer_name, service_date, priority, summary, agent_reasoning)
                      VALUES
                        (${practiceId}::uuid, 'eligibility_blocked', 'claim_submission', ${id}::uuid,
                         ${patientName}, ${claim.payer_name ?? null}, ${claim.service_date ?? null}::date,
                         50, ${summary}, ${JSON.stringify(reasoning)}::jsonb)`
                  }
                } catch (qErr: any) {
                  console.error('[auto-eligibility] queue insert failed:', qErr?.message)
                }
                return res.status(400).json({
                  error: `Eligibility check reports ${claim.payer_name ?? 'payer'} member not active for this patient. Claim was NOT sent. See Billing agent → Review queue.`,
                  eligibility: elig,
                })
              }
            }
          }
        } catch (eligErr: any) {
          // Infrastructure error — don't block the submit. Log for
          // traceability so Sara can see the check attempted.
          console.error('[auto-eligibility] non-fatal (allowing submit):', eligErr?.message)
          try {
            await sql`
              INSERT INTO claim_activity_log (claim_id, created_by_name, kind, body)
              VALUES (${id}::uuid, 'system (auto-eligibility)', 'eligibility_check_error',
                     ${`Pre-submit eligibility check infrastructure error: ${eligErr?.message ?? 'unknown'}. Claim submitted anyway.`})`
          } catch {}
        }
      }

      // If the claim's snapshot of patient address or subscriber info
      // is stale, refresh from the linked child/family record at
      // submit time and persist. This prevents Stedi rejections like
      //   "dependent.address missing"   (Madelynn Rodgers 2026-09-11)
      //   "Missing First Name (Subscriber)"  (Madelynn Rodgers 2026-09-11)
      // whenever the correct data now lives on the family/child.
      const addressStale = !claim.patient_address || !claim.patient_city || !claim.patient_state || !claim.patient_zip
      const subscriberStale = !claim.subscriber_name || !claim.subscriber_name.trim().includes(' ')
      if ((addressStale || subscriberStale) && claim.child_id) {
        // Address can live in three places (per feedback_patient_address_everywhere.md):
        //   1. family_profiles.address_line1 (canonical, new schema)
        //   2. children.parent_address (older per-child column — Carson Yates 2026-09-11
        //      had address here but not on family_profiles, so a family_profiles-only
        //      refresh missed it and Aetna rejected with code 33 "dependent.address")
        //   3. Sara's manual entry via claim edit form (claim.patient_address itself)
        // Resolve via COALESCE across all sources at refresh time.
        const [row] = await sql`
          SELECT
            fp.address_line1 AS fp_addr, fp.city AS fp_city, fp.state AS fp_state, fp.zip AS fp_zip,
            ch.parent_address AS ch_addr, ch.parent_city AS ch_city, ch.parent_state AS ch_state, ch.parent_zip AS ch_zip,
            ch.insurance_subscriber_name, ch.insurance_subscriber_dob,
            ch.insurance_subscriber_gender, ch.insurance_subscriber_relationship,
            ch.insurance_member_id, ch.insurance_group_number
          FROM children ch
          LEFT JOIN family_profiles fp ON fp.id = ch.family_id
          WHERE ch.id = ${claim.child_id}::uuid AND ch.practice_id = ${practiceId}::uuid`
        if (row) {
          const currentSub = (claim.subscriber_name ?? '').trim()
          const childSub   = (row.insurance_subscriber_name ?? '').trim()
          // Prefer a name with both first + last over a single-word one.
          const bestSub = currentSub.includes(' ') ? currentSub
                        : childSub.includes(' ')   ? childSub
                        : (currentSub || childSub || null)
          const filled = {
            patient_address:              claim.patient_address              || row.fp_addr || row.ch_addr             || null,
            patient_city:                 claim.patient_city                 || row.fp_city || row.ch_city             || null,
            patient_state:                claim.patient_state                || row.fp_state || row.ch_state           || null,
            patient_zip:                  claim.patient_zip                  || row.fp_zip || row.ch_zip               || null,
            subscriber_name:              bestSub,
            subscriber_dob:               claim.subscriber_dob               || row.insurance_subscriber_dob          || null,
            subscriber_gender:            claim.subscriber_gender            || row.insurance_subscriber_gender       || null,
            subscriber_relationship:      claim.subscriber_relationship      || row.insurance_subscriber_relationship || null,
            member_id:                    claim.member_id                    || row.insurance_member_id               || null,
            group_number:                 claim.group_number                 || row.insurance_group_number            || null,
          }
          await sql`
            UPDATE claims SET
              patient_address         = ${filled.patient_address},
              patient_city            = ${filled.patient_city},
              patient_state           = ${filled.patient_state},
              patient_zip             = ${filled.patient_zip},
              subscriber_name         = ${filled.subscriber_name},
              subscriber_dob          = ${filled.subscriber_dob}::date,
              subscriber_gender       = ${filled.subscriber_gender},
              subscriber_relationship = ${filled.subscriber_relationship},
              member_id               = ${filled.member_id},
              group_number            = ${filled.group_number},
              updated_at              = now()
            WHERE id = ${id}::uuid AND practice_id = ${practiceId}::uuid`
          Object.assign(claim, filled)
        }
      }

      // ─── BCBS NC: always re-pull member_id + dep_code from the child
      // record at submit time. The chart is the source of truth —
      // claim snapshots can drift (sibling pre-fill overrides on
      // intake, old claims predating dep_code column, merged
      // duplicate children records, etc.). Found 5 open BCBS NC
      // claims with chart/claim drift during Sara's audit 2026-10-08
      // (Madelynn Rodgers, Graham Gerloff x2, Kate Martin). This block
      // ensures Stedi always receives the chart's current values and
      // writes them back to the claim row so the historical record
      // matches what was transmitted.
      if (claim.payer_id === 'UPICO' && claim.child_id) {
        try {
          const [chartRow] = await sql`
            SELECT insurance_member_id, insurance_dependent_code
            FROM children
            WHERE id = ${claim.child_id}::uuid AND practice_id = ${practiceId}::uuid
            LIMIT 1`
          if (chartRow) {
            const chartMember = String(chartRow.insurance_member_id ?? '').trim()
            const chartDep    = String(chartRow.insurance_dependent_code ?? '').replace(/\D/g, '').slice(0, 2)
            const claimMember = String(claim.member_id ?? '').trim()
            const claimDep    = String(claim.insurance_dependent_code ?? '').replace(/\D/g, '').slice(0, 2)
            const memberIdMismatch = chartMember && chartMember !== claimMember
            const depMismatch      = (chartDep || claimDep) && chartDep !== claimDep
            if (chartMember && (memberIdMismatch || depMismatch)) {
              await sql`
                UPDATE claims SET
                  member_id                = ${chartMember},
                  insurance_dependent_code = ${chartDep || null},
                  updated_at               = now()
                WHERE id = ${id}::uuid AND practice_id = ${practiceId}::uuid`
              claim.member_id = chartMember
              claim.insurance_dependent_code = chartDep || null
              try {
                await sql`
                  CREATE TABLE IF NOT EXISTS claim_activity_log (
                    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
                    claim_id uuid NOT NULL,
                    created_at timestamptz NOT NULL DEFAULT NOW(),
                    created_by uuid,
                    created_by_name text,
                    kind text NOT NULL DEFAULT 'note',
                    body text NOT NULL
                  )`
                await sql`
                  INSERT INTO claim_activity_log (claim_id, created_by_name, kind, body)
                  VALUES (${id}::uuid, 'System (auto)', 'bcbs_member_id_refresh',
                         ${`BCBS NC submit: refreshed member_id "${claimMember || '(empty)'}" → "${chartMember}" and dep "${claimDep || '(empty)'}" → "${chartDep || '(empty)'}" from chart before transmit.`})`
              } catch { /* audit log non-fatal */ }
            }
          }
        } catch (e: any) {
          console.error('[claim submit] BCBS member_id refresh failed (non-fatal):', e?.message)
        }
      }

      // Refresh NDC codes from the fee schedule onto any CPT entry
      // that doesn't already carry one. Existing claims whose entries
      // were snapshotted before fee_schedule.ndc_code was seeded (or
      // before this feature shipped) get their NDCs auto-filled at
      // submit time — but ONLY where the entry is currently missing
      // one. Manually-typed NDC overrides are preserved.
      if (Array.isArray(claim.cpt_codes) && claim.cpt_codes.length > 0) {
        const codesNeedingNdc = claim.cpt_codes
          .filter((cpt: any) => cpt?.code && (!cpt.ndc_code || cpt.ndc_unit_count == null))
          .map((cpt: any) => String(cpt.code))
        if (codesNeedingNdc.length > 0) {
          const feeRows = await sql`
            SELECT code, ndc_code, ndc_unit_count FROM fee_schedule
            WHERE practice_id = ${practiceId}::uuid
              AND code = ANY(${codesNeedingNdc}::text[])
              AND (ndc_code IS NOT NULL OR ndc_unit_count IS NOT NULL)`
          const ndcByCode = new Map<string, { ndc_code: string | null; ndc_unit_count: number | null }>()
          for (const row of feeRows) {
            ndcByCode.set(String(row.code), {
              ndc_code: row.ndc_code ? String(row.ndc_code) : null,
              ndc_unit_count: row.ndc_unit_count != null ? parseFloat(row.ndc_unit_count as any) : null,
            })
          }
          if (ndcByCode.size > 0) {
            let changed = false
            const nextCpts = claim.cpt_codes.map((cpt: any) => {
              const seed = cpt?.code ? ndcByCode.get(String(cpt.code)) : undefined
              if (!seed) return cpt
              const next = { ...cpt }
              if (!cpt.ndc_code && seed.ndc_code) { next.ndc_code = seed.ndc_code; changed = true }
              if (cpt.ndc_unit_count == null && seed.ndc_unit_count != null) { next.ndc_unit_count = seed.ndc_unit_count; changed = true }
              return next
            })
            if (changed) {
              await sql`
                UPDATE claims SET
                  cpt_codes = ${JSON.stringify(nextCpts)}::jsonb,
                  updated_at = now()
                WHERE id = ${id}::uuid AND practice_id = ${practiceId}::uuid`
              claim.cpt_codes = nextCpts
            }
          }
        }
      }

      // Hard fail with a clear, actionable message BEFORE hitting
      // Stedi if the subscriber name is still just a single word (or
      // empty). Blue Cross rejects with the useless code-33 EDI
      // message otherwise. Better to catch it here and tell the
      // biller exactly what to fix.
      const subParts = (claim.subscriber_name ?? '').trim().split(/\s+/).filter(Boolean)
      if (subParts.length < 2) {
        return res.status(400).json({
          error: 'Subscriber name must include both a first and last name. Click "Edit patient & insurance info" and enter the full name of the insurance subscriber (e.g., the parent whose insurance covers the child).',
        })
      }
      // Same for patient address — after the auto-refresh above,
      // if address still isn't complete (all four of street/city/
      // state/zip), fail with a clear message rather than shipping a
      // partial payload to Stedi. Aetna and Blue Cross both reject
      // with "dependent.address missing" (Carson Yates 2026-09-11).
      if (!claim.patient_address || !claim.patient_city || !claim.patient_state || !claim.patient_zip) {
        return res.status(400).json({
          error: 'Patient address is incomplete. Click "Edit patient & insurance info" and enter the full street address (street, city, state, ZIP) — Aetna and Blue Cross reject claims without it.',
        })
      }

      // Assign a short, sequential Patient Control Number the first time
      // this claim submits (PEDS + zero-padded 5-digit global sequence,
      // e.g. PEDS00042). Payer sees it, echoes it back on the ERA / 277,
      // matcher on the way in finds the claim via this value first, PCN
      // pill on the card displays it. Legacy claims that submitted
      // before this shipped keep their 20-char UUID PCN.
      //
      // Uses a Postgres SEQUENCE for atomic increments so bursts of
      // concurrent submits can't collide on the same number. Sara +
      // Andrea 2026-09-23.
      if (!claim.payer_control_number) {
        try { await sql`ALTER TABLE claims ADD COLUMN IF NOT EXISTS payer_control_number text` } catch {}
        try { await sql`CREATE SEQUENCE IF NOT EXISTS peds_pcn_seq START 1` } catch {}
        const [pcnRow] = await sql`
          UPDATE claims SET
            payer_control_number = 'PEDS' || LPAD(nextval('peds_pcn_seq')::text, 5, '0'),
            updated_at = NOW()
          WHERE id = ${id}::uuid AND practice_id = ${practiceId}::uuid AND payer_control_number IS NULL
          RETURNING payer_control_number
        `
        if (pcnRow?.payer_control_number) claim.payer_control_number = pcnRow.payer_control_number
      }

      const payload = buildStediPayload(claim, testMode)

      let stediData: any
      try {
        const stediRes = await fetch(
          'https://healthcare.us.stedi.com/2024-04-01/change/medicalnetwork/professionalclaims/v3/submission',
          {
            method: 'POST',
            headers: {
              'Authorization': `Key ${process.env.STEDI_API_KEY}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(payload),
          }
        )
        stediData = await stediRes.json()

        if (!stediRes.ok) {
          // For test mode, return the full Stedi response as 200 so the UI can display the actual error
          if (testMode) {
            return res.json({ test: true, accepted: false, acknowledgment: stediData })
          }
          // Log the payload we sent so we can see exactly what Stedi
          // rejected — helps diagnose "dependent.address missing" style
          // errors where the DB has the field but the payload doesn't
          // for whatever reason.
          console.error('[claims submit] Stedi rejected. Sent payload dependent:',
            JSON.stringify(payload?.dependent ?? null),
            'subscriber:',
            JSON.stringify({
              memberId: payload?.subscriber?.memberId,
              paymentResponsibilityLevelCode: payload?.subscriber?.paymentResponsibilityLevelCode,
              lastName: payload?.subscriber?.lastName,
            }))
          const [updated] = await sql`
            UPDATE claims SET
              status = 'error',
              stedi_response = ${JSON.stringify(stediData)}::jsonb,
              submission_error = ${JSON.stringify(stediData)},
              -- Entering rework: clear the stale ready-for-biller flag so
              -- Andrea has to explicitly re-ready after fixing. Sara 2026-10-06.
              ready_for_biller_at = NULL,
              ready_for_biller_by = NULL,
              updated_at = now()
            WHERE id = ${id}::uuid AND practice_id = ${practiceId}::uuid RETURNING *`
          return res.status(422).json({
            error: 'Stedi rejected the claim',
            details: stediData,
            claim: updated,
            // Include the dependent object we sent so the client can
            // display it in an alert — no more mystery about what
            // was in the request.
            sentDependent: payload?.dependent ?? null,
          })
        }
      } catch (err: any) {
        if (testMode) {
          return res.json({ test: true, accepted: false, acknowledgment: { error: err.message } })
        }
        const [updated] = await sql`
          UPDATE claims SET
            status = 'error',
            submission_error = ${err.message},
            -- Entering rework: clear ready-for-biller flag. Sara 2026-10-06.
            ready_for_biller_at = NULL,
            ready_for_biller_by = NULL,
            updated_at = now()
          WHERE id = ${id}::uuid AND practice_id = ${practiceId}::uuid RETURNING *`
        return res.status(500).json({ error: 'Failed to reach Stedi', claim: updated })
      }

      const claimId = stediData?.claimReference?.referenceNumber ?? stediData?.id ?? null

      if (testMode) {
        return res.json({ test: true, accepted: true, acknowledgment: stediData })
      }

      // Strip convenience / non-covered codes from the claim now that
      // it's submitted to insurance. Must mirror the NEVER_BILL_TO_INSURANCE
      // + Non-Covered Services + format filter above in buildStediPayload,
      // or the stored total_charge won't match what Stedi actually billed
      // and the ERA matcher will see a mismatch.
      const NEVER_BILL_TO_INSURANCE_POST = new Set(['99001'])
      const insuranceCodes = (Array.isArray(claim.cpt_codes) ? claim.cpt_codes : [])
        .filter((c: any) => c.category !== 'Non-Covered Services')
        .filter((c: any) => !NEVER_BILL_TO_INSURANCE_POST.has(String(c.code ?? '')))
      const insuranceTotal = insuranceCodes.reduce((s: number, c: any) => {
        const charge = parseFloat(c.charge_amount) || 0
        const units = parseInt(c.units, 10) || 1
        return s + charge * units
      }, 0)

      const [updated] = await sql`
        UPDATE claims SET
          status = 'submitted',
          stedi_claim_id = ${claimId},
          stedi_response = ${JSON.stringify(stediData)}::jsonb,
          submission_error = NULL,
          submitted_at = now(),
          updated_at = now(),
          cpt_codes = ${JSON.stringify(insuranceCodes)}::jsonb,
          total_charge = ${insuranceTotal}
        WHERE id = ${id}::uuid AND practice_id = ${practiceId}::uuid RETURNING *`

      // Submit-time strip of convenience / 99001 / non-covered codes is a
      // real mutation to cpt_codes. Record it so the history shows the
      // pre-strip vs post-strip shape and the agent can later distinguish
      // "biller moved a code" from "the system auto-stripped it."
      const [submitActor] = await sql`SELECT id, name FROM providers WHERE cognito_sub = ${sub} LIMIT 1`
      await logClaimCodeHistory(sql,
        {
          id: claim.id, practice_id: claim.practice_id,
          cpt_codes: claim.cpt_codes, diagnoses: claim.diagnoses,
          payer_id: claim.payer_id, payer_name: claim.payer_name,
          status: claim.status,
          denial_codes: claim.denial_codes, claim_rejection_reasons: claim.claim_rejection_reasons,
        },
        { cpt_codes: updated.cpt_codes, diagnoses: updated.diagnoses },
        { id: submitActor?.id ?? null, name: submitActor?.name ?? null },
        'submit_strip')

      return res.json(updated)
    }

    // Subscriber name must include first + last if being written.
    // Empty is fine, single-word is not — Blue Cross rejects (code 33).
    if (fields?.subscriber_name && String(fields.subscriber_name).trim()) {
      const parts = String(fields.subscriber_name).trim().split(/\s+/).filter(Boolean)
      if (parts.length < 2) {
        return res.status(400).json({ error: 'Subscriber name must include both first and last name (e.g., "Sarah Rodgers").' })
      }
    }

    // Snapshot the current cpt_codes + diagnoses + denial context BEFORE
    // the UPDATE so claim_history can log a before/after if this edit
    // actually mutates codes or diagnoses. See logClaimCodeHistory. Sara
    // 2026-11-09.
    const [preHistorySnapshot] = await sql`
      SELECT id, practice_id, cpt_codes, diagnoses, payer_id, payer_name,
             status, denial_codes, claim_rejection_reasons
      FROM claims WHERE id = ${id}::uuid AND practice_id = ${practiceId}::uuid`
    const [actor] = await sql`SELECT id, name FROM providers WHERE cognito_sub = ${sub} LIMIT 1`

    // General field update (payer_id, payer_name, cpt_codes, etc.)
    const allowed = ['payer_name', 'payer_id', 'member_id', 'group_number',
                     'subscriber_name', 'subscriber_dob', 'subscriber_gender',
                     'patient_first_name', 'patient_last_name', 'patient_dob', 'patient_gender',
                     'patient_address', 'patient_city', 'patient_state', 'patient_zip',
                     'rendering_provider_npi', 'rendering_provider_taxonomy',
                     'place_of_service', 'service_date', 'status', 'cpt_codes', 'diagnoses',
                     'era_seen_at', 'insurance_dependent_code',
                     // Pam's "Convenience Fee Review" tab checkbox toggle.
                     // Sara 2026-10-06.
                     'convenience_fee_handled']
    const updates: Record<string, any> = {}
    for (const key of allowed) {
      if (key in fields) updates[key] = fields[key]
    }

    // Empty strings for date fields must become null or PostgreSQL ::date cast throws
    for (const dateField of ['subscriber_dob', 'patient_dob', 'service_date'] as const) {
      if (updates[dateField] === '') updates[dateField] = null
    }

    // Recalculate total_charge when cpt_codes are updated
    const newTotal = updates.cpt_codes != null
      ? (updates.cpt_codes as any[]).reduce((s: number, c: any) => {
          const charge = parseFloat(c.charge_amount ?? 0) || 0
          const units = parseInt(c.units, 10) || 1
          return s + charge * units
        }, 0)
      : null

    // If the biller edits a claim currently in 'error' state, they're
    // almost certainly fixing whatever Stedi rejected. Clear the stored
    // rejection so the UI stops showing a stale "Submission failed"
    // banner after the edit — otherwise the user thinks their fix didn't
    // work (they hit save, refresh, and see the same red error, which
    // is actually the frozen error from the previous submission).
    // They'll press Submit to retry.
    const clearStaleError = updates.status == null // don't override an explicit status change

    // Mark the claim as biller-edited whenever dx or cpt changes via
    // this PATCH path. The encounter-notes sign flow checks this flag
    // and refuses to overwrite dx/cpt once set, so a subsequent note
    // re-sign can't revert the biller's work. Shipped 2026-10-07 after
    // Amy Turner case. Also bootstrap the column so cold deploys don't
    // break the SELECT in the sign flow.
    try { await sql`ALTER TABLE claims ADD COLUMN IF NOT EXISTS biller_edited_at timestamptz` } catch {}
    const billerEditedDxOrCpt = updates.diagnoses != null || updates.cpt_codes != null

    const [updated] = await sql`
      UPDATE claims SET
        submission_error           = CASE WHEN ${clearStaleError} AND status = 'error' THEN NULL ELSE submission_error END,
        stedi_response             = CASE WHEN ${clearStaleError} AND status = 'error' THEN NULL ELSE stedi_response END,
        payer_name                 = COALESCE(${updates.payer_name ?? null}, payer_name),
        payer_id                   = COALESCE(${updates.payer_id ?? null}, payer_id),
        member_id                  = COALESCE(${updates.member_id ?? null}, member_id),
        group_number               = COALESCE(${updates.group_number ?? null}, group_number),
        subscriber_name            = COALESCE(${updates.subscriber_name ?? null}, subscriber_name),
        subscriber_dob             = COALESCE(${updates.subscriber_dob ?? null}::date, subscriber_dob),
        subscriber_gender          = COALESCE(${updates.subscriber_gender ?? null}, subscriber_gender),
        patient_first_name         = COALESCE(${updates.patient_first_name ?? null}, patient_first_name),
        patient_last_name          = COALESCE(${updates.patient_last_name ?? null}, patient_last_name),
        patient_dob                = COALESCE(${updates.patient_dob ?? null}::date, patient_dob),
        patient_gender             = COALESCE(${updates.patient_gender ?? null}, patient_gender),
        patient_address            = COALESCE(${updates.patient_address ?? null}, patient_address),
        patient_city               = COALESCE(${updates.patient_city ?? null}, patient_city),
        patient_state              = COALESCE(${updates.patient_state ?? null}, patient_state),
        patient_zip                = COALESCE(${updates.patient_zip ?? null}, patient_zip),
        rendering_provider_npi     = COALESCE(${updates.rendering_provider_npi ?? null}, rendering_provider_npi),
        rendering_provider_taxonomy = COALESCE(${updates.rendering_provider_taxonomy ?? null}, rendering_provider_taxonomy),
        place_of_service           = COALESCE(${updates.place_of_service ?? null}, place_of_service),
        service_date               = COALESCE(${updates.service_date ?? null}::date, service_date),
        status                     = COALESCE(${updates.status ?? null}, CASE WHEN ${clearStaleError} AND status = 'error' THEN 'pending_review' ELSE status END),
        -- When the biller explicitly PATCHes a status, pin the display.
        -- See the ALTER TABLE bootstrap at the top of this handler.
        manual_status_override     = CASE WHEN ${updates.status != null}::boolean THEN true ELSE manual_status_override END,
        cpt_codes                  = COALESCE(${updates.cpt_codes != null ? JSON.stringify(updates.cpt_codes) : null}::jsonb, cpt_codes),
        diagnoses                  = COALESCE(${updates.diagnoses != null ? JSON.stringify(updates.diagnoses) : null}::jsonb, diagnoses),
        total_charge               = COALESCE(${newTotal}, total_charge),
        era_seen_at                = COALESCE(${updates.era_seen_at ?? null}::timestamptz, era_seen_at),
        insurance_dependent_code   = COALESCE(${updates.insurance_dependent_code ?? null}, insurance_dependent_code),
        biller_edited_at           = CASE WHEN ${billerEditedDxOrCpt}::boolean THEN now() ELSE biller_edited_at END,
        updated_at                 = now()
      WHERE id = ${id}::uuid AND practice_id = ${practiceId}::uuid RETURNING *`

    // Record the edit for the billing agent's future pattern learning.
    // Only fires if cpt_codes or diagnoses actually changed (sameJsonb
    // short-circuits the no-op case). Non-fatal.
    if (preHistorySnapshot) {
      await logClaimCodeHistory(sql, preHistorySnapshot as any,
        { cpt_codes: updated.cpt_codes, diagnoses: updated.diagnoses },
        { id: actor?.id ?? null, name: actor?.name ?? null },
        'biller_edit')
    }

    return res.json(updated)
  }

  if (req.method === 'DELETE') {
    const [claim] = await sql`SELECT status FROM claims WHERE id = ${id}::uuid AND practice_id = ${practiceId}::uuid`
    if (!claim) return res.status(404).json({ error: 'Claim not found' })
    if (claim.status === 'submitted') return res.status(400).json({ error: 'Cannot delete a submitted claim' })
    await sql`DELETE FROM claims WHERE id = ${id}::uuid AND practice_id = ${practiceId}::uuid`
    return res.json({ deleted: true })
  }

  res.status(405).json({ error: 'Method not allowed' })
}
