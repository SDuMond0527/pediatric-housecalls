import type { VercelRequest, VercelResponse } from '@vercel/node'
import { neon } from '@neondatabase/serverless'
import { createRemoteJWKSet, jwtVerify } from 'jose'

const VISIT_DURATIONS: Record<string, number> = {
  'In-home sick visit': 60, 'Sports physical': 60, 'CMA + telemedicine': 60,
  'In-home IV fluids': 90, 'Video telemedicine': 30, 'Text visit': 15,
  'In-home CPR class (Heartsaver)': 180, 'In-home CPR class (BLS)': 180,
}

async function verifyAnyToken(authHeader: string | undefined): Promise<void> {
  if (!authHeader?.startsWith('Bearer ')) throw new Error('Missing token')
  const token = authHeader.slice(7)
  const region = process.env.VITE_AWS_REGION || 'us-east-2'
  const familyPoolId = process.env.VITE_FAMILY_USER_POOL_ID || ''
  if (familyPoolId) {
    try {
      const JWKS = createRemoteJWKSet(new URL(`https://cognito-idp.${region}.amazonaws.com/${familyPoolId}/.well-known/jwks.json`))
      const { payload } = await jwtVerify(token, JWKS, { issuer: `https://cognito-idp.${region}.amazonaws.com/${familyPoolId}` })
      if (payload.sub) return
    } catch {}
  }
  const providerPoolId = process.env.VITE_AWS_USER_POOL_ID || ''
  const JWKS = createRemoteJWKSet(new URL(`https://cognito-idp.${region}.amazonaws.com/${providerPoolId}/.well-known/jwks.json`))
  const { payload } = await jwtVerify(token, JWKS, { issuer: `https://cognito-idp.${region}.amazonaws.com/${providerPoolId}` })
  if (!payload.sub) throw new Error('No sub in token')
}

// ── Charm auth (Zoho refresh token flow) ─────────────────────────────────────

const CHARM_BASE_URL      = process.env.CHARM_BASE_URL      || 'https://ehr.charmtracker.com/api/ehr/v1'
const CHARM_CLIENT_ID     = process.env.CHARM_CLIENT_ID     || ''
const CHARM_CLIENT_SECRET = process.env.CHARM_CLIENT_SECRET || ''
const CHARM_REFRESH_TOKEN = process.env.CHARM_REFRESH_TOKEN || ''
const CHARM_API_KEY       = process.env.CHARM_API_KEY       || ''

async function getCharmToken(): Promise<string> {
  const tokenUrls = [
    'https://accounts.charmtracker.com/oauth/v2/token',
    'https://accounts106.charmtracker.com/oauth/v2/token',
  ]
  const params = new URLSearchParams({
    grant_type:    'refresh_token',
    refresh_token: CHARM_REFRESH_TOKEN,
    client_id:     CHARM_CLIENT_ID,
    client_secret: CHARM_CLIENT_SECRET,
  })
  let lastError = ''
  for (const url of tokenUrls) {
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: params })
      const data = await res.json()
      if (data.access_token) return data.access_token
      lastError = JSON.stringify(data)
    } catch (e: any) { lastError = e.message }
  }
  throw new Error(`Charm auth failed: ${lastError}`)
}

