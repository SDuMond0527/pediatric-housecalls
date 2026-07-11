import type { VercelRequest, VercelResponse } from '@vercel/node'
import { neon } from '@neondatabase/serverless'
import { createRemoteJWKSet, jwtVerify } from 'jose'

async function verifyAnyToken(authHeader: string | undefined): Promise<{ sub: string; isFamily: boolean }> {
  if (!authHeader?.startsWith('Bearer ')) throw new Error('Missing token')
  const token = authHeader.slice(7)
  const region = process.env.VITE_AWS_REGION || 'us-east-2'
  const familyPoolId = process.env.VITE_FAMILY_USER_POOL_ID || ''
  if (familyPoolId) {
    try {
      const JWKS = createRemoteJWKSet(new URL(`https://cognito-idp.${region}.amazonaws.com/${familyPoolId}/.well-known/jwks.json`))
      const { payload } = await jwtVerify(token, JWKS, { issuer: `https://cognito-idp.${region}.amazonaws.com/${familyPoolId}` })
      if (payload.sub) return { sub: payload.sub, isFamily: true }
    } catch {}
  }
  const providerPoolId = process.env.VITE_AWS_USER_POOL_ID || ''
  const JWKS = createRemoteJWKSet(new URL(`https://cognito-idp.${region}.amazonaws.com/${providerPoolId}/.well-known/jwks.json`))
  const { payload } = await jwtVerify(token, JWKS, { issuer: `https://cognito-idp.${region}.amazonaws.com/${providerPoolId}` })
  if (!payload.sub) throw new Error('No sub in token')
  return { sub: payload.sub, isFamily: false }
}

