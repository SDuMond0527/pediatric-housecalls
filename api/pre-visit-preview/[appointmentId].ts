import type { VercelRequest, VercelResponse } from '@vercel/node'
import { neon } from '@neondatabase/serverless'
import { createRemoteJWKSet, jwtVerify } from 'jose'

// Pre-Visit Preview — one-screen summary built before every scheduled
// visit. Sara 2026-11-10 (Phase 1). Rules she set:
//   - Only data GoRoam already has. No outside sources.
//   - Every bullet cites a source (source_type + source_id).
//   - No history? Say so plainly. Never guess.
//   - No diagnoses, triage, risk scores, or treatment recommendations.
//   - Per-practice on/off + section hide/reorder.
//   - Log every view in phi_audit_log.
//
// This endpoint:
//   GET /api/pre-visit-preview/{appointmentId}
//     - Returns the stored preview if fresh.
//     - Generates on-demand if missing (handles same-day bookings in
//       the gap between the 15-min cron sweeps — Pediatric Housecalls
//       often books hours or minutes before the visit).
//     - Logs the view to phi_audit_log.
//
// Preview-shape contract (jsonb column `preview_data`):
//   {
//     version: 1,
//     appointment_id,
//     patient: { kind: 'child' | 'patient_profile', id, name, age_display }
//     sections: {
//       reason_for_visit:      { bullets: Bullet[] } | null
//       last_visit:            { bullets: Bullet[] } | null
//       open_items:            { bullets: Bullet[] } | null
//       changes_since_last:    { bullets: Bullet[] } | null
//       active_clinical:       { bullets: Bullet[] } | null
//       house_call_logistics:  { bullets: Bullet[] } | null  // only if practice uses house calls
//     }
//   }
//
//   Bullet = { text, source_type, source_id, source_label? }
//
// Missing section vs. empty section: a key is only present if the
// practice has that section ENABLED. Inside an enabled section, if there's
// no data, we emit a single "no history on file" bullet with source_type
// = 'none' so the UI renders the honest truth instead of hiding.

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

type Bullet = {
  text: string
  source_type: string
  source_id: string | null
  source_label?: string | null
}
type Section = { bullets: Bullet[] }
type PreviewData = {
  version: 1
  appointment_id: string
  patient: {
    kind: 'child' | 'patient_profile'
    id: string
    name: string
    age_display: string | null
  }
  sections: Record<string, Section | null>
}

// Default section config — practices start with everything enabled. The
// practice-settings UI (Phase 1 commit 3) lets Sara reorder or hide.
const DEFAULT_SECTION_CONFIG = {
  reason_for_visit:     { enabled: true, order: 1 },
  active_clinical:      { enabled: true, order: 2 },   // allergies + problems + meds — safety-critical, pinned high
  last_visit:           { enabled: true, order: 3 },
  changes_since_last:   { enabled: true, order: 4 },
  open_items:           { enabled: true, order: 5 },
  house_call_logistics: { enabled: true, order: 6 },   // auto-hidden server-side when practice doesn't do house calls
} as const

function ageDisplay(dobIso: string | null | undefined): string | null {
  if (!dobIso) return null
  try {
    const dob = new Date(String(dobIso).slice(0, 10) + 'T00:00:00Z')
    const now = new Date()
    const months = (now.getUTCFullYear() - dob.getUTCFullYear()) * 12 + (now.getUTCMonth() - dob.getUTCMonth())
    if (months < 24) return `${months} mo`
    const years = Math.floor(months / 12)
    return `${years} y`
  } catch { return null }
}

function parsePipeField(notes: string | null, key: string): string | null {
  if (!notes) return null
  const re = new RegExp(`${key}:([^|]+)`, 'i')
  const m = notes.match(re)
  return m ? m[1].trim() : null
}

/**
 * Build the preview data for one appointment. Reads only GoRoam data;
 * every bullet carries source attribution. Returns null if the
 * appointment doesn't exist (so the caller can 404).
 */
