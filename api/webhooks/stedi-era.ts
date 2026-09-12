import type { VercelRequest, VercelResponse } from '@vercel/node'
import { neon } from '@neondatabase/serverless'
import { createHmac } from 'crypto'
import { walkClaimPayments, findClaimByPCN, applyEraPaymentToClaim } from '../_lib/applyEraPayment'

// Stedi signs webhooks with HMAC-SHA256 — verify the header matches
// Header name: confirm in Stedi dashboard → Webhooks → your endpoint → Signing secret
function verifyStediSignature(req: VercelRequest, body: string): boolean {
  const secret = process.env.STEDI_WEBHOOK_SECRET
  if (!secret) return true // skip in dev if not configured

  const sig = (req.headers['x-stedi-signature'] ?? req.headers['x-webhook-signature']) as string
  if (!sig) return false

  const expected = 'sha256=' + createHmac('sha256', secret).update(body).digest('hex')
  return expected === sig
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).end()

  const rawBody = typeof req.body === 'string' ? req.body : JSON.stringify(req.body)

  if (!verifyStediSignature(req, rawBody)) {
    console.warn('[webhooks/stedi-era] Invalid signature')
    return res.status(401).json({ error: 'Invalid signature' })
  }

  const event = typeof req.body === 'string' ? JSON.parse(req.body) : req.body
  const sql = neon(process.env.DATABASE_URL!)

  // Idempotent column bootstrap so era_seen_at exists on any DB revision.
  try { await sql`ALTER TABLE claims ADD COLUMN IF NOT EXISTS era_seen_at timestamptz` } catch {}

  let processed = 0
  let skipped = 0
  const errors: string[] = []

  // Delegate the walk + match + write to the shared helper so the
  // webhook and the polling cron produce identical DB state. Previously
  // this handler updated the claims row but NEVER touched
  // patient_statements — which is exactly why the biller sees payments
  // in Stedi but nothing on her patient's statement.
  for (const { pcn, parsed } of walkClaimPayments(event)) {
    const claim = await findClaimByPCN(sql, pcn)
    if (!claim) { skipped++; continue }
    try {
      const { statementCreated } = await applyEraPaymentToClaim(sql, claim, parsed, event)
      processed++
      console.log(`[webhooks/stedi-era] ERA applied to claim ${claim.id} (PCN: ${pcn}, stmt ${statementCreated ? 'created' : 'updated'})`)
    } catch (e: any) {
      errors.push(`Claim ${claim.id}: ${e?.message ?? String(e)}`)
    }
  }

  console.log(`[webhooks/stedi-era] Done — ${processed} processed, ${skipped} skipped, ${errors.length} errors`)
  return res.status(200).json({ received: true, processed, skipped, errors })
}
