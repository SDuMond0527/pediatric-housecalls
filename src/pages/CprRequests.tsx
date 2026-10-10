import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { XCircle, Clock, ChevronDown, Check, AlertCircle, Plus, X } from 'lucide-react'
import { format } from 'date-fns'
import { getBookingRequests, updateBookingRequest, getFamiliesByIds, invokeNotifications, createAppointmentWithOverlapRetry, createBookingRequest, getProviderByName } from '../lib/api'
import { Badge } from '../components/ui/Badge'
import { Button } from '../components/ui/Button'
import { Input } from '../components/ui/Input'
import type { BookingRequest, FamilyProfile } from '../types/family'

// Full visit_type strings as stored on booking_requests and appointments.
// Keep these byte-identical to zipData.ts so AdminSchedule / Today / email
// subject lines all resolve the same metadata entry.
const CPR_CLASS_TYPES = [
  {
    label: 'Heartsaver (pediatric)',
    value: 'In-home CPR class (Heartsaver Child and Infant First Aid, CPR, AED, choking, injury/environmental emergencies, opioid-associated emergencies (including how to use Narcan) with optional modules in adult CPR/AED)',
  },
  {
    label: 'BLS (adult)',
    value: 'In-home CPR class (BLS - Adult CPR/AED use, first aid basics, medical/injury/environmental emergencies, choking, opioid-associated emergencies (including how to use Narcan), recognizing mental health crisis signs in the workplace, with optional modules for child & infant CPR/AED)',
  },
] as const

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
  const [scheduleOpen, setScheduleOpen] = useState(false)

  async function fetchBookings() {
    setLoading(true)
    // The API doesn't filter by visit_type, so fetch by status and
    // narrow client-side. Pending default, 'all' shows history too.
    const statuses = filter === 'pending' ? ['pending'] : ['pending', 'confirmed', 'cancelled']
    const results = await Promise.all(statuses.map(s => getBookingRequests({ status: s }).catch(() => [])))
    const merged = (results.flat() as BookingRequest[])
      .filter(b => b.visit_type.toLowerCase().includes('cpr class'))
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
    const familyIds = [...new Set(merged.map(b => b.family_id).filter(Boolean))]
    const families = familyIds.length ? await getFamiliesByIds(familyIds as string[]).catch(() => []) : []
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
        <div className="flex items-center gap-2">
          <Button variant="teal" size="xs" onClick={() => setScheduleOpen(true)}>
            <Plus size={12} /> Schedule a class
          </Button>
          <div className="flex gap-1 bg-[#FAFAF8] border border-[#E8E8E4] rounded-lg p-0.5">
            {(['pending', 'all'] as const).map(f => (
              <button key={f} onClick={() => setFilter(f)}
                className={`px-3 py-1.5 rounded-md text-[12px] font-medium capitalize transition-colors ${filter === f ? 'bg-white shadow-sm text-[#1A1A2E]' : 'text-[#1A1A2E] hover:text-[#555]'}`}>
                {f === 'pending' ? 'Pending' : 'All history'}
              </button>
            ))}
          </div>
        </div>
      </div>

      {scheduleOpen && (
        <ScheduleClassModal
          onClose={() => setScheduleOpen(false)}
          onCreated={async (newBookingId) => {
            setScheduleOpen(false)
            // Melissa just scheduled a confirmed booking — the default
            // Pending filter hides those, so flip to All history and
            // auto-expand the row she just created. Without this she'd
            // think the submit silently dropped the row.
            setFilter('all')
            if (newBookingId) {
              setExpanded(newBookingId)
              setTimeout(() => {
                document.getElementById(`cpr-card-${newBookingId}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
              }, 200)
            }
            await fetchBookings()
          }}
        />
      )}

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
          const patientName = b.family?.display_name || b.family?.email || noteFields.CONTACT_NAME || 'Unknown contact'
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
                    {noteFields.DOB && (
                      <div><span className="text-[#1A1A2E]">Date of birth: </span><span className="font-medium">{noteFields.DOB}</span></div>
                    )}
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

// ─────────────────────────────────────────────────────────────
// Melissa's own "Schedule a class" modal — bypasses the pending-approval
// flow because she IS the approver. Captures just enough contact info
// (Sara 2026-10-10: name, DOB, address, phone, email) + class metadata to
// seed the appointment and send a confirmation email. Writes a confirmed
// booking_request with family_id=null so the row shows up in the "All
// history" tab identically to family-initiated bookings.

const CPR_DURATION_FOR_MODAL = 180

function ScheduleClassModal({ onClose, onCreated }: { onClose: () => void; onCreated: (newBookingId?: string) => void | Promise<void> }) {
  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [dob, setDob] = useState('')
  const [address, setAddress] = useState('')
  const [city, setCity] = useState('')
  const [state, setState] = useState('NC')
  const [zip, setZip] = useState('')
  const [phone, setPhone] = useState('')
  const [email, setEmail] = useState('')
  const [classType, setClassType] = useState<string>(CPR_CLASS_TYPES[0].value)
  const [participantCount, setParticipantCount] = useState('1')
  const [attendeeNames, setAttendeeNames] = useState('')
  const [instructorNotes, setInstructorNotes] = useState('')
  const [date, setDate] = useState('')
  const [time12, setTime12] = useState('9:00 AM')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit() {
    setError(null)
    const req = (val: string, name: string) => (!val.trim() ? `${name} is required` : '')
    const err =
      req(firstName, 'First name')
      || req(lastName, 'Last name')
      || req(dob, 'Date of birth')
      || req(address, 'Street address')
      || req(city, 'City')
      || req(state, 'State')
      || req(zip, 'Zip')
      || req(phone, 'Phone')
      || req(email, 'Email')
      || req(date, 'Class date')
      || req(time12, 'Class time')
    if (err) { setError(err); return }
    const time24 = parseTimeInput(time12)
    if (!time24) { setError(`"${time12}" isn't a valid time — enter something like "9:00 AM" or "2:30 PM".`); return }
    const count = parseInt(participantCount, 10)
    if (isNaN(count) || count < 1 || count > 20) { setError('Participant count must be between 1 and 20.'); return }

    setSubmitting(true)
    try {
      const melissa = await getProviderByName('Melissa Jesse').catch(() => null)
      if (!melissa?.id) { setError('Could not find Melissa Jesse in the provider list.'); setSubmitting(false); return }

      const ref = 'MEL-' + Math.floor(10000 + Math.random() * 90000)
      const fullAddress = `${address.trim()}, ${city.trim()}, ${state.trim()} ${zip.trim()}`
      const notes = [
        `Ref: ${ref}`,
        `CONTACT_NAME:${firstName.trim()} ${lastName.trim()}`,
        `DOB:${dob}`,
        `ADDR:${fullAddress}`,
        `PARENTEMAIL:${email.trim()}`,
        `PARENTPHONE:${phone.trim()}`,
        `PARTICIPANTS:${count}`,
        attendeeNames.trim() ? `ATTENDEES:${attendeeNames.trim()}` : '',
        instructorNotes.trim() ? `INSTRUCTOR_NOTES:${instructorNotes.trim()}` : '',
        `SOURCE:instructor_scheduled`,
      ].filter(Boolean).join('|')

      await createAppointmentWithOverlapRetry({
        provider_id: melissa.id,
        visit_type: classType,
        zone: 'CPR Class',
        scheduled_time: time24,
        scheduled_date: date,
        status: 'upcoming',
        notes,
        duration_minutes: CPR_DURATION_FOR_MODAL,
      }, msg => window.confirm(msg + '\n\nSchedule anyway?'))

      const bookingRow = await createBookingRequest({
        family_id: null,
        child_ids: [],
        visit_type: classType,
        preferred_provider: 'Melissa Jesse',
        zone: 'CPR Class',
        state: state.trim(),
        preferred_date: date,
        preferred_time: time12,
        status: 'confirmed',
        confirmed_provider_id: melissa.id,
        reference_code: ref,
        notes,
      })

      if (bookingRow?.id) {
        invokeNotifications({
          type: 'cpr_booking_approved',
          bookingRequestId: bookingRow.id,
          familyName: `${firstName.trim()} ${lastName.trim()}`,
          parentEmail: email.trim(),
          parentPhone: phone.trim(),
          visitType: classType,
          date,
          time: time12,
        }).catch(() => {})
      }

      await onCreated(bookingRow?.id)
    } catch (e: any) {
      setError(e?.message ?? 'Failed to schedule class')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-start justify-center overflow-y-auto p-6">
      <div className="bg-white rounded-xl shadow-xl max-w-xl w-full my-8">
        <div className="flex items-center justify-between px-5 py-3 border-b border-[#E8E8E4]">
          <div className="font-display text-[16px] font-medium text-[#1A1A2E]">Schedule a CPR class</div>
          <button onClick={onClose} className="text-[#555] hover:text-[#1A1A2E]"><X size={16} /></button>
        </div>
        <div className="px-5 py-4 space-y-4 max-h-[70vh] overflow-y-auto">
          <div className="grid grid-cols-2 gap-3">
            <Input label="First name *" value={firstName} onChange={e => setFirstName(e.target.value)} />
            <Input label="Last name *" value={lastName} onChange={e => setLastName(e.target.value)} />
            <Input label="Date of birth *" type="date" value={dob} onChange={e => setDob(e.target.value)} />
            <Input label="Phone *" type="tel" value={phone} onChange={e => setPhone(e.target.value)} />
            <div className="col-span-2">
              <Input label="Email *" type="email" value={email} onChange={e => setEmail(e.target.value)} />
            </div>
            <div className="col-span-2">
              <Input label="Street address *" value={address} onChange={e => setAddress(e.target.value)} />
            </div>
            <Input label="City *" value={city} onChange={e => setCity(e.target.value)} />
            <Input label="State *" value={state} onChange={e => setState(e.target.value.toUpperCase().slice(0, 2))} />
            <Input label="Zip *" value={zip} onChange={e => setZip(e.target.value)} />
          </div>

          <div className="border-t border-[#E8E8E4] pt-4 space-y-3">
            <div>
              <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-1">Class type *</label>
              <select value={classType} onChange={e => setClassType(e.target.value)}
                className="w-full border border-[#E8E8E4] rounded-lg px-3 py-2 text-[13px] bg-white">
                {CPR_CLASS_TYPES.map(t => (
                  <option key={t.value} value={t.value}>{t.label}</option>
                ))}
              </select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Input label="Class date *" type="date" value={date} onChange={e => setDate(e.target.value)} />
              <Input label="Class time (e.g. 9:00 AM) *" value={time12} onChange={e => setTime12(e.target.value)} />
              <div className="col-span-2">
                <Input label="Number of participants *" type="number" min={1} max={20} value={participantCount}
                  onChange={e => setParticipantCount(e.target.value)} />
              </div>
              <div className="col-span-2">
                <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-1">Attendee names (optional)</label>
                <textarea value={attendeeNames} onChange={e => setAttendeeNames(e.target.value)} rows={2}
                  placeholder="One per line, e.g. Jane Doe · 32"
                  className="w-full border border-[#E8E8E4] rounded-lg px-3 py-2 text-[13px]" />
              </div>
              <div className="col-span-2">
                <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-1">Notes for yourself (optional)</label>
                <textarea value={instructorNotes} onChange={e => setInstructorNotes(e.target.value)} rows={2}
                  className="w-full border border-[#E8E8E4] rounded-lg px-3 py-2 text-[13px]" />
              </div>
            </div>
          </div>

          {error && (
            <div className="flex items-start gap-2 text-[13px] text-[#991B1B] bg-[#FCEBEB] border border-[#F5C6C6] px-3 py-2 rounded-lg">
              <AlertCircle size={14} className="mt-0.5 flex-shrink-0" /> <span>{error}</span>
            </div>
          )}
        </div>
        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-[#E8E8E4]">
          <Button variant="secondary" size="xs" onClick={onClose} disabled={submitting}>Cancel</Button>
          <Button variant="teal" size="xs" onClick={submit} loading={submitting}>
            <Check size={12} /> Schedule &amp; send confirmation
          </Button>
        </div>
      </div>
    </div>
  )
}
