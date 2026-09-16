import type { VercelRequest, VercelResponse } from '@vercel/node'
import { createRemoteJWKSet, jwtVerify } from 'jose'

// Accept EITHER family or provider Cognito tokens so the pharmacy
// autocomplete works from the family intake form AND any staff-side
// surface that needs to pick a pharmacy for a patient.
async function verifyAnyToken(authHeader: string | undefined): Promise<void> {
  if (!authHeader?.startsWith('Bearer ')) throw new Error('Missing token')
  const token = authHeader.slice(7)
  const region = process.env.VITE_AWS_REGION || 'us-east-2'
  const familyPoolId = process.env.VITE_FAMILY_USER_POOL_ID || ''
  if (familyPoolId) {
    try {
      const JWKS = createRemoteJWKSet(new URL(`https://cognito-idp.${region}.amazonaws.com/${familyPoolId}/.well-known/jwks.json`))
      const { payload } = await jwtVerify(token, JWKS, { issuer: `https://cognito-idp.${region}.amazonaws.com/${familyPoolId}` })
      if (payload.sub) return
    } catch {}
  }
  const providerPoolId = process.env.VITE_AWS_USER_POOL_ID || ''
  const JWKS = createRemoteJWKSet(new URL(`https://cognito-idp.${region}.amazonaws.com/${providerPoolId}/.well-known/jwks.json`))
  const { payload } = await jwtVerify(token, JWKS, { issuer: `https://cognito-idp.${region}.amazonaws.com/${providerPoolId}` })
  if (!payload.sub) throw new Error('No sub in token')
}

function cleanEnv(val: string | undefined, fallback = '') {
  return (val || fallback).replace(/[^\x20-\x7E]/g, '').trim()
}

const DS_BASE       = cleanEnv(process.env.DOSESPOT_BASE_URL,        'https://my.staging.dosespot.com')
const DS_CLINIC_ID  = cleanEnv(process.env.DOSESPOT_CLINIC_ID,       '1038875')
const DS_CLINIC_KEY = cleanEnv(process.env.DOSESPOT_CLINIC_KEY)
const DS_SUB_KEY    = cleanEnv(process.env.DOSESPOT_SUBSCRIPTION_KEY)
const DS_CLINICIAN  = cleanEnv(process.env.DOSESPOT_CLINICIAN_ID,    '3122427')

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
      'Content-Type':              'application/x-www-form-urlencoded',
      'Subscription-Key':          DS_SUB_KEY,
      'Ocp-Apim-Subscription-Key': DS_SUB_KEY,
    },
    body: body.toString(),
  })
  if (!r.ok) throw new Error(`DoseSpot token error: ${await r.text()}`)
  const data = await r.json() as { access_token: string }
  return data.access_token
}

/**
 * GET /api/dosespot/pharmacy-search?q=<name>&zip=<zip>&state=<state>
 *
 * Proxies to DoseSpot's pharmacy directory so parents can pick their
 * pharmacy at intake and we save the concrete DoseSpot pharmacy ID
 * (100% match rate on future SSO launches — no fuzzy-matching needed).
 *
 * At least ONE of `q` (name / partial) or `zip` must be supplied. Returns
 * up to 20 matches with clean camelCase fields so the client can render
 * a nice autocomplete dropdown.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  try {
    await verifyAnyToken(req.headers.authorization)
  } catch {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const { q, zip, state } = req.query as { q?: string; zip?: string; state?: string }
  const nameTerm  = String(q ?? '').trim()
  const zipTerm   = String(zip ?? '').trim()
  const stateTerm = String(state ?? '').trim()

  if (!nameTerm && !zipTerm) {
    return res.status(400).json({ error: 'Provide q (pharmacy name) or zip.' })
  }

  try {
    const token = await getDoseSpotToken()
    const params = new URLSearchParams()
    if (nameTerm)  params.set('Name', nameTerm)
    if (zipTerm)   params.set('Zip', zipTerm)
    if (stateTerm) params.set('State', stateTerm)

    const r = await fetch(`${DS_BASE}/webapi/v2/api/pharmacies/search?${params}`, {
      headers: {
        'Content-Type':              'application/json',
        Authorization:               `Bearer ${token}`,
        'Subscription-Key':          DS_SUB_KEY,
        'Ocp-Apim-Subscription-Key': DS_SUB_KEY,
      },
    })

    if (!r.ok) {
      const body = await r.text().catch(() => '')
      return res.status(502).json({ error: `DoseSpot search HTTP ${r.status}: ${body.slice(0, 200)}` })
    }

    const body = await r.json() as { Items?: any[] }
    const items = Array.isArray(body?.Items) ? body.Items.slice(0, 20) : []

    return res.status(200).json({
      items: items.map((p: any) => ({
        id:      p.PharmacyId,
        name:    [p.StoreName, p.PharmacyChain].filter(Boolean)[0] ?? 'Pharmacy',
        address: p.Address1 ?? '',
        city:    p.City ?? '',
        state:   p.State ?? '',
        zip:     p.ZipCode ?? p.Zip ?? '',
        phone:   p.PrimaryPhone ?? p.Phone ?? '',
      })),
    })
  } catch (e: any) {
    console.error('dosespot/pharmacy-search error:', e?.message)
    return res.status(500).json({ error: e?.message ?? 'Internal server error' })
  }
}
