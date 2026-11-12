import { neon } from '@neondatabase/serverless'

// Shared DoseSpot v2 REST API helpers used by the agent authorize +
// prepare paths. Vercel treats any file whose path has an underscore
// segment as internal (not deployable as an endpoint) but will still
// bundle it when it's imported from a sibling route.
//
// The existing api/dosespot/sso.ts deliberately duplicates its own
// auth + patient-create code rather than importing from here —
// refactoring that working path is out of scope for this commit.

function cleanEnv(val: string | undefined, fallback = '') {
  return (val || fallback).replace(/[^\x20-\x7E]/g, '').trim()
}

export const DS_BASE       = cleanEnv(process.env.DOSESPOT_BASE_URL,        'https://my.staging.dosespot.com')
export const DS_CLINIC_ID  = cleanEnv(process.env.DOSESPOT_CLINIC_ID,       '1038875')
export const DS_CLINIC_KEY = cleanEnv(process.env.DOSESPOT_CLINIC_KEY)
export const DS_SUB_KEY    = cleanEnv(process.env.DOSESPOT_SUBSCRIPTION_KEY)
export const DS_CLINICIAN  = cleanEnv(process.env.DOSESPOT_CLINICIAN_ID,    '3122427')

export function dsHeaders(token: string): Record<string, string> {
  return {
    'Content-Type':              'application/json',
    Authorization:               `Bearer ${token}`,
    'Subscription-Key':          DS_SUB_KEY,
    'Ocp-Apim-Subscription-Key': DS_SUB_KEY,
  }
}

// OAuth2 password grant — identical shape to api/dosespot/sso.ts.
export async function getDoseSpotToken(clinicianId?: string): Promise<string> {
  const user = clinicianId || DS_CLINICIAN
  const body = new URLSearchParams({
    grant_type:    'password',
    client_id:     DS_CLINIC_ID,
    client_secret: DS_CLINIC_KEY,
    username:      user,
    password:      DS_CLINIC_KEY,
    scope:         'api',
  })
  const r = await fetch(`${DS_BASE}/webapi/v2/connect/token`, {
    method: 'POST',
    headers: {
      'Content-Type':              'application/x-www-form-urlencoded',
      'Subscription-Key':          DS_SUB_KEY,
      'Ocp-Apim-Subscription-Key': DS_SUB_KEY,
    },
    body: body.toString(),
  })
  if (!r.ok) {
    const msg = await r.text()
    throw new Error(`DoseSpot token error (${r.status}): ${msg.slice(0, 200)}`)
  }
  const data = await r.json() as { access_token: string }
  return data.access_token
}

// Drug search. Returns the top candidate matching strength + form, or
// null if nothing lines up. The caller should refuse to stage the
// prescription if this returns null so the agent can ask the clinician
// for a different name.
export type DrugCandidate = {
  DispensableDrugId: number
  NDC: string | null
  RXCUI: number | null
  NameWithRouteDoseForm: string
  Strength: string | null
  IsObsolete: boolean
}

function normalizeStrength(s: string): string {
  return s.toLowerCase().replace(/\s+/g, '').replace(/milligram/g, 'mg')
}

function normalizeForm(s: string): string {
  return s.toLowerCase().trim()
    .replace(/\btablets?\b/, 'tab')
    .replace(/\bsuspensions?\b/, 'susp')
    .replace(/\bsolutions?\b/, 'sol')
    .replace(/\bcapsules?\b/, 'cap')
    .replace(/\bcreams?\b/, 'cream')
    .replace(/\bointments?\b/, 'ointment')
}

export async function searchDrugCandidates(name: string, token: string): Promise<DrugCandidate[]> {
  const url = `${DS_BASE}/webapi/v2/api/medications/search?name=${encodeURIComponent(name)}&drugStatus=Active&pageNumber=1`
  const r = await fetch(url, { headers: dsHeaders(token) })
  if (!r.ok) {
    const msg = await r.text().catch(() => '')
    throw new Error(`DoseSpot drug search ${r.status}: ${msg.slice(0, 200)}`)
  }
  const data = await r.json() as { Items?: DrugCandidate[] }
  return Array.isArray(data?.Items) ? data.Items.filter(d => !d.IsObsolete) : []
}

