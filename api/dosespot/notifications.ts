import type { VercelRequest, VercelResponse } from '@vercel/node'
import { createRemoteJWKSet, jwtVerify } from 'jose'
import { neon } from '@neondatabase/serverless'

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

function cleanEnv(val: string | undefined, fallback = '') {
  return (val || fallback).replace(/[^\x20-\x7E]/g, '').trim()
}

const DS_BASE      = cleanEnv(process.env.DOSESPOT_BASE_URL,        'https://my.staging.dosespot.com')
const DS_CLINIC_ID = cleanEnv(process.env.DOSESPOT_CLINIC_ID,       '1038875')
const DS_CLINIC_KEY = cleanEnv(process.env.DOSESPOT_CLINIC_KEY)
const DS_SUB_KEY   = cleanEnv(process.env.DOSESPOT_SUBSCRIPTION_KEY)
const DS_CLINICIAN = cleanEnv(process.env.DOSESPOT_CLINICIAN_ID,    '3122427')

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
      'Content-Type':     'application/x-www-form-urlencoded',
      'Subscription-Key': DS_SUB_KEY,
    },
    body: body.toString(),
  })
  if (!r.ok) throw new Error(`DoseSpot token error: ${await r.text()}`)
  const data = await r.json() as { access_token: string }
  return data.access_token
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  try {
    let sub: string
    try {
      sub = await verifyToken(req.headers.authorization)
    } catch {
      return res.status(401).json({ error: 'Unauthorized' })
    }

    const sql = neon(process.env.DATABASE_URL!)
    const [provider] = await sql`SELECT id FROM providers WHERE cognito_sub = ${sub} LIMIT 1`
    if (!provider) return res.status(403).json({ error: 'Provider not found' })

    if (!DS_CLINIC_KEY || !DS_SUB_KEY) {
      return res.status(200).json({ count: 0, breakdown: {} })
    }

    const token = await getDoseSpotToken()

    // Fetch pending notification counts from DoseSpot
    const r = await fetch(`${DS_BASE}/webapi/v2/clinicians/${DS_CLINICIAN}/notifications`, {
      headers: {
        Authorization:      `Bearer ${token}`,
        'Subscription-Key': DS_SUB_KEY,
        Accept:             'application/json',
      },
    })

    if (!r.ok) {
      // Fail gracefully — return 0 rather than erroring the UI
      console.warn('[dosespot/notifications] API response:', r.status, await r.text())
      return res.status(200).json({ count: 0, breakdown: {} })
    }

    const data = await r.json() as Record<string, any>

    // DoseSpot returns counts in fields like RenewalCount, RxChangeCount, ErrorCount
    const breakdown = {
      renewals:  data.RenewalCount  ?? data.renewalCount  ?? 0,
      rxChanges: data.RxChangeCount ?? data.rxChangeCount ?? 0,
      errors:    data.ErrorCount    ?? data.errorCount    ?? 0,
    }
    const count = (data.Count ?? data.count) ??
      (breakdown.renewals + breakdown.rxChanges + breakdown.errors)

    return res.status(200).json({ count, breakdown })

  } catch (err: any) {
    console.error('[dosespot/notifications] error:', err?.message)
    // Always return a valid response so the UI never breaks
    return res.status(200).json({ count: 0, breakdown: {} })
  }
}
