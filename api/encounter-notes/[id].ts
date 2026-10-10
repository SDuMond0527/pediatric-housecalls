import type { VercelRequest, VercelResponse } from '@vercel/node'
import { neon } from '@neondatabase/serverless'
import { createRemoteJWKSet, jwtVerify } from 'jose'

// ── Convenience-fee calculation (inlined from api/convenience-fee.ts) ────
// Keep in sync with the authoritative version there. Vercel's api/lib
// exclusion means we can't share the function via import; duplicating
// here is the established pattern. Sara 2026-10-06.
const CV_CUTOVER_DATE = '2026-10-07' // Automation starts for appts with scheduled_date >= this

// Neon's JS driver returns `date` and `timestamptz` columns as JS Date objects.
// `String(dateObj).slice(0, 10)` returns "Fri Oct 09" (via Date.prototype.toString),
// which Postgres can't parse when passed back as `::date` — the INSERT throws
// and the whole CV auto-charge block gets swallowed by its try/catch, so Colin
// Simpson's claim shipped with no CV row 2026-10-09 (and the orphan cron hit
// the same bug on backfill). Always route date columns through toISOString.
const toYmd = (d: any): string => {
  if (!d) return ''
  if (d instanceof Date) return d.toISOString().slice(0, 10)
  return String(d).slice(0, 10)
}
const CV_CMA_TELE_ALIASES = ['CMA + telemedicine', 'CMA + tele', 'CMA visit — paired with MD/NP telemedicine screening']
const CV_IV_FLUIDS_ALIASES = ['In-home IV fluids', 'RN IV fluids', 'RN IV fluid visit — paired with MD/NP screening', 'RN in-home IV fluids administration', 'Video telemedicine screening for IV fluids']
const cvIsCmaTelePair  = (v?: string | null) => !!v && CV_CMA_TELE_ALIASES.includes(v)
const cvIsIvFluidsPair = (v?: string | null) => !!v && CV_IV_FLUIDS_ALIASES.includes(v)
function cvEasterSunday(year: number): string {
  const a = year % 19, b = Math.floor(year / 100), c = year % 100
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25)
  const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30
  const i = Math.floor(c / 4), k = c % 4
  const l = (32 + 2 * e + 2 * i - h - k) % 7
  const m = Math.floor((a + 11 * h + 22 * l) / 451)
  const month = Math.floor((h + l - 7 * m + 114) / 31)
  const day = ((h + l - 7 * m + 114) % 31) + 1
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}
function cvNthWeekdayOfMonth(year: number, month: number, weekday: number, n: number): string {
  if (n > 0) {
    const d = new Date(year, month - 1, 1); let count = 0
    while (d.getMonth() === month - 1) {
      if (d.getDay() === weekday) { count++; if (count === n) break }
      d.setDate(d.getDate() + 1)
    }
    return `${year}-${String(month).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  } else {
    const d = new Date(year, month, 0)
    while (d.getDay() !== weekday) d.setDate(d.getDate() - 1)
    return `${year}-${String(month).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }
}
function cvIsMajorHoliday(dateStr: string): boolean {
  const year = parseInt(dateStr.slice(0, 4))
  const holidays = [
    `${year}-01-01`, cvEasterSunday(year),
    cvNthWeekdayOfMonth(year, 5, 1, -1), `${year}-07-04`,
    cvNthWeekdayOfMonth(year, 9, 1, 1), cvNthWeekdayOfMonth(year, 11, 4, 4),
    `${year}-12-25`,
  ]
  return holidays.includes(dateStr)
}
function cvCalculateFee(miles: number, dateStr: string, time24: string, visitType: string, state?: string | null): { fee: number; code: string } {
  if (cvIsIvFluidsPair(visitType)) return { fee: 150, code: 'IV-flat' }
  if (cvIsCmaTelePair(visitType))  return { fee: 50,  code: 'CMA-flat' }
  if (cvIsMajorHoliday(dateStr))   return state === 'VA' ? { fee: 200, code: 'VACV10' } : { fee: 200, code: 'CV13' }
  const date = new Date(dateStr + 'T12:00:00')
  const dow = date.getDay()
  const isWeekend = dow === 0 || dow === 6
  const [h] = time24.split(':').map(Number)
  const isPeakHours = h >= 8 && h < 15
  if (state === 'VA') {
    if (isWeekend) {
      if (miles < 5)   return { fee: 125, code: 'VACV7' }
      if (miles <= 15) return { fee: 150, code: 'VACV8' }
      return { fee: 175, code: 'VACV9' }
    }
    if (isPeakHours) {
      if (miles < 2)   return { fee: 50,  code: 'VACV11' }
      if (miles < 5)   return { fee: 75,  code: 'VACV1' }
      if (miles <= 15) return { fee: 100, code: 'VACV2' }
      return { fee: 150, code: 'VACV3' }
    }
    if (miles < 5)   return { fee: 100, code: 'VACV4' }
    if (miles <= 15) return { fee: 125, code: 'VACV5' }
    return { fee: 150, code: 'VACV6' }
  }
  if (isWeekend) {
    if (miles < 2)   return { fee: 100, code: 'CV9' }
    if (miles < 5)   return { fee: 125, code: 'CV10' }
    if (miles <= 15) return { fee: 150, code: 'CV11' }
    return { fee: 175, code: 'CV12' }
  }
  if (isPeakHours) {
    if (miles < 2)   return { fee: 50,  code: 'CV1' }
    if (miles < 5)   return { fee: 75,  code: 'CV2' }
    if (miles <= 15) return { fee: 100, code: 'CV3' }
    return { fee: 150, code: 'CV4' }
  }
  if (miles < 2)   return { fee: 75,  code: 'CV5' }
  if (miles < 5)   return { fee: 100, code: 'CV6' }
  if (miles <= 15) return { fee: 125, code: 'CV7' }
  return { fee: 150, code: 'CV8' }
}
async function cvGetDrivingMiles(origin: string, destination: string): Promise<number | null> {
  const key = process.env.GOOGLE_MAPS_API_KEY || ''
  if (!key) return null
  const url = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${encodeURIComponent(origin)}&destinations=${encodeURIComponent(destination)}&mode=driving&units=imperial&key=${key}`
  try {
    const res = await fetch(url)
    const data = await res.json() as any
    const element = data?.rows?.[0]?.elements?.[0]
    if (element?.status !== 'OK') return null
    return element.distance.value / 1609.344
  } catch { return null }
}

// ── Square + notifications (Phase 2 auto-charge, 2026-10-06) ────────────
// Kill switch for the whole auto-charge pipeline. If set to anything
// other than 'true' (default), rows still get inserted as 'pending' but
// no Square calls fire — Pam handles everything manually. Sara 2026-10-06.
const CV_AUTO_CHARGE_ENABLED = String(process.env.AUTO_CHARGE_CONVENIENCE_FEES ?? 'true').toLowerCase() !== 'false'
// Safety cap: anything above this dollar amount doesn't auto-charge. The
// row stays pending with a warning note for Pam to review manually.
// Normal CV fees are $50–$200; a computed fee > $300 means something is
// wrong with the inputs (bad miles, wrong visit type).
const CV_MAX_AUTO_CHARGE_CENTS = 30000
const CV_SQUARE_ACCESS_TOKEN = process.env.SQUARE_ACCESS_TOKEN || ''
const CV_SQUARE_ENV          = process.env.SQUARE_ENVIRONMENT || 'production'
const CV_SQUARE_LOCATION_ID  = process.env.SQUARE_LOCATION_ID || ''
const CV_SQUARE_BASE_URL     = CV_SQUARE_ENV === 'sandbox' ? 'https://connect.squareupsandbox.com' : 'https://connect.squareup.com'
async function cvSquarePost(path: string, body: unknown): Promise<any> {
  const res = await fetch(`${CV_SQUARE_BASE_URL}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${CV_SQUARE_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
      'Square-Version': '2024-01-17',
    },
    body: JSON.stringify(body),
  })
  const json = await res.json() as any
  if (!res.ok) {
    const detail = json?.errors?.[0]?.detail || json?.errors?.[0]?.category || `Square API error (${res.status})`
    const err = new Error(detail) as any
    err.squareErrors = json?.errors
    throw err
  }
  return json
}
// Resend + Twilio senders (duplicated from api/notifications.ts for the
// same reason other helpers are inlined).
const CV_RESEND_API_KEY = process.env.RESEND_API_KEY || ''
const CV_FROM_EMAIL     = process.env.FROM_EMAIL     || 'noreply@phcbooking.com'
const CV_TWILIO_SID     = process.env.TWILIO_ACCOUNT_SID || ''
const CV_TWILIO_TOKEN   = process.env.TWILIO_AUTH_TOKEN  || ''
const CV_TWILIO_FROM    = process.env.TWILIO_FROM_NUMBER || ''
async function cvSendEmail(to: string, subject: string, html: string): Promise<void> {
  if (!CV_RESEND_API_KEY || CV_RESEND_API_KEY === 'PLACEHOLDER') return
  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${CV_RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: CV_FROM_EMAIL, to, subject, html }),
  }).catch(e => { console.error('[CV email] send failed:', e?.message) })
}
async function cvSendSms(to: string, body: string): Promise<void> {
  if (!CV_TWILIO_SID || !CV_TWILIO_TOKEN || !CV_TWILIO_FROM) return
  const auth = Buffer.from(`${CV_TWILIO_SID}:${CV_TWILIO_TOKEN}`).toString('base64')
  const form = new URLSearchParams({ To: to, From: CV_TWILIO_FROM, Body: body })
  await fetch(`https://api.twilio.com/2010-04-01/Accounts/${CV_TWILIO_SID}/Messages.json`, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  }).catch(e => { console.error('[CV sms] send failed:', e?.message) })
}

