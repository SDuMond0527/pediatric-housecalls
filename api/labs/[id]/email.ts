import type { VercelRequest, VercelResponse } from '@vercel/node'
import { neon } from '@neondatabase/serverless'
import { createRemoteJWKSet, jwtVerify } from 'jose'

const RESEND_API_KEY = process.env.RESEND_API_KEY || ''
const FROM_EMAIL     = process.env.FROM_EMAIL || 'appointments@phcbooking.com'
const PRACTICE_NAME  = process.env.PRACTICE_NAME || 'Pediatric Housecalls'
const PRACTICE_PHONE = process.env.PRACTICE_PHONE || ''

async function verifyToken(authHeader: string | undefined): Promise<string> {
  if (!authHeader?.startsWith('Bearer ')) throw new Error('Missing token')
  const token = authHeader.slice(7)
  const region = process.env.VITE_AWS_REGION || 'us-east-2'
  const userPoolId = process.env.VITE_AWS_USER_POOL_ID || ''
  const JWKS = createRemoteJWKSet(new URL(`https://cognito-idp.${region}.amazonaws.com/${userPoolId}/.well-known/jwks.json`))
  const { payload } = await jwtVerify(token, JWKS, { issuer: `https://cognito-idp.${region}.amazonaws.com/${userPoolId}` })
  if (!payload.sub) throw new Error('No sub in token')
  return payload.sub
}

async function sendEmail(to: string, subject: string, html: string) {
  if (!RESEND_API_KEY || RESEND_API_KEY === 'PLACEHOLDER') {
    console.log(`[EMAIL SKIPPED — no key] To: ${to} | Subject: ${subject}`)
    return
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: `${PRACTICE_NAME} <${FROM_EMAIL}>`, to, subject, html }),
  })
  if (!res.ok) {
    const msg = await res.text()
    throw new Error(`Email failed: ${msg}`)
  }
}

