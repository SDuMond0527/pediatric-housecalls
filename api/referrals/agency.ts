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
    console.log(`[SMS SKIPPED — no key] To: ${to} | Body: ${body}`); return
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
  if (!r.ok) console.error('[agency referral SMS] failed:', await r.text().catch(() => ''))
}

async function sendEmail(to: string, subject: string, html: string) {
  if (!RESEND_API_KEY) return
  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: `${PRACTICE_NAME} <${FROM_EMAIL}>`, to, subject, html }),
  }).catch(e => console.error('[agency referral email] failed:', e?.message))
}

/**
 * POST /api/referrals/agency
 *
 * Public submit path for a home-care agency's nurse flagging a patient.
 * Mirrors the IV fluids referral endpoint but:
 *   - Keys off agency slug (not referring-UC name)
 *   - Clinical fields are generic ("change in condition" style)
 *   - Lands in the same referrals_in table, tagged with agency_id and
 *     referral_source_kind='agency' so the triage inbox can badge it
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const b = req.body ?? {}
  const slug = String(b.agency_slug ?? '').trim().toLowerCase()
  const required = (v: any) => typeof v === 'string' && v.trim().length > 0

  if (!slug)                                   return res.status(400).json({ error: 'agency_slug required' })
  if (!required(b.referring_provider_name))    return res.status(400).json({ error: "Submitting nurse's name is required" })
  if (!b.provider_attestation)                 return res.status(400).json({ error: 'Please confirm you are a licensed nurse referring this patient.' })
  if (!required(b.patient_first_name))         return res.status(400).json({ error: 'Patient first name is required' })
  if (!required(b.patient_last_name))          return res.status(400).json({ error: 'Patient last name is required' })
  if (!required(b.patient_dob))                return res.status(400).json({ error: 'Patient date of birth is required' })
  if (!required(b.parent_name))                return res.status(400).json({ error: 'Guardian / primary contact name is required' })
  if (!required(b.parent_phone))               return res.status(400).json({ error: 'Guardian / contact phone is required' })
  if (!required(b.parent_address))             return res.status(400).json({ error: 'Visit address is required' })
  if (!required(b.change_summary))             return res.status(400).json({ error: 'Change in condition summary is required' })

  const sql = neon(process.env.DATABASE_URL!)

  const [byName] = await sql`SELECT id FROM practices WHERE LOWER(name) = LOWER(${PRACTICE_NAME}) ORDER BY created_at LIMIT 1`
  const [fallback] = byName ? [byName] : await sql`SELECT id FROM practices ORDER BY created_at LIMIT 1`
  const practice = byName ?? fallback
  if (!practice) return res.status(500).json({ error: 'Practice not configured' })
  const practiceId = practice.id

  const [agency] = await sql`
    SELECT id, name FROM agencies
    WHERE practice_id = ${practiceId}::uuid AND slug = ${slug} AND is_active = true
    LIMIT 1`
  if (!agency) return res.status(404).json({ error: 'Agency not found or inactive' })

  // Bootstrap belt-and-suspenders — the agencies endpoint already creates
  // these columns on its first call, but a direct POST hit shouldn't ever
  // crash because of a cold schema.
  try { await sql`ALTER TABLE referrals_in ADD COLUMN IF NOT EXISTS agency_id uuid` } catch {}
  try { await sql`ALTER TABLE referrals_in ADD COLUMN IF NOT EXISTS referral_source_kind text` } catch {}

  const [row] = await sql`
    INSERT INTO referrals_in (
      practice_id, referral_type,
      referring_uc_name, referring_provider_name, provider_attestation,
      patient_first_name, patient_last_name, patient_dob, patient_gender, patient_weight,
      parent_name, parent_phone, parent_email, parent_address,
      insurance_provider, insurance_member_id, subscriber_name, subscriber_dob, subscriber_gender,
      insurance_card_front_url, insurance_card_back_url,
      iv_intake,
      agency_id, referral_source_kind
    ) VALUES (
      ${practiceId}::uuid, 'home_care',
      ${agency.name}, ${b.referring_provider_name.trim()}, true,
      ${b.patient_first_name.trim()}, ${b.patient_last_name.trim()},
      ${b.patient_dob}::date, ${b.patient_gender ?? null}, ${b.patient_weight ?? null},
      ${b.parent_name.trim()}, ${b.parent_phone.trim()}, ${b.parent_email ?? null}, ${b.parent_address.trim()},
      ${b.insurance_provider ?? null}, ${b.insurance_member_id ?? null},
      ${b.subscriber_name ?? null}, ${b.subscriber_dob || null}::date, ${b.subscriber_gender ?? null},
      ${b.insurance_card_front_url ?? null}, ${b.insurance_card_back_url ?? null},
      ${JSON.stringify({
        change_summary:  b.change_summary ?? null,
        symptoms:        b.symptoms ?? null,
        onset:           b.onset ?? null,
        vitals:          b.vitals ?? null,
        last_visit_date: b.last_visit_date ?? null,
        baseline_meds:   b.baseline_meds ?? null,
        other_notes:     b.other_notes ?? null,
      })}::jsonb,
      ${agency.id}::uuid, 'agency'
    )
    RETURNING id`
  const referralId = (row as any).id

  const admins = await sql`
    SELECT phone, email, name FROM providers
    WHERE practice_id = ${practiceId}::uuid
      AND is_admin = true AND is_active = true
      AND COALESCE(receives_referral_alerts, false) = true` as any[]
  const recipients = admins.length > 0 ? admins : [{ phone: '704-560-4169', email: null, name: 'Sara' }]

  const alertBody = `New ${PRACTICE_NAME} referral from ${agency.name}. Log in to GoRoam to view.`
  for (const r of recipients) {
    if (r.phone) await sendSMS(r.phone, alertBody)
    if (r.email) {
      await sendEmail(
        r.email,
        `New home-care referral from ${agency.name}`,
        `<p>You have a new referral in the GoRoam inbox.</p>
         <p>Open it: <a href="${PORTAL_URL}/admin/referrals">${PORTAL_URL}/admin/referrals</a></p>
         <p>(Patient details are inside the inbox — not included in this email for privacy.)</p>`
      )
    }
  }

  return res.json({ ok: true, id: referralId })
}
