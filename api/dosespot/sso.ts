import type { VercelRequest, VercelResponse } from '@vercel/node'
import { neon } from '@neondatabase/serverless'
import { createHmac, createHash } from 'crypto'
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

// ─── DoseSpot config ──────────────────────────────────────────────────────────
// Set these in Vercel environment variables:
//   DOSESPOT_BASE_URL          https://my.staging.dosespot.com
//   DOSESPOT_CLINIC_ID         1038875
//   DOSESPOT_CLINIC_KEY        WUAE5MYPLDG2J9LSSMQ6TQTJHWTHECW4
//   DOSESPOT_SUBSCRIPTION_KEY  6cccfde8eba7b72a493985bdd12f1e130b1dee3a10dffd50563a7c650128427b
//   DOSESPOT_CLINICIAN_ID      3122427  (default; override per provider once we have per-provider IDs)

const DS_BASE        = process.env.DOSESPOT_BASE_URL        || 'https://my.staging.dosespot.com'
const DS_CLINIC_ID   = process.env.DOSESPOT_CLINIC_ID       || '1038875'
const DS_CLINIC_KEY  = process.env.DOSESPOT_CLINIC_KEY      || ''
const DS_SUB_KEY     = process.env.DOSESPOT_SUBSCRIPTION_KEY || ''
const DS_CLINICIAN   = process.env.DOSESPOT_CLINICIAN_ID    || '3122427'

// ─── Token generation ─────────────────────────────────────────────────────────
// TODO: Replace with exact JWT format once DoseSpot Authentication Guide is received.
// Current understanding based on DoseSpot RESTful API V2 patterns:
//   1. Build a JWT (header.payload.signature) signed with HMAC-SHA256 using DS_CLINIC_KEY
//   2. POST to ${DS_BASE}/webapi/token with grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer
//   3. Include Ocp-Apim-Subscription-Key header
// The exact JWT claims (iss/sub/aud/exp) must be confirmed with the Authentication Guide.

