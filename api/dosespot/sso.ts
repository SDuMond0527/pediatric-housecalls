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
    url += `&OnBehalfOfUserId=${clinicianId}`
  }

  return url
}

// ─── Patient sync ────────────────────────────────────────────────────────────

function genderCode(g: string | null): number {
  if (!g) return 3
  const l = g.toLowerCase()
  if (l === 'male'   || l === 'm') return 1
  if (l === 'female' || l === 'f') return 2
  return 3
}

function formatDob(dob: string): string {
  const [y, m, d] = String(dob).split('T')[0].split('-')
  return `${m}/${d}/${y}`
}

function cleanPhone(phone: string | null): string {
  if (!phone) return '0000000000'
  return phone.replace(/\D/g, '').slice(-10).padStart(10, '0')
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
  }

  // If we already have a DoseSpot patient ID, verify it still exists
  if (child.dosespot_patient_id) {
    const check = await fetch(`${DS_BASE}/webapi/v2/patients/${child.dosespot_patient_id}`, { headers })
    if (check.ok) return child.dosespot_patient_id as number
  }

  // Create patient
  const r = await fetch(`${DS_BASE}/webapi/v2/patients`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      FirstName:        child.first_name  || '',
      LastName:         child.last_name   || '',
      DateOfBirth:      child.date_of_birth ? formatDob(String(child.date_of_birth)) : '',
      Gender:           genderCode(child.gender),
      Address1:         family.address_line1 || '',
      City:             family.city          || '',
      State:            family.state         || '',
      ZipCode:          family.zip           || '',
      PrimaryPhone:     cleanPhone(family.phone),
      PrimaryPhoneType: 3,
    }),
  })

  if (!r.ok) {
    const msg = await r.text()
    throw new Error(`DoseSpot patient sync error: ${msg}`)
  }
  const data = await r.json() as { Item?: number }
  return data.Item ?? 0
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

    const [providerRow] = await sql`SELECT id FROM providers WHERE cognito_sub = ${sub} LIMIT 1`
    if (!providerRow) return res.status(403).json({ error: 'Provider not found' })

    const [childRow] = await sql`
      SELECT c.*, fp.phone AS family_phone, fp.address_line1, fp.city, fp.state, fp.zip
      FROM children c
      JOIN family_profiles fp ON fp.id = c.family_id
      WHERE c.id = ${child_id}::uuid
      LIMIT 1`
    if (!childRow) return res.status(404).json({ error: 'Patient not found' })

    const child  = childRow as Record<string, any>
    const family = { phone: child.family_phone, address_line1: child.address_line1, city: child.city, state: child.state, zip: child.zip }

    let dsPatientId: number | undefined = child.dosespot_patient_id || undefined

    try {
      const token   = await getDoseSpotToken()
      dsPatientId   = await findOrCreateDoseSpotPatient(child, family, token)
      if (dsPatientId && !child.dosespot_patient_id) {
        await sql`UPDATE children SET dosespot_patient_id = ${dsPatientId} WHERE id = ${child_id}::uuid`
      }
    } catch (e: any) {
      // Don't block SSO if patient sync fails — open DoseSpot without patient context
      console.warn('[dosespot/sso] patient sync warning:', e.message)
    }

    const ssoUrl = buildSsoUrl(DS_CLINICIAN, dsPatientId)
    return res.status(200).json({ ssoUrl })

  } catch (err: any) {
    console.error('[dosespot/sso] error:', err?.message)
    return res.status(500).json({ error: err?.message || 'Internal server error' })
  }
}
