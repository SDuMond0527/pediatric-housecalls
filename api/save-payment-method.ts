import type { VercelRequest, VercelResponse } from '@vercel/node'
import sql from './_lib/db'
import { getFamilyContext } from './_lib/auth'

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

  let ctx: { sub: string; practiceId: string; familyId: string }
  try {
    ctx = await getFamilyContext(req.headers.authorization)
  } catch {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  try {
    const { nonce } = req.body
    if (!nonce) return res.status(400).json({ error: 'Missing nonce' })

    const [family] = await sql`
      SELECT id, email, display_name, square_customer_id
      FROM family_profiles WHERE id = ${ctx.familyId}::uuid AND practice_id = ${ctx.practiceId} LIMIT 1`
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
      WHERE id = ${ctx.familyId}::uuid AND practice_id = ${ctx.practiceId}`

    return res.json({ ok: true, cardBrand: card.card_brand, last4: card.last_4 })
  } catch (e: any) {
    return res.status(400).json({ ok: false, error: e.message ?? String(e) })
  }
}
