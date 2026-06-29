import type { VercelRequest, VercelResponse } from '@vercel/node'
import Stripe from 'stripe'
import { neon } from '@neondatabase/serverless'

export const config = { api: { bodyParser: false } }

async function getRawBody(req: VercelRequest): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', chunk => chunks.push(Buffer.from(chunk)))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).end()

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!)
  const sig = req.headers['stripe-signature'] as string
  const rawBody = await getRawBody(req)

  let event: Stripe.Event
  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET!)
  } catch (err: any) {
    return res.status(400).json({ error: `Webhook error: ${err.message}` })
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object as Stripe.Checkout.Session
    const { practice_name, admin_name, admin_email, phone, plan } = session.metadata ?? {}

    const sql = neon(process.env.DATABASE_URL!)
    await sql`
      INSERT INTO goroam_signups (
        practice_name, admin_name, admin_email, phone, plan,
        stripe_customer_id, stripe_subscription_id, stripe_session_id
      ) VALUES (
        ${practice_name ?? ''}, ${admin_name ?? ''}, ${admin_email ?? ''}, ${phone ?? ''}, ${plan ?? ''},
        ${session.customer as string ?? ''}, ${session.subscription as string ?? ''}, ${session.id}
      )
      ON CONFLICT (stripe_session_id) DO NOTHING`
  }

  res.json({ received: true })
}
