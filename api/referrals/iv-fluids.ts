import type { VercelRequest, VercelResponse } from '@vercel/node'
import { neon } from '@neondatabase/serverless'

const TWILIO_SID        = process.env.TWILIO_ACCOUNT_SID || ''
const TWILIO_API_KEY    = process.env.TWILIO_API_KEY_SID || ''
const TWILIO_API_SECRET = process.env.TWILIO_API_KEY_SECRET || ''
const TWILIO_FROM       = process.env.TWILIO_FROM_NUMBER || ''
const RESEND_API_KEY    = process.env.RESEND_API_KEY || ''
const FROM_EMAIL        = process.env.FROM_EMAIL || 'appointments@phcbooking.com'
const PRACTICE_NAME     = process.env.PRACTICE_NAME || 'Pediatric Housecalls'
const PORTAL_URL        = process.env.PORTAL_URL || 'https://phc-team.com'

function normalizePhone(phone: string): string {
  const digits = (phone ?? '').replace(/\D/g, '')
  if (digits.length === 10) return `+1${digits}`
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`
  return phone
}

async function sendSMS(to: string, body: string) {
  if (!TWILIO_SID || !TWILIO_API_KEY) {
    console.log(`[SMS SKIPPED — no key] To: ${to} | Body: ${body}`)
    return
  }
  const formData = new URLSearchParams({ From: TWILIO_FROM, To: normalizePhone(to), Body: body })
  const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${Buffer.from(`${TWILIO_API_KEY}:${TWILIO_API_SECRET}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: formData.toString(),
  })
  if (!r.ok) console.error('[referral SMS] failed:', await r.text().catch(() => ''))
}

async function sendEmail(to: string, subject: string, html: string) {
  if (!RESEND_API_KEY) return
  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: `${PRACTICE_NAME} <${FROM_EMAIL}>`, to, subject, html }),
  }).catch(e => console.error('[referral email] failed:', e?.message))
}

