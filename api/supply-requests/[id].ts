import type { VercelRequest, VercelResponse } from '@vercel/node'
import { neon } from '@neondatabase/serverless'
import { createRemoteJWKSet, jwtVerify } from 'jose'

// PATCH /api/supply-requests/[id] — status transitions.
//   action=mark_ordered   (admin)   → ordered + ordered_by_name
//   action=mark_shipped   (admin)   → shipped + shipped_by_name + email provider
//   action=mark_received  (provider or admin)
//   action=cancel         (provider while status=requested, OR admin anytime)
//
// Sara 2026-11-19.

const RESEND_API_KEY = process.env.RESEND_API_KEY || ''
const FROM_EMAIL     = process.env.FROM_EMAIL || 'appointments@phcbooking.com'

async function verifyProviderToken(authHeader: string | undefined): Promise<string> {
  if (!authHeader?.startsWith('Bearer ')) throw new Error('Missing token')
  const token = authHeader.slice(7)
  const region = process.env.VITE_AWS_REGION || 'us-east-2'
  const poolId = process.env.VITE_AWS_USER_POOL_ID || ''
  const JWKS = createRemoteJWKSet(new URL(`https://cognito-idp.${region}.amazonaws.com/${poolId}/.well-known/jwks.json`))
  const { payload } = await jwtVerify(token, JWKS, { issuer: `https://cognito-idp.${region}.amazonaws.com/${poolId}` })
  if (!payload.sub) throw new Error('No sub in token')
  return payload.sub as string
}

function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))
}