async function buildPreviewData(
  sql: any,
  appointmentId: string,
  practiceId: string,
  sectionConfig: Record<string, { enabled: boolean; order: number }>,
  practiceUsesHouseCalls: boolean,
): Promise<PreviewData | null> {
  const [appt] = await sql`
    SELECT id, child_id, provider_id, visit_type, scheduled_date, scheduled_time,
           duration_minutes, notes, status
    FROM appointments
    WHERE id = ${appointmentId}::uuid AND practice_id = ${practiceId}::uuid
    LIMIT 1`
  if (!appt) return null

  // Patient resolver — pediatric children table first, then Phase 4A
  // generic patient_profiles. Matches the project_multispecialty_
  // foundation pattern. If the appointment has no patient at all
  // (rare — e.g., CPR class), return a minimal shell.
  let patientKind: 'child' | 'patient_profile' = 'child'
  let patientId: string | null = appt.child_id ?? null
  let patientName = ''
  let patientDob: string | null = null
  let patientRow: any = null

  if (patientId) {
    const [c] = await sql`
      SELECT id, first_name, last_name, nickname, date_of_birth::text AS date_of_birth,
             allergies, current_medications, insurance_provider, insurance_member_id,
             parent_phone, parent_email, family_id
      FROM children
      WHERE id = ${patientId}::uuid AND practice_id = ${practiceId}::uuid`
    if (c) {
      patientRow = c
      patientName = [c.first_name, c.last_name].filter(Boolean).join(' ') || c.nickname || 'Unknown'
      patientDob = c.date_of_birth
    } else {
      // Phase 4A — generic patient_profiles row.
      const [pp] = await sql`
        SELECT id, first_name, last_name, date_of_birth::text AS date_of_birth,
               allergies, current_medications
        FROM patient_profiles
        WHERE id = ${patientId}::uuid AND practice_id = ${practiceId}::uuid`
      if (pp) {
        patientKind = 'patient_profile'
        patientRow = pp
        patientName = [pp.first_name, pp.last_name].filter(Boolean).join(' ') || 'Unknown'
        patientDob = pp.date_of_birth
      }
    }
  }

  const sections: Record<string, Section | null> = {}

  // Decide which sections render + their order.
  const orderedKeys = Object.entries(sectionConfig)
    .filter(([_, cfg]) => cfg.enabled)
    .sort(([_a, a], [_b, b]) => a.order - b.order)
    .map(([k]) => k)

  for (const key of orderedKeys) {
    // Server-side guard: house-call section is auto-hidden when the
    // practice doesn't do house calls, regardless of the toggle.
    if (key === 'house_call_logistics' && !practiceUsesHouseCalls) continue

    const bullets: Bullet[] = []
    const apptSource = { source_type: 'appointment', source_id: appt.id }

    if (key === 'reason_for_visit') {
      // Pulls in priority order: appointment notes CHIEF_COMPLAINT →
      // raw appointment.notes → booking_request.notes → visit_type.
      const chief = parsePipeField(appt.notes, 'CHIEF_COMPLAINT')
      if (chief) {
        bullets.push({ text: chief, ...apptSource, source_label: 'Chief complaint from booking' })
      } else if (appt.notes && appt.notes.trim() && !appt.notes.includes(':')) {
        // Free-text notes with no pipe delimiters — treat as the reason.
        bullets.push({ text: appt.notes.trim(), ...apptSource, source_label: 'Appointment notes' })
      }
      if (patientId) {
        const [br] = await sql`
          SELECT id, notes, visit_type
          FROM booking_requests
          WHERE ${patientId}::uuid = ANY(child_ids) AND notes IS NOT NULL AND notes <> ''
          ORDER BY created_at DESC LIMIT 1`
        if (br?.notes) bullets.push({ text: br.notes, source_type: 'booking_request', source_id: br.id, source_label: 'Booking request' })
      }
      if (!bullets.length && appt.visit_type) {
        bullets.push({ text: `Scheduled for: ${appt.visit_type}`, ...apptSource })
      }
      if (!bullets.length) bullets.push({ text: 'No reason captured for this visit.', source_type: 'none', source_id: null })
    }

    else if (key === 'active_clinical') {
      // Allergies FIRST — safety critical.
      const allergiesText = String(patientRow?.allergies ?? '').trim()
      const patientSrcType = patientKind === 'child' ? 'child' : 'patient_profile'
      if (!allergiesText || /^(nkda|none|no known)/i.test(allergiesText)) {
        bullets.push({ text: 'No known drug allergies.', source_type: patientSrcType, source_id: patientId, source_label: 'Allergies' })
      } else {
        bullets.push({ text: `Allergies: ${allergiesText}`, source_type: patientSrcType, source_id: patientId, source_label: 'Allergies' })
      }

      // Chronic problems — only unresolved.
      if (patientId) {
        const probs = await sql`
          SELECT id, label, icd10_code
          FROM chronic_problems
          WHERE child_id = ${patientId}::uuid AND resolved_at IS NULL
          ORDER BY added_at ASC`
        if (probs.length === 0) {
          bullets.push({ text: 'No chronic problems on file.', source_type: 'none', source_id: null, source_label: 'Problem list' })
        } else {
          for (const p of probs) {
            bullets.push({
              text: `${p.label}${p.icd10_code ? ` (${p.icd10_code})` : ''}`,
              source_type: 'chronic_problem',
              source_id: p.id,
              source_label: 'Problem list',
            })
          }
        }
      }

      // Medications (free text field — honest about its shape).
      const medsText = String(patientRow?.current_medications ?? '').trim()
      if (!medsText || /^(none|no meds)/i.test(medsText)) {
        bullets.push({ text: 'No current medications on file.', source_type: patientSrcType, source_id: patientId, source_label: 'Medications' })
      } else {
        bullets.push({ text: `Medications: ${medsText}`, source_type: patientSrcType, source_id: patientId, source_label: 'Medications' })
      }
    }

    else if (key === 'last_visit') {
      if (!patientId) {
        bullets.push({ text: 'No patient linked to this appointment.', source_type: 'none', source_id: null })
      } else {
        const [prior] = await sql`
          SELECT en.id, en.chief_complaint, en.assessment, en.plan, en.note_type, en.signed_at,
                 a.scheduled_date::text AS scheduled_date, a.visit_type,
                 p.name AS provider_name
          FROM encounter_notes en
          JOIN appointments a ON a.id = en.appointment_id
          LEFT JOIN providers p ON p.id = en.provider_id
          WHERE en.child_id = ${patientId}::uuid
            AND en.practice_id = ${practiceId}::uuid
            AND en.appointment_id <> ${appointmentId}::uuid
            AND en.is_signed = true
          ORDER BY a.scheduled_date DESC, en.signed_at DESC
          LIMIT 1`
        if (!prior) {
          bullets.push({ text: 'No prior signed notes on file — this is their first visit with the practice.', source_type: 'none', source_id: null })
        } else {
          const noteSource = { source_type: 'encounter_note', source_id: prior.id }
          bullets.push({
            text: `${prior.scheduled_date} — ${prior.visit_type ?? prior.note_type ?? 'Visit'}${prior.provider_name ? ` with ${prior.provider_name}` : ''}`,
            ...noteSource,
            source_label: 'Prior visit',
          })
          if (prior.chief_complaint?.trim()) {
            bullets.push({ text: `CC: ${prior.chief_complaint.trim()}`, ...noteSource, source_label: 'Prior chief complaint' })
          }
          if (prior.assessment?.trim()) {
            const asmt = prior.assessment.trim().slice(0, 500)  // raw trim; Claude summary is a later commit
            bullets.push({ text: `A: ${asmt}${prior.assessment.length > 500 ? '…' : ''}`, ...noteSource, source_label: 'Prior assessment' })
          }
          if (prior.plan?.trim()) {
            const plan = prior.plan.trim().slice(0, 500)
            bullets.push({ text: `P: ${plan}${prior.plan.length > 500 ? '…' : ''}`, ...noteSource, source_label: 'Prior plan' })
          }
        }
      }
    }

    else if (key === 'changes_since_last') {
      // "Changes since last visit" = diff'ing is complex; for Phase 1 we
      // surface high-signal events in the window between prior-visit date
      // and now: new chronic problems, new patient_communications entries.
      // ER/hospital isn't structured — stay honest, don't invent it.
      if (patientId) {
        const [prior] = await sql`
          SELECT a.scheduled_date::text AS scheduled_date
          FROM encounter_notes en JOIN appointments a ON a.id = en.appointment_id
          WHERE en.child_id = ${patientId}::uuid AND en.is_signed = true
            AND en.appointment_id <> ${appointmentId}::uuid
          ORDER BY a.scheduled_date DESC LIMIT 1`
        const sinceDate = prior?.scheduled_date ?? null
        const sinceClause = sinceDate ? ` since ${sinceDate}` : ' on file'

        // New unresolved chronic problems added since the prior visit.
        const newProbs = sinceDate
          ? await sql`SELECT id, label FROM chronic_problems WHERE child_id = ${patientId}::uuid AND added_at > ${sinceDate}::date AND resolved_at IS NULL`
          : []
        for (const np of newProbs as any[]) {
          bullets.push({ text: `New problem added: ${np.label}`, source_type: 'chronic_problem', source_id: np.id, source_label: 'Problem list' })
        }

        // Communications logged since prior visit.
        const comms = sinceDate
          ? await sql`SELECT id, communication_type, occurred_at, notes FROM patient_communications WHERE child_id = ${patientId}::uuid AND occurred_at > ${sinceDate}::date ORDER BY occurred_at DESC LIMIT 5`
          : []
        for (const c of comms as any[]) {
          const dt = new Date(c.occurred_at).toLocaleDateString()
          const summary = String(c.notes ?? '').slice(0, 120)
          bullets.push({
            text: `${dt} ${c.communication_type} contact${summary ? `: ${summary}` : ''}`,
            source_type: 'patient_communication',
            source_id: c.id,
            source_label: 'Communications log',
          })
        }

        if (!bullets.length) {
          bullets.push({ text: `No tracked changes${sinceClause}. Any ER visits or hospitalizations outside GoRoam won't show here — ask at the visit.`, source_type: 'none', source_id: null })
        }
      } else {
        bullets.push({ text: 'No patient linked to this appointment.', source_type: 'none', source_id: null })
      }
    }

    else if (key === 'open_items') {
      // Pending labs, pending radiology, unreviewed lab results.
      if (patientId) {
        const pendingLabs = await sql`
          SELECT id, tests, status FROM lab_orders
          WHERE child_id = ${patientId}::uuid AND status IN ('pending', 'submitted', 'partial')
          ORDER BY created_at DESC LIMIT 10`
        for (const lo of pendingLabs as any[]) {
          const testList = Array.isArray(lo.tests) ? lo.tests.map((t: any) => t.name ?? t.code ?? '').filter(Boolean).join(', ') : ''
          bullets.push({
            text: `Pending lab: ${testList || 'order'} (${lo.status})`,
            source_type: 'lab_order', source_id: lo.id, source_label: 'Lab orders',
          })
        }

        const pendingRad = await sql`
          SELECT id, tests, status FROM radiology_orders
          WHERE child_id = ${patientId}::uuid AND status IN ('pending', 'submitted', 'partial')
          ORDER BY created_at DESC LIMIT 10`
        for (const ro of pendingRad as any[]) {
          const testList = Array.isArray(ro.tests) ? ro.tests.map((t: any) => t.name ?? t.code ?? '').filter(Boolean).join(', ') : ''
          bullets.push({
            text: `Pending radiology: ${testList || 'order'} (${ro.status})`,
            source_type: 'radiology_order', source_id: ro.id, source_label: 'Radiology orders',
          })
        }

        const unreviewedResults = await sql`
          SELECT lr.id, lr.report_date::text AS report_date
          FROM lab_results lr
          WHERE lr.child_id = ${patientId}::uuid AND lr.is_reviewed = false
          ORDER BY lr.report_date DESC LIMIT 10`
        for (const lr of unreviewedResults as any[]) {
          bullets.push({
            text: `Unreviewed lab result from ${lr.report_date}`,
            source_type: 'lab_result', source_id: lr.id, source_label: 'Lab results',
          })
        }

        if (!bullets.length) {
          bullets.push({ text: 'No open items on file.', source_type: 'none', source_id: null })
        }
      } else {
        bullets.push({ text: 'No patient linked to this appointment.', source_type: 'none', source_id: null })
      }
    }

    else if (key === 'house_call_logistics' && practiceUsesHouseCalls) {
      // Address (from children/patient_profile parent OR family_profiles)
      let address: string | null = null
      let addressSourceType = 'family_profile'
      let addressSourceId: string | null = null
      if (patientKind === 'child' && patientRow?.family_id) {
        const [fp] = await sql`SELECT id, address_line1, city, state, zip FROM family_profiles WHERE id = ${patientRow.family_id}::uuid LIMIT 1`
        if (fp?.address_line1) {
          address = `${fp.address_line1}, ${fp.city ?? ''} ${fp.state ?? ''} ${fp.zip ?? ''}`.replace(/\s+/g, ' ').trim()
          addressSourceId = fp.id
        }
      }
      if (address) {
        bullets.push({ text: `Address: ${address}`, source_type: addressSourceType, source_id: addressSourceId, source_label: 'Family address' })
      } else {
        bullets.push({ text: 'No address on file.', source_type: 'none', source_id: null })
      }

      // Access notes extracted from pipe-delimited appointment.notes.
      const gateCode = parsePipeField(appt.notes, 'GATE_CODE') ?? parsePipeField(appt.notes, 'GATE')
      const parking  = parsePipeField(appt.notes, 'PARKING')
      const pets     = parsePipeField(appt.notes, 'PETS')
      const whoHome  = parsePipeField(appt.notes, 'WHO_HOME') ?? parsePipeField(appt.notes, 'PRESENT')
      if (gateCode) bullets.push({ text: `Gate code: ${gateCode}`, ...apptSource, source_label: 'Access notes' })
      if (parking)  bullets.push({ text: `Parking: ${parking}`,     ...apptSource, source_label: 'Access notes' })
      if (pets)     bullets.push({ text: `Pets: ${pets}`,           ...apptSource, source_label: 'Access notes' })
      if (whoHome)  bullets.push({ text: `Who will be home: ${whoHome}`, ...apptSource, source_label: 'Access notes' })

      // Parent contact (child flow only)
      if (patientKind === 'child') {
        if (patientRow?.parent_phone) bullets.push({ text: `Parent phone: ${patientRow.parent_phone}`, source_type: 'child', source_id: patientId, source_label: 'Contact' })
        if (patientRow?.parent_email) bullets.push({ text: `Parent email: ${patientRow.parent_email}`, source_type: 'child', source_id: patientId, source_label: 'Contact' })
      }
    }

    sections[key] = { bullets }
  }

  return {
    version: 1,
    appointment_id: appt.id,
    patient: {
      kind: patientKind,
      id: patientId ?? '',
      name: patientName || 'Unknown patient',
      age_display: ageDisplay(patientDob),
    },
    sections,
  }
}