// Inlined from api/lib/applyClears.ts + api/lib/payerIds.ts — see
// comment in api/appointments/[id].ts explaining why.
const ENCOUNTER_NOTES_CLEARABLE = new Set<string>([
  'chief_complaint', 'subjective', 'objective', 'assessment', 'plan',
  'vaccine_administrations', 'iv_administration', 'labs',
])
async function applyEncounterNoteClears(
  sql: any,
  id: string,
  practiceId: string,
  requested: unknown,
): Promise<void> {
  const clears = Array.isArray(requested)
    ? (requested as unknown[]).filter((k): k is string => typeof k === 'string' && ENCOUNTER_NOTES_CLEARABLE.has(k))
    : []
  for (const field of clears) {
    switch (field) {
      case 'chief_complaint':          await sql`UPDATE encounter_notes SET chief_complaint          = NULL WHERE id = ${id}::uuid AND practice_id = ${practiceId}::uuid`; break
      case 'subjective':               await sql`UPDATE encounter_notes SET subjective               = NULL WHERE id = ${id}::uuid AND practice_id = ${practiceId}::uuid`; break
      case 'objective':                await sql`UPDATE encounter_notes SET objective                = NULL WHERE id = ${id}::uuid AND practice_id = ${practiceId}::uuid`; break
      case 'assessment':               await sql`UPDATE encounter_notes SET assessment               = NULL WHERE id = ${id}::uuid AND practice_id = ${practiceId}::uuid`; break
      case 'plan':                     await sql`UPDATE encounter_notes SET plan                     = NULL WHERE id = ${id}::uuid AND practice_id = ${practiceId}::uuid`; break
      case 'vaccine_administrations':  await sql`UPDATE encounter_notes SET vaccine_administrations  = NULL WHERE id = ${id}::uuid AND practice_id = ${practiceId}::uuid`; break
      case 'iv_administration':        await sql`UPDATE encounter_notes SET iv_administration        = NULL WHERE id = ${id}::uuid AND practice_id = ${practiceId}::uuid`; break
      case 'labs':                     await sql`UPDATE encounter_notes SET labs                     = NULL WHERE id = ${id}::uuid AND practice_id = ${practiceId}::uuid`; break
    }
  }
}
const PAYER_IDS_INLINE: Record<string, string> = {
  'self pay': 'PP', 'self-pay': 'PP', 'selfpay': 'PP', 'self': 'PP',
  'bcbs': 'UPICO', 'bcbs of nc': 'UPICO', 'bcbs nc': 'UPICO',
  'blue cross': 'UPICO', 'blue cross nc': 'UPICO',
  'blue cross blue shield': 'UPICO', 'blue cross blue shield of nc': 'UPICO',
  'blue cross blue shield nc': 'UPICO',
  'aetna': '60054', 'cigna': '62308',
  'united healthcare': '87726', 'united health care': '87726', 'uhc': '87726',
  'umr': '39026', 'humana': '61101',
  'phcs': '52133', 'multiplan': '52133',
  'coventry': '38217', 'select health': '53589',
  'medcost': '56162', 'healthgram': '56162',
  'bright health': '98798', 'bright healthcare': '98798',
}
function resolvePayer(name: string | null): string | null {
  if (!name) return null
  const normalized = name.toLowerCase().trim()
  // Anthem routing per Sara 2026-10-05: see api/claims/index.ts for the
  // canonical rule. Virginia Anthem → VABLS; every other Anthem → UPICO.
  if (/anthem/.test(normalized)) {
    if (/\b(va|virginia)\b/.test(normalized)) return 'VABLS'
    return 'UPICO'
  }
  return PAYER_IDS_INLINE[normalized] ?? null
}

