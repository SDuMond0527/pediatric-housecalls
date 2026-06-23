import type { VercelRequest, VercelResponse } from '@vercel/node'
import { neon } from '@neondatabase/serverless'
import { createRemoteJWKSet, jwtVerify } from 'jose'

async function verifyFamilyToken(authHeader: string | undefined): Promise<string> {
  if (!authHeader?.startsWith('Bearer ')) throw new Error('Missing token')
  const token = authHeader.slice(7)
  const region = process.env.VITE_AWS_REGION || 'us-east-2'
  const userPoolId = process.env.VITE_FAMILY_USER_POOL_ID || ''
  const JWKS = createRemoteJWKSet(
    new URL(`https://cognito-idp.${region}.amazonaws.com/${userPoolId}/.well-known/jwks.json`)
  )
  const { payload } = await jwtVerify(token, JWKS, {
    issuer: `https://cognito-idp.${region}.amazonaws.com/${userPoolId}`,
  })
  if (!payload.sub) throw new Error('No sub in token')
  return payload.sub
}

async function squarePost(path: string, body: unknown) {
  const token = process.env.SQUARE_ACCESS_TOKEN || ''
  const env   = process.env.SQUARE_ENVIRONMENT || 'production'
  const base  = env === 'sandbox' ? 'https://connect.squareupsandbox.com' : 'https://connect.squareup.com'
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Square-Version': '2024-01-17',
    },
    body: JSON.stringify(body),
  })
  const json = await res.json()
  if (!res.ok) {
    const detail = (json as any).errors?.[0]?.detail || (json as any).errors?.[0]?.category || 'Square API error'
    throw new Error(detail)
  }
  return json as any
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  let sub: string
  try {
    sub = await verifyFamilyToken(req.headers.authorization)
  } catch {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  try {
    const { nonce } = req.body
    if (!nonce) return res.status(400).json({ error: 'Missing nonce' })

    const sql = neon(process.env.DATABASE_URL!)
    const [family] = await sql`
      SELECT id, email, display_name, square_customer_id
      FROM family_profiles WHERE cognito_sub = ${sub} LIMIT 1`
    if (!family) return res.status(404).json({ error: 'Family not found' })

    let customerId = family.square_customer_id as string | null
    if (!customerId) {
      const nameParts = ((family.display_name as string) || '').trim().split(/\s+/)
      const { customer } = await squarePost('/v2/customers', {
        given_name:    nameParts[0] || 'Family',
        family_name:   nameParts.slice(1).join(' ') || '',
        email_address: family.email,
        reference_id:  family.id,
      })
      customerId = customer.id as string
    }

    const { card } = await squarePost('/v2/cards', {
      idempotency_key: crypto.randomUUID(),
      source_id: nonce,
      card: { customer_id: customerId },
    })

    await sql`
      UPDATE family_profiles
      SET square_customer_id = ${customerId}, square_card_id = ${card.id as string}
      WHERE cognito_sub = ${sub}`

    return res.json({ ok: true, cardBrand: card.card_brand, last4: card.last_4 })
  } catch (e: any) {
    return res.status(400).json({ ok: false, error: e.message ?? String(e) })
  }
}