async function bootstrap(sql: any): Promise<void> {
  // Our own table.
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS pre_visit_previews (
        id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        practice_id     uuid NOT NULL,
        appointment_id  uuid NOT NULL,
        preview_data    jsonb NOT NULL,
        generated_at    timestamptz NOT NULL DEFAULT NOW(),
        generated_by    text NOT NULL DEFAULT 'on_demand', -- 'cron' | 'on_demand' | 'manual'
        UNIQUE (appointment_id)
      )`
    await sql`CREATE INDEX IF NOT EXISTS idx_pre_visit_previews_practice ON pre_visit_previews(practice_id, generated_at DESC)`
  } catch (e: any) {
    console.error('[pre-visit-preview] bootstrap error (non-fatal):', e?.message)
  }
  // Defensive bootstraps for every table the generator reads. Each one
  // is idempotent-bootstrapped by its own owning endpoint, but a cron
  // or fresh-deploy request to THIS endpoint might arrive first and
  // find them missing. Minimal column set — we only query, don't write.
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS patient_communications (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        child_id uuid, provider_id uuid, provider_name text,
        communication_type text, occurred_at timestamptz,
        notes text, created_at timestamptz DEFAULT NOW()
      )`
  } catch {}
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS chronic_problems (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        child_id uuid, practice_id uuid, label text, icd10_code text,
        added_at timestamptz DEFAULT NOW(), resolved_at timestamptz
      )`
  } catch {}
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS radiology_orders (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        child_id uuid, tests jsonb, status text, created_at timestamptz DEFAULT NOW()
      )`
  } catch {}
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }
  let sub: string
  try { sub = await verifyToken(req.headers.authorization) }
  catch { return res.status(401).json({ error: 'Unauthorized' }) }

  const sql = neon(process.env.DATABASE_URL!)
  await bootstrap(sql)

  const [provider] = await sql`SELECT id, name, practice_id, is_admin FROM providers WHERE cognito_sub = ${sub} LIMIT 1`
  if (!provider) return res.status(403).json({ error: 'Provider not found' })
  const practiceId = provider.practice_id as string

  const appointmentId = String(req.query.appointmentId ?? '').trim()
  if (!appointmentId) return res.status(400).json({ error: 'appointmentId required' })

  // Pull practice settings — need to know section config + whether this
  // practice does house calls. Phase 1 feature flag is uses_pre_visit_preview.
  const [practice] = await sql`SELECT settings FROM practices WHERE id = ${practiceId}::uuid LIMIT 1`
  const settings = (practice?.settings ?? {}) as Record<string, any>
  const featureOn = settings.uses_pre_visit_preview !== false // default-on; opt-out via settings
  if (!featureOn) {
    return res.status(403).json({ error: 'Pre-Visit Preview is not enabled for this practice.' })
  }
  const sectionConfig = { ...DEFAULT_SECTION_CONFIG, ...(settings.pre_visit_preview_sections ?? {}) }
  // Any practice with any in-home visit type should get the house-call
  // section. For now, read a boolean flag; the project memory says the
  // multi-specialty foundation handles this via practice_visit_types but
  // Phase 1 can just use a flag — Sara can tune later.
  const practiceUsesHouseCalls = settings.uses_in_home_visits !== false // default-on for Pediatric Housecalls

  // POST = force regenerate (used by cron + manual refresh button).
  const forceRegenerate = req.method === 'POST'

  const [existing] = await sql`
    SELECT preview_data, generated_at
    FROM pre_visit_previews
    WHERE appointment_id = ${appointmentId}::uuid AND practice_id = ${practiceId}::uuid`

  let data: PreviewData | null = null
  if (existing && !forceRegenerate) {
    data = existing.preview_data as PreviewData
  } else {
    // On-demand generation — handles same-day bookings in the <15-min
    // window between cron sweeps. Sara 2026-11-10.
    data = await buildPreviewData(sql, appointmentId, practiceId, sectionConfig, practiceUsesHouseCalls)
    if (!data) return res.status(404).json({ error: 'Appointment not found' })
    try {
      await sql`
        INSERT INTO pre_visit_previews (practice_id, appointment_id, preview_data, generated_by)
        VALUES (${practiceId}::uuid, ${appointmentId}::uuid, ${JSON.stringify(data)}::jsonb,
                ${forceRegenerate ? 'manual' : 'on_demand'})
        ON CONFLICT (appointment_id) DO UPDATE SET
          preview_data = EXCLUDED.preview_data,
          generated_at = NOW(),
          generated_by = EXCLUDED.generated_by`
    } catch (e: any) {
      console.error('[pre-visit-preview] store failed (non-fatal, returning fresh data anyway):', e?.message)
    }
  }

  // Audit log the view — Sara's rule: log every viewer.
  try {
    await sql`
      INSERT INTO phi_audit_log (provider_id, action, resource_type, resource_id)
      VALUES (${provider.id}::uuid, 'view_pre_visit_preview', 'appointment', ${appointmentId})`
  } catch (e: any) {
    console.error('[pre-visit-preview] audit log failed (non-fatal):', e?.message)
  }

  return res.status(200).json({ data, generated_at: existing?.generated_at ?? new Date().toISOString() })
}
