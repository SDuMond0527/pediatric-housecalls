import type { VercelRequest, VercelResponse } from '@vercel/node'
import Stripe from 'stripe'

const PRICES = {
  starter:    'price_1TnlsEGimkikOFhOzCGy4s5D',
  practice:   'price_1TnlsNGimkikOFhOHsStTVvo',
  enterprise: 'price_1TnltiGimkikOFhOGpD6K97n',
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { plan, practice_name, admin_name, admin_email, phone } = req.body

  if (!plan || !PRICES[plan as keyof typeof PRICES]) {
    return res.status(400).json({ error: 'Invalid plan' })
  }
  if (!practice_name || !admin_email) {
    return res.status(400).json({ error: 'practice_name and admin_email are required' })
  }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!)

  const protocol = req.headers['x-forwarded-proto'] ?? 'https'
  const host = req.headers.host
  const base = `${protocol}://${host}`

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    line_items: [{ price: PRICES[plan as keyof typeof PRICES], quantity: 1 }],
    customer_email: admin_email,
    success_url: `${base}/signup/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${base}/signup`,
    metadata: { practice_name, admin_name: admin_name ?? '', admin_email, phone: phone ?? '', plan },
    subscription_data: {
      metadata: { practice_name, admin_name: admin_name ?? '', admin_email, phone: phone ?? '', plan },
    },
  })

  res.json({ url: session.url })
}
