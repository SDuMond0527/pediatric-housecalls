import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { XCircle, Clock, ChevronDown, Check, AlertCircle } from 'lucide-react'
import { format } from 'date-fns'
import { getBookingRequests, updateBookingRequest, getFamiliesByIds, invokeNotifications, createAppointmentWithOverlapRetry } from '../lib/api'
import { Badge } from '../components/ui/Badge'
import { Button } from '../components/ui/Button'
import type { BookingRequest, FamilyProfile } from '../types/family'

// Provider-facing CPR requests page (Sara 2026-09-21). Melissa lands
// here from the "Review & respond" button in her request email. Shows
// only CPR class bookings, defaults to pending, with the same
// approve/decline UI that lives on /admin/bookings for admins.
//
// This is a focused, non-admin view — Melissa sees just what she needs
// to act on, wrapped in her normal AppLayout (sidebar + patient search)
// instead of being dropped into the admin dashboard.

const CPR_DURATION_MINUTES = 180

function to24hr(time: string): string {
  const [t, ampm] = time.split(' ')
  let [h, m] = t.split(':').map(Number)
  if (ampm === 'PM' && h !== 12) h += 12
  if (ampm === 'AM' && h === 12) h = 0
  return `${h.toString().padStart(2, '0')}:${(m || 0).toString().padStart(2, '0')}`
}
function isFuzzyTimePreference(t: string | null | undefined): boolean {
  if (!t) return true
  const s = t.trim().toLowerCase()
  return s === 'morning' || s === 'afternoon' || s === ''
}
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
function safeFormat(input: string | Date | null | undefined, fmt: string, fallback = '—'): string {
  if (input === null || input === undefined || input === '') return fallback
  const d = input instanceof Date ? input : new Date(input)
  if (isNaN(d.getTime())) return typeof input === 'string' ? input : fallback
  try { return format(d, fmt) } catch { return typeof input === 'string' ? input : fallback }
}
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

interface EnrichedBooking extends BookingRequest {
  family?: FamilyProfile
}

