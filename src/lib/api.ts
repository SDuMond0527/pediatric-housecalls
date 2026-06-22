import '../lib/amplify'
import { fetchAuthSession } from 'aws-amplify/auth'

async function authHeaders(): Promise<Record<string, string>> {
  const session = await fetchAuthSession()
  const token = session.tokens?.accessToken?.toString() ?? ''
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = await authHeaders()
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
  apiFetch<any>(`/api/availability/${providerId}/overrides`, { method: 'POST', body: JSON.stringify(body) })

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
export const getMyFamily = () => apiFetch<any>('/api/families/me')

export const updateMyFamily = (body: Record<string, unknown>) =>
  apiFetch<any>('/api/families/me', { method: 'PATCH', body: JSON.stringify(body) })

export const getFamilyById = (id: string) => apiFetch<any>(`/api/families/${id}`)

export const getFamiliesByIds = (ids: string[]) =>
  apiFetch<any[]>(`/api/families?ids=${ids.join(',')}`)

// ── Children ──────────────────────────────────────────────────
export const createChild = (body: Record<string, unknown>) =>
  apiFetch<any>('/api/children', { method: 'POST', body: JSON.stringify(body) })

export const updateChild = (id: string, body: Record<string, unknown>) =>
  apiFetch<any>(`/api/children/${id}`, { method: 'PATCH', body: JSON.stringify(body) })

export const deleteChild = (id: string) =>
  apiFetch<void>(`/api/children/${id}`, { method: 'DELETE' })

export const getChildrenByIds = (ids: string[]) =>
  apiFetch<any[]>(`/api/children?ids=${ids.join(',')}`)

// ── Analytics ─────────────────────────────────────────────────
export const getAnalytics = () => apiFetch<any>('/api/analytics')

export const getReports = (params: Record<string, string>) =>
  apiFetch<any>(`/api/reports?${new URLSearchParams(params)}`)

// ── Scheduling (slot calculation) ────────────────────────────
export const getSchedulingData = (providerId: string, params: Record<string, string>) =>
  apiFetch<{ availability: any; override: any; visitTypeAvail: any; bookedTimes: string[] }>(
    `/api/scheduling/${providerId}?${new URLSearchParams(params)}`
  )

export const getProviderByName = (name: string) =>
  apiFetch<any | null>(`/api/providers?name=${encodeURIComponent(name)}`)

export const getProvidersByRole = (params: Record<string, string>) =>
  apiFetch<any[]>(`/api/providers?${new URLSearchParams(params)}`)

export const getProvidersByNamesWithSecureText = (names: string[]) =>
  apiFetch<any[]>(`/api/providers?names=${names.map(encodeURIComponent).join(',')}&has_secure_text=true`)

// ── EHR proxy ────────────────────────────────────────────────
export const invokeCharmAppointment = (body: Record<string, unknown>) =>
  apiFetch<void>('/api/charm/appointment', { method: 'POST', body: JSON.stringify(body) })

export const invokeCharmDetails = (body: Record<string, unknown>) =>
  apiFetch<any>('/api/charm/details', { method: 'POST', body: JSON.stringify(body) })

// ── Edge function proxy ───────────────────────────────────────
export const invokeNotifications = (body: Record<string, unknown>) =>
  apiFetch<void>('/api/notifications', { method: 'POST', body: JSON.stringify(body) })
