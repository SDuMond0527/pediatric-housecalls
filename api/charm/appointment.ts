import type { VercelRequest, VercelResponse } from '@vercel/node'
import { verifyToken } from '../_lib/verifyToken'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    await verifyToken(req.headers.authorization)
  } catch {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const supabaseUrl = process.env.SUPABASE_URL
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY
  if (!supabaseUrl || !supabaseKey) return res.status(200).json({ ok: true }) // Non-critical

  try {
    await fetch(`${supabaseUrl}/functions/v1/charm-appointment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${supabaseKey}` },
      body: JSON.stringify(req.body),
    })
  } catch {
    // Non-critical — EHR sync failure shouldn't block booking
  }
  res.status(200).json({ ok: true })
}
