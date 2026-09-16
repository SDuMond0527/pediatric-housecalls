import type { VercelRequest, VercelResponse } from '@vercel/node'
import { neon } from '@neondatabase/serverless'
import { createHash, randomBytes } from 'crypto'
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

// Strip non-ASCII chars that sneak in from copy-paste
function cleanEnv(val: string | undefined, fallback = '') {
  return (val || fallback).replace(/[^\x20-\x7E]/g, '').trim()
}

const DS_BASE       = cleanEnv(process.env.DOSESPOT_BASE_URL,        'https://my.staging.dosespot.com')
const DS_CLINIC_ID  = cleanEnv(process.env.DOSESPOT_CLINIC_ID,       '1038875')
const DS_CLINIC_KEY = cleanEnv(process.env.DOSESPOT_CLINIC_KEY)
const DS_SUB_KEY    = cleanEnv(process.env.DOSESPOT_SUBSCRIPTION_KEY)
const DS_CLINICIAN  = cleanEnv(process.env.DOSESPOT_CLINICIAN_ID,    '3122427')
const DS_ADMIN      = cleanEnv(process.env.DOSESPOT_ADMIN_ID,        '3122428')

// ─── Token (section 1.3.1 of Auth Guide) ────────────────────────────────────
// POST /webapi/v2/connect/token with grant_type=password + clinic credentials

async function getDoseSpotToken(): Promise<string> {
  const body = new URLSearchParams({
    grant_type:    'password',
    client_id:     DS_CLINIC_ID,
    client_secret: DS_CLINIC_KEY,
    username:      DS_CLINICIAN,
    password:      DS_CLINIC_KEY,
    scope:         'api',
  })

  const r = await fetch(`${DS_BASE}/webapi/v2/connect/token`, {
    method: 'POST',
    headers: {
      'Content-Type':   'application/x-www-form-urlencoded',
      'Subscription-Key': DS_SUB_KEY,
      'Ocp-Apim-Subscription-Key': DS_SUB_KEY,
    },
    body: body.toString(),
  })

  if (!r.ok) {
    const msg = await r.text()
    throw new Error(`DoseSpot token error: ${msg}`)
  }
  const data = await r.json() as { access_token: string }
  return data.access_token
}

// ─── SSO URL (section 1.6 of Auth Guide) ────────────────────────────────────
// Encrypted ClinicId  = randomPhrase + Base64(SHA512(randomPhrase + clinicKey))   [trailing == stripped]
// Encrypted UserId    = Base64(SHA512(userId + randomPhrase[0:22] + clinicKey))   [trailing == stripped]

function randomAlphaNum(length: number): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  let result = ''
  while (result.length < length) {
    const bytes = randomBytes(length * 2)
    for (const b of bytes) {
      if (result.length >= length) break
      const idx = b % chars.length
      result += chars[idx]
    }
  }
  return result
}

function buildSsoUrl(clinicianId: string, patientId?: number): string {
  const phrase = randomAlphaNum(32)

  // Encrypted ClinicId
  const clinicHash   = createHash('sha512').update(Buffer.from(phrase + DS_CLINIC_KEY, 'utf8')).digest('base64').replace(/=+$/, '')
  const ssoCode      = encodeURIComponent(phrase + clinicHash)

  // Encrypted UserId
  const phrase22     = phrase.slice(0, 22)
  const userHash     = createHash('sha512').update(Buffer.from(clinicianId + phrase22 + DS_CLINIC_KEY, 'utf8')).digest('base64').replace(/=+$/, '')
  const ssoUserVerify = encodeURIComponent(userHash)

  let url = `${DS_BASE}/LoginSingleSignOn.aspx`
  url += `?SingleSignOnClinicId=${DS_CLINIC_ID}`
  url += `&SingleSignOnUserId=${clinicianId}`
  url += `&SingleSignOnPhraseLength=32`
  url += `&SingleSignOnCode=${ssoCode}`
  url += `&SingleSignOnUserIdVerify=${ssoUserVerify}`

  if (patientId) {
    url += `&PatientId=${patientId}`
  }

  return url
}

// ─── Patient sync ────────────────────────────────────────────────────────────

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

