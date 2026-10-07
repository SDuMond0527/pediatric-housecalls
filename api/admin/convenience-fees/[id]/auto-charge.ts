import type { VercelRequest, VercelResponse } from '@vercel/node'
import { neon } from '@neondatabase/serverless'
import { createRemoteJWKSet, jwtVerify } from 'jose'

const CV_SQUARE_ACCESS_TOKEN  = process.env.SQUARE_ACCESS_TOKEN  || ''
const CV_SQUARE_ENV           = (process.env.SQUARE_ENVIRONMENT   || 'production').toLowerCase()
const CV_SQUARE_API_BASE      = CV_SQUARE_ENV === 'sandbox'
  ? 'https://connect.squareupsandbox.com'
  : 'https://connect.squareup.com'
const CV_MAX_AUTO_CHARGE_CENTS = 30000

async function verifyToken(authHeader: string | undefined): Promise<string> {
  if (!authHeader?.startsWith('Bearer ')) throw new Error('Missing token')
  const token = authHeader.slice(7)
  const region = process.env.VITE_AWS_REGION || 'us-east-2'
  const poolId = process.env.VITE_AWS_USER_POOL_ID || ''
  const JWKS = createRemoteJWKSet(new URL(`https://cognito-idp.${region}.amazonaws.com/${poolId}/.well-known/jwks.json`))
  const { payload } = await jwtVerify(token, JWKS, { issuer: `https://cognito-idp.${region}.amazonaws.com/${poolId}` })
  if (!payload.sub) throw new Error('No sub in token')
  return payload.sub as string
}

async function squarePost(path: string, body: any) {
  const res = await fetch(`${CV_SQUARE_API_BASE}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${CV_SQUARE_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
      'Square-Version': '2024-10-17',
    },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  let json: any
  try { json = JSON.parse(text) } catch { json = { raw: text } }
  if (!res.ok) {
    const err: any = new Error(json?.errors?.[0]?.detail ?? json?.message ?? `Square HTTP ${res.status}`)
    err.status = res.status
    err.body = json
    throw err
  }
  return json
}

/**
 * POST /api/admin/convenience-fees/[id]/auto-charge
 *
 * Fires a Square direct charge against the family's card on file for
 * a specific convenience_fee_charges row. Mirrors the auto-charge
 * logic from the sign-time path in api/encounter-notes/[id].ts but
 * callable on demand — used for pre-cutover rows (visits scheduled
 * before 2026-10-07) that didn't get an auto-charge attempt at
 * claim-gen time, and for retry after a failure.
 *
 * Idempotent via Square's idempotency_key = `cv_charge_${rowId}`.
 * Shipped 2026-10-07 after the Mackenzie Twigg (2026-10-06 visit) case.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  let sub: string
  try { sub = await verifyToken(req.headers.authorization) }
  catch { return res.status(401).json({ error: 'Unauthorized' }) }

  if (!CV_SQUARE_ACCESS_TOKEN) return res.status(500).json({ error: 'SQUARE_ACCESS_TOKEN not configured' })

  const cvId = req.query.id as string
  if (!cvId) return res.status(400).json({ error: 'id required' })

  const sql = neon(process.env.DATABASE_URL!)
  const [provider] = await sql`SELECT id, name, practice_id, is_admin FROM providers WHERE cognito_sub = ${sub} LIMIT 1`
  if (!provider) return res.status(403).json({ error: 'Provider not found' })
  if (!provider.is_admin) return res.status(403).json({ error: 'Admin only' })

  // Lookup the CV row + family's Square info.
  const [row] = await sql`
    SELECT cv.id, cv.claim_id, cv.amount_cents, cv.status, cv.service_date,
           cv.cv_code, cv.patient_name, cv.square_payment_id,
           c.patient_first_name, c.patient_last_name,
           ch.family_id,
           fp.square_customer_id, fp.square_card_id, fp.email
    FROM convenience_fee_charges cv
    LEFT JOIN claims c ON c.id = cv.claim_id
    LEFT JOIN children ch ON ch.id = c.child_id
    LEFT JOIN family_profiles fp ON fp.id = ch.family_id
    WHERE cv.id = ${cvId}::uuid AND cv.practice_id = ${provider.practice_id}::uuid
    LIMIT 1
  `
  if (!row) return res.status(404).json({ error: 'Convenience fee row not found' })

  if (row.status === 'auto_charged' || row.status === 'manually_charged' || row.status === 'paid') {
    return res.status(409).json({ error: `Already ${row.status}. No charge fired.` })
  }
  if (row.status === 'reversed') {
    return res.status(409).json({ error: 'This fee has been reversed. Create a new charge if needed.' })
  }
  if (!row.amount_cents || row.amount_cents <= 0) {
    return res.status(400).json({ error: 'Invalid amount on row.' })
  }
  if (row.amount_cents > CV_MAX_AUTO_CHARGE_CENTS) {
    return res.status(400).json({ error: `Safety cap: amount $${(row.amount_cents/100).toFixed(2)} exceeds $${(CV_MAX_AUTO_CHARGE_CENTS/100).toFixed(0)} cap. Charge manually in Square and click "Mark charged" instead.` })
  }
  if (!row.square_customer_id || !row.square_card_id) {
    return res.status(400).json({ error: 'No Square card on file for this family. Charge manually in Square and click "Mark charged", or ask the family to add a card.' })
  }

  const firstName = String(row.patient_first_name ?? '').trim() || 'your child'
  const dosStr = String(row.service_date).slice(0, 10)
  const dosDisplay = (() => { try { const d = new Date(dosStr); return `${d.getMonth()+1}/${d.getDate()}/${d.getFullYear()}` } catch { return dosStr } })()
  const practiceName = process.env.PRACTICE_NAME || 'Pediatric House Calls'
  const chargeNote = `${practiceName} — in-home visit convenience fee for ${firstName} on ${dosDisplay}. Thank you so much for allowing us to care for your child!`

  try {
    const payResp = await squarePost('/v2/payments', {
      idempotency_key: `cv_charge_${row.id}`,
      amount_money: { amount: row.amount_cents, currency: 'USD' },
      source_id: row.square_card_id,
      customer_id: row.square_customer_id,
      buyer_email_address: row.email ?? undefined,
      note: chargeNote,
    })
    const paymentId = payResp?.payment?.id
    if (!paymentId) {
      return res.status(500).json({ error: 'Square accepted request but no payment id returned', body: payResp })
    }
    await sql`
      UPDATE convenience_fee_charges
      SET status = 'auto_charged',
          charged_at = NOW(),
          square_payment_id = ${paymentId},
          updated_at = NOW()
      WHERE id = ${row.id}::uuid`
    return res.status(200).json({ ok: true, square_payment_id: paymentId, amount_cents: row.amount_cents })
  } catch (chargeErr: any) {
    const errMsg = chargeErr?.body?.errors?.[0]?.detail ?? chargeErr?.message ?? 'Square charge failed'
    await sql`
      UPDATE convenience_fee_charges
      SET failure_reason = ${errMsg},
          failed_at = NOW(),
          updated_at = NOW()
      WHERE id = ${row.id}::uuid`
    return res.status(500).json({ error: errMsg })
  }
}
