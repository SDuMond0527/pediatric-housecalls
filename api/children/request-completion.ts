import type { VercelRequest, VercelResponse } from '@vercel/node'
import { neon } from '@neondatabase/serverless'
import { createRemoteJWKSet, jwtVerify } from 'jose'

// Staff-triggered endpoint. Given a child_id, look up the linked family's
// phone + email and send an SMS + email asking the parent to log into the
// family portal to complete their child's profile. The portal's dashboard
// and booking flows now both mount a mandatory CompleteChildProfileGate,
// so the parent is walked through every missing field the moment they
// arrive from the link.

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

const TWILIO_SID  = process.env.TWILIO_ACCOUNT_SID   || ''
const TWILIO_KEY  = process.env.TWILIO_API_KEY_SID   || ''
const TWILIO_SEC  = process.env.TWILIO_API_KEY_SECRET || ''
const TWILIO_FROM = process.env.TWILIO_FROM_NUMBER   || ''
const RESEND_KEY  = process.env.RESEND_API_KEY       || ''
const FROM_EMAIL  = process.env.FROM_EMAIL           || 'appointments@phcbooking.com'
const PORTAL_URL  = process.env.PORTAL_URL           || 'https://phc-team.com'
const PRACTICE    = process.env.PRACTICE_NAME        || 'Pediatric Housecalls'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' })

  try { await verifyToken(req.headers.authorization) }
  catch { return res.status(401).json({ ok: false, error: 'Unauthorized' }) }

  const { childId } = req.query as { childId: string }
  if (!childId) return res.status(400).json({ ok: false, error: 'childId required' })

  const sql = neon(process.env.DATABASE_URL!)

  const [row] = await sql`
    SELECT
      c.first_name,
      c.last_name,
      c.parent_phone,
      c.parent_email,
      fp.phone AS family_phone,
      fp.email AS family_email
    FROM children c
    LEFT JOIN family_profiles fp ON fp.id = c.family_id
    WHERE c.id = ${childId}::uuid
    LIMIT 1
  `
  if (!row) return res.status(404).json({ ok: false, error: 'Child not found' })

  const phone = String(row.parent_phone || row.family_phone || '').trim()
  const email = String(row.parent_email || row.family_email || '').trim()
  if (!phone && !email) {
    return res.status(400).json({ ok: false, error: 'No parent phone or email on file — nothing to send to.' })
  }

  const childName = [row.first_name, row.last_name].filter(Boolean).join(' ') || 'your child'
  const url = `${PORTAL_URL}/family/dashboard`
  const smsBody = `${PRACTICE}: We're missing some required info for ${childName}'s chart. Please log in and complete their profile so we can file claims / send prescriptions / order labs: ${url}`
  const emailSubject = `[Action needed] Complete ${childName}'s profile`
  const emailHtml = `<!DOCTYPE html><html><body style="font-family:sans-serif;color:#1A1A2E;max-width:600px;margin:0 auto;padding:20px;">
    <h2>${PRACTICE} — Please complete your child's profile</h2>
    <p>Our office needs some required information for <strong>${childName}</strong>'s chart before we can file insurance claims, send prescriptions, order labs, or otherwise fully care for them.</p>
    <p>Please log into the family portal and we'll walk you through the missing fields. It should take a minute.</p>
    <p style="margin:24px 0;"><a href="${url}" style="display:inline-block;padding:12px 24px;background:#7F77DD;color:#fff;text-decoration:none;border-radius:8px;font-weight:600;">Open the family portal</a></p>
    <p style="font-size:12px;color:#999;">— ${PRACTICE}</p>
  </body></html>`

  const results: Record<string, unknown> = { phone: !!phone, email: !!email }

  if (phone && TWILIO_SID && TWILIO_KEY) {
    try {
      const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${Buffer.from(`${TWILIO_KEY}:${TWILIO_SEC}`).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ From: TWILIO_FROM, To: phone, Body: smsBody }),
      })
      results.smsOk = r.ok
      if (!r.ok) results.smsErr = await r.text()
    } catch (e: any) { results.smsErr = String(e?.message ?? e) }
  }

  if (email && RESEND_KEY) {
    try {
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: `${PRACTICE} <${FROM_EMAIL}>`, to: email, subject: emailSubject, html: emailHtml }),
      })
      results.emailOk = r.ok
      if (!r.ok) results.emailErr = await r.text()
    } catch (e: any) { results.emailErr = String(e?.message ?? e) }
  }

  return res.json({ ok: true, results })
}
