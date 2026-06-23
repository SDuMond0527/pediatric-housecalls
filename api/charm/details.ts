import type { VercelRequest, VercelResponse } from '@vercel/node'
import { createRemoteJWKSet, jwtVerify } from 'jose'

async function verifyAnyToken(authHeader: string | undefined): Promise<void> {
  if (!authHeader?.startsWith('Bearer ')) throw new Error('Missing token')
  const token = authHeader.slice(7)
  const region = process.env.VITE_AWS_REGION || 'us-east-2'
  const providerPoolId = process.env.VITE_AWS_USER_POOL_ID || ''
  const JWKS = createRemoteJWKSet(new URL(`https://cognito-idp.${region}.amazonaws.com/${providerPoolId}/.well-known/jwks.json`))
  const { payload } = await jwtVerify(token, JWKS, { issuer: `https://cognito-idp.${region}.amazonaws.com/${providerPoolId}` })
  if (!payload.sub) throw new Error('No sub in token')
}

// ── Charm auth ────────────────────────────────────────────────────────────────

// Note: get-charm-details uses the accounts106 subdomain (Zoho account region)
const CHARM_TOKEN_URL   = 'https://accounts106.charmtracker.com/oauth/v2/token'
const CHARM_BASE_URL    = process.env.CHARM_BASE_URL      || 'https://ehr.charmtracker.com/api/ehr/v1'
const CHARM_CLIENT_ID   = process.env.CHARM_CLIENT_ID     || ''
const CHARM_CLIENT_SECRET = process.env.CHARM_CLIENT_SECRET || ''
const CHARM_REFRESH_TOKEN = process.env.CHARM_REFRESH_TOKEN || ''
const CHARM_API_KEY     = process.env.CHARM_API_KEY       || ''

async function getCharmToken(): Promise<string> {
  const res = await fetch(CHARM_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type:    'refresh_token',
      refresh_token: CHARM_REFRESH_TOKEN,
      client_id:     CHARM_CLIENT_ID,
      client_secret: CHARM_CLIENT_SECRET,
    }),
  })
  const data = await res.json()
  if (!data.access_token) throw new Error(`Charm auth failed: ${JSON.stringify(data)}`)
  return data.access_token
}

async function charmGet(path: string, token: string): Promise<any> {
  const res = await fetch(`${CHARM_BASE_URL}${path}`, {
    headers: {
      'Authorization': `Zoho-oauthtoken ${token}`,
      'api_key':       CHARM_API_KEY,
      'Content-Type':  'application/json',
    },
  })
  if (!res.ok) return null
  return res.json()
}

// ── Handler ───────────────────────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    await verifyAnyToken(req.headers.authorization)
  } catch {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  if (!CHARM_CLIENT_ID || !CHARM_REFRESH_TOKEN) {
    return res.status(503).json({ ok: false, error: 'Charm not configured' })
  }

  const { charm_patient_id, charm_appointment_id } = req.body
  if (!charm_patient_id) return res.status(400).json({ ok: false, error: 'charm_patient_id required' })

  try {
    const token = await getCharmToken()

    const [patientData, allergyData] = await Promise.all([
      charmGet(`/patients/${charm_patient_id}`, token),
      charmGet(`/patients/${charm_patient_id}/allergies`, token),
    ])

    const patient = patientData?.patient || patientData || {}
    const allergies = allergyData?.allergies || allergyData?.data || []

    let appointmentReason = ''
    if (charm_appointment_id) {
      const apptData = await charmGet(`/appointment/${charm_appointment_id}`, token)
        ?? await charmGet(`/appointments/${charm_appointment_id}`, token)
      appointmentReason = apptData?.appointment?.reason || apptData?.reason || ''
    }

    return res.json({
      ok: true,
      patient: {
        first_name: patient.first_name || '',
        last_name:  patient.last_name  || '',
        dob:        patient.dob        || '',
        gender:     patient.gender     || '',
        email:      patient.email      || '',
        phone:      patient.mobile || patient.home_phone || '',
        address:    [patient.address_line1, patient.city, patient.state, patient.zip_code].filter(Boolean).join(', '),
      },
      allergies: Array.isArray(allergies)
        ? allergies.map((a: any) => `${a.allergen} (${a.severity || 'unknown'})`).join(', ')
        : '',
      appointment_reason: appointmentReason,
    })
  } catch (err: any) {
    return res.status(500).json({ ok: false, error: err.message ?? String(err) })
  }
}
