import '../lib/amplify'
import { fetchAuthSession } from 'aws-amplify/auth'
import { getFamilyAccessToken } from '../contexts/FamilyAuthContext'

async function authHeaders(): Promise<Record<string, string>> {
  const session = await fetchAuthSession()
  const token = session.tokens?.accessToken?.toString() ?? ''
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }
}

async function familyAuthHeaders(): Promise<Record<string, string>> {
  const token = await getFamilyAccessToken()
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }
}

async function publicFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { ...init, headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) } })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }))
    throw new Error(err.error ?? res.statusText)
  }
  return res.json()
}

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = await authHeaders()
  const res = await fetch(path, { ...init, headers: { ...headers, ...(init?.headers ?? {}) } })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }))
    throw new Error(err.error || res.statusText || `HTTP ${res.status}`)
  }
  return res.json()
}

async function familyApiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = await familyAuthHeaders()
  const res = await fetch(path, { ...init, headers: { ...headers, ...(init?.headers ?? {}) } })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }))
    throw new Error(err.error ?? res.statusText)
  }
  return res.json()
}

// ── Appointments ──────────────────────────────────────────────
export const getAppointments = (params: Record<string, string>) =>
  apiFetch<any[]>(`/api/appointments?${new URLSearchParams(params)}`)

export const createAppointment = (body: Record<string, unknown>) =>
  apiFetch<any>('/api/appointments', { method: 'POST', body: JSON.stringify(body) })

export const updateAppointment = (id: string, body: Record<string, unknown>) =>
  apiFetch<any>(`/api/appointments/${id}`, { method: 'PATCH', body: JSON.stringify(body) })

// ── Schedule blocks ───────────────────────────────────────────
export const getScheduleBlocks = (params: Record<string, string>) =>
  apiFetch<any[]>(`/api/schedule-blocks?${new URLSearchParams(params)}`)

export const createScheduleBlock = (body: Record<string, unknown>) =>
  apiFetch<any>('/api/schedule-blocks', { method: 'POST', body: JSON.stringify(body) })

export const deleteScheduleBlock = (id: string) =>
  apiFetch<void>(`/api/schedule-blocks/${id}`, { method: 'DELETE' })

// ── Providers ─────────────────────────────────────────────────
export const getProviders = (params?: Record<string, string>) =>
  apiFetch<any[]>(`/api/providers${params ? '?' + new URLSearchParams(params) : ''}`)

export const getMyProvider = () => apiFetch<any>('/api/providers/me')

export const updateProvider = (id: string, body: Record<string, unknown>) =>
  apiFetch<any>(`/api/providers/${id}`, { method: 'PATCH', body: JSON.stringify(body) })

// ── Availability ──────────────────────────────────────────────
export const getAvailability = (providerId: string) =>
  apiFetch<any>(`/api/availability/${providerId}`)

export const saveAvailabilityDays = (providerId: string, days: any[]) =>
  apiFetch<any[]>(`/api/availability/${providerId}`, { method: 'PUT', body: JSON.stringify(days) })

export const upsertAvailabilityOverride = (providerId: string, body: Record<string, unknown>) =>
  apiFetch<any>(`/api/availability/overrides`, { method: 'POST', body: JSON.stringify({ ...body, provider_id: providerId }) })

export const deleteAvailabilityOverride = (id: string) =>
  apiFetch<void>(`/api/availability/overrides/${id}`, { method: 'DELETE' })

export const createZoneRestriction = (body: Record<string, unknown>) =>
  apiFetch<any>('/api/zone-restrictions', { method: 'POST', body: JSON.stringify(body) })

export const deleteZoneRestriction = (id: string) =>
  apiFetch<void>(`/api/zone-restrictions/${id}`, { method: 'DELETE' })

export const createTimeBlock = (body: Record<string, unknown>) =>
  apiFetch<any>('/api/time-blocks', { method: 'POST', body: JSON.stringify(body) })

