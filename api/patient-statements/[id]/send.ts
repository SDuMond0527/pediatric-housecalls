import type { VercelRequest, VercelResponse } from '@vercel/node'
import { neon } from '@neondatabase/serverless'
import { createRemoteJWKSet, jwtVerify } from 'jose'

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

const RESEND_API_KEY    = process.env.RESEND_API_KEY || ''
const FROM_EMAIL        = process.env.FROM_EMAIL || 'billing@phcbooking.com'
const TWILIO_SID        = process.env.TWILIO_ACCOUNT_SID || ''
const TWILIO_API_KEY    = process.env.TWILIO_API_KEY_SID || ''
const TWILIO_API_SECRET = process.env.TWILIO_API_KEY_SECRET || ''
const TWILIO_FROM       = process.env.TWILIO_FROM_NUMBER || ''

async function sendEmail(to: string, subject: string, html: string) {
  if (!RESEND_API_KEY || RESEND_API_KEY === 'PLACEHOLDER') {
    console.log(`[EMAIL SKIPPED — no key] To: ${to} | Subject: ${subject}`)
    return
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: `Pediatric Housecalls <${FROM_EMAIL}>`, to, subject, html }),
  })
  if (!res.ok) {
    const msg = await res.text()
    console.error('Email error:', msg)
    throw new Error(`Email failed: ${msg}`)
  }
}

async function sendSMS(to: string, body: string) {
  if (!TWILIO_SID || !TWILIO_API_KEY) {
    console.log(`[SMS SKIPPED — no credentials] To: ${to} | Body: ${body}`)
    return
  }
  const formData = new URLSearchParams({ From: TWILIO_FROM, To: to, Body: body })
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${TWILIO_API_KEY}:${TWILIO_API_SECRET}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: formData,
  })
  if (!res.ok) {
    const msg = await res.text()
    console.error('SMS error:', msg)
    throw new Error(`SMS failed: ${msg}`)
  }
}

function fmtMoney(n: any): string {
  const v = parseFloat(n ?? 0)
  return isNaN(v) ? '$0.00' : `$${v.toFixed(2)}`
}

function fmtDate(d: string | null): string {
  if (!d) return '—'
  try {
    const s = String(d).split('T')[0]
    const [y, m, day] = s.split('-').map(Number)
    const date = new Date(y, m - 1, day)
    return date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
  } catch { return d ?? '—' }
}