async function generateClaimForNote(sql: any, encounterNoteId: string, practiceId: string) {
  const [existing] = await sql`
    SELECT id, status FROM claims WHERE encounter_note_id = ${encounterNoteId}::uuid AND practice_id = ${practiceId}::uuid
  `
  // If a submitted / accepted claim already exists, leave it alone
  // (billers do NOT want auto-sync overwriting frozen claims). But
  // if the claim is still editable (pending_review / error / draft),
  // fall through so we can re-sync it below with any newly-added
  // CPT codes or diagnoses on the note. Previously this bailed out
  // for ALL existing claims, which meant re-signing a note never
  // updated its claim — Sara DuMond 2026-09-13: virtual visit claim
  // showed $0 empty after 99213 was added and note re-signed.
  const isEditable = !existing || ['pending_review', 'error', 'draft'].includes(String(existing.status))
  if (existing && !isEditable) return { skipped: 'Claim already submitted' }

  const [note] = await sql`SELECT * FROM encounter_notes WHERE id = ${encounterNoteId}::uuid AND practice_id = ${practiceId}::uuid`
  if (!note) return { error: 'Note not found' }
  if (!note.is_signed) return { error: 'Note must be signed' }

  const [appt] = note.appointment_id
    ? await sql`SELECT * FROM appointments WHERE id = ${note.appointment_id}::uuid AND practice_id = ${practiceId}::uuid`
    : [null]
  const [child] = note.child_id
    ? await sql`SELECT * FROM children WHERE id = ${note.child_id}::uuid AND practice_id = ${practiceId}::uuid`
    : [null]
  const [provider] = note.provider_id
    ? await sql`SELECT name, npi, taxonomy_code FROM providers WHERE id = ${note.provider_id}::uuid AND practice_id = ${practiceId}::uuid`
    : [null]
  const [family] = child?.family_id
    ? await sql`SELECT address_line1, city, state, zip FROM family_profiles WHERE id = ${child.family_id}::uuid AND practice_id = ${practiceId}::uuid`
    : [null]
  // Resolve address across all sources at snapshot time (family_profiles
  // first, fallback to children.parent_* — Carson Yates 2026-09-11 had
  // address on children.parent_address but not on family_profiles).
  const resolvedAddr = {
    line1: family?.address_line1 ?? child?.parent_address ?? null,
    city:  family?.city          ?? child?.parent_city    ?? null,
    state: family?.state         ?? child?.parent_state   ?? null,
    zip:   family?.zip           ?? child?.parent_zip     ?? null,
  }

  // Vaccine encounters AND RN in-home IV fluids visits are always billed
  // under Dr. Sara DuMond as the rendering provider. RNs can't bill
  // independently, so the claim must go under the supervising MD. The
  // regex matches every IV fluids RN-side alias (In-home IV fluids,
  // RN IV fluids, RN IV fluid visit — paired with MD/NP screening,
  // RN in-home IV fluids administration) and intentionally excludes the
  // 'Video telemedicine screening for IV fluids' NP side (which bills
  // under the NP itself). Sara 2026-10-06.
  const isVaccineVisit = appt?.visit_type === 'In-home vaccine administration'
  const vt = String(appt?.visit_type ?? '')
  const isRnIvFluidsVisit = /iv/i.test(vt) && /fluid/i.test(vt)
    && /(rn|administration|in-home)/i.test(vt)
    && !/screening/i.test(vt)
  const [supervisingMd] = (isVaccineVisit || isRnIvFluidsVisit)
    ? await sql`SELECT name, npi, taxonomy_code FROM providers WHERE name = 'Dr. Sara DuMond' AND practice_id = ${practiceId}::uuid LIMIT 1`
    : [null]
  const renderingProvider = supervisingMd ?? provider

  const rawCptCodes = Array.isArray(note.cpt_codes) ? note.cpt_codes : []

  // Aetna POC-test self-pay swap — Sara 2026-10-05.
  // Aetna's benefits policy excludes in-home point-of-care tests. Billing
  // them produces CARC 96 (non-covered) every time; the family ends up
  // paying anyway. Swap the test CPT to its self-pay equivalent BEFORE
  // the claim is written so downstream totals / insurance filtering /
  // forceSelfPay logic see the post-swap list. See
  // project_aetna_poc_self_pay_swap.md for the full policy.
  const AETNA_POC_SWAP: Record<string, { code: string; description: string; charge_amount: number }> = {
    '87880': { code: 'SelfStre', description: 'Self-pay rapid strep test',                       charge_amount: 10 },
    '87812': { code: 'SelfFluC', description: 'Self-pay rapid flu/COVID test',                   charge_amount: 35 },
    '81002': { code: 'SLFUrine', description: 'Self-pay urine dipstick and lab handling fee',    charge_amount: 10 },
  }
  const isAetna = String(child?.insurance_provider ?? '').toLowerCase().trim() === 'aetna'
  const aetnaSwapRecords: Array<{ from: string; to: string }> = []
  let swappedCpts = rawCptCodes
  if (isAetna && rawCptCodes.length > 0) {
    // Idempotency guard: if the self-pay equivalent is already in the
    // list (biller manually swapped on a prior review), skip. Prevents
    // double-ups on re-signed notes with existing editable claims.
    const existingCodes = new Set(rawCptCodes.map((c: any) => String(c.code)))
    swappedCpts = rawCptCodes.map((c: any) => {
      const swap = AETNA_POC_SWAP[String(c.code)]
      if (!swap) return c
      if (existingCodes.has(swap.code)) return c
      aetnaSwapRecords.push({ from: String(c.code), to: swap.code })
      return {
        ...c,
        code: swap.code,
        description: swap.description,
        charge_amount: swap.charge_amount,
        category: 'Non-Covered Services',
      }
    })
  }

  // CVTech auto-attach for the MD/NP side of a CMA + telemedicine paired
  // visit. Sara 2026-10-05. By convention, BOTH sides of the pair carry
  // visit_type = "CMA + telemedicine" with different providers assigned.
  // Since CMAs are locked from signing (see api/encounter-notes/[id].ts
  // PUT handler), any CMA+tele visit that reaches claim-gen is the MD/NP
  // side by elimination — and that side is the single billable claim,
  // which must carry the $50 "Convenience fee - in-home tech diagnostic
  // visit" (CVTech) as a self-pay line. Idempotent: skips if CVTech is
  // already present. See project_hybrid_telemed_billing_rule.md.
  let cvtechAttached = false
  if (appt?.visit_type === 'CMA + telemedicine') {
    const alreadyHasCvtech = swappedCpts.some((c: any) => String(c.code) === 'CVTech')
    if (!alreadyHasCvtech) {
      swappedCpts = [...swappedCpts, {
        code: 'CVTech',
        description: 'Convenience fee - in-home tech diagnostic visit',
        charge_amount: 50,
        category: 'Non-Covered Services',
        place_of_service: '12',
      }]
      cvtechAttached = true
    }
  }

  // Include ALL codes on the stored claim (convenience fees visible for admin
  // review). Non-Covered Services get stripped from the Stedi payload at
  // submission time by api/claims/[id].ts. Matches api/claims/index.ts:63.
  // Previously this stripped Non-Covered here too, so auto-generated claims
  // (created when a provider signs a note) never had the convenience fee,
  // even though manually-generated claims did — because the Sept 1 fix
  // (88fe14d) was applied to only one of the two claim-generation paths.
  const allCptCodes = swappedCpts
  const cptCodes = allCptCodes
  const total = cptCodes.reduce((s: number, c: any) => {
    const charge = parseFloat(c.charge_amount) || 0
    const units = parseInt(c.units, 10) || 1
    return s + charge * units
  }, 0)
  const insuranceCodes = allCptCodes.filter((c: any) => c.category !== 'Non-Covered Services')
  // Force self-pay when:
  //   - visit_type is "Text visit" (always cash-pay regardless of what
  //     insurance is on file for the patient — Sara 2026-10-05), OR
  //   - every CPT is Non-Covered Services (CPR class, etc.) — insurance
  //     would only reject it. See matching rule in api/claims/index.ts.
  const isTextVisit = appt?.visit_type === 'Text visit'
  const forceSelfPay = isTextVisit || (allCptCodes.length > 0 && insuranceCodes.length === 0)
  const pos = insuranceCodes[0]?.place_of_service ?? (appt?.visit_type?.toLowerCase().includes('tele') ? '10' : '12')
  const payerName = forceSelfPay ? 'Self Pay' : (child?.insurance_provider ?? null)
  const payerId   = forceSelfPay ? 'PP'       : resolvePayer(child?.insurance_provider ?? null)

  let claim: any
  if (existing) {
    // Editable claim already exists — refresh cpt_codes / diagnoses /
    // total from the note, UNLESS the biller has edited them directly
    // on the claim (biller_edited_at set). Biller edits are closer to
    // the actual submission; a subsequent note re-sign shouldn't
    // revert them. Fix for Amy Turner case 2026-10-07: Andrea changed
    // Z77.21 to a different code, saved, submitted — but Stedi got
    // the original because the note got re-touched between save and
    // submit and this UPDATE wiped her edit.
    try { await sql`ALTER TABLE claims ADD COLUMN IF NOT EXISTS biller_edited_at timestamptz` } catch {}
    const priorPayerId = existing.payer_id
    const billerLocked = !!existing.biller_edited_at
    ;[claim] = await sql`
      UPDATE claims SET
        cpt_codes    = CASE WHEN ${billerLocked}::boolean THEN cpt_codes ELSE ${JSON.stringify(cptCodes)}::jsonb END,
        diagnoses    = CASE WHEN ${billerLocked}::boolean THEN diagnoses ELSE ${JSON.stringify(note.diagnoses ?? [])}::jsonb END,
        total_charge = CASE WHEN ${billerLocked}::boolean THEN total_charge ELSE ${total} END,
        place_of_service = COALESCE(${pos}, place_of_service),
        payer_name   = COALESCE(${payerName}, payer_name),
        payer_id     = COALESCE(${payerId}, payer_id),
        updated_at   = now()
      WHERE id = ${existing.id}
      RETURNING *`

    // Payer flipped from Self Pay → insurance on re-sign (provider added
    // an insurance-billable CPT after a self-pay-only first sign). The
    // self-pay fast-path auto-generated AND auto-sent a patient statement
    // for the full self-pay amount on the first sign. That statement is
    // now stale and the family would be double-billed if they pay it AND
    // we bill insurance. Void it. Sara caught this 2026-10-07 on
    // Mackenzie Twigg (Karen Hinkle RN IV fluids note).
    if (priorPayerId === 'PP' && claim?.payer_id && claim.payer_id !== 'PP') {
      try {
        const voided = await sql`
          UPDATE patient_statements SET
            status      = 'written_off',
            voided_at   = NOW(),
            void_reason = 'Superseded: claim re-signed with insurance-billable CPTs; original self-pay statement no longer applicable. Family should ignore any email with this balance.'
          WHERE claim_id = ${claim.id}::uuid
            AND status NOT IN ('paid', 'written_off')
          RETURNING id`
        if (voided.length > 0) {
          try {
            await sql`
              CREATE TABLE IF NOT EXISTS claim_activity_log (
                id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
                claim_id        uuid NOT NULL,
                created_at      timestamptz NOT NULL DEFAULT NOW(),
                created_by      uuid,
                created_by_name text,
                kind            text NOT NULL DEFAULT 'note',
                body            text NOT NULL
              )`
            await sql`
              INSERT INTO claim_activity_log (claim_id, created_by, created_by_name, kind, body)
              VALUES (
                ${claim.id}::uuid, NULL, 'System (auto)', 'self_pay_statement_voided',
                ${'Voided ' + voided.length + ' stale self-pay statement(s) because claim payer flipped from PP to ' + (claim.payer_id ?? '?') + ' on re-sign.'}
              )`
          } catch { /* non-fatal */ }
        }
      } catch (voidErr: any) {
        console.error('[encounter-notes sign] void stale self-pay statements failed (non-fatal):', voidErr?.message)
      }
    }
  } else {
    ;[claim] = await sql`
      INSERT INTO claims (
        practice_id, encounter_note_id, appointment_id, child_id, provider_id,
        payer_name, payer_id,
        subscriber_name, subscriber_dob, subscriber_gender, member_id, group_number, insurance_dependent_code,
        service_date, place_of_service,
        diagnoses, cpt_codes, total_charge,
        rendering_provider_name, rendering_provider_npi, rendering_provider_taxonomy,
        patient_first_name, patient_last_name, patient_dob, patient_gender,
        patient_address, patient_city, patient_state, patient_zip
      ) VALUES (
        ${practiceId}::uuid, ${encounterNoteId}::uuid,
        ${note.appointment_id ?? null}::uuid, ${note.child_id ?? null}::uuid, ${note.provider_id ?? null}::uuid,
        ${payerName}, ${payerId},
        ${child?.insurance_subscriber_name ?? null}, ${child?.insurance_subscriber_dob ?? null},
        ${child?.insurance_subscriber_gender ?? null}, ${child?.insurance_member_id ?? null},
        ${child?.insurance_group_number ?? null},
        ${child?.insurance_dependent_code ?? null},
        ${appt?.scheduled_date ?? null}, ${pos},
        ${JSON.stringify(note.diagnoses ?? [])}::jsonb, ${JSON.stringify(cptCodes)}::jsonb, ${total},
        ${renderingProvider?.name ?? null}, ${renderingProvider?.npi ?? null}, ${renderingProvider?.taxonomy_code ?? null},
        ${child?.first_name ?? null}, ${child?.last_name ?? null},
        ${child?.date_of_birth ?? null}, ${child?.gender ?? null},
        ${resolvedAddr.line1}, ${resolvedAddr.city}, ${resolvedAddr.state}, ${resolvedAddr.zip}
      )
      RETURNING *`
  }

  // Write audit trail for CVTech auto-attach. Non-fatal if log fails —
  // the fee itself is already on the claim; biller just doesn't see the
  // explanatory activity entry.
  if (claim?.id && cvtechAttached) {
    const body = 'Auto-attached CVTech ($50 in-home diagnostic tech convenience fee) — paired with CMA visit for this patient.'
    try {
      await sql`
        CREATE TABLE IF NOT EXISTS claim_activity_log (
          id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          claim_id        uuid NOT NULL,
          created_at      timestamptz NOT NULL DEFAULT NOW(),
          created_by      uuid,
          created_by_name text,
          kind            text NOT NULL DEFAULT 'note',
          body            text NOT NULL
        )`
      await sql`
        INSERT INTO claim_activity_log (claim_id, created_by, created_by_name, kind, body)
        VALUES (${claim.id}::uuid, NULL, 'System (auto)', 'cvtech_auto_attach', ${body})
      `
    } catch (logErr: any) {
      console.error('cvtech auto-attach activity log failed (non-fatal):', logErr?.message)
    }
  }

  // Write audit trail for any Aetna POC swap that fired. Non-fatal if
  // the log insert fails — the swap itself is already persisted on the
  // claim's cpt_codes. Pam/Andrea will still see the swapped line in
  // the claim view; they just won't see the explanatory activity entry.
  if (claim?.id && aetnaSwapRecords.length > 0) {
    const swapSummary = aetnaSwapRecords.map(s => `${s.from} → ${s.to}`).join(', ')
    const body = `Auto-swapped POC test code(s) to self-pay (${swapSummary}) — Aetna does not cover in-home POC testing. Provider's note is unchanged; this swap only affects what gets billed. Patient will owe the self-pay amount.`
    try {
      await sql`
        CREATE TABLE IF NOT EXISTS claim_activity_log (
          id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          claim_id        uuid NOT NULL,
          created_at      timestamptz NOT NULL DEFAULT NOW(),
          created_by      uuid,
          created_by_name text,
          kind            text NOT NULL DEFAULT 'note',
          body            text NOT NULL
        )`
      await sql`
        INSERT INTO claim_activity_log (claim_id, created_by, created_by_name, kind, body)
        VALUES (${claim.id}::uuid, NULL, 'System (auto)', 'aetna_poc_swap', ${body})
      `
    } catch (logErr: any) {
      console.error('aetna poc swap activity log failed (non-fatal):', logErr?.message)
    }
  }

  // ─── Self-pay fast-path ────────────────────────────────────────────────
  // Self-pay claims never go to Stedi (per project_self_pay_not_billed_via_stedi).
  // No biller review step, no auto-ready. Instead: generate a draft
  // patient statement directly from the claim at sign time. Patient
  // owes the full total_charge; Pam only has to review + send.
  //
  // Idempotent: skips if a statement already exists for this claim.
  // Non-fatal: a failed statement insert is logged but doesn't block
  // the sign flow. Sara 2026-10-05.
  const isSelfPayClaim = !!(claim?.id && (claim.payer_id === 'PP' || /self[\s-]*pay/i.test(String(claim.payer_name ?? ''))))
  if (isSelfPayClaim) {
    try {
      const [existingStmt] = await sql`SELECT id FROM patient_statements WHERE claim_id = ${claim.id}::uuid LIMIT 1`
      if (!existingStmt) {
        const [stmtClaim] = await sql`
          SELECT
            cl.id, cl.practice_id, cl.service_date, cl.cpt_codes, cl.total_charge,
            cl.patient_first_name, cl.patient_last_name, cl.patient_dob,
            ch.parent_email, ch.parent_phone,
            fp.email AS family_email, fp.phone AS family_phone
          FROM claims cl
          LEFT JOIN children ch ON ch.id = COALESCE(cl.child_id, (SELECT child_id FROM appointments WHERE id = cl.appointment_id LIMIT 1))
          LEFT JOIN family_profiles fp ON fp.id = ch.family_id
          WHERE cl.id = ${claim.id}::uuid
          LIMIT 1
        `
        if (stmtClaim) {
          const totalCharge = +(parseFloat(String(stmtClaim.total_charge ?? 0)) || 0).toFixed(2)
          const email = stmtClaim.parent_email ?? stmtClaim.family_email ?? null
          const phone = stmtClaim.parent_phone ?? stmtClaim.family_phone ?? null
          const [spRow] = await sql`
            INSERT INTO patient_statements (
              practice_id, claim_id,
              patient_first_name, patient_last_name, patient_dob,
              date_of_service, cpt_codes,
              patient_email, patient_phone,
              amount_billed, insurance_payment, contractual_adjustment,
              patient_copay, patient_deductible, patient_coinsurance, patient_non_covered,
              remaining_balance, prior_balance, total_amount_due, total_amount_due_text,
              status, created_at, updated_at
            ) VALUES (
              ${stmtClaim.practice_id}::uuid, ${stmtClaim.id},
              ${stmtClaim.patient_first_name}, ${stmtClaim.patient_last_name}, ${stmtClaim.patient_dob},
              ${stmtClaim.service_date}, ${JSON.stringify(stmtClaim.cpt_codes ?? [])}::jsonb,
              ${email}, ${phone},
              ${totalCharge}, 0, 0,
              0, 0, 0, ${totalCharge},
              ${totalCharge}, 0, ${totalCharge}, ${String(totalCharge)},
              'draft', NOW(), NOW()
            )
            RETURNING id
          `
          try {
            await sql`
              CREATE TABLE IF NOT EXISTS claim_activity_log (
                id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
                claim_id        uuid NOT NULL,
                created_at      timestamptz NOT NULL DEFAULT NOW(),
                created_by      uuid,
                created_by_name text,
                kind            text NOT NULL DEFAULT 'note',
                body            text NOT NULL
              )`
            await sql`
              INSERT INTO claim_activity_log (claim_id, created_by, created_by_name, kind, body)
              VALUES (
                ${claim.id}::uuid, NULL, 'System (auto)', 'self_pay_statement',
                'Auto-generated draft patient statement at claim-gen time (self-pay — no insurance to bill).'
              )
            `
          } catch { /* log is non-fatal */ }

          // Auto-send the self-pay statement — same auto-send gate as
          // insurance ERAs, just a simpler one (no insurance_payment /
          // denial_codes to check — self-pay never gets an ERA). Full
          // charge is the patient's responsibility, Pam doesn't need to
          // review. Policy change 2026-10-06 after Sara talked to Pam.
          const spStmtId = (spRow as any)?.id as string | undefined
          if (spStmtId && totalCharge > 0) {
            const autoSendEnabled = String(process.env.AUTO_SEND_CLEAN_STATEMENTS ?? 'true').toLowerCase() !== 'false'
            if (autoSendEnabled) {
              const svcToken = process.env.INTERNAL_SERVICE_TOKEN || ''
              const base = process.env.PORTAL_URL || 'https://phc-team.com'
              if (svcToken) {
                await fetch(`${base}/api/patient-statements/${spStmtId}/send`, {
                  method: 'POST',
                  headers: {
                    'X-Internal-Service-Token': svcToken,
                    'X-Practice-Id': String(stmtClaim.practice_id),
                  },
                }).catch(e => { console.error('[self-pay auto-send] fetch failed:', e?.message) })
              }
            }
          }
        }
      }
    } catch (e: any) {
      console.error('self-pay statement auto-gen failed (non-fatal):', e?.message)
    }
    return { claim }
  }

  // ─── Auto-ready for biller (unconditional for insurance claims) ───────
  // Previously gated by a full clean-check (dx + CPT + NPI + DOB + no $0
  // + filing window + fresh eligibility + no duplicate). After Sara's
  // 2026-10-06 redesign:
  //   - Pre-sign gate in EncounterNoteModal catches provider-fixable
  //     issues (dx/CPT/DOB/zero-line) at the moment of signing, so most
  //     "dirty" cases never reach claim-gen.
  //   - Everything that DOES reach claim-gen goes to Ready for Biller;
  //     Andrea reviews before clicking Submit, catches anything the
  //     pre-sign gate missed (bad NPI, stale eligibility, duplicate).
  //   - Self-pay is already handled above by the fast-path (statement
  //     draft, early return) — won't reach this block.
  //
  // Kill switch: AUTO_READY_CLEAN_CLAIMS=false in Vercel env disables.
  // Idempotent on re-sign: UPDATE is gated on ready_for_biller_at IS NULL.
  //
  // Sara 2026-10-06.
  const AUTO_READY_ENABLED = String(process.env.AUTO_READY_CLEAN_CLAIMS ?? 'true').toLowerCase() !== 'false'
  if (AUTO_READY_ENABLED && claim?.id && !claim.ready_for_biller_at) {
    {
      try {
        await sql`
          UPDATE claims SET
            ready_for_biller_at = NOW(),
            ready_for_biller_by = ${'System (auto)'},
            updated_at = NOW()
          WHERE id = ${claim.id}::uuid
            AND practice_id = ${practiceId}::uuid
            AND ready_for_biller_at IS NULL
        `
        await sql`
          CREATE TABLE IF NOT EXISTS claim_activity_log (
            id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            claim_id        uuid NOT NULL,
            created_at      timestamptz NOT NULL DEFAULT NOW(),
            created_by      uuid,
            created_by_name text,
            kind            text NOT NULL DEFAULT 'note',
            body            text NOT NULL
          )`
        await sql`
          INSERT INTO claim_activity_log (claim_id, created_by, created_by_name, kind, body)
          VALUES (
            ${claim.id}::uuid, NULL, 'System (auto)', 'auto_ready',
            'Auto-marked ready for biller — scrubber passed with no errors or warnings.'
          )
        `
      } catch (e: any) {
        console.error('auto-ready failed (non-fatal):', e?.message)
      }
    }
  }

  // ─── Convenience fee audit row (automation cutover 2026-10-07) ──────
  // For appointments with scheduled_date >= 2026-10-07, log a row into
  // convenience_fee_charges with status='pending' so Pam can see it on
  // /admin/convenience-fees. Pre-cutover visits continue through her
  // existing manual Square workflow and don't produce rows here. Fully
  // wrapped in try/catch — never blocks note sign. Idempotent: skips if
  // a row already exists for this claim. Sara 2026-10-06.
  if (claim?.id && appt?.scheduled_date) {
    try {
      const dosStr = toYmd(appt.scheduled_date)
      const inAutomationWindow = dosStr >= CV_CUTOVER_DATE
      // Skip pure-virtual visits (no in-home component → no CV).
      const vt = String(appt.visit_type ?? '')
      const isVirtualOnly = /^(video telemedicine|text visit)$/i.test(vt)
        || vt === 'Video telemedicine screening for IV fluids' // NP side of IV pair — CV lives on RN side
      // Only one row per claim.
      const [existing] = await sql`SELECT id FROM convenience_fee_charges WHERE claim_id = ${claim.id}::uuid LIMIT 1`
      if (inAutomationWindow && !isVirtualOnly && !existing) {
        // Flat-fee paths skip the Google Maps call entirely.
        const flatIv  = cvIsIvFluidsPair(vt)
        const flatCma = cvIsCmaTelePair(vt)
        const isHoliday = cvIsMajorHoliday(dosStr)

        // Insert the row FIRST with placeholder amount so nothing between
        // here and the final charge can leave the claim without a row.
        // Google Maps / Square / serverless-timeout can all swallow the
        // whole block mid-execution; writing the row first means at worst
        // the row lingers 'pending' with miles=0 and the cron
        // (drain-pending-cv-charges) + the "orphan CV scan" catch it.
        // Fallback amount = CV1 ($50) because that's the minimum CV fee —
        // better to under-charge and let the biller correct than to never
        // charge at all. Sara 2026-10-08 (Ramsay Schrum case).
        const patientNameSnap  = [claim.patient_first_name, claim.patient_last_name].filter(Boolean).join(' ') || null
        const providerNameSnap = (provider as any)?.name ?? null
        const [cvRowInit] = await sql`
          INSERT INTO convenience_fee_charges (
            practice_id, appointment_id, claim_id,
            patient_name, provider_name, service_date,
            cv_code, amount_cents, status
          ) VALUES (
            ${practiceId}::uuid, ${appt.id}::uuid, ${claim.id}::uuid,
            ${patientNameSnap}, ${providerNameSnap}, ${dosStr}::date,
            'CV1', 5000, 'pending'
          )
          RETURNING id
        `
        const cvRowId = (cvRowInit as any)?.id as string | undefined

        // Now compute the real miles + fee. If any of this throws, the
        // pending row still exists at $50/CV1 and the cron handles it.
        let miles = 0
        if (!flatIv && !flatCma && !isHoliday) {
          let originAddress: string | null = null
          try {
            const [priorAppt] = await sql`
              SELECT notes FROM appointments
              WHERE provider_id = ${appt.provider_id}::uuid
                AND practice_id = ${practiceId}::uuid
                AND scheduled_date = ${dosStr}::date
                AND scheduled_time < ${appt.scheduled_time}
                AND status != 'cancelled'
              ORDER BY scheduled_time DESC
              LIMIT 1`
            const priorNotes = String((priorAppt as any)?.notes ?? '')
            const priorAddr = priorNotes.split('|').find(p => p.trim().startsWith('ADDR:'))?.replace(/^.*?ADDR:/, '').trim()
            if (priorAddr) originAddress = priorAddr
            if (!originAddress) {
              const [prow] = await sql`SELECT home_address FROM providers WHERE id = ${appt.provider_id}::uuid LIMIT 1`
              originAddress = (prow as any)?.home_address || null
            }
          } catch { /* non-fatal */ }
          const destAddress = [resolvedAddr.line1, resolvedAddr.city, resolvedAddr.state, resolvedAddr.zip].filter(Boolean).join(', ')
          if (originAddress && destAddress) {
            const m = await cvGetDrivingMiles(originAddress, destAddress)
            if (m !== null) miles = m
          }
        }
        const time24 = String(appt.scheduled_time ?? '12:00').slice(0, 5)
        const stateCode = (resolvedAddr.state as string) ?? null
        const distanceBased = cvCalculateFee(miles, dosStr, time24, vt, stateCode)

        // Provider's choice wins. If the provider put a CV / VACV line
        // on the claim (manually or via the built-in picker), that is the
        // authoritative fee — do NOT recompute from miles. The miles
        // calc is only a fallback for the pre-populate case where the
        // provider hasn't yet added a CV line.
        //
        // Sara 2026-10-10: an earlier version of this block always used
        // the distance-based result, which overcharged Roy, Connor,
        // Gibson, and Nash when their providers coded a lower-level CV
        // than my distance calc suggested. Never again.
        const claimCpts: any[] = Array.isArray((claim as any)?.cpt_codes) ? (claim as any).cpt_codes : []
        const providerCvLine = claimCpts.find((c: any) =>
          c?.category === 'Non-Covered Services'
          && (String(c?.code ?? '').startsWith('CV') || String(c?.code ?? '').startsWith('VACV'))
        )
        let code: string
        let amountCents: number
        if (providerCvLine) {
          code = String(providerCvLine.code)
          amountCents = Math.round((parseFloat(String(providerCvLine.charge_amount ?? '0')) || 0) * 100)
        } else {
          code = distanceBased.code
          amountCents = Math.round(distanceBased.fee * 100)
        }

        // Upgrade the row with the real amount + code if they differ
        // from the placeholder. Idempotent: skips if the row is already
        // charged (shouldn't be at this point, but belt-and-suspenders).
        if (cvRowId && (amountCents !== 5000 || code !== 'CV1')) {
          await sql`
            UPDATE convenience_fee_charges
            SET cv_code = ${code},
                amount_cents = ${amountCents},
                updated_at = NOW()
            WHERE id = ${cvRowId}::uuid AND status = 'pending'`
        }

        // ─── Phase 2: auto-charge pipeline ──────────────────────────────
        // Try direct Square charge against the family's card on file.
        // If no card / charge fails → create a Square Payment Link and
        // send it via email + SMS. Any failure keeps the row 'pending'
        // (plus a note) so Pam picks it up manually. Fully wrapped —
        // never blocks the sign flow. Sara 2026-10-06.
        if (CV_AUTO_CHARGE_ENABLED && cvRowId && amountCents > 0) {
          const safetyCapExceeded = amountCents > CV_MAX_AUTO_CHARGE_CENTS
          const firstName = String(claim.patient_first_name ?? '').trim() || 'your child'
          const dosDisplay = (() => { try { const d = new Date(dosStr); return `${d.getMonth()+1}/${d.getDate()}/${d.getFullYear()}` } catch { return dosStr } })()
          const practiceName = process.env.PRACTICE_NAME || 'Pediatric House Calls'
          // Square's /v2/payments.note has a 45-char cap. Any longer and
          // the whole charge fails with "Field must not be greater than 45
          // length" (Mackenzie 2026-10-07, Ramsay 2026-10-08). Keep it
          // short + patient-identifying.
          const chargeNote = `In-home CV fee ${firstName} ${dosDisplay}`.slice(0, 45)

          if (safetyCapExceeded) {
            await sql`
              UPDATE convenience_fee_charges
              SET failure_reason = ${`Auto-charge blocked: amount $${(amountCents/100).toFixed(2)} exceeds safety cap of $${(CV_MAX_AUTO_CHARGE_CENTS/100).toFixed(0)}. Review and charge manually.`},
                  updated_at = NOW()
              WHERE id = ${cvRowId}::uuid`
          } else {
            // Lookup family contact + Square card
            let family: any = null
            try {
              if (child?.family_id) {
                const [fam] = await sql`
                  SELECT square_customer_id, square_card_id, email, phone, display_name
                  FROM family_profiles WHERE id = ${child.family_id}::uuid LIMIT 1`
                family = fam ?? null
              }
            } catch { /* non-fatal */ }

            let chargedOk = false
            // Attempt direct charge if card is on file
            if (family?.square_card_id && family?.square_customer_id && CV_SQUARE_ACCESS_TOKEN) {
              try {
                const payResp = await cvSquarePost('/v2/payments', {
                  // Square's idempotency_key maxes at 45 chars. `cv_charge_` +
                  // UUID = 46 → rejected. Strip hyphens to fit in 34.
                  // Sara 2026-10-08 (actual bug behind Mackenzie/Ramsay).
                  idempotency_key: `cv${(cvRowId ?? '').replace(/-/g, '')}`,
                  amount_money: { amount: amountCents, currency: 'USD' },
                  source_id: family.square_card_id,
                  customer_id: family.square_customer_id,
                  buyer_email_address: family.email ?? undefined,
                  note: chargeNote,
                })
                const paymentId = payResp?.payment?.id
                if (paymentId) {
                  await sql`
                    UPDATE convenience_fee_charges
                    SET status = 'auto_charged',
                        charged_at = NOW(),
                        square_payment_id = ${paymentId},
                        updated_at = NOW()
                    WHERE id = ${cvRowId}::uuid`
                  chargedOk = true
                }
              } catch (chargeErr: any) {
                console.error('[CV auto-charge] direct charge failed:', chargeErr?.message)
                await sql`
                  UPDATE convenience_fee_charges
                  SET failure_reason = ${String(chargeErr?.message ?? 'direct charge failed').slice(0, 500)},
                      failed_at = NOW(),
                      updated_at = NOW()
                  WHERE id = ${cvRowId}::uuid`
                // fall through to payment link
              }
            }

            // Fallback: payment link
            if (!chargedOk && CV_SQUARE_ACCESS_TOKEN && CV_SQUARE_LOCATION_ID) {
              try {
                const linkResp = await cvSquarePost('/v2/online-checkout/payment-links', {
                  idempotency_key: `cv_link_${cvRowId}`,
                  quick_pay: {
                    name: `${practiceName} — convenience fee for ${firstName} on ${dosDisplay}`,
                    price_money: { amount: amountCents, currency: 'USD' },
                    location_id: CV_SQUARE_LOCATION_ID,
                  },
                  pre_populated_data: {
                    buyer_email: family?.email ?? undefined,
                    buyer_phone_number: family?.phone ?? undefined,
                  },
                  checkout_options: {
                    allow_tipping: false,
                  },
                  description: 'Thank you so much for allowing us to care for your child!',
                })
                const link = linkResp?.payment_link
                if (link?.url) {
                  await sql`
                    UPDATE convenience_fee_charges
                    SET status = 'link_sent',
                        link_sent_at = NOW(),
                        square_payment_link_id  = ${link.id},
                        square_payment_link_url = ${link.url},
                        square_order_id         = ${link.order_id ?? null},
                        failed_at = NULL,
                        updated_at = NOW()
                    WHERE id = ${cvRowId}::uuid`
                  // Send the link to the parent
                  const amountDisplay = `$${(amountCents/100).toFixed(2)}`
                  // Parent first name: prefer display_name's first token
                  // ("The Rodgers" → "Rodgers family" fallback), else generic.
                  const dn = String(family?.display_name ?? '').trim()
                  const parentFirst = dn && !/^the\b/i.test(dn) ? dn.split(/\s+/)[0] : ''
                  const greeting = parentFirst ? `Hi ${parentFirst},` : 'Hi there,'
                  const smsBody = `${greeting} this is ${practiceName}. Your in-home visit convenience fee for ${firstName}'s visit on ${dosDisplay} is ${amountDisplay}. Pay securely here: ${link.url} Reply with any questions. Thank you so much for allowing us to care for your child!`
                  const emailHtml = `<p style="font-family:system-ui,sans-serif;font-size:14px;color:#1A1A2E;line-height:1.6">${greeting}<br><br>This is ${practiceName}. Your in-home visit convenience fee for ${firstName}'s visit on ${dosDisplay} is <strong>${amountDisplay}</strong>.</p><p style="margin:20px 0"><a href="${link.url}" style="display:inline-block;background:#7F77DD;color:#fff;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:600">Pay securely</a></p><p style="font-family:system-ui,sans-serif;font-size:13px;color:#555">Or paste this link into your browser: ${link.url}</p><p style="font-family:system-ui,sans-serif;font-size:14px;color:#1A1A2E;margin-top:28px">Reply with any questions.<br>Thank you so much for allowing us to care for your child!</p>`
                  if (family?.email) await cvSendEmail(family.email, `${practiceName} — Convenience fee for ${firstName}'s visit on ${dosDisplay}`, emailHtml)
                  if (family?.phone) await cvSendSms(family.phone, smsBody)
                } else {
                  await sql`
                    UPDATE convenience_fee_charges
                    SET failure_reason = ${'Payment link response missing URL'},
                        failed_at = NOW(),
                        updated_at = NOW()
                    WHERE id = ${cvRowId}::uuid`
                }
              } catch (linkErr: any) {
                console.error('[CV auto-charge] payment link failed:', linkErr?.message)
                await sql`
                  UPDATE convenience_fee_charges
                  SET failure_reason = ${String(linkErr?.message ?? 'payment link creation failed').slice(0, 500)},
                      failed_at = NOW(),
                      updated_at = NOW()
                  WHERE id = ${cvRowId}::uuid`
              }
            }
          }
        }
      }
    } catch (e: any) {
      console.error('CV charge row insert failed (non-fatal):', e?.message)
    }
  }

  return { claim }
}