export const deleteTimeBlock = (id: string) =>
  apiFetch<void>(`/api/time-blocks/${id}`, { method: 'DELETE' })

export const upsertVisitTypeAvailability = (providerId: string, rows: any[]) =>
  apiFetch<any[]>(`/api/visit-type-availability/${providerId}`, { method: 'PUT', body: JSON.stringify(rows) })

// ── Broadcasts ────────────────────────────────────────────────
export const getBroadcasts = (params?: Record<string, string>) =>
  apiFetch<any[]>(`/api/broadcasts${params ? '?' + new URLSearchParams(params) : ''}`)

export const createBroadcast = (body: Record<string, unknown>) =>
  apiFetch<any>('/api/broadcasts', { method: 'POST', body: JSON.stringify(body) })

export const updateBroadcast = (id: string, body: Record<string, unknown>) =>
  apiFetch<any>(`/api/broadcasts/${id}`, { method: 'PATCH', body: JSON.stringify(body) })

export const deleteBroadcast = (id: string) =>
  apiFetch<void>(`/api/broadcasts/${id}`, { method: 'DELETE' })

// ── Booking requests ──────────────────────────────────────────
export const getBookingRequests = (params?: Record<string, string>) =>
  apiFetch<any[]>(`/api/booking-requests${params ? '?' + new URLSearchParams(params) : ''}`)

export const createBookingRequest = (body: Record<string, unknown>) =>
  apiFetch<any>('/api/booking-requests', { method: 'POST', body: JSON.stringify(body) })

export const updateBookingRequest = (id: string, body: Record<string, unknown>) =>
  apiFetch<any>(`/api/booking-requests/${id}`, { method: 'PATCH', body: JSON.stringify(body) })

// ── Waitlist entries ──────────────────────────────────────────
export const getWaitlistEntries = (params?: Record<string, string>) =>
  apiFetch<any[]>(`/api/waitlist-entries${params ? '?' + new URLSearchParams(params) : ''}`)

export const createWaitlistEntry = (body: Record<string, unknown>) =>
  apiFetch<any>('/api/waitlist-entries', { method: 'POST', body: JSON.stringify(body) })

export const updateWaitlistEntry = (id: string, body: Record<string, unknown>) =>
  apiFetch<any>(`/api/waitlist-entries/${id}`, { method: 'PATCH', body: JSON.stringify(body) })

// ── Slot offers ───────────────────────────────────────────────
export const getSlotOffers = (params: Record<string, string>) =>
  apiFetch<any[]>(`/api/slot-offers?${new URLSearchParams(params)}`)

export const updateSlotOffer = (id: string, body: Record<string, unknown>) =>
  apiFetch<any>(`/api/slot-offers/${id}`, { method: 'PATCH', body: JSON.stringify(body) })

// ── Families ──────────────────────────────────────────────────
export const getMyFamily = () => familyApiFetch<any>('/api/families/me')

export const updateMyFamily = (body: Record<string, unknown>) =>
  familyApiFetch<any>('/api/families/me', { method: 'PATCH', body: JSON.stringify(body) })

export const getFamilyById = (id: string) => apiFetch<any>(`/api/families/${id}`)

export const getFamiliesByIds = (ids: string[]) =>
  apiFetch<any[]>(`/api/families?ids=${ids.join(',')}`)

// ── Children ──────────────────────────────────────────────────
export const createChild = (body: Record<string, unknown>) =>
  familyApiFetch<any>('/api/children', { method: 'POST', body: JSON.stringify(body) })

export const updateChild = (id: string, body: Record<string, unknown>) =>
  familyApiFetch<any>(`/api/children/${id}`, { method: 'PATCH', body: JSON.stringify(body) })

export const providerCreateChild = (body: Record<string, unknown>) =>
  apiFetch<any>('/api/children', { method: 'POST', body: JSON.stringify(body) })

