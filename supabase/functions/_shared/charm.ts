// Shared Charm Health API utilities

const CHARM_TOKEN_URL = 'https://accounts.charmtracker.com/oauth/v2/token'
const CHARM_BASE_URL = Deno.env.get('CHARM_BASE_URL') || 'https://ehr2.charmtracker.com/api/ehr/v2/fhir'
const CHARM_CLIENT_ID = Deno.env.get('CHARM_CLIENT_ID') || ''
const CHARM_CLIENT_SECRET = Deno.env.get('CHARM_CLIENT_SECRET') || ''
const CHARM_PRACTICE_ID = Deno.env.get('CHARM_PRACTICE_ID') || ''

export async function getCharmToken(): Promise<string> {
  const res = await fetch(CHARM_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: CHARM_CLIENT_ID,
      client_secret: CHARM_CLIENT_SECRET,
      scope: 'openid',
    }),
  })
  const data = await res.json()
  if (!data.access_token) throw new Error(`Charm auth failed: ${JSON.stringify(data)}`)
  return data.access_token
}

export async function charmFetch(path: string, options: RequestInit = {}): Promise<any> {
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
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Charm API error ${res.status}: ${err}`)
  }
  return res.json()
}

export function buildPatientResource(data: {
  firstName: string
  lastName: string
  dateOfBirth: string
  guardianPhone: string
  guardianEmail: string
  address?: string
  state?: string
  zip?: string
  insuranceProvider?: string
  insuranceMemberId?: string
  insuranceGroupNumber?: string
  insuranceSubscriberName?: string
}) {
  return {
    resourceType: 'Patient',
    meta: {
      tag: [{ system: 'https://pediatrichousecalls.com', code: 'portal-created' }]
    },
    name: [{ use: 'official', family: data.lastName, given: [data.firstName] }],
    birthDate: data.dateOfBirth,
    telecom: [
      { system: 'phone', value: data.guardianPhone, use: 'mobile' },
      { system: 'email', value: data.guardianEmail },
    ],
    ...(data.address ? {
      address: [{
        use: 'home',
        line: [data.address],
        state: data.state || '',
        postalCode: data.zip || '',
        country: 'US',
      }]
    } : {}),
    contact: [{
      relationship: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v2-0131', code: 'N', display: 'Next-of-kin' }] }],
      name: { text: data.guardianEmail },
      telecom: [{ system: 'phone', value: data.guardianPhone }],
    }],
  }
}

export function buildAppointmentResource(data: {
  charmPatientId: string
  visitType: string
  date: string
  time: string
  zone: string
  providerName: string
  complaint: string
}) {
  const [hour, minute] = data.time.replace(' AM','').replace(' PM','').split(':').map(Number)
  const isPM = data.time.includes('PM')
  const h24 = isPM && hour !== 12 ? hour + 12 : (!isPM && hour === 12 ? 0 : hour)
  const start = `${data.date}T${h24.toString().padStart(2,'0')}:${minute.toString().padStart(2,'0')}:00`
  const endHour = h24 + 1
  const end = `${data.date}T${endHour.toString().padStart(2,'0')}:${minute.toString().padStart(2,'0')}:00`

  return {
    resourceType: 'Appointment',
    status: 'booked',
    serviceType: [{
      coding: [{ display: data.visitType }],
      text: data.visitType,
    }],
    reasonCode: [{ text: data.complaint }],
    start,
    end,
    comment: `Zone: ${data.zone}. Provider: ${data.providerName}. Booked via Pediatric Housecalls portal.`,
    participant: [{
      actor: { reference: `Patient/${data.charmPatientId}`, display: '' },
      status: 'accepted',
    }],
  }
}

export function buildCoverageResource(data: {
  charmPatientId: string
  insuranceProvider: string
  memberId: string
  groupNumber?: string
  subscriberName?: string
}) {
  return {
    resourceType: 'Coverage',
    status: 'active',
    subscriber: { display: data.subscriberName || '' },
    subscriberId: data.memberId,
    beneficiary: { reference: `Patient/${data.charmPatientId}` },
    payor: [{ display: data.insuranceProvider }],
    class: data.groupNumber ? [{
      type: { coding: [{ code: 'group' }] },
      value: data.groupNumber,
    }] : [],
  }
}