/**
 * POST /api/referrals/iv-fluids
 *
 * Public endpoint — urgent-care staff hit this via the QR-coded form at
 * /referral/iv-fluids. No auth. Creates a referrals_in row + alerts the
 * admin team by SMS + email. No PHI in either alert body.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const b = req.body ?? {}
  const required = (v: any) => typeof v === 'string' && v.trim().length > 0
  if (!required(b.referring_uc_name))          return res.status(400).json({ error: 'Referring urgent care name is required' })
  if (!required(b.referring_provider_name))    return res.status(400).json({ error: "Referring provider's name is required" })
  if (!b.provider_attestation)                 return res.status(400).json({ error: 'Please confirm you are a licensed provider referring this patient.' })
  if (!required(b.patient_first_name))         return res.status(400).json({ error: 'Patient first name is required' })
  if (!required(b.patient_last_name))          return res.status(400).json({ error: 'Patient last name is required' })
  if (!required(b.patient_dob))                return res.status(400).json({ error: 'Patient date of birth is required' })
  if (!required(b.patient_weight))             return res.status(400).json({ error: 'Patient weight is required' })
  if (!required(b.parent_name))                return res.status(400).json({ error: 'Parent name is required' })
  if (!required(b.parent_phone))               return res.status(400).json({ error: 'Parent phone is required' })
  if (!required(b.parent_email))               return res.status(400).json({ error: 'Parent email is required' })
  if (!required(b.parent_address))             return res.status(400).json({ error: 'Visit address is required' })

  const sql = neon(process.env.DATABASE_URL!)

  // Hard-coded practice resolution — the form is public and we only run
  // one practice today. If/when PHC runs multiple practices, add a
  // ?practice= slug on the QR URL.
  const [practice] = await sql`SELECT id FROM practices ORDER BY created_at LIMIT 1`
  if (!practice) return res.status(500).json({ error: 'Practice not configured' })
  const practiceId = practice.id

  try {
    await sql`
      CREATE TABLE IF NOT EXISTS referrals_in (
        id                           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        practice_id                  uuid NOT NULL,
        created_at                   timestamptz NOT NULL DEFAULT NOW(),
        updated_at                   timestamptz NOT NULL DEFAULT NOW(),
        referral_type                text NOT NULL DEFAULT 'iv_fluids',
        referring_uc_name            text NOT NULL,
        referring_provider_name      text NOT NULL,
        provider_attestation         boolean NOT NULL DEFAULT false,
        patient_first_name           text NOT NULL,
        patient_last_name            text NOT NULL,
        patient_dob                  date NOT NULL,
        patient_gender               text,
        patient_weight               text,
        parent_name                  text NOT NULL,
        parent_phone                 text NOT NULL,
        parent_email                 text NOT NULL,
        parent_address               text NOT NULL,
        insurance_provider           text,
        insurance_member_id          text,
        subscriber_name              text,
        subscriber_dob               date,
        subscriber_gender            text,
        insurance_card_front_url     text,
        insurance_card_back_url      text,
        iv_intake                    jsonb,
        status                       text NOT NULL DEFAULT 'new',
        status_updated_at            timestamptz,
        status_updated_by            text,
        appointment_id               uuid,
        activity_log                 jsonb NOT NULL DEFAULT '[]'::jsonb
      )`
  } catch {}

  const [row] = await sql`
    INSERT INTO referrals_in (
      practice_id,
      referring_uc_name, referring_provider_name, provider_attestation,
      patient_first_name, patient_last_name, patient_dob, patient_gender, patient_weight,
      parent_name, parent_phone, parent_email, parent_address,
      insurance_provider, insurance_member_id, subscriber_name, subscriber_dob, subscriber_gender,
      insurance_card_front_url, insurance_card_back_url,
      iv_intake
    ) VALUES (
      ${practiceId}::uuid,
      ${b.referring_uc_name.trim()}, ${b.referring_provider_name.trim()}, true,
      ${b.patient_first_name.trim()}, ${b.patient_last_name.trim()},
      ${b.patient_dob}::date, ${b.patient_gender ?? null}, ${b.patient_weight.trim()},
      ${b.parent_name.trim()}, ${b.parent_phone.trim()}, ${b.parent_email.trim()}, ${b.parent_address.trim()},
      ${b.insurance_provider ?? null}, ${b.insurance_member_id ?? null},
      ${b.subscriber_name ?? null}, ${b.subscriber_dob || null}::date, ${b.subscriber_gender ?? null},
      ${b.insurance_card_front_url ?? null}, ${b.insurance_card_back_url ?? null},
      ${JSON.stringify(b.iv_intake ?? {})}::jsonb
    )
    RETURNING id`
  const referralId = (row as any).id

  // Fan out alerts. No PHI in the SMS / email body — just the referring
  // UC name + a link to the referral inbox.
  const admins = await sql`
    SELECT phone, email, name FROM providers
    WHERE practice_id = ${practiceId}::uuid
      AND is_admin = true AND is_active = true
      AND COALESCE(receives_referral_alerts, false) = true` as any[]

  // Legacy fallback — before the receives_referral_alerts flag was wired
  // Sara is the sole alert recipient per her ask 2026-10-21. If no one
  // has opted in via the flag yet, send to the hard-coded cell.
  const recipients = admins.length > 0 ? admins : [{ phone: '704-560-4169', email: null, name: 'Sara' }]

  const alertBody = `New ${PRACTICE_NAME} referral from ${b.referring_uc_name.trim()}. Log in to GoRoam to view.`
  for (const r of recipients) {
    if (r.phone) await sendSMS(r.phone, alertBody)
    if (r.email) {
      await sendEmail(
        r.email,
        `New IV fluids referral from ${b.referring_uc_name.trim()}`,
        `<p>You have a new IV fluids referral in the GoRoam inbox.</p>
         <p>Open it: <a href="${PORTAL_URL}/admin/referrals">${PORTAL_URL}/admin/referrals</a></p>
         <p>(Patient details are inside the inbox — not included in this email for privacy.)</p>`
      )
    }
  }

  return res.json({ ok: true, id: referralId })
}
