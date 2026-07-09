import type { VercelRequest, VercelResponse } from '@vercel/node'
import { CognitoIdentityProviderClient, AdminGetUserCommand } from '@aws-sdk/client-cognito-identity-provider'
import { generateResetToken } from '../_lib/reset-token'

const RESEND_API_KEY = process.env.RESEND_API_KEY || ''
const FROM_EMAIL     = process.env.FROM_EMAIL || 'appointments@phcbooking.com'
const PORTAL_URL     = process.env.PORTAL_URL || 'https://phcbooking.com'
const PRACTICE_NAME  = process.env.VITE_PRACTICE_NAME || 'Pediatric Housecalls'

async function sendResetEmail(to: string, resetUrl: string) {
  if (!RESEND_API_KEY) return
  const html = `
    <div style="font-family:sans-serif;max-width:480px;margin:0 auto;background:#FAFAF8;padding:32px 24px;border-radius:16px;">
      <div style="text-align:center;margin-bottom:24px;">
        <span style="font-size:22px;font-weight:600;color:#1A1A2E;">${PRACTICE_NAME}</span>
      </div>
      <div style="background:#fff;border:1px solid #E8E8E4;border-radius:12px;padding:28px;">
        <h2 style="margin:0 0 8px;font-size:18px;color:#1A1A2E;">Reset your password</h2>
        <p style="margin:0 0 20px;font-size:14px;color:#555;line-height:1.6;">
          We received a request to reset the password for your ${PRACTICE_NAME} family account.
          Click the button below to set a new password. This link expires in <strong>1 hour</strong>.
        </p>
        <div style="text-align:center;margin:24px 0;">
          <a href="${resetUrl}" style="display:inline-block;background:#7F77DD;color:#fff;text-decoration:none;padding:13px 28px;border-radius:10px;font-size:15px;font-weight:500;">
            Reset my password
          </a>
        </div>
        <p style="margin:0;font-size:12px;color:#999;line-height:1.6;">
          If you didn't request this, you can safely ignore this email — your password won't change.<br><br>
          Or copy this link into your browser:<br>
          <span style="color:#7F77DD;word-break:break-all;">${resetUrl}</span>
        </p>
      </div>
    </div>`
  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: `${PRACTICE_NAME} <${FROM_EMAIL}>`, to, subject: 'Reset your password', html }),
  })
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
  const { email } = req.body ?? {}
  if (!email || typeof email !== 'string') return res.status(400).json({ error: 'Email required' })

  const region     = process.env.VITE_AWS_REGION || 'us-east-2'
  const userPoolId = process.env.VITE_FAMILY_USER_POOL_ID
  const accessKeyId     = process.env.AWS_ADMIN_ACCESS_KEY_ID
  const secretAccessKey = process.env.AWS_ADMIN_SECRET_ACCESS_KEY

  // Always return success to avoid email enumeration
  if (!userPoolId || !accessKeyId || !secretAccessKey) return res.json({ ok: true })

  try {
    const client = new CognitoIdentityProviderClient({ region, credentials: { accessKeyId, secretAccessKey } })
    await client.send(new AdminGetUserCommand({ UserPoolId: userPoolId, Username: email.toLowerCase().trim() }))
    // User exists — generate token and send email
    const token = generateResetToken(email.toLowerCase().trim(), 'family')
    const resetUrl = `${PORTAL_URL}/family/reset-password?token=${encodeURIComponent(token)}`
    await sendResetEmail(email, resetUrl)
  } catch {
    // User not found or other error — return success anyway (no enumeration)
  }

  return res.json({ ok: true })
}