// Pick the best drug match from search results given clinician-stated
// strength + form. If zero results → return null. If a strength+form
// match exists → return it. Otherwise return the top result and mark
// the match as weak so the UI can warn.
export function pickBestDrugMatch(
  candidates: DrugCandidate[],
  strength: string,
  form: string,
): { pick: DrugCandidate; confidence: 'strong' | 'weak' } | null {
  if (candidates.length === 0) return null
  const wantStr = normalizeStrength(strength || '')
  const wantForm = normalizeForm(form || '')

  for (const c of candidates) {
    const name = c.NameWithRouteDoseForm || ''
    const strengthOk = wantStr && (normalizeStrength(c.Strength || '').includes(wantStr) || normalizeStrength(name).includes(wantStr))
    const formOk = wantForm && normalizeForm(name).includes(wantForm)
    if (strengthOk && formOk) return { pick: c, confidence: 'strong' }
  }
  return { pick: candidates[0], confidence: 'weak' }
}

// Dispense units — static-ish list from DoseSpot. Cached per cold
// start to avoid an extra round-trip on every prescription.
export type DispenseUnit = {
  StandardDispenseUnitTypeID: number
  Name: string
  Abbreviation?: string
  Singular?: string
  Plural?: string
  IsActive: boolean
}
let dispenseUnitsCache: DispenseUnit[] | null = null
export async function getDispenseUnits(token: string): Promise<DispenseUnit[]> {
  if (dispenseUnitsCache) return dispenseUnitsCache
  const r = await fetch(`${DS_BASE}/webapi/v2/api/dispenseUnits`, { headers: dsHeaders(token) })
  if (!r.ok) {
    const msg = await r.text().catch(() => '')
    throw new Error(`DoseSpot dispenseUnits ${r.status}: ${msg.slice(0, 200)}`)
  }
  const data = await r.json() as { Items?: DispenseUnit[] }
  const list = Array.isArray(data?.Items) ? data.Items.filter(u => u.IsActive) : []
  dispenseUnitsCache = list
  return list
}

// Parse "150 mL" / "30 tablets" / "1 tube" into { qty, unit }.
export function parseDispenseQty(raw: string): { qty: number; unit: string } | null {
  const m = String(raw ?? '').trim().match(/^([\d.]+)\s*([A-Za-z][A-Za-z]*)\.?$/)
  if (!m) return null
  const qty = Number(m[1])
  if (!Number.isFinite(qty) || qty <= 0) return null
  return { qty, unit: m[2].toLowerCase() }
}

export function matchDispenseUnit(units: DispenseUnit[], unit: string): DispenseUnit | null {
  const u = unit.toLowerCase().replace(/s$/, '')
  for (const du of units) {
    const names = [du.Name, du.Abbreviation, du.Singular, du.Plural]
      .filter(Boolean)
      .map(n => String(n).toLowerCase().replace(/s$/, ''))
    if (names.includes(u)) return du
  }
  // Common aliases DoseSpot's list may not express directly.
  const aliases: Record<string, string[]> = {
    ml:     ['milliliter', 'milliliters', 'ml'],
    tab:    ['tablet', 'tablets'],
    cap:    ['capsule', 'capsules'],
    gm:     ['gram', 'grams', 'g'],
  }
  for (const [key, list] of Object.entries(aliases)) {
    if (list.includes(u)) {
      for (const du of units) {
        if (String(du.Name).toLowerCase() === key) return du
      }
    }
  }
  return null
}