async function sendWaitlistNotifications(entry: Record<string, unknown>, sql: ReturnType<typeof neon>) {
  const RESEND_KEY   = process.env.RESEND_API_KEY || ''
  const TWILIO_SID   = process.env.TWILIO_ACCOUNT_SID || ''
  const TWILIO_KEY   = process.env.TWILIO_API_KEY_SID || ''
  const TWILIO_SEC   = process.env.TWILIO_API_KEY_SECRET || ''
  const TWILIO_FROM  = process.env.TWILIO_FROM_NUMBER || ''
  const FROM_EMAIL   = process.env.FROM_EMAIL || 'appointments@phc-team.com'
  const PORTAL_URL   = process.env.PORTAL_URL || 'https://phc-team.com'
  const PRACTICE     = process.env.PRACTICE_NAME || 'Pediatric Housecalls'

  async function sendEmail(to: string, subject: string, html: string) {
    if (!RESEND_KEY) { console.error('[waitlist] no RESEND_API_KEY'); return }
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: `${PRACTICE} <${FROM_EMAIL}>`, to, subject, html }),
    })
    if (!r.ok) console.error('[waitlist] email error:', await r.text())
    else console.error('[waitlist] email sent to', to)
  }

  async function sendSMS(to: string, body: string) {
    if (!TWILIO_SID || !TWILIO_KEY) { console.error('[waitlist] no Twilio creds'); return }
    const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${TWILIO_KEY}:${TWILIO_SEC}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ From: TWILIO_FROM, To: to, Body: body }),
    })
    if (!r.ok) console.error('[waitlist] SMS error:', await r.text())
    else console.error('[waitlist] SMS sent to', to)
  }

  const stateLabel = entry.state === 'NC' ? 'North Carolina' : entry.state === 'SC' ? 'South Carolina' : entry.state === 'VA' ? 'Virginia' : (entry.state as string) || ''
  const smsBody = `${PRACTICE}: New waitlist entry${entry.zip ? ` (zip ${entry.zip})` : ''}. View: ${PORTAL_URL}/admin/waitlist`
  const emailSubject = `[Waitlist] New family${entry.zip ? ` — zip ${entry.zip}` : ''}${stateLabel ? `, ${stateLabel}` : ''}`
  const emailHtml = `<!DOCTYPE html><html><body style="font-family:sans-serif;color:#1A1A2E;">
<h2 style="color:#1A1A2E;">${PRACTICE} — New Waitlist Entry</h2>
<p>A family has joined the waitlist.</p>
<ul>
  ${entry.zip ? `<li><strong>Zip:</strong> ${entry.zip}</li>` : ''}
  ${stateLabel ? `<li><strong>State:</strong> ${stateLabel}</li>` : ''}
  ${entry.visit_type ? `<li><strong>Visit type:</strong> ${entry.visit_type}</li>` : ''}
  ${entry.preferred_time_window ? `<li><strong>Preferred time:</strong> ${entry.preferred_time_window}</li>` : ''}
</ul>
<p><a href="${PORTAL_URL}/admin/waitlist" style="background:#EF9F27;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none;">View waitlist</a></p>
</body></html>`

  const recipients = await sql`SELECT name, phone, email, states, role FROM providers WHERE is_active = true OR role = 'admin'`
  console.error('[waitlist] notifying', recipients.length, 'recipients')

  for (const prov of recipients) {
    const provStates: string[] = (prov.states ?? []) as string[]
    if (prov.role !== 'admin' && entry.state && provStates.length > 0 && !provStates.includes(entry.state as string)) {
      console.error('[waitlist] skipping', prov.name, '— state mismatch')
      continue
    }
    console.error('[waitlist] notifying', prov.name, 'email:', prov.email, 'phone:', prov.phone)
    if (prov.email) await sendEmail(prov.email, emailSubject, emailHtml).catch(e => console.error('[waitlist] email failed for', prov.name, e))
    if (prov.phone) await sendSMS(prov.phone, smsBody).catch(e => console.error('[waitlist] SMS failed for', prov.name, e))
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  let auth: { sub: string; isFamily: boolean }
  try {
    auth = await verifyAnyToken(req.headers.authorization)
  } catch {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const sql = neon(process.env.DATABASE_URL!)

  if (auth.isFamily) {
    const profileRows = await sql`SELECT id, practice_id FROM family_profiles WHERE cognito_sub = ${auth.sub} LIMIT 1`
    if (!profileRows.length) return res.json([])
    const practiceId = profileRows[0].practice_id as string
    const familyProfileId = profileRows[0].id as string

    if (req.method === 'GET') {
      const rows = await sql`SELECT id FROM waitlist_entries WHERE family_id = ${familyProfileId}::uuid AND practice_id = ${practiceId}::uuid AND status = 'waiting'`
      return res.json(rows)
    }

    if (req.method === 'POST') {
      const b = req.body
      const childIds: string[] = b.child_ids ?? []
      const childIdsPg = `{${childIds.join(',')}}`
      const [row] = await sql`
        INSERT INTO waitlist_entries (practice_id, family_id, child_ids, visit_type, zip, zone, state, complaint, status, notes, preferred_time_window)
        VALUES (${practiceId}::uuid, ${familyProfileId}::uuid, ${childIdsPg}::uuid[], ${b.visit_type}, ${b.zip ?? null}, ${b.zone ?? null}, ${b.state ?? null}, ${b.complaint ?? null}, 'waiting', ${b.notes ?? null}, ${b.preferred_time_window ?? null})
        RETURNING *`
      console.error('[waitlist] entry created:', row.id)
      await sendWaitlistNotifications(row as Record<string, unknown>, sql).catch(e => console.error('[waitlist] notification error:', e))
      return res.json(row)
    }

    return res.status(405).json({ error: 'Method not allowed' })
  }

  // Provider path
  const providerRows = await sql`SELECT practice_id, states FROM providers WHERE cognito_sub = ${auth.sub} LIMIT 1`
  if (!providerRows.length) return res.status(403).json({ error: 'Provider not found' })
  const practiceId = providerRows[0].practice_id as string
  const providerStates: string[] = (providerRows[0].states ?? []) as string[]

  if (req.method === 'GET') {
    const { status, family_id } = req.query as Record<string, string>
    let rows: unknown[]
    if (family_id) {
      rows = await sql`SELECT id FROM waitlist_entries WHERE family_id = ${family_id}::uuid AND practice_id = ${practiceId}::uuid AND status = 'waiting'`
    } else if (status) {
      if (providerStates.length > 0) {
        rows = await sql`SELECT * FROM waitlist_entries WHERE status = ${status} AND practice_id = ${practiceId}::uuid AND (state = ANY(${providerStates}::text[]) OR state IS NULL) ORDER BY created_at ASC`
      } else {
        rows = await sql`SELECT * FROM waitlist_entries WHERE status = ${status} AND practice_id = ${practiceId}::uuid ORDER BY created_at ASC`
      }
    } else {
      rows = await sql`SELECT * FROM waitlist_entries WHERE practice_id = ${practiceId}::uuid ORDER BY created_at DESC`
    }
    return res.json(rows)
  }

  if (req.method === 'POST') {
    const b = req.body
    const childIds: string[] = b.child_ids ?? []
    const childIdsPg = `{${childIds.join(',')}}`
    const [row] = await sql`
      INSERT INTO waitlist_entries (practice_id, family_id, child_ids, visit_type, zip, zone, state, complaint, status, notes, preferred_time_window)
      VALUES (${practiceId}::uuid, ${b.family_id}::uuid, ${childIdsPg}::uuid[], ${b.visit_type}, ${b.zip ?? null}, ${b.zone ?? null}, ${b.state ?? null}, ${b.complaint ?? null}, 'waiting', ${b.notes ?? null}, ${b.preferred_time_window ?? null})
      RETURNING *`
    return res.json(row)
  }

  res.status(405).json({ error: 'Method not allowed' })
}