async function emailProviderShipped(opts: {
  providerEmail: string
  providerName: string
  practiceName: string
  shippingAddress: string
  items: Array<{ supply_name: string; quantity: number; unit_label: string | null }>
}) {
  if (!RESEND_API_KEY || !opts.providerEmail) return
  const itemsHtml = opts.items.map(i =>
    `<li>${escapeHtml(i.supply_name)}${i.unit_label ? ` — ${escapeHtml(i.unit_label)}` : ''} × ${i.quantity}</li>`
  ).join('')
  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#1A1A2E;max-width:560px;margin:0 auto">
      <div style="padding:20px 24px;background:#1A1A2E;color:white;border-radius:12px 12px 0 0">
        <div style="font-size:18px;font-weight:600">Your supplies are on the way</div>
        <div style="color:#AFA9EC;font-size:12px;margin-top:4px">${escapeHtml(opts.practiceName)}</div>
      </div>
      <div style="padding:20px 24px;background:white;border:1px solid #E8E8E4;border-top:none;border-radius:0 0 12px 12px">
        <p style="font-size:14px;line-height:1.5;margin:0 0 12px">Hi ${escapeHtml(opts.providerName)},</p>
        <p style="font-size:14px;line-height:1.5;margin:0 0 12px">Your supply order has shipped. Expect it at:</p>
        <p style="font-size:13px;background:#FAFAF8;border:1px solid #E8E8E4;border-radius:8px;padding:10px 12px;margin:0 0 16px">${escapeHtml(opts.shippingAddress)}</p>
        <div style="font-size:12px;font-weight:600;color:#555;text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px">Items</div>
        <ul style="font-size:13px;margin:0 0 12px;padding-left:20px;line-height:1.6">${itemsHtml}</ul>
      </div>
    </div>`
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: `${opts.practiceName} <${FROM_EMAIL}>`,
        to: [opts.providerEmail],
        subject: 'Your supply order is on the way',
        html,
      }),
    })
  } catch (e: any) {
    console.error('[supply-requests] shipped email failed:', e?.message)
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'PATCH') return res.status(405).json({ error: 'Method not allowed' })

  let sub: string
  try { sub = await verifyProviderToken(req.headers.authorization) }
  catch { return res.status(401).json({ error: 'Unauthorized' }) }

  const sql = neon(process.env.DATABASE_URL!)
  const [actor] = await sql`SELECT id, name, practice_id, is_admin, is_super_admin FROM providers WHERE cognito_sub = ${sub} LIMIT 1`
  if (!actor) return res.status(403).json({ error: 'Provider not found' })
  const isAdmin = !!(actor.is_admin || actor.is_super_admin)

  const id = req.query.id as string
  if (!id) return res.status(400).json({ error: 'id required' })

  const b = req.body ?? {}
  const action = String(b.action ?? '')

  const [request] = await sql`
    SELECT * FROM supply_requests
    WHERE id = ${id}::uuid AND practice_id = ${actor.practice_id}::uuid
    LIMIT 1`
  if (!request) return res.status(404).json({ error: 'Request not found' })

  if (action === 'mark_ordered') {
    if (!isAdmin) return res.status(403).json({ error: 'Admin only' })
    if (request.status !== 'requested') return res.status(400).json({ error: `Can't mark ordered from status ${request.status}` })
    const [row] = await sql`
      UPDATE supply_requests
      SET status = 'ordered', ordered_at = NOW(), ordered_by_name = ${actor.name ?? 'Admin'}
      WHERE id = ${id}::uuid RETURNING *`
    return res.status(200).json(row)
  }

  if (action === 'mark_shipped') {
    if (!isAdmin) return res.status(403).json({ error: 'Admin only' })
    if (!['ordered','requested'].includes(request.status)) return res.status(400).json({ error: `Can't mark shipped from status ${request.status}` })
    const [row] = await sql`
      UPDATE supply_requests
      SET status = 'shipped', shipped_at = NOW(), shipped_by_name = ${actor.name ?? 'Admin'}
      WHERE id = ${id}::uuid RETURNING *`

    // Fire-and-forget notification email.
    try {
      const [prov] = await sql`SELECT name, email FROM providers WHERE id = ${request.provider_id}::uuid`
      const [prac] = await sql`SELECT name FROM practices WHERE id = ${request.practice_id}::uuid`
      const items = await sql`SELECT supply_name, quantity, unit_label FROM supply_request_items WHERE request_id = ${id}::uuid`
      if (prov?.email) {
        await emailProviderShipped({
          providerEmail:  prov.email as string,
          providerName:   (prov.name as string) ?? 'Provider',
          practiceName:   (prac?.name as string) ?? 'Your practice',
          shippingAddress: request.shipping_address ?? 'Your address on file',
          items: items as any,
        })
      }
    } catch (e: any) {
      console.error('[supply-requests] shipped email prep failed:', e?.message)
    }
    return res.status(200).json(row)
  }

  if (action === 'mark_received') {
    // Provider who owns the request OR admin.
    if (!isAdmin && String(actor.id) !== String(request.provider_id)) return res.status(403).json({ error: 'Not your request' })
    if (!['shipped','ordered'].includes(request.status)) return res.status(400).json({ error: `Can't mark received from status ${request.status}` })
    const [row] = await sql`
      UPDATE supply_requests
      SET status = 'received', received_at = NOW()
      WHERE id = ${id}::uuid RETURNING *`
    return res.status(200).json(row)
  }

  if (action === 'cancel') {
    const reason = typeof b.reason === 'string' ? b.reason.trim() || null : null
    // Provider can cancel their own request while requested; admin anytime
    // before received.
    const isOwner = String(actor.id) === String(request.provider_id)
    if (!isAdmin && !isOwner) return res.status(403).json({ error: 'Not your request' })
    if (!isAdmin && request.status !== 'requested') return res.status(400).json({ error: `Can only cancel a request that hasn't been ordered yet` })
    if (['received','cancelled'].includes(request.status)) return res.status(400).json({ error: `Already ${request.status}` })
    const [row] = await sql`
      UPDATE supply_requests
      SET status = 'cancelled', cancelled_at = NOW(),
          cancelled_by_name = ${actor.name ?? 'Unknown'}, cancelled_reason = ${reason}
      WHERE id = ${id}::uuid RETURNING *`
    return res.status(200).json(row)
  }

  return res.status(400).json({ error: `Unknown action: ${action}` })
}
