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

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

    let sub: string
    try {
      sub = await verifyToken(req.headers.authorization)
    } catch {
      return res.status(401).json({ error: 'Unauthorized' })
    }

    const sql = neon(process.env.DATABASE_URL!)
    const [provider] = await sql`SELECT id, name FROM providers WHERE cognito_sub = ${sub} LIMIT 1`
    if (!provider) return res.status(403).json({ error: 'Provider not found' })

    const { child_id, appointment_id, tests, diagnoses, priority = 'routine', notes } = req.body as {
      child_id: string
      appointment_id?: string
      tests: { code: string; name: string }[]
      diagnoses: string[]
      priority?: string
      notes?: string
    }

    if (!child_id || !tests?.length) return res.status(400).json({ error: 'child_id and tests required' })

    // Save order to DB first
    const [order] = await sql`
      INSERT INTO lab_orders (child_id, provider_id, appointment_id, tests, diagnoses, priority, notes, status)
      VALUES (
        ${child_id}::uuid,
        ${provider.id}::uuid,
        ${appointment_id ?? null}::uuid,
        ${JSON.stringify(tests)}::jsonb,
        ${diagnoses ?? []}::text[],
        ${priority},
        ${notes ?? null},
        'pending'
      )
      RETURNING *
    `

    // TODO: Submit to Labcorp API once credentials are configured
    // const LC_BASE = process.env.LABCORP_API_BASE_URL       // e.g. https://api.labcorp.com
    // const LC_CLIENT_ID = process.env.LABCORP_CLIENT_ID
    // const LC_CLIENT_SECRET = process.env.LABCORP_CLIENT_SECRET
    // const LC_ACCOUNT_NUMBER = process.env.LABCORP_ACCOUNT_NUMBER
    //
    // Steps:
    // 1. GET token: POST {LC_BASE}/token with client_credentials grant
    // 2. Fetch child demographics from DB to build patient payload
    // 3. POST {LC_BASE}/v1/orders with patient + test codes + ordering provider NPI
    // 4. Store returned order ID: UPDATE lab_orders SET labcorp_order_id=..., status='submitted'
    //
    // For now, order is saved as 'pending' — submit manually via Labcorp Link portal

    return res.status(201).json(order)
  } catch (err: any) {
    console.error('labs/order error:', err)
    return res.status(500).json({ error: err.message || 'Internal server error' })
  }
}
