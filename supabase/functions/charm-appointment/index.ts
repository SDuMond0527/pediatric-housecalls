import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const CHARM_TOKEN_URL    = 'https://accounts.charmtracker.com/oauth/v2/token'
const CHARM_BASE_URL     = Deno.env.get('CHARM_BASE_URL')     || 'https://sandbox3.charmtracker.com/api/ehr/v1'
const CHARM_CLIENT_ID    = Deno.env.get('CHARM_CLIENT_ID')    || ''
const CHARM_CLIENT_SECRET = Deno.env.get('CHARM_CLIENT_SECRET') || ''
const CHARM_REFRESH_TOKEN = Deno.env.get('CHARM_REFRESH_TOKEN') || ''
const CHARM_API_KEY      = Deno.env.get('CHARM_API_KEY')      || ''

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
)

// ── Auth ──────────────────────────────────────────────────────────────────────

async function getCharmToken(): Promise<string> {
  const res = await fetch(CHARM_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type:    'refresh_token',
      refresh_token: CHARM_REFRESH_TOKEN,
      client_id:     CHARM_CLIENT_ID,
      client_secret: CHARM_CLIENT_SECRET,
    }),
  })
  const data = await res.json()
  if (!data.access_token) throw new Error(`Charm auth failed: ${JSON.stringify(data)}`)
  return data.access_token
}

