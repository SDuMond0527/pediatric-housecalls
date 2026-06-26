import type { VercelRequest, VercelResponse } from '@vercel/node'
import sql from './_lib/db'
import { getProviderContext } from './_lib/auth'

async function squarePost(path: string, body: unknown) {
  const token = process.env.SQUARE_ACCESS_TOKEN || ''
  const env = process.env.SQUARE_ENVIRONMENT || 'production'
  const base = env === 'sandbox' ? 'https://connect.squareupsandbox.com' : 'https://connect.squareup.com'
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Square-Version': '2024-01-17',
    },
    body: JSON.stringify(body),
  })
  const json = await res.json() as any
  if (!res.ok) {
    const detail = json.errors?.[0]?.detail || json.errors?.[0]?.category || 'Square API error'
    throw new Error(detail)
  }
  return json
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  let practiceId: string
  try {
    const ctx = await getProviderContext(req.headers.authorization)
    practiceId = ctx.practiceId
  } catch {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { appointmentId, amountCents } = req.body as { appointmentId: string; amountCents: number }
  if (!appointmentId || !amountCents || amountCents < 50) {
    return res.status(400).json({ error: 'appointmentId and amountCents (min 50) required' })
  }

  // Load the appointment
  const [appt] = await sql`SELECT id, notes, charm_appointment_id FROM appointments WHERE id = ${appointmentId}::uuid AND practice_id = ${practiceId}::uuid LIMIT 1`
  if (!appt) return res.status(404).json({ error: 'Appointment not found' })

  // Prevent double-charging: check if already charged
  if ((appt.notes as string | null)?.includes('CHARGE_ID:')) {
    return res.status(409).json({ error: 'This appointment has already been charged' })
  }

  // Find the family — first try Ref code in notes, then charm_appointment_id
  let family: any = null

  const refMatch = (appt.notes as string | null)?.match(/Ref:\s*(PUC-\d+)/)
  if (refMatch) {
    const [br] = await sql`SELECT family_id FROM booking_requests WHERE reference_code = ${refMatch[1]} AND practice_id = ${practiceId}::uuid LIMIT 1`
    if (br) {
      ;[family] = await sql`SELECT square_customer_id, square_card_id FROM family_profiles WHERE id = ${br.family_id}::uuid AND practice_id = ${practiceId}::uuid LIMIT 1`
    }
  }

  if (!family && appt.charm_appointment_id) {
    const [br] = await sql`SELECT family_id FROM booking_requests WHERE charm_appointment_id = ${appt.charm_appointment_id} AND practice_id = ${practiceId}::uuid LIMIT 1`
    if (br) {
      ;[family] = await sql`SELECT square_customer_id, square_card_id FROM family_profiles WHERE id = ${br.family_id}::uuid AND practice_id = ${practiceId}::uuid LIMIT 1`
    }
  }

  if (!family?.square_card_id) {
    return res.status(404).json({ error: 'No card on file for this family' })
  }

  // Charge via Square
  let payment: any
  try {
    const result = await squarePost('/v2/payments', {
      idempotency_key: crypto.randomUUID(),
      amount_money: { amount: amountCents, currency: 'USD' },
      source_id: family.square_card_id,
      customer_id: family.square_customer_id,
      note: `Visit – appointment ${appointmentId}`,
    })
    payment = result.payment
  } catch (e: any) {
    return res.status(402).json({ error: e.message ?? 'Payment failed' })
  }

  // Append charge info to appointment notes
  const chargeTag = `|CHARGE_ID:${payment.id}|CHARGED_CENTS:${amountCents}`
  await sql`UPDATE appointments SET notes = COALESCE(notes, '') || ${chargeTag} WHERE id = ${appointmentId}::uuid AND practice_id = ${practiceId}::uuid`

  return res.json({
    ok: true,
    paymentId: payment.id,
    amountCents,
    cardBrand: payment.card_details?.card?.card_brand,
    last4: payment.card_details?.card?.last_4,
  })
}
