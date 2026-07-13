import type { VercelRequest, VercelResponse } from '@vercel/node'
import { neon } from '@neondatabase/serverless'
import { createHmac } from 'crypto'

// Verify Square webhook signature to ensure the request is genuine
function verifySquareSignature(req: VercelRequest, body: string): boolean {
  const sigKey = process.env.SQUARE_WEBHOOK_SIGNATURE_KEY
  if (!sigKey) return true // skip verification in dev if key not set

  const squareSig = req.headers['x-square-hmacsha256-signature'] as string
  if (!squareSig) return false

  // Square signs: WEBHOOK_URL + raw_body
  const webhookUrl = `https://${req.headers.host}/api/webhooks/square`
  const hmac = createHmac('sha256', sigKey)
    .update(webhookUrl + body)
    .digest('base64')

  return hmac === squareSig
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).end()

  // Square sends raw JSON body — read it as string for signature verification
  const rawBody = typeof req.body === 'string' ? req.body : JSON.stringify(req.body)

  if (!verifySquareSignature(req, rawBody)) {
    console.warn('[webhooks/square] Invalid signature')
    return res.status(401).json({ error: 'Invalid signature' })
  }

  const event = typeof req.body === 'string' ? JSON.parse(req.body) : req.body

  // We only care about payments that have reached COMPLETED status
  if (event.type !== 'payment.updated' && event.type !== 'payment.completed') {
    return res.status(200).json({ received: true })
  }

  const paymentStatus = event.data?.object?.payment?.status
  if (paymentStatus !== 'COMPLETED') {
    return res.status(200).json({ received: true })
  }

  const payment = event.data?.object?.payment
  if (!payment) return res.status(200).json({ received: true })

  const orderId    = payment.order_id as string | undefined
  const paidAmount = payment.total_money?.amount  // in cents
  const paidAt     = payment.updated_at ?? payment.created_at ?? new Date().toISOString()

  if (!orderId) return res.status(200).json({ received: true })

  try {
    const sql = neon(process.env.DATABASE_URL!)

    // Match by square_order_id (set when we created the payment link)
    const [stmt] = await sql`
      SELECT id, status, total_amount_due
      FROM patient_statements
      WHERE square_order_id = ${orderId}
      LIMIT 1
    `

    if (!stmt) {
      console.log(`[webhooks/square] No statement found for order_id ${orderId}`)
      return res.status(200).json({ received: true })
    }

    if (stmt.status === 'paid') {
      return res.status(200).json({ received: true, note: 'already paid' })
    }

    await sql`
      UPDATE patient_statements SET
        status   = 'paid',
        paid_at  = ${paidAt},
        paid_amount_cents = ${paidAmount ?? null},
        updated_at = NOW()
      WHERE id = ${stmt.id}
    `

    console.log(`[webhooks/square] Statement ${stmt.id} marked paid — order ${orderId}`)
    return res.status(200).json({ received: true, statement_id: stmt.id })

  } catch (e: any) {
    console.error('[webhooks/square] error:', e?.message)
    // Always return 200 to Square so it doesn't retry
    return res.status(200).json({ received: true })
  }
}