// Create a coded prescription. Returns the new PrescriptionId on success.
export type CreatePrescriptionInput = {
  patientId: number
  pharmacyId: number
  dispensableDrugId: number
  dispenseUnitId: number
  quantity: number
  refills: number
  daysSupply: number
  directions: string
  pharmacyNotes?: string | null
  noSubstitutions?: boolean
}
export async function createCodedPrescription(input: CreatePrescriptionInput, token: string): Promise<{ PrescriptionId: number; raw: any }> {
  const body = {
    DispensableDrugId: input.dispensableDrugId,
    DispenseUnitId:    input.dispenseUnitId,
    Quantity:          input.quantity,
    Refills:           Math.max(0, Math.min(99, Math.trunc(input.refills))),
    Directions:        input.directions.slice(0, 1000),
    Status:            'Active',
    PharmacyId:        input.pharmacyId,
    DaysSupply:        Math.max(0, Math.min(365, Math.trunc(input.daysSupply))),
    PharmacyNotes:     input.pharmacyNotes ? input.pharmacyNotes.slice(0, 210) : undefined,
    NoSubstitutions:   !!input.noSubstitutions,
  }
  const r = await fetch(`${DS_BASE}/webapi/v2/api/patients/${input.patientId}/prescriptions/coded`, {
    method: 'POST',
    headers: dsHeaders(token),
    body: JSON.stringify(body),
  })
  const txt = await r.text()
  if (!r.ok) {
    throw new Error(`DoseSpot create prescription ${r.status}: ${txt.slice(0, 400)}`)
  }
  const data = JSON.parse(txt) as { Id?: number; PrescriptionId?: number; Result?: { ResultCode?: string; ResultDescription?: string } }
  if (data?.Result?.ResultCode && data.Result.ResultCode !== 'OK') {
    throw new Error(`DoseSpot create prescription error: ${data.Result.ResultDescription || data.Result.ResultCode}`)
  }
  const rxId = data.PrescriptionId ?? data.Id
  if (!rxId) throw new Error(`DoseSpot create prescription returned no id: ${txt.slice(0, 200)}`)
  return { PrescriptionId: rxId, raw: data }
}

// Send (transmit) one or more non-EPCS prescriptions to the patient's
// assigned pharmacy. Controlled substances will be rejected here (they
// need /sendEpcs with a PIN + OTP) — we rely on that as a natural
// guardrail in addition to the keyword check at prepare time.
export async function sendPrescriptions(patientId: number, prescriptionIds: number[], token: string): Promise<any> {
  const r = await fetch(`${DS_BASE}/webapi/v2/api/patients/${patientId}/prescriptions/send`, {
    method: 'POST',
    headers: dsHeaders(token),
    body: JSON.stringify({ PrescriptionIds: prescriptionIds }),
  })
  const txt = await r.text()
  if (!r.ok) {
    throw new Error(`DoseSpot send prescription ${r.status}: ${txt.slice(0, 400)}`)
  }
  try { return JSON.parse(txt) } catch { return { raw: txt } }
}

// Controlled-substance keyword block list. Phase 1 refuses any
// prescription whose drug name matches a Schedule II-V DEA entry. The
// list isn't exhaustive — DoseSpot's own /send endpoint will reject
// EPCS drugs anyway — but this catches the obvious cases at the
// prepare stage so the agent can refuse conversationally rather than
// surfacing a cryptic DoseSpot error after Authorize.
const CONTROLLED_KEYWORDS = [
  // Schedule II opioids
  'oxycodone', 'oxycontin', 'percocet', 'hydrocodone', 'vicodin', 'norco',
  'morphine', 'ms contin', 'fentanyl', 'duragesic', 'actiq',
  'hydromorphone', 'dilaudid', 'methadone', 'meperidine', 'demerol',
  'codeine phosphate',
  // Schedule II stimulants
  'adderall', 'amphetamine', 'dextroamphetamine', 'methylphenidate',
  'ritalin', 'concerta', 'vyvanse', 'lisdexamfetamine', 'focalin',
  // Schedule II other
  'ketamine',
  // Schedule III-IV benzos + sedatives
  'alprazolam', 'xanax', 'lorazepam', 'ativan', 'diazepam', 'valium',
  'clonazepam', 'klonopin', 'temazepam', 'restoril', 'midazolam', 'versed',
  'zolpidem', 'ambien', 'eszopiclone', 'lunesta',
  // Schedule V
  'pregabalin', 'lyrica', 'tramadol', 'ultram',
  // Buprenorphine (Schedule III)
  'buprenorphine', 'suboxone', 'subutex',
]
export function isLikelyControlled(drugName: string): boolean {
  const n = String(drugName ?? '').toLowerCase()
  if (!n) return false
  return CONTROLLED_KEYWORDS.some(k => n.includes(k))
}

