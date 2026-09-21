import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { XCircle, Clock, ChevronDown, Check } from 'lucide-react'
import { format } from 'date-fns'
import { getBookingRequests, updateBookingRequest, getFamiliesByIds, getChildrenByIds, invokeNotifications, createAppointmentWithOverlapRetry } from '../../lib/api'
import { Badge } from '../../components/ui/Badge'
import { Button } from '../../components/ui/Button'
import type { BookingRequest, FamilyProfile } from '../../types/family'

// Parses the pipe-delimited notes serialized by BookVisit for CPR
// (and other) bookings so the admin can see structured fields (age
// range, prior training, class location, etc.) at a glance.
function parseBookingNotes(notes: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!notes) return out
  for (const part of String(notes).split('|')) {
    const idx = part.indexOf(':')
    if (idx <= 0) continue
    const key = part.slice(0, idx).trim()
    const val = part.slice(idx + 1).trim()
    if (key) out[key] = val
  }
  return out
}

const CPR_DURATION_MINUTES = 180

// Safe wrapper around date-fns format(). A single row with a null or
// malformed preferred_date used to throw RangeError('Invalid time
// value') and take down the whole page (Sentry
// 14df41465e49479a836321bc536313c1, Sara 2026-09-21). Fallback returns
// the raw value or an em-dash so the render survives.
function safeFormat(input: string | Date | null | undefined, fmt: string, fallback = '—'): string {
  if (input === null || input === undefined || input === '') return fallback
  const d = input instanceof Date ? input : new Date(input)
  if (isNaN(d.getTime())) return typeof input === 'string' ? input : fallback
  try { return format(d, fmt) } catch { return typeof input === 'string' ? input : fallback }
}

// booking_requests.preferred_time is 12-hour ("9:00 AM"), but
// appointments.scheduled_time is 24-hour ("09:00"). Every other
// caller in the codebase converts before insert; keep the same
// convention here.
function to24hr(time: string): string {
  const [t, ampm] = time.split(' ')
  let [h, m] = t.split(':').map(Number)
  if (ampm === 'PM' && h !== 12) h += 12
  if (ampm === 'AM' && h === 12) h = 0
  return `${h.toString().padStart(2, '0')}:${(m || 0).toString().padStart(2, '0')}`
}

// CPR bookings store the family's fuzzy time preference ("Morning" or
// "Afternoon") in preferred_time — Melissa picks the real time on
// approval. This detects those so the approve flow can prompt.
function isFuzzyTimePreference(t: string | null | undefined): boolean {
  if (!t) return true
  const s = t.trim().toLowerCase()
  return s === 'morning' || s === 'afternoon' || s === ''
}

// Convert "9:00 AM", "9:00AM", "9 AM", "9:30 pm" → "09:00" / "21:30".
// Returns null if the string doesn't parse as a time.
function parseTimeInput(raw: string): string | null {
  const s = raw.trim().toUpperCase().replace(/\s+/g, ' ')
  const match = s.match(/^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)$/)
  if (!match) return null
  let h = parseInt(match[1], 10)
  const m = match[2] ? parseInt(match[2], 10) : 0
  const ampm = match[3]
  if (h < 1 || h > 12 || m < 0 || m > 59) return null
  if (ampm === 'PM' && h !== 12) h += 12
  if (ampm === 'AM' && h === 12) h = 0
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

interface EnrichedBooking extends BookingRequest {
  family?: FamilyProfile
  childNames?: string[]
}