export const archiveChildInsurance = (id: string) =>
  apiFetch<any>(`/api/children/${id}`, { method: 'PATCH', body: JSON.stringify({ _action: 'archive_insurance' }) })

export const familyArchiveChildInsurance = (id: string) =>
  familyApiFetch<any>(`/api/children/${id}`, { method: 'PATCH', body: JSON.stringify({ _action: 'archive_insurance' }) })

export const deleteChild = (id: string) =>
  apiFetch<void>(`/api/children/${id}`, { method: 'DELETE' })

export const getChildrenByIds = (ids: string[]) =>
  apiFetch<any[]>(`/api/children?ids=${ids.join(',')}`)

export const getChildrenByFamilyIds = (familyIds: string[]) =>
  apiFetch<any[]>(`/api/children?family_ids=${familyIds.join(',')}`)

export const searchChildren = (q: string) =>
  apiFetch<any[]>(q.trim() ? `/api/children?search=${encodeURIComponent(q)}` : '/api/children')

// ── Analytics ─────────────────────────────────────────────────
export const getAnalytics = () => apiFetch<any>('/api/analytics')

export const getReports = (params: Record<string, string>) =>
  apiFetch<any>(`/api/reports?${new URLSearchParams(params)}`)

export const getAvailabilityOverview = () =>
  apiFetch<any>('/api/admin/availability-overview')

// ── Scheduling (slot calculation) ────────────────────────────
export const getSchedulingData = (providerId: string, params: Record<string, string>) =>
  publicFetch<{ availability: any; override: any; visitTypeAvail: any; bookedSlots: { time: string; duration: number }[] }>(
    `/api/scheduling/${providerId}?${new URLSearchParams(params)}`
  )

export const getProviderByName = (name: string) =>
  publicFetch<any | null>(`/api/providers?name=${encodeURIComponent(name)}`)

export const getProvidersByRole = (params: Record<string, string>) =>
  publicFetch<any[]>(`/api/providers?${new URLSearchParams(params)}`)

export const getProvidersByNamesWithSecureText = (names: string[]) =>
  publicFetch<any[]>(`/api/providers?names=${names.map(encodeURIComponent).join(',')}&has_secure_text=true`)

// ── Family-facing versions (use family JWT) ───────────────────
export const familyGetBookingRequests = (params?: Record<string, string>) =>
  familyApiFetch<any[]>(`/api/booking-requests${params ? '?' + new URLSearchParams(params) : ''}`)

export const familyCreateBookingRequest = (body: Record<string, unknown>) =>
  familyApiFetch<any>('/api/booking-requests', { method: 'POST', body: JSON.stringify(body) })

export const familyUpdateBookingRequest = (id: string, body: Record<string, unknown>) =>
  familyApiFetch<any>(`/api/booking-requests/${id}`, { method: 'PATCH', body: JSON.stringify(body) })

export const familyGetWaitlistEntries = (params?: Record<string, string>) =>
  familyApiFetch<any[]>(`/api/waitlist-entries${params ? '?' + new URLSearchParams(params) : ''}`)

export const familyCreateWaitlistEntry = (body: Record<string, unknown>) =>
  familyApiFetch<any>('/api/waitlist-entries', { method: 'POST', body: JSON.stringify(body) })

export const familyGetSlotOffers = (params: Record<string, string>) =>
  familyApiFetch<any[]>(`/api/slot-offers?${new URLSearchParams(params)}`)

export const familyUpdateSlotOffer = (id: string, body: Record<string, unknown>) =>
  familyApiFetch<any>(`/api/slot-offers/${id}`, { method: 'PATCH', body: JSON.stringify(body) })

export const familyInvokeNotifications = (body: Record<string, unknown>) =>
  familyApiFetch<void>('/api/notifications', { method: 'POST', body: JSON.stringify(body) })