// Ensure the patient exists in DoseSpot. If children.dosespot_patient_id
// is already set and still valid, returns it. Otherwise creates one
// using the same shape sso.ts uses so the two paths stay in sync for
// any patient Sara's ever launched DoseSpot for.
function genderCode(g: string | null): string {
  if (!g) return 'Unknown'
  const l = g.toLowerCase()
  if (l === 'male'   || l === 'm') return 'Male'
  if (l === 'female' || l === 'f') return 'Female'
  return 'Unknown'
}
function formatDob(dob: any): string {
  const d = new Date(dob)
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${day}T00:00:00.000Z`
}
function cleanPhone(phone: string | null): string | null {
  if (!phone) return null
  const digits = phone.replace(/\D/g, '').slice(-10)
  if (digits.length < 10) return null
  return digits
}
export async function ensureDoseSpotPatient(
  childId: string,
  practiceId: string,
  token: string,
  sql: ReturnType<typeof neon>,
): Promise<number> {
  const [row] = await sql`
    SELECT c.id, c.first_name, c.last_name, c.date_of_birth, c.gender,
           c.dosespot_patient_id,
           c.parent_phone, c.parent_address, c.parent_city, c.parent_state, c.parent_zip,
           fp.phone AS family_phone, fp.address_line1, fp.city, fp.state, fp.zip
    FROM children c
    LEFT JOIN family_profiles fp ON fp.id = c.family_id
    WHERE c.id = ${childId}::uuid AND c.practice_id = ${practiceId}::uuid
    LIMIT 1`
  if (!row) throw new Error('Patient not found in this practice')

  if (row.dosespot_patient_id) {
    // Validate still exists in DoseSpot. If not, fall through and recreate.
    const check = await fetch(`${DS_BASE}/webapi/v2/api/patients/${row.dosespot_patient_id}`, { headers: dsHeaders(token) })
    if (check.ok) return row.dosespot_patient_id as number
  }

  const addressLine = row.address_line1 || row.parent_address
  const city        = row.city          || row.parent_city
  const state       = row.state         || row.parent_state
  const zip         = row.zip           || row.parent_zip
  const phone       = cleanPhone(row.family_phone || row.parent_phone)

  const missing: string[] = []
  if (!addressLine) missing.push('street address')
  if (!city) missing.push('city')
  if (!phone) missing.push('phone number')
  if (missing.length) {
    throw new Error(`Patient is missing required DoseSpot info: ${missing.join(', ')}. Update the chart before prescribing.`)
  }

  const r = await fetch(`${DS_BASE}/webapi/v2/api/patients`, {
    method: 'POST',
    headers: dsHeaders(token),
    body: JSON.stringify({
      FirstName:        row.first_name || '',
      LastName:         row.last_name  || '',
      DateOfBirth:      row.date_of_birth ? formatDob(String(row.date_of_birth)) : '',
      Gender:           genderCode(row.gender),
      Address1:         String(addressLine || '').slice(0, 35),
      City:             String(city || '').slice(0, 35),
      State:            state || '',
      ZipCode:          zip || '',
      PrimaryPhone:     phone,
      PrimaryPhoneType: 'Home',
      Active:           true,
      Weight: 0, WeightMetric: 'lb', Height: 0, HeightMetric: 'inch',
    }),
  })
  const txt = await r.text()
  if (!r.ok) throw new Error(`DoseSpot patient create ${r.status}: ${txt.slice(0, 300)}`)
  const data = JSON.parse(txt) as { Id?: number; Result?: { ResultCode?: string; ResultDescription?: string } }
  if (data?.Result?.ResultCode && data.Result.ResultCode !== 'OK') {
    throw new Error(`DoseSpot patient create: ${data.Result.ResultDescription || data.Result.ResultCode}`)
  }
  const id = data.Id ?? 0
  if (!id) throw new Error('DoseSpot patient create returned no id')

  await sql`UPDATE children SET dosespot_patient_id = ${id} WHERE id = ${childId}::uuid`
  return id
}