async function charmFetch(path: string, options: RequestInit = {}, token: string): Promise<any> {
  const res = await fetch(`${CHARM_BASE_URL}${path}`, {
    ...options,
    headers: {
      'Authorization': `Zoho-oauthtoken ${token}`,
      'api_key':       CHARM_API_KEY,
      'Content-Type':  'application/json',
      ...(options.headers ?? {}),
    },
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`Charm API ${res.status} on ${path}: ${text}`)
  return JSON.parse(text)
}

// ── Charm helpers ─────────────────────────────────────────────────────────────

async function getFacilityId(token: string): Promise<string> {
  const data = await charmFetch('/facilities', {}, token)
  const list = data.facilities || data.data || data
  if (!Array.isArray(list) || list.length === 0) throw new Error('No facilities found in Charm')
  return String(list[0].facility_id)
}

async function findMemberId(token: string, providerName: string): Promise<string | null> {
  const data = await charmFetch('/members', {}, token)
  const members = data.members || data.data || []
  if (!Array.isArray(members) || members.length === 0) return null
  const clinicalRoles = ['Physician', 'Nurse Practitioner']
  const clinical = members.filter((m: any) => clinicalRoles.some(r => m.roles?.includes(r)))
  const pool = clinical.length > 0 ? clinical : members
  if (providerName) {
    const lastName = providerName.split(' ').pop()?.toLowerCase() || ''
    const match = pool.find((m: any) =>
      m.full_name?.toLowerCase().includes(lastName) ||
      providerName.toLowerCase().includes((m.last_name || '').toLowerCase())
    )
    if (match) return String(match.member_id)
  }
  return pool.length > 0 ? String(pool[0].member_id) : null
}

async function enrichPatient(token: string, patientId: string, intake: Record<string, string>) {
  const allergies = intake.allergies || ''
  const isNKDA = ['nkda', 'none', 'no known allergies', ''].includes(allergies.toLowerCase().trim())
  if (!isNKDA) {
    const today = new Date().toISOString().split('T')[0]
    for (const allergen of allergies.split(',').map(a => a.trim()).filter(Boolean)) {
      await charmFetch(`/patients/${patientId}/allergies`, {
        method: 'POST',
        body: JSON.stringify({ allergen, type: 'Medication', severity: 'Mild', date: today, status: 'Active', reactions: '' }),
      }, token).catch(() => {})
    }
  }
}

async function updatePatient(token: string, patientId: string, intake: Record<string, string>, email: string) {
  const body: Record<string, unknown> = { email }
  if (intake.firstName)         body.first_name     = intake.firstName
  if (intake.lastName)          body.last_name      = intake.lastName
  if (intake.gender)            body.gender         = intake.gender === 'Female' ? 'female' : intake.gender === 'Male' ? 'male' : 'other'
  if (intake.pcp)               body.custom_field_1 = intake.pcp
  if (intake.preferredPharmacy) body.custom_field_2 = intake.preferredPharmacy
  // Charm v1 rejects address_line1/state/zip_code as "Extra key found in JSON"
  await charmFetch(`/patients/${patientId}`, { method: 'PUT', body: JSON.stringify(body) }, token).catch(() => {})
  await enrichPatient(token, patientId, intake)
}

async function findOrCreatePatient(
  token: string,
  facilityId: string,
  intake: Record<string, string>,
  familyEmail: string,
): Promise<string> {
  if (intake.firstName && intake.lastName) {
    const search = await charmFetch(
      `/patients?facility_id=${facilityId}&first_name_contains=${encodeURIComponent(intake.firstName)}&last_name_contains=${encodeURIComponent(intake.lastName)}`,
      {}, token,
    ).catch(() => null)
    const patients = search?.patients || search?.data || []
    if (Array.isArray(patients) && patients.length > 0) {
      const existingId = String(patients[0].patient_id)
      await updatePatient(token, existingId, intake, familyEmail)
      return existingId
    }
  }

  const body: Record<string, unknown> = {
    first_name: intake.firstName || 'Unknown',
    last_name:  intake.lastName  || 'Unknown',
    email:      familyEmail,
    gender:     intake.gender === 'Female' ? 'female' : intake.gender === 'Male' ? 'male' : 'other',
    facilities: [{ facility_id: facilityId }],
  }
  if (!intake.dateOfBirth) throw new Error(`DOB required for patient creation`)
  body.dob = intake.dateOfBirth

  const created = await charmFetch('/patients', { method: 'POST', body: JSON.stringify(body) }, token)
  const patientId = created.patient_id || created.data?.patient_id
  if (!patientId) throw new Error(`Patient creation failed: ${JSON.stringify(created)}`)

  await updatePatient(token, String(patientId), intake, familyEmail)
  return String(patientId)
}

// ── Handler ───────────────────────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(200).json({ ok: true })

  try {
    await verifyAnyToken(req.headers.authorization)
  } catch {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  if (!CHARM_CLIENT_ID || !CHARM_REFRESH_TOKEN) {
    return res.status(200).json({ ok: true, skipped: 'Charm not configured' })
  }

  const { bookingRequestId, childIntakes, appointmentDbId } = req.body

  try {
    const sql = neon(process.env.DATABASE_URL!)

    const [booking] = await sql`SELECT * FROM booking_requests WHERE id = ${bookingRequestId}::uuid LIMIT 1`
    if (!booking) return res.status(200).json({ ok: false, error: 'Booking not found' })

    const [family] = await sql`SELECT * FROM family_profiles WHERE id = ${booking.family_id}::uuid LIMIT 1`
    const children = booking.child_ids?.length
      ? await sql`SELECT * FROM children WHERE id = ANY(${JSON.stringify(booking.child_ids)}::uuid[])`
      : []

    if (!family || !children.length) return res.status(200).json({ ok: false, error: 'Family or children not found' })

    const token = await getCharmToken()
    const facilityId = process.env.CHARM_FACILITY_ID || await getFacilityId(token)
    const memberId = booking.preferred_provider
      ? await findMemberId(token, booking.preferred_provider)
      : null

    const visitAddress = (booking.notes ?? '').split('|').find((p: string) => p.trim().startsWith('ADDR:'))?.replace('ADDR:', '').trim() || ''
    const charmAppointmentIds: string[] = []

    for (const child of children) {
      const intake = ((childIntakes ?? {})[child.id] ?? {}) as Record<string, string>
      let charmPatientId: string | null = child.charm_patient_id || null

      if (!charmPatientId) {
        try {
          charmPatientId = await findOrCreatePatient(token, facilityId, intake, family.email)
        } catch {
          charmPatientId = process.env.CHARM_TEST_PATIENT_ID || null
          if (!charmPatientId) continue
        }
      } else {
        await updatePatient(token, charmPatientId, intake, family.email)
      }

      await sql`UPDATE children SET charm_patient_id = ${charmPatientId} WHERE id = ${child.id}::uuid`

      const complaint = [
        intake.chiefComplaint,
        intake.additionalInfo,
        visitAddress ? `Address: ${visitAddress}` : '',
        intake.medicalHistory ? `PMH: ${intake.medicalHistory}` : '',
        intake.currentMedications ? `Meds: ${intake.currentMedications}` : '',
        intake.vaccinationStatus ? `Vaccines: ${intake.vaccinationStatus}` : '',
        intake.insuranceProvider
          ? `Insurance: ${intake.insuranceProvider} | Member: ${intake.insuranceMemberId || '—'} | Group: ${intake.insuranceGroupNumber || '—'} | Subscriber: ${intake.insuranceSubscriberName || '—'}`
          : '',
        intake.preferredPharmacy ? `Pharmacy: ${intake.preferredPharmacy}` : '',
        intake.pcp ? `PCP: ${intake.pcp}` : '',
      ].filter(Boolean).join(' | ') || 'See booking'

      const [timePart, ampm] = booking.preferred_time.split(' ')
      const [h, m] = timePart.split(':')
      const startTime = `${h.padStart(2, '0')}:${m} ${ampm || 'AM'}`

      const apptBody = {
        patient_id:          charmPatientId,
        facility_id:         facilityId,
        member_id:           memberId ?? await findMemberId(token, '').catch(() => null),
        mode:                'In Person',
        repetition:          'Single Date',
        start_date:          booking.preferred_date,
        start_time:          startTime,
        duration_in_minutes: (VISIT_DURATIONS[booking.visit_type] ?? 60) + (['In-home sick visit','Sports physical','CMA + telemedicine','In-home IV fluids'].includes(booking.visit_type) ? (children.length - 1) * 15 : 0),
        reason:              complaint,
      }

      const apptResult = await charmFetch('/appointments', { method: 'POST', body: JSON.stringify(apptBody) }, token)
      const apptId = apptResult.appointment_id || apptResult.data?.appointment_id

      if (apptId) {
        charmAppointmentIds.push(String(apptId))
        if (appointmentDbId) {
          await sql`UPDATE appointments SET charm_appointment_id = ${String(apptId)}, charm_patient_id = ${charmPatientId} WHERE id = ${appointmentDbId}::uuid`
        }
      }
    }

    if (charmAppointmentIds.length) {
      await sql`UPDATE booking_requests SET charm_appointment_id = ${charmAppointmentIds.join(',')} WHERE id = ${bookingRequestId}::uuid`
    }
    await sql`UPDATE family_profiles SET charm_synced_at = NOW() WHERE id = ${family.id}::uuid`

    return res.status(200).json({ ok: true, charmAppointmentIds })
  } catch (err: any) {
    console.error('Charm appointment sync error:', err)
    return res.status(200).json({ ok: false, error: err.message ?? String(err) })
  }
}