export const familyCreateAppointment = (body: Record<string, unknown>) =>
  familyApiFetch<any>('/api/appointments', { method: 'POST', body: JSON.stringify(body) })

// ── EHR proxy ────────────────────────────────────────────────
export const invokeCharmAppointment = (body: Record<string, unknown>) =>
  familyApiFetch<void>('/api/charm/appointment', { method: 'POST', body: JSON.stringify(body) })

export const invokeCharmDetails = (body: Record<string, unknown>) =>
  apiFetch<any>('/api/charm/details', { method: 'POST', body: JSON.stringify(body) })

export const familyChangePassword = (currentPassword: string, newPassword: string) =>
  familyApiFetch<void>('/api/families/change-password', { method: 'POST', body: JSON.stringify({ currentPassword, newPassword }) })

export const familyGetEncounterNotes = () =>
  familyApiFetch<any[]>('/api/family/encounter-notes')

export const familyUpdateWaitlistEntry = (id: string, body: Record<string, unknown>) =>
  familyApiFetch<any>(`/api/waitlist-entries/${id}`, { method: 'PATCH', body: JSON.stringify(body) })

// ── Edge function proxy ───────────────────────────────────────
export const invokeNotifications = (body: Record<string, unknown>) =>
  apiFetch<void>('/api/notifications', { method: 'POST', body: JSON.stringify(body) })

// ── Payments ──────────────────────────────────────────────────
export const chargeCard = (appointmentId: string, amountCents: number) =>
  apiFetch<{ ok: boolean; paymentId: string; amountCents: number; cardBrand?: string; last4?: string }>(
    '/api/charge-card', { method: 'POST', body: JSON.stringify({ appointmentId, amountCents }) }
  )

// ── EMR ──────────────────────────────────────────────────────
export const getEncounterNote = (params: Record<string, string>) =>
  apiFetch<any>(`/api/encounter-notes?${new URLSearchParams(params)}`)

export const getEncounterNotes = (params: Record<string, string>) =>
  apiFetch<any[]>(`/api/encounter-notes?${new URLSearchParams(params)}`)

export const createEncounterNote = (body: Record<string, unknown>) =>
  apiFetch<any>('/api/encounter-notes', { method: 'POST', body: JSON.stringify(body) })

export const updateEncounterNote = (id: string, body: Record<string, unknown>) =>
  apiFetch<any>(`/api/encounter-notes/${id}`, { method: 'PUT', body: JSON.stringify(body) })

export const patchEncounterNote = (id: string, body: { diagnoses?: unknown; cpt_codes?: unknown }) =>
  apiFetch<any>(`/api/encounter-notes/${id}`, { method: 'PATCH', body: JSON.stringify(body) })

export const getVitals = (params: Record<string, string>) =>
  apiFetch<any>(`/api/vitals?${new URLSearchParams(params)}`)

export const getVitalsList = (params: Record<string, string>) =>
  apiFetch<any[]>(`/api/vitals?${new URLSearchParams(params)}`)

export const saveVitals = (body: Record<string, unknown>) =>
  apiFetch<any>('/api/vitals', { method: 'POST', body: JSON.stringify(body) })

// ── Fee schedule ──────────────────────────────────────────────
export const getFeeSchedule = () =>
  apiFetch<any[]>('/api/fee-schedule')

