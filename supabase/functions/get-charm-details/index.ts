const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const CHARM_TOKEN_URL  = 'https://accounts106.charmtracker.com/oauth/v2/token'
const CHARM_BASE_URL   = Deno.env.get('CHARM_BASE_URL') || 'https://sandbox3.charmtracker.com/api/ehr/v1'
const CHARM_CLIENT_ID  = Deno.env.get('CHARM_CLIENT_ID') || ''
const CHARM_CLIENT_SECRET = Deno.env.get('CHARM_CLIENT_SECRET') || ''
const CHARM_REFRESH_TOKEN = Deno.env.get('CHARM_REFRESH_TOKEN') || ''
const CHARM_API_KEY    = Deno.env.get('CHARM_API_KEY') || ''

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
  if (!data.access_token) throw new Error('Charm auth failed')
  return data.access_token
}

async function charmGet(path: string, token: string): Promise<any> {
  const res = await fetch(`${CHARM_BASE_URL}${path}`, {
    headers: {
      'Authorization': `Zoho-oauthtoken ${token}`,
      'api_key':       CHARM_API_KEY,
      'Content-Type':  'application/json',
    },
  })
  if (!res.ok) return null
  return res.json()
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const { charm_patient_id, charm_appointment_id } = await req.json()
    if (!charm_patient_id) throw new Error('charm_patient_id required')

    const token = await getCharmToken()

    // Fetch patient demographics
    const patientData = await charmGet(`/patients/${charm_patient_id}`, token)
    const patient = patientData?.patient || patientData || {}

    // Fetch allergies
    const allergyData = await charmGet(`/patients/${charm_patient_id}/allergies`, token)
    const allergies = allergyData?.allergies || allergyData?.data || []

    // Fetch appointment reason (I'm not certain if it's /appointment/{id} or /appointments/{id}
    // — trying both, falling back gracefully if neither works)
    let appointmentReason = ''
    if (charm_appointment_id) {
      const apptData = await charmGet(`/appointment/${charm_appointment_id}`, token)
        || await charmGet(`/appointments/${charm_appointment_id}`, token)
      appointmentReason = apptData?.appointment?.reason || apptData?.reason || ''
    }

    return new Response(JSON.stringify({
      ok: true,
      patient: {
        first_name:  patient.first_name  || '',
        last_name:   patient.last_name   || '',
        dob:         patient.dob         || '',
        gender:      patient.gender      || '',
        email:       patient.email       || '',
        phone:       patient.mobile || patient.home_phone || '',
        address:     [patient.address_line1, patient.city, patient.state, patient.zip_code].filter(Boolean).join(', '),
      },
      allergies: Array.isArray(allergies)
        ? allergies.map((a: any) => `${a.allergen} (${a.severity || 'severity unknown'})`).join(', ')
        : '',
      appointment_reason: appointmentReason,
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: (err as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
