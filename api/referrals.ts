import type { VercelRequest, VercelResponse } from '@vercel/node'
import { neon } from '@neondatabase/serverless'
import { createRemoteJWKSet, jwtVerify } from 'jose'

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

function toE164(num: string): string {
  const digits = num.replace(/\D/g, '')
  return digits.length === 10 ? `+1${digits}` : `+${digits}`
}

function fmtDate(d: string | null | undefined): string {
  if (!d) return '—'
  try { return new Date(d).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) }
  catch { return String(d) }
}

// Escape a value for direct HTML insertion (no user-generated HTML
// rendered — safer to escape everything and keep formatting explicit).
function esc(v: any): string {
  if (v === null || v === undefined) return ''
  return String(v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function buildReferralHtml(data: {
  child: any
  specialist: { name: string; specialty?: string | null; fax_number?: string | null; address?: string | null }
  provider: { name?: string | null; role?: string | null; npi?: string | null }
  practice: {
    name: string
    phone?: string | null
    fax?: string | null
    referral_contact_name?: string | null
    referral_contact_phone?: string | null
    referral_contact_email?: string | null
  }
  reason: string
  urgency: string
  clinical_summary: string
  createdAt: Date
  // Attachment toggles (Sara 2026-09-21). Cover page always has
  // patient identity + allergies; these opt-in sections extend it
  // and become extra pages of the fax.
  attachments: {
    demographics: boolean
    insurance: boolean
    notes: Array<{
      id: string
      scheduled_date: string | null
      visit_type: string | null
      is_signed: boolean
      chief_complaint: string | null
      subjective: string | null
      objective: string | null
      assessment: string | null
      plan: string | null
      diagnoses: any
      cpt_codes: any
      provider_name?: string | null
    }>
  }
}): string {
  const c = data.child
  const childName = [c?.first_name, c?.last_name].filter(Boolean).join(' ') || c?.display_label || 'Unknown patient'
  const dob = fmtDate(c?.date_of_birth ? String(c.date_of_birth).split('T')[0] : null)
  const urgencyLabel = data.urgency === 'stat' ? 'STAT / Same day' : data.urgency === 'urgent' ? 'Urgent (within 1 week)' : 'Routine'
  const urgencyColor = data.urgency === 'stat' ? '#991B1B' : data.urgency === 'urgent' ? '#8A4B00' : '#31447A'
  const address = [c?.parent_address, c?.parent_city, c?.parent_state, c?.parent_zip].filter(Boolean).join(', ')

  const dxList = Array.isArray(c?.diagnoses) ? c.diagnoses : []

  const demographicsSection = data.attachments.demographics ? `
<div class="attachment page-break">
  <h1>Attachment: Demographics</h1>
  <div class="subtitle">${esc(childName)} · DOB ${esc(dob)}</div>
  <table class="kv">
    <tr><td>Address</td><td>${esc(address || 'Not on file')}</td></tr>
    <tr><td>Parent phone</td><td>${esc(c?.parent_phone || 'Not on file')}</td></tr>
    <tr><td>Parent email</td><td>${esc(c?.parent_email || 'Not on file')}</td></tr>
    ${c?.pcp ? `<tr><td>Primary care</td><td>${esc(c.pcp)}</td></tr>` : ''}
    ${c?.preferred_pharmacy ? `<tr><td>Preferred pharmacy</td><td>${esc(c.preferred_pharmacy)}</td></tr>` : ''}
  </table>
</div>
` : ''

  const insuranceSection = data.attachments.insurance ? `
<div class="attachment page-break">
  <h1>Attachment: Insurance</h1>
  <div class="subtitle">${esc(childName)} · DOB ${esc(dob)}</div>
  <table class="kv">
    <tr><td>Provider</td><td>${esc(c?.insurance_provider || 'Not on file')}</td></tr>
    ${c?.insurance_member_id ? `<tr><td>Member ID</td><td>${esc(c.insurance_member_id)}</td></tr>` : ''}
    ${c?.insurance_group_number ? `<tr><td>Group #</td><td>${esc(c.insurance_group_number)}</td></tr>` : ''}
    ${c?.insurance_subscriber_name ? `<tr><td>Subscriber</td><td>${esc(c.insurance_subscriber_name)}</td></tr>` : ''}
    ${c?.insurance_subscriber_dob ? `<tr><td>Subscriber DOB</td><td>${esc(fmtDate(String(c.insurance_subscriber_dob).split('T')[0]))}</td></tr>` : ''}
    ${c?.insurance_subscriber_relationship ? `<tr><td>Relationship</td><td>${esc(c.insurance_subscriber_relationship)}</td></tr>` : ''}
  </table>
</div>
` : ''

  const notesSections = data.attachments.notes.map(n => {
    const dxs = Array.isArray(n.diagnoses) ? n.diagnoses : []
    const cpts = Array.isArray(n.cpt_codes) ? n.cpt_codes : []
    return `
<div class="attachment page-break">
  <h1>Attachment: Encounter note</h1>
  <div class="subtitle">
    ${esc(childName)} · DOB ${esc(dob)}<br>
    ${esc(fmtDate(n.scheduled_date))}${n.visit_type ? ' · ' + esc(n.visit_type) : ''}${n.provider_name ? ' · ' + esc(n.provider_name) : ''}${n.is_signed ? ' · Signed' : ' · Draft (unsigned)'}
  </div>
  ${n.chief_complaint ? `<div class="section"><h2>Chief complaint</h2><div class="body-text">${esc(n.chief_complaint)}</div></div>` : ''}
  ${n.subjective ? `<div class="section"><h2>Subjective</h2><div class="body-text">${esc(n.subjective)}</div></div>` : ''}
  ${n.objective ? `<div class="section"><h2>Objective</h2><div class="body-text">${esc(n.objective)}</div></div>` : ''}
  ${n.assessment ? `<div class="section"><h2>Assessment</h2><div class="body-text">${esc(n.assessment)}</div></div>` : ''}
  ${n.plan ? `<div class="section"><h2>Plan</h2><div class="body-text">${esc(n.plan)}</div></div>` : ''}
  ${dxs.length ? `<div class="section"><h2>Diagnoses</h2><ul>${dxs.map((d: any) => `<li>${esc((d.code ?? '') + ' — ' + (d.name ?? d.description ?? ''))}</li>`).join('')}</ul></div>` : ''}
  ${cpts.length ? `<div class="section"><h2>CPT codes</h2><ul>${cpts.map((cp: any) => `<li>${esc((cp.code ?? '') + ' — ' + (cp.description ?? ''))}</li>`).join('')}</ul></div>` : ''}
</div>
`
  }).join('')

  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><style>
  body { font-family: system-ui, -apple-system, sans-serif; color: #1A1A2E; margin: 32px; font-size: 13px; line-height: 1.5; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .subtitle { color: #666; margin-bottom: 24px; font-size: 12px; }
  .practice-header { border-bottom: 2px solid #1A1A2E; padding-bottom: 14px; margin-bottom: 20px; }
  .practice-name { font-size: 16px; font-weight: 600; }
  .practice-contact { color: #666; font-size: 11px; margin-top: 3px; }
  .urgency { display: inline-block; padding: 4px 10px; border-radius: 4px; color: #fff; font-weight: 600; font-size: 12px; margin-bottom: 14px; }
  .section { margin: 18px 0; }
  .section h2 { font-size: 13px; text-transform: uppercase; letter-spacing: 0.06em; color: #666; margin: 0 0 6px; font-weight: 600; }
  table.kv { width: 100%; border-collapse: collapse; }
  table.kv td { padding: 4px 8px; vertical-align: top; border-bottom: 1px solid #F1EFE8; }
  table.kv td:first-child { color: #666; width: 130px; font-size: 12px; }
  .body-text { white-space: pre-wrap; padding: 10px 12px; background: #FAFAF8; border-left: 3px solid #7F77DD; border-radius: 4px; }
  .signature { margin-top: 32px; padding-top: 12px; border-top: 1px solid #E8E8E4; font-size: 12px; }
  .signature strong { display: block; font-size: 14px; }
  .footer { margin-top: 24px; font-size: 10px; color: #999; text-align: center; }
  .attachment { margin-top: 40px; padding-top: 24px; border-top: 3px double #1A1A2E; }
  .page-break { page-break-before: always; }
  ul { margin: 4px 0; padding-left: 20px; }
</style></head><body>

<div class="practice-header">
  <div class="practice-name">${esc(data.practice.name)}</div>
  <div class="practice-contact">
    ${data.practice.phone ? 'Phone: ' + esc(data.practice.phone) : ''}
    ${data.practice.phone && data.practice.fax ? ' · ' : ''}
    ${data.practice.fax ? 'Fax: ' + esc(data.practice.fax) : ''}
  </div>
</div>

<h1>Specialist Referral</h1>
<div class="subtitle">Sent ${fmtDate(data.createdAt.toISOString())}</div>

<div class="urgency" style="background: ${urgencyColor};">${esc(urgencyLabel)}</div>

<div class="section">
  <h2>Referring to</h2>
  <table class="kv">
    <tr><td>Specialist</td><td><strong>${esc(data.specialist.name)}</strong></td></tr>
    ${data.specialist.specialty ? `<tr><td>Specialty</td><td>${esc(data.specialist.specialty)}</td></tr>` : ''}
    ${data.specialist.address ? `<tr><td>Address</td><td>${esc(data.specialist.address)}</td></tr>` : ''}
    ${data.specialist.fax_number ? `<tr><td>Fax</td><td>${esc(data.specialist.fax_number)}</td></tr>` : ''}
  </table>
</div>

<div class="section">
  <h2>Patient</h2>
  <table class="kv">
    <tr><td>Name</td><td><strong>${esc(childName)}</strong></td></tr>
    <tr><td>DOB</td><td>${esc(dob)}</td></tr>
    ${c?.gender ? `<tr><td>Sex</td><td>${esc(c.gender)}</td></tr>` : ''}
    ${c?.allergies ? `<tr><td>Allergies</td><td><strong style="color:#991B1B;">${esc(c.allergies)}</strong></td></tr>` : ''}
    ${c?.current_medications ? `<tr><td>Medications</td><td>${esc(c.current_medications)}</td></tr>` : ''}
    ${c?.medical_history ? `<tr><td>PMH</td><td>${esc(c.medical_history)}</td></tr>` : ''}
    ${dxList.length ? `<tr><td>Diagnoses</td><td>${esc(dxList.map((d: any) => (d.code ?? '') + ' ' + (d.name ?? d.description ?? '')).join(', '))}</td></tr>` : ''}
  </table>
</div>

<div class="section">
  <h2>Reason for referral</h2>
  <div class="body-text">${esc(data.reason)}</div>
</div>

${data.clinical_summary ? `
<div class="section">
  <h2>Clinical summary</h2>
  <div class="body-text">${esc(data.clinical_summary)}</div>
</div>
` : ''}

<div class="signature">
  <strong>${esc(data.provider.name ?? 'Referring provider')}${data.provider.role ? ', ' + esc(data.provider.role) : ''}</strong>
  ${data.provider.npi ? 'NPI: ' + esc(data.provider.npi) : ''}<br>
  ${esc(data.practice.name)}${data.practice.phone ? ' · ' + esc(data.practice.phone) : ''}
</div>

${(data.practice.referral_contact_name || data.practice.referral_contact_phone || data.practice.referral_contact_email) ? `
<div class="section" style="margin-top: 18px; padding: 12px 14px; background: #EEEDFE; border: 1px solid #AFA9EC; border-radius: 6px;">
  <div style="font-size: 12px; font-weight: 600; color: #3C3489; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 4px;">
    Need more information?
  </div>
  <div style="font-size: 13px; color: #1A1A2E; line-height: 1.6;">
    Contact${data.practice.referral_contact_name ? ' <strong>' + esc(data.practice.referral_contact_name) + '</strong>' : ' our office'} at ${esc(data.practice.name)}${data.practice.referral_contact_phone ? ' — ' + esc(data.practice.referral_contact_phone) : ''}${data.practice.referral_contact_email ? ' · ' + esc(data.practice.referral_contact_email) : ''}
  </div>
</div>
` : ''}

${(data.attachments.demographics || data.attachments.insurance || data.attachments.notes.length > 0) ? `
<div class="section" style="margin-top: 24px;">
  <h2>Attachments included</h2>
  <ul>
    ${data.attachments.demographics ? '<li>Demographics</li>' : ''}
    ${data.attachments.insurance ? '<li>Insurance information</li>' : ''}
    ${data.attachments.notes.map(n => `<li>Encounter note — ${esc(fmtDate(n.scheduled_date))}${n.visit_type ? ` (${esc(n.visit_type)})` : ''}</li>`).join('')}
  </ul>
</div>
` : ''}

<div class="footer">
  Confidential medical referral — for the intended recipient only.
</div>

${demographicsSection}
${insuranceSection}
${notesSections}

</body></html>`
}

/**
 * /api/referrals
 *
 * POST — create a referral and fax it. Body:
 *   { child_id, specialist_id, reason, clinical_summary, urgency }
 *   ('routine' | 'urgent' | 'stat')
 * GET  — list referrals for a child (?child_id=<uuid>)
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  let sub: string
  try { sub = await verifyToken(req.headers.authorization) }
  catch { return res.status(401).json({ error: 'Unauthorized' }) }

  const sql = neon(process.env.DATABASE_URL!)

  const [prov] = await sql`SELECT id, name, role, practice_id FROM providers WHERE cognito_sub = ${sub} LIMIT 1`
  if (!prov) return res.status(403).json({ error: 'Provider not found' })
  const practiceId = prov.practice_id as string

  // Idempotent table bootstrap.
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS referrals (
        id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        practice_id               uuid NOT NULL REFERENCES practices(id) ON DELETE CASCADE,
        child_id                  uuid NOT NULL REFERENCES children(id) ON DELETE CASCADE,
        specialist_id             uuid REFERENCES specialists(id) ON DELETE SET NULL,
        specialist_name_snapshot  text NOT NULL,
        specialist_fax_snapshot   text,
        sent_by_provider_id       uuid REFERENCES providers(id) ON DELETE SET NULL,
        sent_by_provider_name     text,
        reason                    text NOT NULL,
        clinical_summary          text,
        urgency                   text NOT NULL DEFAULT 'routine',
        faxed_at                  timestamptz,
        fax_id                    text,
        fax_status                text NOT NULL DEFAULT 'pending',
        fax_error                 text,
        created_at                timestamptz NOT NULL DEFAULT now(),
        updated_at                timestamptz NOT NULL DEFAULT now()
      )
    `
    await sql`CREATE INDEX IF NOT EXISTS referrals_child_idx ON referrals(child_id)`
    await sql`CREATE INDEX IF NOT EXISTS referrals_practice_idx ON referrals(practice_id)`
  } catch (e: any) { console.error('referrals bootstrap failed:', e?.message) }

  if (req.method === 'GET') {
    const childId = req.query.child_id as string
    if (!childId) return res.status(400).json({ error: 'child_id required' })
    const rows = await sql`
      SELECT r.*, s.specialty AS specialist_specialty
      FROM referrals r
      LEFT JOIN specialists s ON s.id = r.specialist_id
      WHERE r.child_id = ${childId}::uuid AND r.practice_id = ${practiceId}::uuid
      ORDER BY r.created_at DESC
    `
    return res.status(200).json(rows)
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { child_id, specialist_id, reason, clinical_summary, urgency, attachments } = req.body ?? {}
  if (!child_id)       return res.status(400).json({ error: 'child_id required' })
  if (!specialist_id)  return res.status(400).json({ error: 'specialist_id required' })
  if (!reason?.trim()) return res.status(400).json({ error: 'reason required' })
  const urg = ['routine', 'urgent', 'stat'].includes(urgency) ? urgency : 'routine'
  const includeDemographics = !!attachments?.include_demographics
  const includeInsurance    = !!attachments?.include_insurance
  const noteIds = Array.isArray(attachments?.encounter_note_ids)
    ? (attachments.encounter_note_ids as unknown[]).filter((x): x is string => typeof x === 'string')
    : []

  // Resolve everything we need for the fax.
  const [child] = await sql`SELECT * FROM children WHERE id = ${child_id}::uuid AND practice_id = ${practiceId}::uuid LIMIT 1`
  if (!child) return res.status(404).json({ error: 'Patient not found' })
  const [specialist] = await sql`SELECT * FROM specialists WHERE id = ${specialist_id}::uuid AND practice_id = ${practiceId}::uuid LIMIT 1`
  if (!specialist) return res.status(404).json({ error: 'Specialist not found' })
  // Practice-level referral contact — the "call/email us if you need
  // more" line on every referral cover sheet. Sara set Pam as the
  // point of contact 2026-09-21. Bootstrap columns idempotently so
  // fresh preview branches don't break.
  try { await sql`ALTER TABLE practices ADD COLUMN IF NOT EXISTS referral_contact_name text` } catch {}
  try { await sql`ALTER TABLE practices ADD COLUMN IF NOT EXISTS referral_contact_phone text` } catch {}
  try { await sql`ALTER TABLE practices ADD COLUMN IF NOT EXISTS referral_contact_email text` } catch {}

  const [practice] = await sql`
    SELECT name, phone, fax,
           referral_contact_name, referral_contact_phone, referral_contact_email
    FROM practices WHERE id = ${practiceId}::uuid LIMIT 1
  `
  if (!practice) return res.status(500).json({ error: 'Practice not found' })

  // Persist the referral first with fax_status='pending' so we don't
  // lose the record if the Sinch call fails.
  const [ref] = await sql`
    INSERT INTO referrals (
      practice_id, child_id, specialist_id,
      specialist_name_snapshot, specialist_fax_snapshot,
      sent_by_provider_id, sent_by_provider_name,
      reason, clinical_summary, urgency, fax_status
    ) VALUES (
      ${practiceId}::uuid, ${child_id}::uuid, ${specialist_id}::uuid,
      ${specialist.name}, ${specialist.fax_number ?? null},
      ${prov.id}::uuid, ${prov.name ?? null},
      ${reason.trim()}, ${clinical_summary ?? null}, ${urg}, 'pending'
    )
    RETURNING *
  `

  // No fax number → mark as failed with clear reason. Referral row is
  // still saved so the biller/admin can act on it manually.
  if (!specialist.fax_number) {
    const [updated] = await sql`
      UPDATE referrals SET fax_status = 'failed', fax_error = 'No fax number on file for specialist', updated_at = NOW()
      WHERE id = ${ref.id}::uuid RETURNING *
    `
    return res.status(200).json(updated)
  }

  // Attempt fax via Sinch (same infra as PCP note fax).
  const projectId = process.env.SINCH_PROJECT_ID
  const keyId     = process.env.SINCH_KEY_ID
  const keySecret = process.env.SINCH_KEY_SECRET
  const fromNum   = process.env.SINCH_FAX_NUMBER
  if (!projectId || !keyId || !keySecret || !fromNum) {
    const [updated] = await sql`
      UPDATE referrals SET fax_status = 'failed', fax_error = 'Sinch fax credentials not configured', updated_at = NOW()
      WHERE id = ${ref.id}::uuid RETURNING *
    `
    return res.status(200).json(updated)
  }

  // Fetch the encounter notes the user selected to attach. Verifies
  // each belongs to this patient's chart in this practice — we won't
  // fax notes for a different child even if a bad id is sent.
  let attachedNotes: any[] = []
  if (noteIds.length > 0) {
    attachedNotes = await sql`
      SELECT en.id, en.scheduled_date, en.visit_type, en.is_signed,
             en.chief_complaint, en.subjective, en.objective, en.assessment, en.plan,
             en.diagnoses, en.cpt_codes,
             p.name AS provider_name
      FROM encounter_notes en
      LEFT JOIN providers p ON p.id = en.provider_id
      LEFT JOIN appointments a ON a.id = en.appointment_id
      WHERE en.id = ANY(${noteIds}::uuid[])
        AND en.practice_id = ${practiceId}::uuid
        AND en.child_id = ${child_id}::uuid
      ORDER BY COALESCE(en.scheduled_date, a.scheduled_date, en.created_at::date) DESC
    ` as any[]
    // Fill in scheduled_date from the joined appointment if the note
    // row doesn't have one directly.
    for (const n of attachedNotes) {
      if (!n.scheduled_date) {
        const [appt] = await sql`
          SELECT scheduled_date, visit_type FROM appointments
          WHERE id = (SELECT appointment_id FROM encounter_notes WHERE id = ${n.id}::uuid)
        `
        if (appt) {
          n.scheduled_date = appt.scheduled_date
          if (!n.visit_type) n.visit_type = appt.visit_type
        }
      }
    }
  }

  const html = buildReferralHtml({
    child,
    specialist: { name: specialist.name, specialty: specialist.specialty, fax_number: specialist.fax_number, address: specialist.address },
    provider: { name: prov.name, role: prov.role },
    practice: {
      name: practice.name,
      phone: practice.phone,
      fax: practice.fax,
      referral_contact_name:  practice.referral_contact_name,
      referral_contact_phone: practice.referral_contact_phone,
      referral_contact_email: practice.referral_contact_email,
    },
    reason: reason.trim(),
    clinical_summary: clinical_summary ?? '',
    urgency: urg,
    createdAt: new Date(ref.created_at),
    attachments: {
      demographics: includeDemographics,
      insurance: includeInsurance,
      notes: attachedNotes.map(n => ({
        id: n.id,
        scheduled_date: n.scheduled_date ? String(n.scheduled_date).split('T')[0] : null,
        visit_type: n.visit_type,
        is_signed: !!n.is_signed,
        chief_complaint: n.chief_complaint,
        subjective: n.subjective,
        objective: n.objective,
        assessment: n.assessment,
        plan: n.plan,
        diagnoses: n.diagnoses,
        cpt_codes: n.cpt_codes,
        provider_name: n.provider_name,
      })),
    },
  })

  try {
    const form = new FormData()
    form.append('to',   toE164(specialist.fax_number))
    form.append('from', toE164(fromNum))
    form.append('file', new Blob([html], { type: 'text/html' }), 'referral.html')

    const sinchRes = await fetch(
      `https://fax.api.sinch.com/v3/projects/${projectId}/faxes`,
      { method: 'POST', headers: { Authorization: 'Basic ' + Buffer.from(`${keyId}:${keySecret}`).toString('base64') }, body: form },
    )
    const rawText = await sinchRes.text().catch(() => '')
    let result: any = {}
    try { result = JSON.parse(rawText) } catch {}

    if (sinchRes.ok) {
      const [updated] = await sql`
        UPDATE referrals SET fax_status = 'sent', fax_id = ${result.id ?? null}, faxed_at = NOW(), updated_at = NOW()
        WHERE id = ${ref.id}::uuid RETURNING *
      `
      return res.status(200).json(updated)
    }
    console.error('[referral fax] Sinch error:', sinchRes.status, rawText)
    const [updated] = await sql`
      UPDATE referrals SET fax_status = 'failed', fax_error = ${`Sinch ${sinchRes.status}: ${rawText.slice(0, 500)}`}, updated_at = NOW()
      WHERE id = ${ref.id}::uuid RETURNING *
    `
    return res.status(200).json(updated)
  } catch (e: any) {
    const [updated] = await sql`
      UPDATE referrals SET fax_status = 'failed', fax_error = ${e?.message ?? 'Fax attempt threw'}, updated_at = NOW()
      WHERE id = ${ref.id}::uuid RETURNING *
    `
    return res.status(200).json(updated)
  }
}