export function AdminBookings() {
  const [bookings, setBookings] = useState<EnrichedBooking[]>([])
  const [loading, setLoading] = useState(true)
  const [expanded, setExpanded] = useState<string | null>(null)
  // Default to 'pending' so CPR requests awaiting Melissa's approval are
  // the first thing an admin/instructor sees when they land on this page.
  const [filter, setFilter] = useState<'pending' | 'confirmed' | 'cancelled' | 'all'>('pending')
  const [actioning, setActioning] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  async function fetchBookings() {
    setLoading(true)
    const params: Record<string, string> = {}
    if (filter !== 'all') params.status = filter
    const bData = await getBookingRequests(params).catch(() => null)
    if (!bData) { setLoading(false); return }

    const familyIds = [...new Set(bData.map(b => b.family_id))]
    const childIdsFlat = [...new Set(bData.flatMap(b => b.child_ids ?? []))]

    const [families, kids] = await Promise.all([
      familyIds.length ? getFamiliesByIds(familyIds).catch(() => []) : Promise.resolve([]),
      childIdsFlat.length ? getChildrenByIds(childIdsFlat).catch(() => []) : Promise.resolve([]),
    ])

    const enriched: EnrichedBooking[] = bData.map(b => ({
      ...b,
      family: (families as FamilyProfile[]).find(f => f.id === b.family_id),
      childNames: (kids as any[]).filter(c => (b.child_ids ?? []).includes(c.id)).map(c => c.first_name) || [],
    }))

    setBookings(enriched)
    setLoading(false)
  }

  useEffect(() => { fetchBookings() }, [filter])

  // Deep-link support: /admin/bookings?booking=<id> auto-selects the
  // right status filter (so the row is in the current view), expands
  // the card, and scrolls it into view. Used by Melissa's "Review &
  // respond" button in the CPR request email — she lands here with
  // the exact booking already open and ready to Approve or Decline.
  const [searchParams, setSearchParams] = useSearchParams()
  useEffect(() => {
    const targetId = searchParams.get('booking')
    if (!targetId || loading || bookings.length === 0) return
    const target = bookings.find(b => b.id === targetId)
    if (!target) {
      // The email link came in but this booking isn't in the current
      // filter's result set — switch to 'all' so the next fetchBookings
      // grabs it, then this effect re-runs and expands it.
      if (filter !== 'all') setFilter('all')
      return
    }
    setExpanded(targetId)
    const next = new URLSearchParams(searchParams)
    next.delete('booking')
    setSearchParams(next, { replace: true })
    setTimeout(() => {
      document.getElementById(`booking-card-${targetId}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }, 100)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, bookings, searchParams])

  // Approve a pending CPR request → create the appointment for Melissa,
  // flip the request to 'confirmed', notify the family. Currently only
  // CPR requests land in 'pending' status, so no per-visit-type branching
  // is needed yet — the appointment is always Melissa, 180 min, zone
  // 'CPR Class'. If more pending-approval flows are added, factor this
  // out per visit type. Sara 2026-09-20.
  async function approveBooking(b: EnrichedBooking) {
    if (!b.confirmed_provider_id) {
      setActionError('This request has no provider on record — cannot create appointment. Contact support.')
      return
    }

    // CPR requests come in with a fuzzy time-of-day preference
    // (Morning / Afternoon), not an exact slot — prompt Melissa for
    // the real time she wants to teach. Non-fuzzy times (existing
    // sick-visit approvals, if any) go straight through.
    let rawTime12h: string     // "9:00 AM" — for storing on booking_request + email display
    let scheduledTime24h: string  // "09:00"   — for appointment.scheduled_time
    if (isFuzzyTimePreference(b.preferred_time)) {
      const hint = b.preferred_time?.trim() ? ` The family requested ${b.preferred_time}.` : ''
      const raw = window.prompt(
        `What time will you teach this class?${hint}\n\nEnter as "9:00 AM" or "2:30 PM":`,
        b.preferred_time?.toLowerCase() === 'afternoon' ? '2:00 PM' : '9:00 AM',
      )
      if (raw === null) return  // user hit Cancel
      const parsed = parseTimeInput(raw)
      if (!parsed) {
        setActionError(`"${raw}" isn't a valid time — enter something like "9:00 AM" or "2:30 PM".`)
        return
      }
      rawTime12h = raw.trim()
      scheduledTime24h = parsed
    } else {
      rawTime12h = b.preferred_time
      scheduledTime24h = to24hr(b.preferred_time)
    }

    if (!window.confirm(`Approve this CPR class booking for ${safeFormat(b.preferred_date + 'T12:00:00', 'EEE, MMM d')} at ${rawTime12h}?`)) return
    setActioning(b.id); setActionError(null)
    try {
      await createAppointmentWithOverlapRetry({
        provider_id: b.confirmed_provider_id,
        visit_type: b.visit_type,
        zone: b.zone || 'CPR Class',
        scheduled_time: scheduledTime24h,
        scheduled_date: b.preferred_date,
        status: 'upcoming',
        notes: b.notes ?? undefined,
        duration_minutes: CPR_DURATION_MINUTES,
      }, msg => window.confirm(msg + '\n\nApprove anyway?'))
      // Store the confirmed 12hr time back on the booking_request so
      // the family email + reports show the actual class start, not
      // the fuzzy preference.
      await updateBookingRequest(b.id, { status: 'confirmed', preferred_time: rawTime12h })
      invokeNotifications({
        type: 'cpr_booking_approved',
        bookingRequestId: b.id,
        familyName: b.family?.display_name || b.family?.email || 'A family',
        parentEmail: b.family?.email || null,
        parentPhone: b.family?.phone || null,
        visitType: b.visit_type,
        date: b.preferred_date,
        time: rawTime12h,
      }).catch(() => {})
      await fetchBookings()
    } catch (e: any) {
      setActionError(e?.message ?? 'Failed to approve booking')
    } finally {
      setActioning(null)
    }
  }

  async function declineBooking(b: EnrichedBooking) {
    const reason = window.prompt('Why are you declining this booking? (Optional — the family will see this)')
    if (reason === null) return  // user hit Cancel
    setActioning(b.id); setActionError(null)
    try {
      const declineNote = reason.trim() ? `DECLINE_REASON:${reason.trim()}` : ''
      const combinedNotes = [b.notes, declineNote].filter(Boolean).join('|')
      await updateBookingRequest(b.id, { status: 'cancelled', notes: combinedNotes })
      invokeNotifications({
        type: 'cpr_booking_declined',
        bookingRequestId: b.id,
        familyName: b.family?.display_name || b.family?.email || 'A family',
        parentEmail: b.family?.email || null,
        parentPhone: b.family?.phone || null,
        visitType: b.visit_type,
        date: b.preferred_date,
        time: b.preferred_time,
        declineReason: reason.trim() || null,
      }).catch(() => {})
      await fetchBookings()
    } catch (e: any) {
      setActionError(e?.message ?? 'Failed to decline booking')
    } finally {
      setActioning(null)
    }
  }

  async function cancelBooking(id: string) {
    await updateBookingRequest(id, { status: 'cancelled' })
    fetchBookings()

    const booking = bookings.find(b => b.id === id)
    if (booking) {
      // Notify provider + family of admin cancellation
      if (booking.confirmed_provider_id) {
        invokeNotifications({
          type: 'booking_cancelled',
          providerId: booking.confirmed_provider_id,
          visitType: booking.visit_type,
          date: booking.preferred_date,
          time: booking.preferred_time,
          zone: booking.zone || '',
          familyName: booking.family?.display_name || booking.family?.email || 'A family',
          parentEmail: booking.family?.email || null,
          parentPhone: booking.family?.phone || null,
        }).catch(() => {})
      }
      // Notify waitlisted families in the same zone that the slot opened
      if (booking.confirmed_provider_id && booking.zone) {
        invokeNotifications({
          type: 'slot_opened',
          providerId: booking.confirmed_provider_id,
          zone: booking.zone,
          visitType: booking.visit_type,
          date: booking.preferred_date,
          time: booking.preferred_time,
        }).catch(() => {})
      }
    }
  }

  return (
    <div>
      <div className="bg-white border-b border-[#E8E8E4] px-6 py-4 flex items-center justify-between sticky top-0 z-10">
        <div>
          <div className="font-display text-[18px] font-medium text-[#1A1A2E]">Booking requests</div>
          <div className="text-[12px] text-[#1A1A2E] mt-0.5">Most bookings auto-confirm; CPR class requests wait here for Melissa to approve.</div>
        </div>
        <div className="flex gap-1 bg-[#FAFAF8] border border-[#E8E8E4] rounded-lg p-0.5">
          {(['pending', 'confirmed', 'cancelled', 'all'] as const).map(f => (
            <button key={f} onClick={() => setFilter(f)}
              className={`px-3 py-1.5 rounded-md text-[12px] font-medium capitalize transition-colors ${filter === f ? 'bg-white shadow-sm text-[#1A1A2E]' : 'text-[#1A1A2E] hover:text-[#555]'}`}>
              {f}
            </button>
          ))}
        </div>
      </div>

      {actionError && (
        <div className="mx-6 mt-3 text-[13px] text-[#991B1B] bg-[#FCEBEB] border border-[#F5C6C6] px-3 py-2 rounded-lg">{actionError}</div>
      )}

      <div className="p-6 space-y-3 max-w-3xl">
        {!loading && bookings.length === 0 && (
          <div className="text-center py-16 text-[#1A1A2E] text-[14px]">No {filter} booking requests.</div>
        )}

        {bookings.map(b => (
          <div key={b.id} id={`booking-card-${b.id}`} className={`border rounded-xl overflow-hidden bg-white shadow-sm ${b.status === 'pending' ? 'border-[#FAC775]' : 'border-[#E8E8E4]'}`}>
            <div className="flex items-center gap-3 px-5 py-4 cursor-pointer" onClick={() => setExpanded(expanded === b.id ? null : b.id)}>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-display text-[15px] font-medium text-[#1A1A2E]">
                    {b.visit_type} — {b.zone || b.state}
                  </span>
                  <Badge variant={b.status === 'pending' ? 'amber' : b.status === 'confirmed' ? 'teal' : 'gray'}>
                    {b.status === 'pending' ? 'Pending' : b.status === 'confirmed' ? 'Confirmed' : 'Cancelled'}
                  </Badge>
                </div>
                <div className="text-[12px] text-[#1A1A2E] mt-0.5 flex items-center gap-2 flex-wrap">
                  <span className="flex items-center gap-1"><Clock size={11} />{safeFormat(b.preferred_date + 'T12:00:00', 'EEE, MMM d')} at {b.preferred_time || '—'}</span>
                  <span>· {b.visit_type}</span>
                  {b.zone && <span>· {b.zone}</span>}
                </div>
              </div>
              <ChevronDown size={14} className={`text-[#1A1A2E] transition-transform flex-shrink-0 ${expanded === b.id ? 'rotate-180' : ''}`} />
            </div>

            {expanded === b.id && (() => {
              const noteFields = parseBookingNotes(b.notes)
              const isCprRequest = b.visit_type.toLowerCase().includes('cpr class')
              return (
              <div className="px-5 pb-5 border-t border-[#E8E8E4] pt-4">
                <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-[13px] mb-4">
                  <div><span className="text-[#1A1A2E]">Contact: </span><span className="font-medium">{b.family?.email}</span></div>
                  <div><span className="text-[#1A1A2E]">Provider: </span><span className="font-medium">{b.preferred_provider || 'Any'}</span></div>
                  <div><span className="text-[#1A1A2E]">Zone: </span><span className="font-medium">{b.zone || '—'}</span></div>
                  <div><span className="text-[#1A1A2E]">State: </span><span className="font-medium">{b.state || '—'}</span></div>
                  {noteFields.PARENTPHONE && (
                    <div><span className="text-[#1A1A2E]">Phone: </span><span className="font-medium">{noteFields.PARENTPHONE}</span></div>
                  )}
                  {noteFields.ADDR && (
                    <div className="col-span-2"><span className="text-[#1A1A2E]">Address: </span><span className="font-medium">{noteFields.ADDR}</span></div>
                  )}
                  {b.charm_appointment_id && (
                    <div className="col-span-2"><span className="text-[#1A1A2E]">Charm ID: </span><span className="font-mono text-[11px]">{b.charm_appointment_id}</span></div>
                  )}
                  <div className="col-span-2 text-[11px] text-[#aeaeb2]">Ref: {b.reference_code} · Submitted {safeFormat(b.created_at, 'MMM d, h:mm a')}</div>
                </div>

                {/* CPR-class intake details — surfaces the participant
                    count / attendees / age range / prior training /
                    class location / instructor notes that BookVisit
                    collects on the CPR intake step. */}
                {isCprRequest && (
                  <div className="mb-4 border border-[#F5B7B1] bg-[#FDEDEC] rounded-lg p-3 text-[13px] space-y-1.5">
                    <div className="text-[11px] font-semibold text-[#922B21] uppercase tracking-wider mb-1">CPR class intake</div>
                    {noteFields.PARTICIPANTS && <div><span className="text-[#555]">Participants: </span><span className="font-medium">{noteFields.PARTICIPANTS}</span></div>}
                    {noteFields.ATTENDEES && <div><span className="text-[#555]">Attendees: </span><span className="font-medium whitespace-pre-wrap">{noteFields.ATTENDEES}</span></div>}
                    {noteFields.AGE_RANGE && <div><span className="text-[#555]">Age range: </span><span className="font-medium">{noteFields.AGE_RANGE}</span></div>}
                    {noteFields.PRIOR_TRAINING && <div><span className="text-[#555]">Prior training: </span><span className="font-medium capitalize">{noteFields.PRIOR_TRAINING}</span></div>}
                    {noteFields.CLASS_LOCATION && <div><span className="text-[#555]">Class location: </span><span className="font-medium">{noteFields.CLASS_LOCATION}</span></div>}
                    {noteFields.INSTRUCTOR_NOTES && <div><span className="text-[#555]">Notes for instructor: </span><span className="font-medium whitespace-pre-wrap">{noteFields.INSTRUCTOR_NOTES}</span></div>}
                    {noteFields.DECLINE_REASON && <div className="mt-2 pt-2 border-t border-[#F5B7B1]"><span className="text-[#555]">Decline reason: </span><span className="font-medium italic">{noteFields.DECLINE_REASON}</span></div>}
                  </div>
                )}

                <div className="flex flex-wrap gap-2">
                  {b.status === 'pending' && (
                    <>
                      <Button variant="teal" size="xs" loading={actioning === b.id} onClick={() => approveBooking(b)}>
                        <Check size={12} /> Approve &amp; create appointment
                      </Button>
                      <Button variant="secondary" size="xs" loading={actioning === b.id} onClick={() => declineBooking(b)}>
                        <XCircle size={12} /> Decline
                      </Button>
                    </>
                  )}
                  {b.status === 'confirmed' && (
                    <Button variant="danger" size="xs" onClick={() => cancelBooking(b.id)}>
                      <XCircle size={12} /> Cancel booking
                    </Button>
                  )}
                </div>
              </div>
              )
            })()}
          </div>
        ))}
      </div>

    </div>
  )
}