function buildLabOrderEmail(opts: {
  patientName: string
  providerName: string
  orderedDate: string
  tests: { code: string; name: string }[]
  diagnoses: string[]
  priority: string
  notes?: string | null
}): string {
  const { patientName, providerName, orderedDate, tests, diagnoses, priority, notes } = opts

  const testRows = tests.map(t =>
    `<tr><td style="padding:8px 12px;border-bottom:1px solid #f0ede6;font-size:14px;color:#1a1a2e;">${t.name}</td><td style="padding:8px 12px;border-bottom:1px solid #f0ede6;font-size:13px;color:#777;font-family:monospace;">${t.code}</td></tr>`
  ).join('')

  const dxSection = diagnoses.length > 0
    ? `<p style="margin:0 0 6px;font-size:13px;color:#555;"><strong>Diagnoses:</strong> ${diagnoses.join(', ')}</p>`
    : ''

  const notesSection = notes
    ? `<p style="margin:6px 0 0;font-size:13px;color:#555;"><strong>Notes:</strong> ${notes}</p>`
    : ''

  const statBanner = priority === 'stat'
    ? `<div style="background:#fef2f2;border:1px solid #fca5a5;border-radius:8px;padding:10px 14px;margin-bottom:16px;font-size:13px;color:#dc2626;font-weight:600;">⚠ STAT order — please go to Labcorp as soon as possible.</div>`
    : ''

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f5f4ef;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f4ef;padding:32px 0;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">

        <!-- Header -->
        <tr><td style="background:#1a1a2e;border-radius:12px 12px 0 0;padding:24px 32px;">
          <div style="font-size:20px;font-weight:700;color:#fff;letter-spacing:-0.3px;">${PRACTICE_NAME}</div>
          <div style="font-size:13px;color:#a0a0c0;margin-top:4px;">Lab Order</div>
        </td></tr>

        <!-- Body -->
        <tr><td style="background:#fff;padding:28px 32px;">
          <p style="margin:0 0 20px;font-size:15px;color:#1a1a2e;">Hi ${patientName.split(' ')[0]},</p>
          <p style="margin:0 0 20px;font-size:14px;color:#444;line-height:1.6;">
            Your provider has placed the following lab order. Please <strong>bring this email (printed or on your phone)</strong> to any Labcorp patient service center to have your labs drawn.
          </p>

          ${statBanner}

          <!-- Order details -->
          <div style="background:#fafaf8;border:1px solid #e8e8e4;border-radius:10px;padding:16px 20px;margin-bottom:20px;">
            <p style="margin:0 0 6px;font-size:13px;color:#555;"><strong>Patient:</strong> ${patientName}</p>
            <p style="margin:0 0 6px;font-size:13px;color:#555;"><strong>Ordering Provider:</strong> ${providerName}</p>
            <p style="margin:0 0 6px;font-size:13px;color:#555;"><strong>Order Date:</strong> ${orderedDate}</p>
            ${dxSection}
            ${notesSection}
          </div>

          <!-- Tests table -->
          <div style="margin-bottom:20px;">
            <div style="font-size:12px;font-weight:600;color:#999;text-transform:uppercase;letter-spacing:0.8px;margin-bottom:10px;">Tests Ordered</div>
            <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e8e8e4;border-radius:8px;overflow:hidden;border-collapse:collapse;">
              <thead>
                <tr style="background:#f5f4ef;">
                  <th style="padding:8px 12px;text-align:left;font-size:12px;font-weight:600;color:#666;">Test Name</th>
                  <th style="padding:8px 12px;text-align:left;font-size:12px;font-weight:600;color:#666;">Code</th>
                </tr>
              </thead>
              <tbody>${testRows}</tbody>
            </table>
          </div>

          <div style="background:#e8f4fd;border:1px solid #bfdbfe;border-radius:8px;padding:14px 16px;margin-bottom:20px;">
            <div style="font-size:13px;font-weight:600;color:#1e40af;margin-bottom:4px;">Find a Labcorp Location</div>
            <div style="font-size:13px;color:#1e40af;">Visit <a href="https://www.labcorp.com/labs-and-appointments/find-lab" style="color:#2563eb;">labcorp.com</a> to find the nearest patient service center. Most locations accept walk-ins.</div>
          </div>

          <p style="margin:0;font-size:13px;color:#777;line-height:1.6;">
            If you have questions, contact us${PRACTICE_PHONE ? ' at ' + PRACTICE_PHONE : ''}.
          </p>
        </td></tr>

        <!-- Footer -->
        <tr><td style="background:#f5f4ef;border-radius:0 0 12px 12px;padding:16px 32px;text-align:center;">
          <p style="margin:0;font-size:12px;color:#aaa;">${PRACTICE_NAME} · This email contains protected health information.</p>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  let sub: string
  try { sub = await verifyToken(req.headers.authorization) } catch {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const sql = neon(process.env.DATABASE_URL!)
  const [provider] = await sql`SELECT id, practice_id, name FROM providers WHERE cognito_sub = ${sub} LIMIT 1`
  if (!provider) return res.status(403).json({ error: 'Provider not found' })

  const orderId = req.query.id as string
  if (!orderId) return res.status(400).json({ error: 'Order ID required' })

  try {
    // Fetch order with child + family email, scoped to practice via providers join
    const [order] = await sql`
      SELECT
        o.id, o.tests, o.diagnoses, o.priority, o.notes, o.created_at,
        p.name AS provider_name,
        ch.first_name AS child_first_name, ch.last_name AS child_last_name,
        COALESCE(fp.email, ch.parent_email) AS family_email
      FROM lab_orders o
      JOIN providers p ON p.id = o.provider_id AND p.practice_id = ${provider.practice_id}::uuid
      JOIN children ch ON ch.id = o.child_id
      LEFT JOIN family_profiles fp ON fp.id = ch.family_id
      WHERE o.id = ${orderId}::uuid
    `
    if (!order) return res.status(404).json({ error: 'Order not found' })

    const email = order.family_email
    if (!email) return res.status(400).json({ error: 'No email address on file for this patient' })

    const patientName = [order.child_first_name, order.child_last_name].filter(Boolean).join(' ')
    const orderedDate = new Date(order.created_at).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })

    const html = buildLabOrderEmail({
      patientName,
      providerName: order.provider_name,
      orderedDate,
      tests: Array.isArray(order.tests) ? order.tests : [],
      diagnoses: Array.isArray(order.diagnoses) ? order.diagnoses : [],
      priority: order.priority ?? 'routine',
      notes: order.notes,
    })

    await sendEmail(email, `Lab Order — ${patientName}`, html)

    return res.status(200).json({ sent: true, to: email })
  } catch (err: any) {
    console.error('[labs email] error:', err)
    return res.status(500).json({ error: err.message ?? 'Failed to send email' })
  }
}