async function charmFetch(path: string, options: RequestInit = {}, token: string): Promise<any> {
  const url = `${CHARM_BASE_URL}${path}`
  const res = await fetch(url, {
    ...options,
    headers: {
      'Authorization': `Zoho-oauthtoken ${token}`,
      'api_key':       CHARM_API_KEY,
      'Content-Type':  'application/json',
      ...(options.headers || {}),
    },
  })
  const text = await res.text()
  console.log(`Charm ${options.method || 'GET'} ${path} → ${res.status}:`, text.slice(0, 500))
  if (!res.ok) throw new Error(`Charm API ${res.status} on ${path}: ${text}`)
  return JSON.parse(text)
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function getFacilityId(token: string): Promise<string> {
  const data = await charmFetch('/facilities', {}, token)
  const list = data.facilities || data.data || data
  if (!Array.isArray(list) || list.length === 0) throw new Error('No facilities found in Charm')
  return String(list[0].facility_id)
}

async function enrichPatient(token: string, patientId: string, intake: Record<string, string>) {
  const today = new Date().toISOString().split('T')[0]
  const allergies = intake.allergies || ''
  const isNKDA = ['nkda', 'none', 'no known allergies', ''].includes(allergies.toLowerCase())

  if (!isNKDA) {
    // Split comma-separated allergies and add each one
    const allergenList = allergies.split(',').map(a => a.trim()).filter(Boolean)
    for (const allergen of allergenList) {
      await charmFetch(`/patients/${patientId}/allergies`, {
        method: 'POST',
        body: JSON.stringify({
          allergen,
          type: 'Medication',
          severity: 'Mild',
          date: today,
          status: 'Active',
          reactions: '',
        }),
      }, token).catch(e => console.log('Allergy add failed:', e.message))
    }
  }
}

async function updatePatient(
  token: string,
  patientId: string,
  intake: Record<string, string>,
  email: string,
) {
  const body: Record<string, unknown> = { email }
  if (intake.firstName)         body.first_name      = intake.firstName
  if (intake.lastName)          body.last_name       = intake.lastName
  if (intake.gender)            body.gender          = intake.gender === 'Female' ? 'female' : intake.gender === 'Male' ? 'male' : 'other'
  if (intake.pcp)               body.custom_field_1  = intake.pcp
  if (intake.preferredPharmacy) body.custom_field_2  = intake.preferredPharmacy
  // Charm v1 rejects address fields (address_line1, state, zip_code) as "Extra key found in JSON"
  // Visit address is included in the appointment reason field instead

  await charmFetch(`/patients/${patientId}`, {
    method: 'PUT',
    body: JSON.stringify(body),
  }, token).catch(e => console.log('Patient update failed:', e.message))
  await enrichPatient(token, patientId, intake)
}

async function findOrCreatePatient(
  token: string,
  facilityId: string,
  intake: Record<string, string>,
  familyEmail: string,
): Promise<string> {
  // Search for existing patient first
  if (intake.firstName && intake.lastName) {
    const search = await charmFetch(
      `/patients?facility_id=${facilityId}&first_name_contains=${encodeURIComponent(intake.firstName)}&last_name_contains=${encodeURIComponent(intake.lastName)}`,
      {}, token,
    )
    const patients = search.patients || search.data || []
    if (Array.isArray(patients) && patients.length > 0) {
      const existingId = String(patients[0].patient_id)
      console.log('Found existing Charm patient:', existingId)
      return existingId
    }
  }

  // Create new patient
  // Create with minimum confirmed-valid fields only
  const body: Record<string, unknown> = {
    first_name:  intake.firstName || 'Unknown',
    last_name:   intake.lastName  || 'Unknown',
    email:       familyEmail,
    gender:      intake.gender === 'Female' ? 'female' : intake.gender === 'Male' ? 'male' : 'other',
    facilities:  [{ facility_id: facilityId }],
  }
  if (intake.dateOfBirth) body.dob = intake.dateOfBirth
  else throw new Error(`DOB required for patient creation — missing for ${intake.firstName || 'Unknown'}`)

  const bodyStr = JSON.stringify(body)
  console.log('Patient body being sent to Charm:', bodyStr)
  const created = await charmFetch('/patients', { method: 'POST', body: bodyStr }, token)
  const patientId = created.patient_id || created.data?.patient_id
  if (!patientId) throw new Error(`Patient creation failed: ${JSON.stringify(created)}`)
  console.log('Created Charm patient:', patientId)

  // Update with additional data via PUT (separate call, non-blocking)
  await updatePatient(token, String(patientId), intake, familyEmail)
  await enrichPatient(token, String(patientId), intake)
  return String(patientId)
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
  return String(pool[0].member_id)
}

function to24hr(time: string): string {
  const [t, ampm] = time.split(' ')
  let [h, m] = t.split(':').map(Number)
  if (ampm === 'PM' && h !== 12) h += 12
  if (ampm === 'AM' && h === 12) h = 0
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`
}

// ── Main ──────────────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const { bookingRequestId, childIntakes, appointmentDbId } = await req.json()

    const { data: booking } = await supabase
      .from('booking_requests').select('*').eq('id', bookingRequestId).single()
    if (!booking) throw new Error('Booking not found')

    const { data: family } = await supabase
      .from('family_profiles').select('*').eq('id', booking.family_id).single()
    const { data: kids } = await supabase
      .from('children').select('*').in('id', booking.child_ids)

    if (!family || !kids?.length) throw new Error('Family or children not found')

    // Get one token for all calls
    const token = await getCharmToken()
    const facilityId = Deno.env.get('CHARM_FACILITY_ID') || await getFacilityId(token)

    // Find provider member ID
    const memberId = booking.preferred_provider
      ? await findMemberId(token, booking.preferred_provider)
      : null

    const charmAppointmentIds: string[] = []
    const visitAddress = booking.notes?.split('|').find((p: string) => p.startsWith('ADDR:'))?.replace('ADDR:', '').trim() || ''

    for (const child of kids) {
      const intake = (childIntakes?.[child.id] || {}) as Record<string, string>
      let charmPatientId: string | null = child.charm_patient_id || null

      if (!charmPatientId) {
        try {
          charmPatientId = await findOrCreatePatient(token, facilityId, intake, family.email)
          await supabase.from('children')
            .update({ charm_patient_id: String(charmPatientId) })
            .eq('id', child.id)
        } catch (e) {
          console.log('Patient creation failed:', e)
          charmPatientId = Deno.env.get('CHARM_TEST_PATIENT_ID') || '100181000000000531'
        }
      } else {
        // Update existing patient with latest data
        await updatePatient(token, charmPatientId, intake, family.email)
      }

      // Build appointment
      const complaint = [
        intake.chiefComplaint,
        intake.additionalInfo,
        visitAddress ? `Address: ${visitAddress}` : '',
        intake.medicalHistory ? `PMH: ${intake.medicalHistory}` : '',
        intake.currentMedications ? `Meds: ${intake.currentMedications}` : '',
        intake.vaccinationStatus ? `Vaccines: ${intake.vaccinationStatus}` : '',
        intake.insuranceProvider ? `Insurance: ${intake.insuranceProvider} | Member: ${intake.insuranceMemberId || '—'} | Group: ${intake.insuranceGroupNumber || '—'} | Subscriber: ${intake.insuranceSubscriberName || '—'} | Sub DOB: ${intake.insuranceSubscriberDob || '—'} | Sub Sex: ${intake.insuranceSubscriberGender || '—'}` : '',
        intake.preferredPharmacy ? `Pharmacy: ${intake.preferredPharmacy}` : '',
        intake.pcp ? `PCP: ${intake.pcp}` : '',
      ].filter(Boolean).join(' | ') || 'See booking'

      const apptBody: Record<string, unknown> = {
        patient_id:          charmPatientId,
        facility_id:         facilityId,
        member_id:           memberId || await findMemberId(token, '').then(id => id).catch(() => null),
        mode:                'In Person',
        repetition:          'Single Date',
        start_date:          booking.preferred_date,
        start_time:          (() => {
          const [t, ampm] = booking.preferred_time.split(' ')
          const [h, m] = t.split(':')
          return `${h.padStart(2, '0')}:${m} ${ampm}`
        })(),
        duration_in_minutes: 60 + (kids.length - 1) * 15,
        reason:              complaint,
      }
      console.log('Appointment body being sent to Charm:', JSON.stringify(apptBody))

      const apptResult = await charmFetch('/appointments', {
        method: 'POST',
        body: JSON.stringify(apptBody),
      }, token)

      const apptId = apptResult.appointment_id || apptResult.data?.appointment_id
      if (apptId) {
        charmAppointmentIds.push(String(apptId))
        // Save Charm IDs back to our appointments table so providers can fetch patient details
        if (appointmentDbId && charmPatientId) {
          await supabase.from('appointments')
            .update({ charm_appointment_id: String(apptId), charm_patient_id: String(charmPatientId) })
            .eq('id', appointmentDbId)
        }
      }
    }

    await supabase.from('booking_requests')
      .update({ charm_appointment_id: charmAppointmentIds.join(',') })
      .eq('id', bookingRequestId)

    await supabase.from('family_profiles')
      .update({ charm_synced_at: new Date().toISOString() })
      .eq('id', family.id)

    return new Response(JSON.stringify({ ok: true, charmAppointmentIds }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  } catch (err) {
    console.error('Charm appointment sync error:', err)
    return new Response(JSON.stringify({ ok: false, error: (err as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