function base64url(buf: Buffer | string): string {
  const b = typeof buf === 'string' ? Buffer.from(buf) : buf
  return b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function buildJwt(clinicianId: string): string {
  const header  = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const now     = Math.floor(Date.now() / 1000)
  // TODO: Confirm exact claim names with Authentication Guide
  const payload = base64url(JSON.stringify({
    iss: DS_CLINIC_ID,
    sub: clinicianId,
    aud: `${DS_BASE}/webapi/token`,
    exp: now + 60,
    iat: now,
  }))
  const sig = base64url(
    createHmac('sha256', DS_CLINIC_KEY).update(`${header}.${payload}`).digest()
  )
  return `${header}.${payload}.${sig}`
}

async function getDoseSpotToken(clinicianId: string): Promise<string> {
  const jwt = buildJwt(clinicianId)
  const r = await fetch(`${DS_BASE}/webapi/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Ocp-Apim-Subscription-Key': DS_SUB_KEY,
    },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  })
  if (!r.ok) {
    const msg = await r.text()
    throw new Error(`DoseSpot token error: ${msg}`)
  }
  const data = await r.json()
  return data.access_token as string
}

// ─── Patient sync ─────────────────────────────────────────────────────────────

interface DoseSpotPatient {
  FirstName: string
  LastName: string
  DateOfBirth: string   // MM/DD/YYYY
  Gender: number        // 1=Male 2=Female 3=Unknown
  Address1: string
  City: string
  State: string
  ZipCode: string
  PrimaryPhone: string
  PrimaryPhoneType: number  // 1=Home 2=Work 3=Cell
}

function genderCode(g: string | null): number {
  if (!g) return 3
  const l = g.toLowerCase()
  if (l === 'male' || l === 'm') return 1
  if (l === 'female' || l === 'f') return 2
  return 3
}

function formatDob(dob: string): string {
  // Convert YYYY-MM-DD → MM/DD/YYYY
  const [y, m, d] = dob.split('T')[0].split('-')
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
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
    'Ocp-Apim-Subscription-Key': DS_SUB_KEY,
  }

  // If we already have a DoseSpot patient ID, verify it still exists
  if (child.dosespot_patient_id) {
    const check = await fetch(
      `${DS_BASE}/webapi/v2/patients/${child.dosespot_patient_id}`,
      { headers }
    )
    if (check.ok) return child.dosespot_patient_id as number
  }

  // Create new patient
  const phone = family.phone || child.parent_phone || null
  const patient: DoseSpotPatient = {
    FirstName:        child.first_name  || '',
    LastName:         child.last_name   || '',
    DateOfBirth:      child.date_of_birth ? formatDob(String(child.date_of_birth)) : '',
    Gender:           genderCode(child.gender),
    Address1:         family.address_line1 || child.parent_address || '',
    City:             family.city    || child.parent_city    || '',
    State:            family.state   || child.parent_state   || '',
    ZipCode:          family.zip     || child.parent_zip     || '',
    PrimaryPhone:     cleanPhone(phone),
    PrimaryPhoneType: 3,  // Cell
  }

  const r = await fetch(`${DS_BASE}/webapi/v2/patients`, {
    method: 'POST',
    headers,
    body: JSON.stringify(patient),
  })
  if (!r.ok) {
    const msg = await r.text()
    throw new Error(`DoseSpot create patient error: ${msg}`)
  }
  const data = await r.json()
  return data.Item as number
}

// ─── SSO URL ──────────────────────────────────────────────────────────────────
// TODO: Confirm exact SSO URL format with Authentication Guide.
// DoseSpot JumpStart SSO opens their hosted prescribing UI in an iframe.
// Expected format based on DoseSpot JumpStart documentation patterns:
//   ${DS_BASE}/LoginSingleSignOn.aspx?b={encryptedToken}&p={patientId}&clinicianid={clinicianId}
// The encrypted token is a signed payload built from the clinic key.

function buildSsoUrl(dsPatientId: number, clinicianId: string): string {
  const now        = Math.floor(Date.now() / 1000)
  const payload    = `${DS_CLINIC_ID}${clinicianId}${now}`
  const hash       = createHash('md5').update(payload + DS_CLINIC_KEY).digest('hex')
  const encoded    = Buffer.from(`${payload}${hash}`).toString('base64')
  // TODO: Verify the exact parameter names with Authentication Guide
  return `${DS_BASE}/LoginSingleSignOn.aspx?b=${encodeURIComponent(encoded)}&p=${dsPatientId}&clinicianid=${clinicianId}`
}

// ─── Handler ──────────────────────────────────────────────────────────────────

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

  if (!DS_CLINIC_KEY) return res.status(503).json({ error: 'DoseSpot credentials not configured — set DOSESPOT_CLINIC_KEY in Vercel environment variables' })
  if (!DS_SUB_KEY)   return res.status(503).json({ error: 'DoseSpot credentials not configured — set DOSESPOT_SUBSCRIPTION_KEY in Vercel environment variables' })

  const sql = neon(process.env.DATABASE_URL!)

  // Verify provider
  const [providerRow] = await sql`SELECT id FROM providers WHERE cognito_sub = ${sub} LIMIT 1`
  if (!providerRow) return res.status(403).json({ error: 'Provider not found' })

  const clinicianId: string = DS_CLINICIAN

  // Load child + family (no practice_id filter — provider auth is sufficient)
  const [childRow] = await sql`
    SELECT c.*, fp.phone AS family_phone, fp.address_line1 AS family_address_line1,
           fp.city AS family_city, fp.state AS family_state, fp.zip AS family_zip
    FROM children c
    JOIN family_profiles fp ON fp.id = c.family_id
    WHERE c.id = ${child_id}::uuid
    LIMIT 1`
  if (!childRow) return res.status(404).json({ error: 'Patient not found' })

  const child  = childRow as Record<string, any>
  const family = {
    phone:         child.family_phone,
    address_line1: child.family_address_line1,
    city:          child.family_city,
    state:         child.family_state,
    zip:           child.family_zip,
  }

  try {
    // 1. Get DoseSpot access token
    const token = await getDoseSpotToken(clinicianId)

    // 2. Sync patient to DoseSpot (create if first time)
    const dsPatientId = await findOrCreateDoseSpotPatient(child, family, token)

    // 3. Persist the DoseSpot patient ID so we don't re-create next time
    if (!child.dosespot_patient_id) {
      await sql`UPDATE children SET dosespot_patient_id = ${dsPatientId} WHERE id = ${child_id}::uuid`
    }

    // 4. Generate SSO URL
    const ssoUrl = buildSsoUrl(dsPatientId, clinicianId)

    return res.json({ ssoUrl })
  } catch (err: any) {
    console.error('[dosespot/sso] DoseSpot API error:', err?.message)
    return res.status(502).json({ error: err?.message || 'DoseSpot API error' })
  }

  } catch (err: any) {
    console.error('[dosespot/sso] Unhandled error:', err?.message, err?.stack)
    return res.status(500).json({ error: err?.message || 'Internal server error' })
  }
}