function buildEmailHtml(stmt: any, paymentUrl: string): string {
  const cptRows = (stmt.cpt_codes ?? []).map((c: any) => `
    <tr>
      <td style="padding:8px 12px; border-bottom:1px solid #f0f0f0; color:#1A1A2E; font-size:13px;">${c.code}</td>
      <td style="padding:8px 12px; border-bottom:1px solid #f0f0f0; color:#555; font-size:13px;">${c.description ?? ''}</td>
    </tr>
  `).join('')

  const copay         = parseFloat(stmt.patient_copay ?? 0) || 0
  const deductible    = parseFloat(stmt.patient_deductible ?? 0) || 0
  const coinsurance   = parseFloat(stmt.patient_coinsurance ?? 0) || 0
  const nonCovered    = parseFloat(stmt.patient_non_covered ?? 0) || 0
  const priorBalance  = stmt.prior_balance && stmt.prior_balance !== '0' && stmt.prior_balance !== '0.00'
  const insPayment    = parseFloat(stmt.insurance_payment ?? 0) || 0

  const optionalRows = [
    copay > 0       ? `<tr><td style="padding:6px 0;color:#555;font-size:13px;">Patient Copay</td><td style="padding:6px 0;text-align:right;color:#1A1A2E;font-size:13px;">${fmtMoney(stmt.patient_copay)}</td></tr>` : '',
    deductible > 0  ? `<tr><td style="padding:6px 0;color:#555;font-size:13px;">Patient Deductible</td><td style="padding:6px 0;text-align:right;color:#1A1A2E;font-size:13px;">${fmtMoney(stmt.patient_deductible)}</td></tr>` : '',
    coinsurance > 0 ? `<tr><td style="padding:6px 0;color:#555;font-size:13px;">Patient Coinsurance</td><td style="padding:6px 0;text-align:right;color:#1A1A2E;font-size:13px;">${fmtMoney(stmt.patient_coinsurance)}</td></tr>` : '',
    nonCovered > 0  ? `<tr><td style="padding:6px 0;color:#555;font-size:13px;">Non-Covered Services</td><td style="padding:6px 0;text-align:right;color:#1A1A2E;font-size:13px;">${fmtMoney(stmt.patient_non_covered)}</td></tr>` : '',
    priorBalance    ? `<tr><td style="padding:6px 0;color:#555;font-size:13px;">Prior Balance</td><td style="padding:6px 0;text-align:right;color:#1A1A2E;font-size:13px;">${stmt.prior_balance}</td></tr>` : '',
  ].filter(Boolean).join('')

  // Build explanation paragraphs
  const explanations = stmt.explanations ?? []
  const explanationParas = explanations.map((ex: any) => {
    if (ex.type === 'deductible') {
      const amt = ex.applied ?? '0.00'
      return `<p style="font-size:13px;color:#444;line-height:1.6;margin:0 0 12px;">Your insurance processed this visit and applied $${amt} to your deductible.</p>`
    }
    if (ex.type === 'coinsurance') {
      const paid = ex.paid ?? '0.00'
      const responsibility = ex.responsibility ?? ex.copayAmount ?? '0.00'
      return `<p style="font-size:13px;color:#444;line-height:1.6;margin:0 0 12px;">Your insurance processed this visit and paid $${paid} toward the visit and they indicate that you are responsible for a co-insurance amount of $${responsibility}.</p>`
    }
    if (ex.type === 'copay') {
      const paid = ex.paid ?? '0.00'
      const copayAmt = ex.copayAmount ?? ex.responsibility ?? '0.00'
      return `<p style="font-size:13px;color:#444;line-height:1.6;margin:0 0 12px;">Your insurance processed this visit and paid $${paid} toward the visit and they indicate that you have a co-pay responsibility of $${copayAmt}.</p>`
    }
    return ''
  }).join('')

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:40px 20px;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">

        <!-- Header -->
        <tr>
          <td style="background:#1A1A2E;padding:28px 36px;">
            <p style="margin:0;color:#ffffff;font-size:20px;font-weight:700;letter-spacing:-0.3px;">
              Pediatric House<span style="color:#7F77DD;">calls</span>
            </p>
            <p style="margin:6px 0 0;color:rgba(255,255,255,0.6);font-size:13px;">Patient Statement</p>
          </td>
        </tr>

        <!-- Body -->
        <tr>
          <td style="padding:32px 36px;">

            <!-- Patient Info -->
            <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;border:1px solid #E8E8E4;border-radius:8px;overflow:hidden;">
              <tr style="background:#f9f9f7;">
                <td style="padding:8px 12px;font-size:11px;font-weight:600;color:#999;text-transform:uppercase;letter-spacing:0.5px;border-bottom:1px solid #E8E8E4;">Patient Name</td>
                <td style="padding:8px 12px;font-size:11px;font-weight:600;color:#999;text-transform:uppercase;letter-spacing:0.5px;border-bottom:1px solid #E8E8E4;">Date of Birth</td>
                <td style="padding:8px 12px;font-size:11px;font-weight:600;color:#999;text-transform:uppercase;letter-spacing:0.5px;border-bottom:1px solid #E8E8E4;">Date of Service</td>
              </tr>
              <tr>
                <td style="padding:10px 12px;font-size:13px;color:#1A1A2E;font-weight:500;">${stmt.patient_first_name ?? ''} ${stmt.patient_last_name ?? ''}</td>
                <td style="padding:10px 12px;font-size:13px;color:#1A1A2E;">${fmtDate(stmt.patient_dob)}</td>
                <td style="padding:10px 12px;font-size:13px;color:#1A1A2E;">${fmtDate(stmt.date_of_service)}</td>
              </tr>
            </table>

            <!-- CPT Codes -->
            ${cptRows ? `
            <p style="margin:0 0 8px;font-size:11px;font-weight:600;color:#999;text-transform:uppercase;letter-spacing:0.5px;">Services Rendered</p>
            <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;border:1px solid #E8E8E4;border-radius:8px;overflow:hidden;">
              <tr style="background:#f9f9f7;">
                <td style="padding:8px 12px;font-size:11px;font-weight:600;color:#999;text-transform:uppercase;letter-spacing:0.5px;border-bottom:1px solid #E8E8E4;">Code</td>
                <td style="padding:8px 12px;font-size:11px;font-weight:600;color:#999;text-transform:uppercase;letter-spacing:0.5px;border-bottom:1px solid #E8E8E4;">Description</td>
              </tr>
              ${cptRows}
            </table>` : ''}

            <!-- Financial Summary -->
            <p style="margin:0 0 8px;font-size:11px;font-weight:600;color:#999;text-transform:uppercase;letter-spacing:0.5px;">Financial Summary</p>
            <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;border:1px solid #E8E8E4;border-radius:8px;overflow:hidden;padding:4px 16px;">
              <tr><td style="padding:6px 0;color:#555;font-size:13px;">Amount Billed</td><td style="padding:6px 0;text-align:right;color:#1A1A2E;font-size:13px;">${fmtMoney(stmt.amount_billed)}</td></tr>
              <tr><td style="padding:6px 0;color:#555;font-size:13px;">Insurance Payment</td><td style="padding:6px 0;text-align:right;color:#1A1A2E;font-size:13px;">-${fmtMoney(insPayment)}</td></tr>
              <tr><td style="padding:6px 0;color:#555;font-size:13px;">Contractual Adjustment</td><td style="padding:6px 0;text-align:right;color:#1A1A2E;font-size:13px;">-${fmtMoney(stmt.contractual_adjustment)}</td></tr>
              ${optionalRows}
              <tr><td style="padding:6px 0;color:#555;font-size:13px;">Remaining Balance</td><td style="padding:6px 0;text-align:right;color:#1A1A2E;font-size:13px;">${fmtMoney(stmt.remaining_balance)}</td></tr>
              <tr style="border-top:2px solid #E8E8E4;">
                <td style="padding:10px 0 6px;color:#1A1A2E;font-size:15px;font-weight:700;">Total Amount Due</td>
                <td style="padding:10px 0 6px;text-align:right;color:#1A1A2E;font-size:15px;font-weight:700;">${fmtMoney(stmt.total_amount_due)}</td>
              </tr>
            </table>

            <!-- Explanations -->
            ${explanationParas ? `
            <div style="margin-bottom:24px;">
              ${explanationParas}
            </div>` : ''}

            <!-- Pay Now Button -->
            <div style="text-align:center;margin:32px 0 24px;">
              <a href="${paymentUrl}" style="display:inline-block;background:#7F77DD;color:#ffffff;text-decoration:none;font-size:15px;font-weight:600;padding:14px 40px;border-radius:8px;letter-spacing:0.2px;">Pay Now</a>
            </div>

            <!-- Disclaimer -->
            <div style="background:#f5f5f3;border-radius:8px;padding:16px 20px;margin-top:8px;">
              <p style="margin:0;font-size:12px;color:#666;line-height:1.6;">Per our payment policy, the card on file will be automatically charged for the total amount if the balance is not paid within 2 weeks of this statement. You will receive an automated receipt notifying you of that charge. If you prefer to pay by a different card, please click the payment link above. Thank you for allowing us to care for your child!</p>
            </div>

          </td>
        </tr>

        <!-- Footer -->
        <tr>
          <td style="background:#f9f9f7;padding:20px 36px;border-top:1px solid #E8E8E4;">
            <p style="margin:0;font-size:11px;color:#999;text-align:center;">Pediatric Housecalls &bull; Questions? Reply to this email or call your provider.</p>
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  try {
    const sub = await verifyToken(req.headers.authorization)
    const sql = neon(process.env.DATABASE_URL!)

    // Look up provider's practice_id
    const [provider] = await sql`SELECT practice_id FROM providers WHERE cognito_sub = ${sub} LIMIT 1`
    if (!provider) return res.status(403).json({ error: 'Provider not found' })
    const practiceId = provider.practice_id

    const statementId = req.query.id as string
    if (!statementId) return res.status(400).json({ error: 'id required' })

    // 1. Fetch statement + claim
    const [stmt] = await sql`
      SELECT ps.*, c.stedi_claim_id
      FROM patient_statements ps
      LEFT JOIN claims c ON c.id = ps.claim_id
      WHERE ps.id = ${statementId} AND ps.practice_id = ${practiceId}::uuid
      LIMIT 1
    `
    if (!stmt) return res.status(404).json({ error: 'Statement not found' })

    const totalAmountDue = stmt.total_amount_due ?? '0'

    // 2. Create Square payment link
    const squareRes = await fetch('https://connect.squareup.com/v2/online-checkout/payment-links', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.SQUARE_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        idempotency_key: `stmt-${statementId}-${Date.now()}`,
        quick_pay: {
          name: 'Pediatric Housecalls - Patient Balance',
          price_money: {
            amount: Math.round(parseFloat(totalAmountDue) * 100),
            currency: 'USD',
          },
          location_id: process.env.SQUARE_LOCATION_ID,
        },
      }),
    })

    if (!squareRes.ok) {
      const msg = await squareRes.text()
      console.error('Square payment link error:', msg)
      return res.status(500).json({ error: `Square API error: ${msg}` })
    }

    const squareData = await squareRes.json()
    const paymentUrl: string = squareData.payment_link?.url ?? squareData.payment_link?.long_url ?? ''
    const squareOrderId: string = squareData.payment_link?.order_id ?? ''
    const squareLinkId: string  = squareData.payment_link?.id ?? ''
    if (!paymentUrl) return res.status(500).json({ error: 'Square did not return a payment URL' })

    // 3. Save square IDs early so webhook can match this statement later
    await sql`
      UPDATE patient_statements SET
        square_payment_url    = ${paymentUrl},
        square_order_id       = ${squareOrderId || null},
        square_payment_link_id = ${squareLinkId || null},
        updated_at = NOW()
      WHERE id = ${statementId}
    `

    // Reload statement to get updated data for email
    const [updatedStmt] = await sql`SELECT * FROM patient_statements WHERE id = ${statementId} LIMIT 1`
    const emailStmt = updatedStmt ?? stmt

    // 4. Send email
    const emailTo = emailStmt.patient_email
    if (emailTo) {
      const subject = 'Your statement for Pediatric Housecalls is now available to view and pay.'
      const html = buildEmailHtml(emailStmt, paymentUrl)
      await sendEmail(emailTo, subject, html)
    }

    // 5. Send SMS
    const phoneTo = emailStmt.patient_phone
    if (phoneTo) {
      const dosFormatted = emailStmt.date_of_service
        ? new Date(emailStmt.date_of_service).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
        : '—'
      const smsBody = `Your statement from Pediatric Housecalls (DOS: ${dosFormatted}) is ready. Total due: ${fmtMoney(totalAmountDue)}. Pay online: ${paymentUrl} — Per our policy, the card on file will be auto-charged if unpaid within 2 weeks.`
      await sendSMS(phoneTo, smsBody)
    }

    // 6. Update statement status to sent
    const [finalStmt] = await sql`
      UPDATE patient_statements SET
        status = 'sent',
        sent_at = NOW(),
        square_payment_url    = ${paymentUrl},
        square_order_id       = ${squareOrderId || null},
        square_payment_link_id = ${squareLinkId || null},
        updated_at = NOW()
      WHERE id = ${statementId}
      RETURNING *
    `

    return res.status(200).json(finalStmt)
  } catch (e: any) {
    console.error('patient-statements send error:', e)
    return res.status(500).json({ error: e.message ?? 'Internal server error' })
  }
}