const PRACTICE_NAME = process.env.PRACTICE_NAME || 'Pediatric House Calls PLLC'
const PRACTICE_PHONE = process.env.PRACTICE_PHONE || ''

function toE164(fax: string): string {
  const digits = fax.replace(/\D/g, '')
  return digits.length === 10 ? `+1${digits}` : `+${digits}`
}

function buildNoteHtml(note: any, child: any, pcp: any, provider: any, appt: any): string {
  const fmtDate = (d: string | null | undefined) => {
    if (!d) return '—'
    try { return new Date(d).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) }
    catch { return d }
  }
  const diagnoses: { code: string; name: string }[] = Array.isArray(note.diagnoses) ? note.diagnoses : []
  const childName = [child?.first_name, child?.last_name].filter(Boolean).join(' ') || 'Unknown'

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<style>
  body { font-family: Arial, sans-serif; font-size: 13px; color: #222; margin: 40px; line-height: 1.5; }
  .header { border-bottom: 2px solid #333; padding-bottom: 12px; margin-bottom: 20px; }
  .practice { font-size: 18px; font-weight: bold; }
  .meta { display: grid; grid-template-columns: 1fr 1fr; gap: 4px 24px; margin-bottom: 20px; background: #f5f5f5; padding: 12px; border-radius: 4px; }
  .meta-label { font-weight: bold; font-size: 11px; text-transform: uppercase; color: #555; }
  h3 { font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em; color: #555; border-bottom: 1px solid #ddd; padding-bottom: 4px; margin: 16px 0 6px; }
  .section { margin-bottom: 12px; white-space: pre-wrap; }
  .dx { margin: 3px 0; }
  .footer { margin-top: 30px; border-top: 1px solid #ccc; padding-top: 12px; font-size: 11px; color: #777; }
</style>
</head><body>
<div class="header">
  <div class="practice">${PRACTICE_NAME}</div>
  <div style="font-size:12px;color:#555;margin-top:4px;">CONFIDENTIAL MEDICAL RECORD — FACSIMILE TRANSMISSION</div>
  ${PRACTICE_PHONE ? `<div style="font-size:12px;color:#555;">Tel: ${PRACTICE_PHONE}</div>` : ''}
</div>

<div class="meta">
  <div><div class="meta-label">Patient</div>${childName}</div>
  <div><div class="meta-label">Date of Birth</div>${fmtDate(child?.date_of_birth)}</div>
  <div><div class="meta-label">Date of Service</div>${fmtDate(appt?.scheduled_date)}</div>
  <div><div class="meta-label">Visit Type</div>${appt?.visit_type || '—'}</div>
  <div><div class="meta-label">Rendering Provider</div>${provider?.name || '—'}</div>
  <div><div class="meta-label">Signed</div>${fmtDate(note.signed_at)}</div>
</div>

${note.chief_complaint ? `<h3>Chief Complaint</h3><div class="section">${note.chief_complaint}</div>` : ''}
${note.subjective     ? `<h3>Subjective (History)</h3><div class="section">${note.subjective}</div>` : ''}
${note.objective      ? `<h3>Objective (Exam)</h3><div class="section">${note.objective}</div>` : ''}
${(() => {
  const l = note.labs as any
  if (!l || typeof l !== 'object') return ''
  const lines: string[] = []
  if (l.rapid_strep?.checked)         lines.push(`Rapid Strep: ${l.rapid_strep.result || '—'}`)
  if (l.rapid_flu_covid?.checked)     lines.push(`Rapid Flu/COVID: ${l.rapid_flu_covid.result || '—'}`)
  if (l.rapid_flu_rsv_covid?.checked) lines.push(`Rapid Flu/RSV/COVID: ${l.rapid_flu_rsv_covid.result || '—'}`)
  if (l.urine_dipstick?.checked) {
    const u = l.urine_dipstick
    const parts = [
      u.ph && `pH ${u.ph}`,
      u.leukocyte_esterase && `Leukocyte esterase ${u.leukocyte_esterase}`,
      u.nitrite && `Nitrite ${u.nitrite}`,
      u.ketones && `Ketones ${u.ketones}`,
      u.specific_gravity && `Specific gravity ${u.specific_gravity}`,
      u.blood && `Blood ${u.blood}`,
      u.glucose && `Glucose ${u.glucose}`,
    ].filter(Boolean).join(', ') || '—'
    lines.push(`Urine dipstick: ${parts}`)
  }
  if (l.fingerstick_glucose?.checked) lines.push(`Fingerstick glucose: ${l.fingerstick_glucose.value || '—'} mg/dL`)
  return lines.length ? `<h3>Labs</h3><div class="section">${lines.join('<br>')}</div>` : ''
})()}
${note.assessment     ? `<h3>Assessment</h3><div class="section">${note.assessment}</div>` : ''}
${note.plan           ? `<h3>Plan</h3><div class="section">${note.plan}</div>` : ''}

${diagnoses.length ? `<h3>Diagnoses</h3>${diagnoses.map(d => `<div class="dx"><strong>${d.code}</strong> — ${d.name}</div>`).join('')}` : ''}

<div class="footer">
  This fax is intended only for ${pcp?.name || 'the recipient practice'}. It may contain confidential health information protected by HIPAA.
  If received in error, please destroy and notify ${PRACTICE_NAME} at ${PRACTICE_PHONE || 'our office'}.
</div>
</body></html>`
}

async function faxNoteToPcp(note: any, practiceId: string, sql: any): Promise<void> {
  const projectId  = process.env.SINCH_PROJECT_ID
  const keyId      = process.env.SINCH_KEY_ID
  const keySecret  = process.env.SINCH_KEY_SECRET
  const fromNumber = process.env.SINCH_FAX_NUMBER

  if (!projectId || !keyId || !keySecret || !fromNumber) {
    console.log('[fax] Sinch credentials not configured — skipping')
    return
  }

  if (!note.child_id) return

  // Load child → PCP fax number
  const [child] = await sql`
    SELECT c.*, p.id AS pcp_id_val, p.name AS pcp_name, p.fax_number AS pcp_fax
    FROM children c
    LEFT JOIN pcps p ON p.id = c.pcp_id
    WHERE c.id = ${note.child_id}::uuid AND c.practice_id = ${practiceId}::uuid
    LIMIT 1
  `
  if (!child?.pcp_fax) {
    console.log(`[fax] No PCP fax on file for child ${note.child_id} — skipping`)
    return
  }

  const [provider] = note.provider_id
    ? await sql`SELECT name FROM providers WHERE id = ${note.provider_id}::uuid LIMIT 1`
    : [null]

  const [appt] = note.appointment_id
    ? await sql`SELECT scheduled_date, visit_type FROM appointments WHERE id = ${note.appointment_id}::uuid LIMIT 1`
    : [null]

  const html = buildNoteHtml(note, child, { name: child.pcp_name, fax_number: child.pcp_fax }, provider, appt)

  const toNum = toE164(child.pcp_fax)
  const fromNum = toE164(fromNumber)
  console.log(`[fax] Attempting: from=${fromNum} to=${toNum} pcp="${child.pcp_name}"`)

  const form = new FormData()
  form.append('to', toNum)
  form.append('from', fromNum)
  form.append('file', new Blob([html], { type: 'text/html' }), 'note.html')

  const sinchRes = await fetch(
    `https://fax.api.sinch.com/v3/projects/${projectId}/faxes`,
    {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${keyId}:${keySecret}`).toString('base64'),
      },
      body: form,
    }
  )

  const rawText = await sinchRes.text().catch(() => '')
  let result: any = {}
  try { result = JSON.parse(rawText) } catch {}

  if (sinchRes.ok) {
    await sql`
      UPDATE encounter_notes SET pcp_faxed_at = now(), pcp_fax_id = ${result.id ?? null}, pcp_faxed_to_name = ${child.pcp_name ?? null}
      WHERE id = ${note.id}::uuid
    `
    console.log(`[fax] Sent note ${note.id} to ${child.pcp_name} (${child.pcp_fax}) — Sinch fax id: ${result.id}`)
  } else {
    console.error(`[fax] Sinch error ${sinchRes.status}:`, rawText)
  }
}

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

export default async function handler(req: VercelRequest, res: VercelResponse) {
  let sub: string
  try {
    sub = await verifyToken(req.headers.authorization)
  } catch {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const sql = neon(process.env.DATABASE_URL!)
  const { id } = req.query as Record<string, string>
  if (!id) return res.status(400).json({ error: 'id required' })

  const providerRows = await sql`SELECT practice_id, name, role FROM providers WHERE cognito_sub = ${sub} LIMIT 1`
  if (!providerRows.length) return res.status(403).json({ error: 'Provider not found' })
  const practiceId    = providerRows[0].practice_id as string
  const currentProviderName = providerRows[0].name as string
  const currentProviderRole = providerRows[0].role as string | null

  // Idempotent column bootstrap for the freeze-at-sign medical
  // history snapshot. Safe on every request.
  try { await sql`ALTER TABLE encounter_notes ADD COLUMN IF NOT EXISTS medical_history_snapshot text` } catch {}
  // Supervising-physician co-signature (2026-09-19). Optional on any
  // NP-signed note. Bootstrap here so every GET/PUT surfaces the
  // columns even before the first co-sign is recorded.
  try { await sql`ALTER TABLE encounter_notes ADD COLUMN IF NOT EXISTS co_signed_by uuid REFERENCES providers(id)` } catch {}
  try { await sql`ALTER TABLE encounter_notes ADD COLUMN IF NOT EXISTS co_signed_by_name text` } catch {}
  try { await sql`ALTER TABLE encounter_notes ADD COLUMN IF NOT EXISTS co_signed_at timestamptz` } catch {}

  if (req.method === 'GET') {
    // ?format=html → return the note as a printable HTML document
    // biller/provider can save-as-PDF via browser print. Same renderer
    // used for the PCP fax path so the layout is proven and consistent.
    if (req.query.format === 'html' || req.query.download === '1') {
      const [note] = await sql`
        SELECT en.*, ch.medical_history AS child_medical_history
        FROM encounter_notes en
        LEFT JOIN children ch ON ch.id = en.child_id
        WHERE en.id = ${id}::uuid AND en.practice_id = ${practiceId}::uuid
        LIMIT 1`
      if (!note) return res.status(404).json({ error: 'Note not found' })

      const [child] = note.child_id
        ? await sql`
            SELECT c.*, p.id AS pcp_id_val, p.name AS pcp_name, p.fax_number AS pcp_fax
            FROM children c
            LEFT JOIN pcps p ON p.id = c.pcp_id
            WHERE c.id = ${note.child_id}::uuid AND c.practice_id = ${practiceId}::uuid
            LIMIT 1`
        : [null]
      const [provider] = note.provider_id
        ? await sql`SELECT name FROM providers WHERE id = ${note.provider_id}::uuid LIMIT 1`
        : [null]
      const [appt] = note.appointment_id
        ? await sql`SELECT scheduled_date, visit_type FROM appointments WHERE id = ${note.appointment_id}::uuid LIMIT 1`
        : [null]

      const html = buildNoteHtml(
        note,
        child ?? {},
        child ? { name: child.pcp_name, fax_number: child.pcp_fax } : null,
        provider,
        appt,
      )

      const dateStr = appt?.scheduled_date
        ? toYmd(appt.scheduled_date)
        : toYmd(note.signed_at ?? note.created_at)
      const patientSlug = [child?.first_name, child?.last_name]
        .filter(Boolean).join('_').toLowerCase().replace(/[^a-z0-9_]/g, '') || 'patient'
      const filename = `encounter_${patientSlug}_${dateStr}.html`

      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      // inline (not attachment) so it opens in a new tab — biller then
      // hits Cmd+P → Save as PDF for payer portal upload.
      res.setHeader('Content-Disposition', `inline; filename="${filename}"`)
      return res.status(200).send(html)
    }

    const rows = await sql`
      SELECT en.*,
             ch.medical_history AS child_medical_history,
             p.role AS provider_role,
             p.name AS provider_name
      FROM encounter_notes en
      LEFT JOIN children ch ON ch.id = en.child_id
      LEFT JOIN providers p ON p.id = en.provider_id
      WHERE en.id = ${id}::uuid AND en.practice_id = ${practiceId}::uuid
      LIMIT 1`
    return res.json(rows[0] ?? null)
  }

  // Admin-only PATCH: update diagnoses and/or cpt_codes on any note (including signed)
  if (req.method === 'PATCH') {
    const [provRow] = await sql`SELECT is_admin FROM providers WHERE cognito_sub = ${sub} AND practice_id = ${practiceId}::uuid LIMIT 1`
    if (!provRow?.is_admin) return res.status(403).json({ error: 'Admin only' })

    const { diagnoses, cpt_codes } = req.body
    const [row] = await sql`
      UPDATE encounter_notes SET
        diagnoses  = COALESCE(${diagnoses  != null ? JSON.stringify(diagnoses)  : null}::jsonb, diagnoses),
        cpt_codes  = COALESCE(${cpt_codes  != null ? JSON.stringify(cpt_codes)  : null}::jsonb, cpt_codes),
        updated_at = now()
      WHERE id = ${id}::uuid AND practice_id = ${practiceId}::uuid
      RETURNING *`
    if (!row) return res.status(404).json({ error: 'Note not found' })

    // Sync any editable linked claim so post-signing edits (e.g., admin
    // adding a TextE / self-pay code that the provider forgot) actually
    // reach the claim. Only sync when the claim is still editable
    // (not submitted / not error). Sara DuMond 2026-09-13 — text visit
    // claim stayed at $0 after TextE was added post-signing.
    if (cpt_codes != null || diagnoses != null) {
      const nextCpts = Array.isArray(row.cpt_codes) ? row.cpt_codes : []
      const nextTotal = nextCpts.reduce((s: number, c: any) => {
        const charge = parseFloat(c.charge_amount) || 0
        const units = parseInt(c.units, 10) || 1
        return s + charge * units
      }, 0)
      await sql`
        UPDATE claims SET
          cpt_codes    = COALESCE(${cpt_codes  != null ? JSON.stringify(nextCpts)   : null}::jsonb, cpt_codes),
          diagnoses    = COALESCE(${diagnoses  != null ? JSON.stringify(row.diagnoses ?? []) : null}::jsonb, diagnoses),
          total_charge = COALESCE(${cpt_codes  != null ? nextTotal                    : null}, total_charge),
          updated_at   = now()
        WHERE encounter_note_id = ${id}::uuid
          AND practice_id = ${practiceId}::uuid
          AND status IN ('pending_review', 'error', 'draft')`
    }
    return res.json(row)
  }

  if (req.method === 'PUT') {
    try {
      const [existing] = await sql`SELECT is_signed FROM encounter_notes WHERE id = ${id}::uuid AND practice_id = ${practiceId}::uuid LIMIT 1`
      if (!existing) return res.status(404).json({ error: 'Note not found' })

      const { note_type, chief_complaint, subjective, objective, assessment, plan, diagnoses, cpt_codes, photos, files, is_signed, child_id, vaccine_administrations, iv_administration, medical_history_snapshot, labs } = req.body

      // Idempotent bootstrap — every PUT after this deploy ensures the
      // labs column exists so a save can never silently drop the field.
      try { await sql`ALTER TABLE encounter_notes ADD COLUMN IF NOT EXISTS labs jsonb` } catch {}
      // Files attachment column added 2026-10-07. Companion to photos.
      try { await sql`ALTER TABLE encounter_notes ADD COLUMN IF NOT EXISTS files jsonb DEFAULT '[]'::jsonb` } catch {}

      const unlocking = is_signed === false
      if (existing.is_signed && !unlocking) return res.status(403).json({ error: 'Cannot edit a signed note' })

      const signing = is_signed === true

      // CMAs may never sign ANY encounter note. On a paired CMA +
      // telemedicine visit, only the MD/NP's tele note is the billable
      // encounter; the CMA's note is support documentation only. Sara
      // 2026-10-05. UI already blocks the Sign button for CMAs — this
      // is server-side belt-and-suspenders so a crafted request can't
      // bypass.
      if (signing && currentProviderRole === 'CMA') {
        return res.status(403).json({ error: "CMAs can't sign encounter notes. Save as draft and the MD/NP on the paired tele visit will sign for billing." })
      }

      // Vaccine encounters may only be signed by Dr. Sara DuMond. She is the
      // supervising physician on all vaccine claims (the RN/CMA who runs the
      // visit can draft the note but not sign it).
      if (signing) {
        const [ap] = await sql`
          SELECT a.visit_type
          FROM encounter_notes en
          LEFT JOIN appointments a ON a.id = en.appointment_id
          WHERE en.id = ${id}::uuid AND en.practice_id = ${practiceId}::uuid
          LIMIT 1
        `
        if (ap?.visit_type === 'In-home vaccine administration' && currentProviderName !== 'Dr. Sara DuMond') {
          return res.status(403).json({ error: 'Vaccine encounter notes can only be signed by Dr. Sara DuMond.' })
        }
      }

      let row: any
      try {
        ;[row] = await sql`
          UPDATE encounter_notes SET
            note_type       = COALESCE(${note_type ?? null}, note_type),
            chief_complaint = COALESCE(${chief_complaint ?? null}, chief_complaint),
            subjective      = COALESCE(${subjective ?? null}, subjective),
            objective       = COALESCE(${objective ?? null}, objective),
            assessment      = COALESCE(${assessment ?? null}, assessment),
            plan            = COALESCE(${plan ?? null}, plan),
            diagnoses       = COALESCE(${diagnoses != null ? JSON.stringify(diagnoses) : null}::jsonb, diagnoses),
            cpt_codes       = COALESCE(${cpt_codes != null ? JSON.stringify(cpt_codes) : null}::jsonb, cpt_codes),
            photos          = COALESCE(${photos != null ? JSON.stringify(photos) : null}::jsonb, photos),
            files           = COALESCE(${files != null ? JSON.stringify(files) : null}::jsonb, files),
            vaccine_administrations = COALESCE(${vaccine_administrations != null ? JSON.stringify(vaccine_administrations) : null}::jsonb, vaccine_administrations),
            iv_administration = COALESCE(${iv_administration != null ? JSON.stringify(iv_administration) : null}::jsonb, iv_administration),
            labs              = COALESCE(${labs != null ? JSON.stringify(labs) : null}::jsonb, labs),
            medical_history_snapshot = COALESCE(${medical_history_snapshot ?? null}, medical_history_snapshot),
            child_id        = COALESCE(${child_id ?? null}::uuid, child_id),
            is_signed       = ${signing},
            signed_at       = CASE WHEN ${signing} THEN now() WHEN ${unlocking} THEN NULL ELSE signed_at END,
            updated_at      = now()
          WHERE id = ${id}::uuid AND practice_id = ${practiceId}::uuid
          RETURNING *`
      } catch (err: any) {
        console.error('[note-put] UPDATE failed:', err?.message)
        return res.status(500).json({ error: 'Note update failed: ' + (err?.message ?? String(err)) })
      }

      if (child_id && row?.appointment_id) {
        try {
          await sql`UPDATE appointments SET child_id = ${child_id}::uuid WHERE id = ${row.appointment_id}::uuid AND practice_id = ${practiceId}::uuid`
        } catch (err: any) {
          console.error('[note-put] appointment child_id update failed:', err?.message)
        }
      }
      if (signing && row?.child_id) {
        try { await faxNoteToPcp(row, practiceId, sql) }
        catch (err: any) { console.error('[fax] PCP fax failed:', err?.message) }
      }
      // On sign, propagate the note's medical_history_snapshot back to
      // the child record so the chart tab stays current. The snapshot
      // on this note is frozen; the child record is the live version.
      if (signing && row?.child_id && medical_history_snapshot !== undefined && medical_history_snapshot !== null) {
        try {
          await sql`
            UPDATE children SET
              medical_history = ${medical_history_snapshot},
              updated_at = NOW()
            WHERE id = ${row.child_id}::uuid AND practice_id = ${practiceId}::uuid`
        } catch (err: any) { console.error('[medical-history sync] failed:', err?.message) }
      }
      if (signing && row?.id) {
        try { await generateClaimForNote(sql, row.id, practiceId) }
        catch (err: any) { console.error('[claim] Auto-generation failed:', err?.message) }
      }

      // _clear support — let providers wipe SOAP sections they mistyped.
      // See feedback_extract_shared_code_first_try.md.
      const requestedClears = (req.body as any)?._clear
      if (Array.isArray(requestedClears) && requestedClears.length > 0) {
        await applyEncounterNoteClears(sql, id, practiceId, requestedClears)
        const [refreshed] = await sql`SELECT * FROM encounter_notes WHERE id = ${id}::uuid AND practice_id = ${practiceId}::uuid`
        return res.json(refreshed)
      }
      return res.json(row)
    } catch (err: any) {
      console.error('[note-put] Unhandled error:', err?.message)
      return res.status(500).json({ error: 'Internal error: ' + (err?.message ?? String(err)) })
    }
  }

  res.status(405).json({ error: 'Method not allowed' })
}