export function CprRequests() {
  const [bookings, setBookings] = useState<EnrichedBooking[]>([])
  const [loading, setLoading] = useState(true)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [filter, setFilter] = useState<'pending' | 'all'>('pending')
  const [actioning, setActioning] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  async function fetchBookings() {
    setLoading(true)
    // The API doesn't filter by visit_type, so fetch by status and
    // narrow client-side. Pending default, 'all' shows history too.
    const statuses = filter === 'pending' ? ['pending'] : ['pending', 'confirmed', 'cancelled']
    const results = await Promise.all(statuses.map(s => getBookingRequests({ status: s }).catch(() => [])))
    const merged = (results.flat() as BookingRequest[])
      .filter(b => b.visit_type.toLowerCase().includes('cpr class'))
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
    const familyIds = [...new Set(merged.map(b => b.family_id))]
    const families = familyIds.length ? await getFamiliesByIds(familyIds).catch(() => []) : []
    setBookings(merged.map(b => ({
      ...b,
      family: (families as FamilyProfile[]).find(f => f.id === b.family_id),
    })))
    setLoading(false)
  }
  useEffect(() => { fetchBookings() }, [filter])

  // Deep-link support — /cpr-requests?booking=<id> from the request
  // email auto-expands the row and scrolls to it. If ?action=approve
  // or ?action=decline is also present (Melissa clicked one of the two
  // email buttons directly), auto-fire that flow after expanding.
  // If the id isn't in the current filter's results, fall back to 'all'
  // so the next fetch grabs it (this effect re-runs on bookings change).
  const [searchParams, setSearchParams] = useSearchParams()
  useEffect(() => {
    const targetId = searchParams.get('booking')
    const action = searchParams.get('action')  // 'approve' | 'decline' | null
    if (!targetId || loading || bookings.length === 0) return
    const target = bookings.find(b => b.id === targetId)
    if (!target) {
      if (filter !== 'all') setFilter('all')
      return
    }
    setExpanded(targetId)
    const next = new URLSearchParams(searchParams)
    next.delete('booking')
    next.delete('action')
    setSearchParams(next, { replace: true })
    setTimeout(() => {
      document.getElementById(`cpr-card-${targetId}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }, 100)
    // Only auto-fire from a pending booking; approved/cancelled don't need action.
    if (target.status === 'pending' && (action === 'approve' || action === 'decline')) {
      // Small delay lets the row expand and scroll first, so the
      // window.prompt / window.confirm dialogs don't appear before
      // Melissa can see the context underneath.
      setTimeout(() => {
        if (action === 'approve') approveBooking(target)
        else declineBooking(target)
      }, 250)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, bookings, searchParams])

  async function approveBooking(b: EnrichedBooking) {
    if (!b.confirmed_provider_id) {
      setActionError('This request has no provider on record — cannot create appointment. Contact support.')
      return
    }
    let rawTime12h: string
    let scheduledTime24h: string
    if (isFuzzyTimePreference(b.preferred_time)) {
      const hint = b.preferred_time?.trim() ? ` The family requested ${b.preferred_time}.` : ''
      const raw = window.prompt(
        `What time will you teach this class?${hint}\n\nEnter as "9:00 AM" or "2:30 PM":`,
        b.preferred_time?.toLowerCase() === 'afternoon' ? '2:00 PM' : '9:00 AM',
      )
      if (raw === null) return
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
    if (reason === null) return
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

  return (
    <div>
      <div className="bg-white border-b border-[#E8E8E4] px-6 py-4 flex items-center justify-between sticky top-0 z-10">
        <div>
          <div className="font-display text-[18px] font-medium text-[#1A1A2E]">CPR class requests</div>
          <div className="text-[12px] text-[#1A1A2E] mt-0.5">Approve or decline family requests for in-home CPR classes.</div>
        </div>
        <div className="flex gap-1 bg-[#FAFAF8] border border-[#E8E8E4] rounded-lg p-0.5">
          {(['pending', 'all'] as const).map(f => (
            <button key={f} onClick={() => setFilter(f)}
              className={`px-3 py-1.5 rounded-md text-[12px] font-medium capitalize transition-colors ${filter === f ? 'bg-white shadow-sm text-[#1A1A2E]' : 'text-[#1A1A2E] hover:text-[#555]'}`}>
              {f === 'pending' ? 'Pending' : 'All history'}
            </button>
          ))}
        </div>
      </div>

      {actionError && (
        <div className="mx-6 mt-3 flex items-start gap-2 text-[13px] text-[#991B1B] bg-[#FCEBEB] border border-[#F5C6C6] px-3 py-2 rounded-lg">
          <AlertCircle size={14} className="mt-0.5 flex-shrink-0" /> <span>{actionError}</span>
        </div>
      )}

      <div className="p-6 space-y-3 max-w-3xl">
        {loading && <div className="text-center py-12 text-[13px] text-[#1A1A2E]/60">Loading…</div>}
        {!loading && bookings.length === 0 && (
          <div className="text-center py-16 text-[#1A1A2E] text-[14px]">
            {filter === 'pending' ? 'No pending CPR class requests. You’re all caught up.' : 'No CPR class requests on record.'}
          </div>
        )}
        {bookings.map(b => {
          const noteFields = parseBookingNotes(b.notes)
          const patientName = b.family?.display_name || b.family?.email || 'Unknown family'
          return (
            <div key={b.id} id={`cpr-card-${b.id}`} className={`border rounded-xl overflow-hidden bg-white shadow-sm ${b.status === 'pending' ? 'border-[#FAC775]' : 'border-[#E8E8E4]'}`}>
              <div className="flex items-center gap-3 px-5 py-4 cursor-pointer" onClick={() => setExpanded(expanded === b.id ? null : b.id)}>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-display text-[15px] font-medium text-[#1A1A2E]">
                      {patientName}
                    </span>
                    <Badge variant={b.status === 'pending' ? 'amber' : b.status === 'confirmed' ? 'teal' : 'gray'}>
                      {b.status === 'pending' ? 'Pending' : b.status === 'confirmed' ? 'Confirmed' : 'Cancelled'}
                    </Badge>
                  </div>
                  <div className="text-[12px] text-[#1A1A2E] mt-0.5 flex items-center gap-2 flex-wrap">
                    <span className="flex items-center gap-1"><Clock size={11} />{safeFormat(b.preferred_date + 'T12:00:00', 'EEE, MMM d')} · {b.preferred_time || '—'}</span>
                    {noteFields.PARTICIPANTS && <span>· {noteFields.PARTICIPANTS} participant{noteFields.PARTICIPANTS === '1' ? '' : 's'}</span>}
                  </div>
                </div>
                <ChevronDown size={14} className={`text-[#1A1A2E] transition-transform flex-shrink-0 ${expanded === b.id ? 'rotate-180' : ''}`} />
              </div>

              {expanded === b.id && (
                <div className="px-5 pb-5 border-t border-[#E8E8E4] pt-4">
                  <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-[13px] mb-4">
                    <div><span className="text-[#1A1A2E]">Contact email: </span><span className="font-medium">{noteFields.PARENTEMAIL || b.family?.email || '—'}</span></div>
                    <div><span className="text-[#1A1A2E]">Contact phone: </span><span className="font-medium">{noteFields.PARENTPHONE || b.family?.phone || '—'}</span></div>
                    {noteFields.ADDR && (
                      <div className="col-span-2"><span className="text-[#1A1A2E]">Address: </span><span className="font-medium">{noteFields.ADDR}</span></div>
                    )}
                    <div className="col-span-2 text-[11px] text-[#aeaeb2]">
                      Ref: {b.reference_code} · Submitted {safeFormat(b.created_at, 'MMM d, h:mm a')}
                    </div>
                  </div>

                  <div className="mb-4 border border-[#F5B7B1] bg-[#FDEDEC] rounded-lg p-3 text-[13px] space-y-1.5">
                    <div className="text-[11px] font-semibold text-[#922B21] uppercase tracking-wider mb-1">Class intake</div>
                    {noteFields.PARTICIPANTS && <div><span className="text-[#555]">Participants: </span><span className="font-medium">{noteFields.PARTICIPANTS}</span></div>}
                    {noteFields.ATTENDEES && <div><span className="text-[#555]">Attendees: </span><span className="font-medium whitespace-pre-wrap">{noteFields.ATTENDEES}</span></div>}
                    {noteFields.AGE_RANGE && <div><span className="text-[#555]">Age range: </span><span className="font-medium">{noteFields.AGE_RANGE}</span></div>}
                    {noteFields.PRIOR_TRAINING && <div><span className="text-[#555]">Prior training: </span><span className="font-medium capitalize">{noteFields.PRIOR_TRAINING}</span></div>}
                    {noteFields.CLASS_LOCATION && <div><span className="text-[#555]">Class location: </span><span className="font-medium">{noteFields.CLASS_LOCATION}</span></div>}
                    {noteFields.INSTRUCTOR_NOTES && <div><span className="text-[#555]">Notes for you: </span><span className="font-medium whitespace-pre-wrap">{noteFields.INSTRUCTOR_NOTES}</span></div>}
                    {noteFields.DECLINE_REASON && <div className="mt-2 pt-2 border-t border-[#F5B7B1]"><span className="text-[#555]">Decline reason: </span><span className="font-medium italic">{noteFields.DECLINE_REASON}</span></div>}
                  </div>

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
                      <span className="text-[12px] text-[#085041] bg-[#E1F5EE] border border-[#8FD8BE] px-2.5 py-1 rounded-full">
                        Confirmed — appointment is on your schedule
                      </span>
                    )}
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
