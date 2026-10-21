import type { VercelRequest, VercelResponse } from '@vercel/node'
import { neon } from '@neondatabase/serverless'
import { createRemoteJWKSet, jwtVerify } from 'jose'
import { createHmac } from 'crypto'

const RESEND_API_KEY = process.env.RESEND_API_KEY || ''
const FROM_EMAIL     = process.env.FROM_EMAIL || 'appointments@phcbooking.com'
const PRACTICE_NAME  = process.env.PRACTICE_NAME || 'Pediatric Housecalls'
const PORTAL_URL     = process.env.PORTAL_URL || 'https://phc-team.com'
const UNSUB_SECRET   = process.env.MARKETING_UNSUBSCRIBE_SECRET || process.env.INTERNAL_SERVICE_TOKEN || ''

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

function wrapHtml(bodyHtml: string, unsubUrl: string): string {
  return `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#F6F3EE;font-family:-apple-system,Segoe UI,sans-serif;color:#1A1A2E;">
  <div style="max-width:600px;margin:0 auto;padding:12px 24px;background:#FEF3C7;border-bottom:1px solid #FDE68A;color:#92400E;font-size:12px;">
    <strong>TEST</strong> — this is only going to you so you can preview the layout. Real recipients will not see this banner.
  </div>
  <div style="max-width:600px;margin:0 auto;padding:24px;background:#FFFFFF;">
    ${bodyHtml}
  </div>
  <div style="max-width:600px;margin:0 auto;padding:16px 24px 32px;font-size:11px;color:#1A1A2E99;line-height:1.5;">
    <p style="margin:0 0 8px;">${PRACTICE_NAME} · 5960 Fairview Rd Suite 400, Charlotte, NC 28210</p>
    <p style="margin:0;">Not interested in marketing emails? <a href="${unsubUrl}" style="color:#1A1A2E99;">Unsubscribe here</a>. You'll still get appointment reminders, statements, and other transactional emails.</p>
  </div>
</body></html>`
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  let sub: string
  try { sub = await verifyToken(req.headers.authorization) }
  catch { return res.status(401).json({ error: 'Unauthorized' }) }

  const sql = neon(process.env.DATABASE_URL!)
  const [provider] = await sql`SELECT id, name, email, is_admin FROM providers WHERE cognito_sub = ${sub} LIMIT 1`
  if (!provider)          return res.status(403).json({ error: 'Provider not found' })
  if (!provider.is_admin) return res.status(403).json({ error: 'Admin only' })
  if (!provider.email)    return res.status(400).json({ error: 'Your provider record has no email on file.' })

  const { subject, html } = (req.body ?? {}) as { subject?: string; html?: string }
  if (!subject?.trim()) return res.status(400).json({ error: 'Subject required' })
  if (!html?.trim())    return res.status(400).json({ error: 'Body required' })

  // Dummy unsubscribe link — points at the admin's provider id so the
  // page renders, but no family row has that id so clicking it won't
  // opt anyone out.
  const token = UNSUB_SECRET
    ? createHmac('sha256', UNSUB_SECRET).update(provider.id).digest('hex').slice(0, 32)
    : 'preview'
  const unsubUrl = `${PORTAL_URL}/api/marketing/unsubscribe?f=${provider.id}&t=${token}`
  const wrapped = wrapHtml(html, unsubUrl)

  if (!RESEND_API_KEY || RESEND_API_KEY === 'PLACEHOLDER') {
    return res.json({ ok: true, skipped: true, to: provider.email })
  }

  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: `${PRACTICE_NAME} <${FROM_EMAIL}>`,
      to: provider.email,
      subject: `[TEST] ${subject}`,
      html: wrapped,
    }),
  })
  if (!r.ok) {
    const msg = await r.text().catch(() => '')
    return res.status(502).json({ error: `Resend rejected the send: ${msg}` })
  }
  return res.json({ ok: true, to: provider.email })
}