// Look up DoseSpot's numeric PharmacyId for the child's free-text
// preferred pharmacy and assign it as the patient's primary pharmacy.
// Best-effort: any failure logs and returns null — DoseSpot must still
// open even if we can't match the pharmacy. The matched ID + the source
// text are cached on the child row so we only search DoseSpot's directory
// on first sync or after Sara edits the pharmacy text.
async function syncPreferredPharmacy(
  child: Record<string, any>,
  family: Record<string, any>,
  patientId: number,
  token: string,
  sql: any,
): Promise<{ pharmacyId: number | null; matched?: string; error?: string }> {
  const preferredText = String(child.preferred_pharmacy ?? '').trim()
  const savedId = child.dosespot_pharmacy_id as number | null | undefined

  // Best case: intake-time autocomplete already saved a concrete
  // pharmacy_id. Skip search entirely and assign it. This is why the
  // new PharmacyAutocomplete matters — 100% match rate, no parsing.
  if (savedId) {
    const headers = {
      'Content-Type':              'application/json',
      Authorization:               `Bearer ${token}`,
      'Subscription-Key':          DS_SUB_KEY,
      'Ocp-Apim-Subscription-Key': DS_SUB_KEY,
    }
    const assignRes = await fetch(`${DS_BASE}/webapi/v2/api/patients/${patientId}/pharmacies`, {
      method:  'POST',
      headers,
      body:    JSON.stringify({ PharmacyId: savedId, IsPrimary: true }),
    })
    if (assignRes.ok) return { pharmacyId: savedId, matched: `direct id ${savedId}` }
    // If DoseSpot rejects the assign (e.g. ID no longer valid), fall
    // through to the free-text fuzzy match so the launch still works.
  }

  if (!preferredText) return { pharmacyId: null }

  // Skip search when we already synced the same source text via fuzzy match.
  if (savedId && child.dosespot_pharmacy_source_text === preferredText) {
    return { pharmacyId: savedId, matched: 'cached' }
  }

  const headers = {
    'Content-Type':     'application/json',
    Authorization:      `Bearer ${token}`,
    'Subscription-Key': DS_SUB_KEY,
    'Ocp-Apim-Subscription-Key': DS_SUB_KEY,
  }

  // Parse the free-text pharmacy string into DoseSpot-friendly components.
  // Sara's typical entries look like "Publix #1518 Cotswold 4425 Randolph Rd."
  //   Name    = pharmacy chain (first word — CVS, Publix, Walgreens, etc.)
  //   Address = the street portion (matches "<digits> <words> Rd/St/Ave/…")
  //   State   = from family_profiles (NC / SC / VA)
  // DoseSpot's search wants each piece in its own param. Passing the
  // full string as Name matches nothing.
  const chainMatch = preferredText.match(/^(CVS|Publix|Walgreens|Rite Aid|Walmart|Target|Costco|Kroger|Harris Teeter|Sam's Club|Kaiser|Amazon Pharmacy|PillPack|Kinney|Winn-Dixie|Food Lion)/i)
  const name = chainMatch ? chainMatch[1] : preferredText.split(/[\s#,]/)[0]
  const addrMatch = preferredText.match(/\d+\s+[A-Za-z][A-Za-z\s'.]*?\s+(Rd|Road|St|Street|Ave|Avenue|Blvd|Boulevard|Way|Dr|Drive|Ln|Lane|Ct|Court|Pkwy|Parkway|Hwy|Highway|Cir|Circle|Pl|Place|Ter|Terrace)\b\.?/i)
  const streetAddress = addrMatch ? addrMatch[0].replace(/\.$/, '') : null

  try {
    // Build a series of increasingly loose search attempts. Take the
    // first non-empty result set. Order: chain + address + state →
    // chain + state → chain + address → chain alone.
    const attempts: Array<{ label: string; params: URLSearchParams }> = []
    const push = (label: string, entries: Record<string, string | null>) => {
      const p = new URLSearchParams()
      for (const [k, v] of Object.entries(entries)) if (v) p.set(k, v)
      attempts.push({ label, params: p })
    }
    push('name+addr+state', { Name: name, Address: streetAddress, State: family.state ?? null })
    push('name+state',      { Name: name, State: family.state ?? null })
    if (streetAddress) push('name+addr', { Name: name, Address: streetAddress })
    push('name only',       { Name: name })

    let first: { PharmacyId: number; StoreName?: string; Address1?: string; City?: string; State?: string } | undefined
    let usedLabel = ''
    let lastStatus = 0
    for (const { label, params } of attempts) {
      const res = await fetch(`${DS_BASE}/webapi/v2/api/pharmacies/search?${params}`, { headers })
      lastStatus = res.status
      if (!res.ok) continue
      const body = await res.json() as { Items?: any[] }
      const items = Array.isArray(body?.Items) ? body.Items : []
      if (items.length > 0) {
        first = items[0]
        usedLabel = label
        break
      }
    }

    if (!first?.PharmacyId) {
      return {
        pharmacyId: null,
        error: `no match for "${preferredText}" (parsed name="${name}"${streetAddress ? `, addr="${streetAddress}"` : ''}, state=${family.state ?? 'null'}${lastStatus ? `, last HTTP ${lastStatus}` : ''})`,
      }
    }

    // Assign as the patient's primary pharmacy in DoseSpot.
    const assignRes = await fetch(`${DS_BASE}/webapi/v2/api/patients/${patientId}/pharmacies`, {
      method:  'POST',
      headers,
      body:    JSON.stringify({ PharmacyId: first.PharmacyId, IsPrimary: true }),
    })
    if (!assignRes.ok) {
      const body = await assignRes.text().catch(() => '')
      return { pharmacyId: null, error: `pharmacy assign HTTP ${assignRes.status}: ${body.slice(0, 200)}` }
    }

    // Cache the match so we skip search on subsequent DoseSpot launches.
    await sql`
      UPDATE children SET
        dosespot_pharmacy_id           = ${first.PharmacyId},
        dosespot_pharmacy_source_text  = ${preferredText}
      WHERE id = ${child.id}::uuid`

    const label = [first.StoreName, first.Address1, first.City, first.State].filter(Boolean).join(' · ')
    return { pharmacyId: first.PharmacyId, matched: `${label || String(first.PharmacyId)} (via ${usedLabel})` }
  } catch (e: any) {
    return { pharmacyId: null, error: e?.message ?? String(e) }
  }
}

async function findOrCreateDoseSpotPatient(
  child: Record<string, any>,
  family: Record<string, any>,
  token: string
): Promise<number> {
  const headers = {
    'Content-Type':     'application/json',
    Authorization:      `Bearer ${token}`,
    'Subscription-Key': DS_SUB_KEY,
    'Ocp-Apim-Subscription-Key': DS_SUB_KEY,
  }

  // If we already have a DoseSpot patient ID, verify it still exists
  if (child.dosespot_patient_id) {
    const check = await fetch(`${DS_BASE}/webapi/v2/api/patients/${child.dosespot_patient_id}`, { headers })
    if (check.ok) {
      const existing = await check.json() as { Item?: { PatientId?: number } }
      return existing.Item?.PatientId ?? child.dosespot_patient_id as number
    }
    // Stale ID — fall through to recreate
  }

  // Validate required DoseSpot fields before calling API
  const missing: string[] = []
  if (!family.address_line1) missing.push('street address')
  if (!family.city) missing.push('city')
  const phone = cleanPhone(family.phone)
  if (!phone) missing.push('phone number')
  if (missing.length) {
    throw new Error(`Patient is missing required info for DoseSpot: ${missing.join(', ')}. Please update the patient's contact information in their chart and try again.`)
  }

  // Create patient
  const patientUrl = `${DS_BASE}/webapi/v2/api/patients`
  console.error('[dosespot/sso] calling:', patientUrl)
  const r = await fetch(patientUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      FirstName:        child.first_name  || '',
      LastName:         child.last_name   || '',
      DateOfBirth:      child.date_of_birth ? formatDob(String(child.date_of_birth)) : '',
      Gender:           genderCode(child.gender),
      Address1:         family.address_line1,
      City:             family.city,
      State:            family.state         || '',
      ZipCode:          family.zip           || '',
      PrimaryPhone:     phone,
      PrimaryPhoneType: 'Home',
      Active:           true,
      Weight:           0,
      WeightMetric:     'lb',
      Height:           0,
      HeightMetric:     'inch',
    }),
  })

  const responseText = await r.text()
  console.error('[dosespot/sso] patient create status:', r.status, 'body:', responseText)
  if (!r.ok) {
    throw new Error(`DoseSpot patient create ${r.status}: ${responseText}`)
  }
  const data = JSON.parse(responseText) as { Id?: number; Result?: { ResultCode?: string; ResultDescription?: string } }
  if (data.Result?.ResultCode && data.Result.ResultCode !== 'OK') {
    throw new Error(`DoseSpot patient create error: ${data.Result.ResultDescription || data.Result.ResultCode}`)
  }
  return data.Id ?? 0
}

// ─── Handler ─────────────────────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  try {
    let sub: string
    try {
      sub = await verifyToken(req.headers.authorization)
    } catch {
      return res.status(401).json({ error: 'Unauthorized' })
    }

    const { child_id } = req.body as { child_id?: string }
    if (!child_id) return res.status(400).json({ error: 'child_id required' })

    if (!DS_CLINIC_KEY) return res.status(503).json({ error: 'DOSESPOT_CLINIC_KEY not configured in Vercel' })
    if (!DS_SUB_KEY)    return res.status(503).json({ error: 'DOSESPOT_SUBSCRIPTION_KEY not configured in Vercel' })

    const sql = neon(process.env.DATABASE_URL!)

    // Bootstrap the pharmacy-cache columns idempotently. Cheap on hot
    // starts, correct on cold. Both columns are server-set only.
    try { await sql`ALTER TABLE children ADD COLUMN IF NOT EXISTS dosespot_pharmacy_id integer` } catch {}
    try { await sql`ALTER TABLE children ADD COLUMN IF NOT EXISTS dosespot_pharmacy_source_text text` } catch {}

    const [providerRow] = await sql`SELECT id, dosespot_clinician_id FROM providers WHERE cognito_sub = ${sub} LIMIT 1`
    if (!providerRow) return res.status(403).json({ error: 'Provider not found' })

    const [childRow] = await sql`
      SELECT c.*, fp.phone AS family_phone, fp.address_line1, fp.city, fp.state, fp.zip
      FROM children c
      LEFT JOIN family_profiles fp ON fp.id = c.family_id
      WHERE c.id = ${child_id}::uuid
      LIMIT 1`
    if (!childRow) return res.status(404).json({ error: 'Patient not found' })

    const child  = childRow as Record<string, any>

    // DoseSpot requires first name, last name, and date of birth — fail early with a clear message
    const missing = [
      !child.first_name && 'first name',
      !child.last_name  && 'last name',
      !child.date_of_birth && 'date of birth',
    ].filter(Boolean)
    if (missing.length) {
      return res.status(422).json({
        error: `Cannot open DoseSpot: patient record is missing ${missing.join(', ')}. Please update the patient chart before prescribing.`,
      })
    }
    // Use family profile fields, falling back to child's own parent fields
    const family = {
      phone:        child.family_phone   || child.parent_phone,
      address_line1: child.address_line1 || child.parent_address,
      city:         child.city           || child.parent_city,
      state:        child.state          || child.parent_state,
      zip:          child.zip            || child.parent_zip,
    }

    let dsPatientId: number | undefined = child.dosespot_patient_id || undefined

    let syncError: string | undefined
    let pharmacySyncNote: string | undefined
    try {
      const token   = await getDoseSpotToken()
      console.error('[dosespot/sso] got token, syncing patient. child.dosespot_patient_id:', child.dosespot_patient_id)
      dsPatientId   = await findOrCreateDoseSpotPatient(child, family, token)
      console.error('[dosespot/sso] dsPatientId after sync:', dsPatientId)
      if (dsPatientId && !child.dosespot_patient_id) {
        await sql`UPDATE children SET dosespot_patient_id = ${dsPatientId} WHERE id = ${child_id}::uuid`
      }

      // Preferred pharmacy sync — best-effort. Never blocks DoseSpot
      // launch. Logs the outcome so we can see match/mismatch patterns
      // in Vercel function logs without failing the flow.
      if (dsPatientId) {
        const pharm = await syncPreferredPharmacy(child, family, dsPatientId, token, sql)
        if (pharm.matched)      console.error('[dosespot/sso] preferred pharmacy set:', pharm.matched)
        else if (pharm.error)   console.error('[dosespot/sso] preferred pharmacy skipped:', pharm.error)
        pharmacySyncNote = pharm.matched ? `Preferred pharmacy: ${pharm.matched}` : pharm.error
      }
    } catch (e: any) {
      syncError = e.message
      console.error('[dosespot/sso] patient sync error:', e.message)
    }

    const clinicianId = (providerRow.dosespot_clinician_id as string | null) || DS_ADMIN
    const ssoUrl = buildSsoUrl(clinicianId, dsPatientId)
    console.error('[dosespot/sso] final dsPatientId:', dsPatientId, '| URL includes PatientId:', ssoUrl.includes('PatientId'))
    return res.status(200).json({ ssoUrl, syncError, dsPatientId, pharmacySyncNote })

  } catch (err: any) {
    console.error('[dosespot/sso] error:', err?.message)
    return res.status(500).json({ error: err?.message || 'Internal server error' })
  }
}
