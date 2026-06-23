import type { VercelRequest, VercelResponse } from '@vercel/node'
import { createRemoteJWKSet, jwtVerify } from 'jose'

async function verifyToken(authHeader: string | undefined): Promise<void> {
  if (!authHeader?.startsWith('Bearer ')) throw new Error('Missing token')
  const token = authHeader.slice(7)
  const region = process.env.VITE_AWS_REGION || 'us-east-2'
  const providerPoolId = process.env.VITE_AWS_USER_POOL_ID || ''
  const JWKS = createRemoteJWKSet(new URL(`https://cognito-idp.${region}.amazonaws.com/${providerPoolId}/.well-known/jwks.json`))
  const { payload } = await jwtVerify(token, JWKS, { issuer: `https://cognito-idp.${region}.amazonaws.com/${providerPoolId}` })
  if (!payload.sub) throw new Error('No sub')
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try { await verifyToken(req.headers.authorization) } catch { return res.status(401).json({ error: 'Unauthorized' }) }
  if (req.method !== 'GET') return res.status(405).end()

  const clientId     = process.env.CHARM_CLIENT_ID     || ''
  const clientSecret = process.env.CHARM_CLIENT_SECRET || ''
  const refreshToken = process.env.CHARM_REFRESH_TOKEN || ''
  const apiKey       = process.env.CHARM_API_KEY       || ''
  const baseUrl      = process.env.CHARM_BASE_URL      || 'https://ehr.charmtracker.com/api/ehr/v1'
  const facilityId   = process.env.CHARM_FACILITY_ID   || '(auto)'

  const envCheck = {
    CHARM_CLIENT_ID:     clientId     ? `set (${clientId.slice(0,6)}…)`     : 'MISSING',
    CHARM_CLIENT_SECRET: clientSecret ? `set (${clientSecret.slice(0,4)}…)` : 'MISSING',
    CHARM_REFRESH_TOKEN: refreshToken ? `set (${refreshToken.slice(0,6)}…)` : 'MISSING',
    CHARM_API_KEY:       apiKey       ? `set (${apiKey.slice(0,6)}…)`       : 'MISSING',
    CHARM_BASE_URL:      baseUrl,
    CHARM_FACILITY_ID:   facilityId,
  }

  if (!clientId || !refreshToken) {
    return res.json({ ok: false, step: 'env', envCheck, error: 'Missing required env vars' })
  }

  // Try token with accounts.charmtracker.com
  let token: string | null = null
  let tokenError: string | null = null
  let tokenUrl = 'https://accounts.charmtracker.com/oauth/v2/token'
  try {
    const r = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret }),
    })
    const d = await r.json()
    if (d.access_token) { token = d.access_token } else { tokenError = JSON.stringify(d) }
  } catch (e: any) { tokenError = e.message }

  // If that failed, try accounts106
  if (!token) {
    const url106 = 'https://accounts106.charmtracker.com/oauth/v2/token'
    try {
      const r = await fetch(url106, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret }),
      })
      const d = await r.json()
      if (d.access_token) { token = d.access_token; tokenUrl = url106; tokenError = null }
      else { tokenError = `accounts: ${tokenError} | accounts106: ${JSON.stringify(d)}` }
    } catch (e: any) { tokenError += ` | accounts106: ${e.message}` }
  }

  if (!token) {
    return res.json({ ok: false, step: 'auth', envCheck, tokenUrl, error: tokenError })
  }

  // Try to list facilities
  let facilitiesResult: any = null
  let facilitiesError: string | null = null
  try {
    const r = await fetch(`${baseUrl}/facilities`, {
      headers: { 'Authorization': `Zoho-oauthtoken ${token}`, 'api_key': apiKey, 'Content-Type': 'application/json' },
    })
    facilitiesResult = await r.json()
    if (!r.ok) facilitiesError = `HTTP ${r.status}: ${JSON.stringify(facilitiesResult)}`
  } catch (e: any) { facilitiesError = e.message }

  return res.json({
    ok: !facilitiesError,
    envCheck,
    auth: { tokenUrl, tokenObtained: true },
    facilities: facilitiesError ? { error: facilitiesError } : facilitiesResult,
  })
}