// ── Note photo upload ─────────────────────────────────────────
export async function uploadNotePhoto(file: File): Promise<string> {
  const { fetchAuthSession } = await import('aws-amplify/auth')
  const session = await fetchAuthSession()
  const token = session.tokens?.accessToken?.toString() ?? ''
  const response = await fetch(`/api/upload-note-photo?filename=${encodeURIComponent(file.name)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': file.type },
    body: file,
  })
  if (!response.ok) throw new Error('Photo upload failed')
  const data = await response.json()
  return data.url
}

// ── Eligibility ───────────────────────────────────────────────
export const checkEligibility = (appointmentId: string) =>
  apiFetch<any>('/api/eligibility', { method: 'POST', body: JSON.stringify({ appointment_id: appointmentId }) })

// ── Claims ────────────────────────────────────────────────────
export const getUnbilledNotes = () =>
  apiFetch<any[]>('/api/claims?unbilled=true')

export const getClaims = (status?: string) =>
  apiFetch<any[]>(status ? `/api/claims?status=${status}` : '/api/claims')

export const generateClaim = (encounter_note_id: string) =>
  apiFetch<any>('/api/claims', { method: 'POST', body: JSON.stringify({ encounter_note_id }) })

export const getClaim = (id: string) =>
  apiFetch<any>(`/api/claims/${id}`)

export const updateClaim = (id: string, body: Record<string, unknown>) =>
  apiFetch<any>(`/api/claims/${id}`, { method: 'PUT', body: JSON.stringify(body) })

export const submitClaim = (id: string) =>
  apiFetch<any>(`/api/claims/${id}`, { method: 'PUT', body: JSON.stringify({ action: 'submit' }) })

export const testClaim = (id: string) =>
  apiFetch<any>(`/api/claims/${id}`, { method: 'PUT', body: JSON.stringify({ action: 'test' }) })

export const deleteClaim = (id: string) =>
  apiFetch<any>(`/api/claims/${id}`, { method: 'DELETE' })

// ── Practices (super admin) ───────────────────────────────────
export const getPractices = () =>
  apiFetch<any[]>('/api/practices')

export const createPractice = (body: Record<string, unknown>) =>
  apiFetch<any>('/api/practices', { method: 'POST', body: JSON.stringify(body) })

export const createProviderForPractice = (body: Record<string, unknown>) =>
  apiFetch<any>('/api/practices/providers', { method: 'POST', body: JSON.stringify(body) })

export const getPracticeZones = (practiceId?: string) =>
  fetch(`/api/practice-zones${practiceId ? `?practice_id=${practiceId}` : ''}`).then(r => r.json()) as Promise<any[]>

export const upsertPracticeZone = (body: Record<string, unknown>) =>
  apiFetch<any>('/api/practice-zones', { method: 'POST', body: JSON.stringify(body) })

export const updatePracticeZone = (id: string, body: Record<string, unknown>) =>
  apiFetch<any>(`/api/practice-zones?id=${id}`, { method: 'PATCH', body: JSON.stringify(body) })
export const deletePracticeZone = (id: string) =>
  apiFetch<void>(`/api/practice-zones?id=${id}`, { method: 'DELETE' })

export const getPracticeVisitTypes = (practiceId: string) =>
  apiFetch<any[]>(`/api/admin/practice-visit-types?practice_id=${practiceId}`)

export const upsertPracticeVisitType = (body: Record<string, unknown>) =>
  apiFetch<any>('/api/admin/practice-visit-types', { method: 'POST', body: JSON.stringify(body) })

export const deletePracticeVisitType = (id: string) =>
  apiFetch<void>(`/api/admin/practice-visit-types?id=${id}`, { method: 'DELETE' })

export const getProvidersByZone = (zone: string) =>
  publicFetch<any[]>(`/api/providers?zone=${encodeURIComponent(zone)}`)

export const getOnCallSchedule = (params?: { start?: string; end?: string }) =>
  apiFetch<any[]>(`/api/on-call-schedule${params ? '?' + new URLSearchParams(params as Record<string, string>) : ''}`)

export const setOnCallProvider = (date: string, provider_id: string | null) =>
  apiFetch<any>('/api/on-call-schedule', { method: 'PUT', body: JSON.stringify({ date, provider_id }) })

export const getProvidersByState = (state: string) =>
  publicFetch<any[]>(`/api/providers?state=${encodeURIComponent(state)}`)

export const getNoteTemplates = () =>
  apiFetch<any[]>('/api/note-templates')
export const createNoteTemplate = (body: Record<string, unknown>) =>
  apiFetch<any>('/api/note-templates', { method: 'POST', body: JSON.stringify(body) })
export const updateNoteTemplate = (id: string, body: Record<string, unknown>) =>
  apiFetch<any>(`/api/note-templates/${id}`, { method: 'PATCH', body: JSON.stringify(body) })
export const deleteNoteTemplate = (id: string) =>
  apiFetch<void>(`/api/note-templates/${id}`, { method: 'DELETE' })

// ── Patient Statements ────────────────────────────────────────
export const getPatientStatement = (claimId: string) =>
  apiFetch<any>(`/api/patient-statements?claim_id=${encodeURIComponent(claimId)}`)

export const getAllPatientStatements = (status?: string) =>
  apiFetch<any[]>(`/api/patient-statements/all${status ? `?status=${encodeURIComponent(status)}` : ''}`)

export const createPatientStatement = (data: any) =>
  apiFetch<any>('/api/patient-statements', { method: 'POST', body: JSON.stringify(data) })

export const updatePatientStatement = (id: string, data: any) =>
  apiFetch<any>(`/api/patient-statements/${id}`, { method: 'PATCH', body: JSON.stringify(data) })

export const sendPatientStatement = (id: string) =>
  apiFetch<any>(`/api/patient-statements/${id}/send`, { method: 'POST' })

export const pullStediEra = (claimId: string) =>
  apiFetch<any>(`/api/stedi/era?claim_id=${encodeURIComponent(claimId)}`)

// ── DoseSpot e-Prescribing ────────────────────────────────────
export const getDoseSpotSSO = (childId: string) =>
  apiFetch<{ ssoUrl: string }>('/api/dosespot/sso', { method: 'POST', body: JSON.stringify({ child_id: childId }) })

export const getDoseSpotNotifications = () =>
  apiFetch<{ count: number; breakdown: { renewals: number; rxChanges: number; errors: number } }>('/api/dosespot/notifications')

// ── Labs ──────────────────────────────────────────────────────
export const getLabOrders = (childId: string) =>
  apiFetch<any[]>(`/api/labs/results?child_id=${encodeURIComponent(childId)}`)

export const createLabOrder = (body: {
  child_id: string
  appointment_id?: string
  tests: { code: string; name: string }[]
  diagnoses: string[]
  priority: 'routine' | 'stat'
  notes?: string
}) => apiFetch<any>('/api/labs/order', { method: 'POST', body: JSON.stringify(body) })

// ── PHI Audit Log ─────────────────────────────────────────────
export function logAudit(action: string, resource_type: string, resource_id?: string) {
  apiFetch<void>('/api/audit', { method: 'POST', body: JSON.stringify({ action, resource_type, resource_id }) })
    .catch(() => {})  // fire-and-forget, never block the UI
}


// ── PCP Directory ─────────────────────────────────────────────
export const getPcps = (q?: string) =>
  apiFetch<any[]>(`/api/pcps${q ? `?q=${encodeURIComponent(q)}` : ''}`)

export const getFamilyPcps = () =>
  familyApiFetch<any[]>('/api/pcps')

export const getFamilyPharmacies = () =>
  familyApiFetch<string[]>('/api/pharmacies')

export const familyAddPcp = (name: string) =>
  familyApiFetch<any>('/api/pcps', { method: 'POST', body: JSON.stringify({ name }) })

export const addPcp = (body: { name: string; fax_number?: string; aliases?: string[]; state?: string }) =>
  apiFetch<any>('/api/pcps', { method: 'POST', body: JSON.stringify(body) })

export const updatePcp = (id: string, body: { name?: string; fax_number?: string; is_active?: boolean }) =>
  apiFetch<any>(`/api/pcps/${id}`, { method: 'PATCH', body: JSON.stringify(body) })

export const getAllPcps = () =>
  apiFetch<any[]>('/api/pcps?all=true')
