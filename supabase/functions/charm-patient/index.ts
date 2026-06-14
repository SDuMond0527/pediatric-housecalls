import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const CHARM_TOKEN_URL = 'https://accounts.charmtracker.com/oauth/v2/token'
const CHARM_BASE_URL = Deno.env.get('CHARM_BASE_URL') || 'https://ehr2.charmtracker.com/api/ehr/v2/fhir'

async function getCharmToken(): Promise<string> {
  const res = await fetch(CHARM_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: Deno.env.get('CHARM_CLIENT_ID') || '',
      client_secret: Deno.env.get('CHARM_CLIENT_SECRET') || '',
      scope: 'openid',
    }),
  })
  const data = await res.json()
  if (!data.access_token) throw new Error(`Charm auth failed: ${JSON.stringify(data)}`)
  return data.access_token
}

async function charmFetch(path: string, options: RequestInit = {}): Promise<any> {
  const token = await getCharmToken()
  const res = await fetch(`${CHARM_BASE_URL}${path}`, {
    ...options,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/fhir+json',
      'Accept': 'application/fhir+json',
      ...(options.headers || {}),
    },
  })
  if (!res.ok) throw new Error(`Charm API error ${res.status}: ${await res.text()}`)
  return res.json()
}

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
)

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const { action, data } = await req.json()

    if (action === 'search') {
      // Search Charm for existing patient by name + DOB
      const params = new URLSearchParams({
        family: data.lastName,
        given: data.firstName,
        birthdate: data.dateOfBirth,
      })
      const result = await charmFetch(`/Patient?${params}`)
      const patients = result.entry || []
      return new Response(JSON.stringify({
        found: patients.length > 0,
        patients: patients.map((e: any) => ({
          id: e.resource.id,
          name: `${e.resource.name?.[0]?.given?.[0]} ${e.resource.name?.[0]?.family}`,
          birthDate: e.resource.birthDate,
        })),
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }

    if (action === 'create') {
      // Create new patient in Charm
      const patient = buildPatientResource(data)
      const result = await charmFetch('/Patient', {
        method: 'POST',
        body: JSON.stringify(patient),
      })
      const charmPatientId = result.id

      // Create insurance coverage if provided
      if (data.insuranceProvider && data.insuranceMemberId && charmPatientId) {
        const coverage = buildCoverageResource({
          charmPatientId,
          insuranceProvider: data.insuranceProvider,
          memberId: data.insuranceMemberId,
          groupNumber: data.insuranceGroupNumber,
          subscriberName: data.insuranceSubscriberName,
        })
        await charmFetch('/Coverage', { method: 'POST', body: JSON.stringify(coverage) })
      }

      // Save charm_patient_id to children table
      if (data.childId && charmPatientId) {
        await supabase.from('children').update({ charm_patient_id: charmPatientId }).eq('id', data.childId)
      }

      // Mark family as synced
      if (data.familyId) {
        await supabase.from('family_profiles').update({ charm_synced_at: new Date().toISOString() }).eq('id', data.familyId)
      }

      return new Response(JSON.stringify({ charmPatientId }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    if (action === 'link') {
      // Link an existing Charm patient to a child record
      await supabase.from('children').update({ charm_patient_id: data.charmPatientId }).eq('id', data.childId)
      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    return new Response(JSON.stringify({ error: 'Unknown action' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
