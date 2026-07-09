import type { VercelRequest, VercelResponse } from '@vercel/node'
import { createHmac } from 'crypto'

const RESEND_API_KEY = process.env.RESEND_API_KEY || ''
const FROM_EMAIL     = process.env.FROM_EMAIL || 'appointments@phcbooking.com'
const PORTAL_URL     = process.env.PORTAL_URL || 'https://phcbooking.com'
const PRACTICE_NAME  = process.env.VITE_PRACTICE_NAME || 'Pediatric Housecalls'
const SECRET         = process.env.PASSWORD_RESET_SECRET || process.env.VITE_SUPABASE_ANON_KEY || 'dev-reset-secret'

function generateResetToken(email: string): string {
  const payload = { email, exp: Date.now() + 3_600_000 }
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const sig  = createHmac('sha256', SECRET).update(data).digest('base64url')
  return `${data}.${sig}`
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
  const { email } = req.body ?? {}
  if (!email || typeof email !== 'string') return res.status(400).json({ error: 'Email required' })

  const normalizedEmail = email.toLowerCase().trim()
  const token    = generateResetToken(normalizedEmail)
  const resetUrl = `${PORTAL_URL}/reset-password?token=${encodeURIComponent(token)}`

  console.log('forgot-password(provider): sending to', normalizedEmail, '| RESEND set:', !!RESEND_API_KEY)

  if (!RESEND_API_KEY) {
    console.error('forgot-password(provider): RESEND_API_KEY not set')
    return res.json({ ok: true })
  }

  const html = `
    <div style="font-family:sans-serif;max-width:480px;margin:0 auto;background:#FAFAF8;padding:32px 24px;border-radius:16px;">
      <div style="text-align:center;margin-bottom:24px;">
        <span style="font-size:22px;font-weight:600;color:#1A1A2E;">${PRACTICE_NAME}</span>
      </div>
      <div style="background:#fff;border:1px solid #E8E8E4;border-radius:12px;padding:28px;">
        <h2 style="margin:0 0 8px;font-size:18px;color:#1A1A2E;">Reset your provider password</h2>
        <p style="margin:0 0 20px;font-size:14px;color:#555;line-height:1.6;">
          We received a request to reset the password for your ${PRACTICE_NAME} provider account.
          Click the button below to set a new password. This link expires in <strong>1 hour</strong>.
        </p>
        <div style="text-align:center;margin:24px 0;">
          <a href="${resetUrl}" style="display:inline-block;background:#1A1A2E;color:#fff;text-decoration:none;padding:13px 28px;border-radius:10px;font-size:15px;font-weight:500;">
            Reset my password
          </a>
        </div>
        <p style="margin:0;font-size:12px;color:#999;line-height:1.6;">
          If you didn't request this, you can safely ignore this email — your password won't change.<br><br>
          Or copy this link into your browser:<br>
          <span style="color:#1A1A2E;word-break:break-all;">${resetUrl}</span>
        </p>
      </div>
    </div>`

  try {
    const r    = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: `${PRACTICE_NAME} <${FROM_EMAIL}>`, to: normalizedEmail, subject: 'Reset your provider password', html }),
    })
    const body = await r.json()
    if (!r.ok) console.error('forgot-password(provider): Resend error', r.status, JSON.stringify(body))
    else        console.log('forgot-password(provider): sent, id=', (body as any).id)
  } catch (e: any) {
    console.error('forgot-password(provider): fetch error', e?.message)
  }

  return res.json({ ok: true })
}
