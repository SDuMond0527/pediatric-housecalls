import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { CalendarPlus, Clock, X, AlertTriangle, Sparkles } from 'lucide-react'
import { format, isBefore, addHours } from 'date-fns'
import { familyGetWaitlistEntries, familyGetSlotOffers, familyUpdateSlotOffer, familyGetBookingRequests, familyUpdateBookingRequest, familyInvokeNotifications } from '../../lib/api'
import { useFamilyAuth } from '../../contexts/FamilyAuthContext'
import { Button } from '../../components/ui/Button'
import { VISIT_TYPE_INFO } from '../../lib/zipData'
import { usePracticeZones } from '../../hooks/usePracticeZones'
import type { BookingRequest, SlotOffer } from '../../types/family'

const IN_PERSON_TYPES = ['In-home sick visit', 'Sports physical', 'CMA + telemedicine', 'In-home IV fluids']

function isWithin2Hours(booking: BookingRequest): boolean {
  const [time, ampm] = booking.preferred_time.split(' ')
  let [h, m] = time.split(':').map(Number)
  if (ampm === 'PM' && h !== 12) h += 12
  if (ampm === 'AM' && h === 12) h = 0
  const apptDateTime = new Date(`${booking.preferred_date}T${h.toString().padStart(2,'0')}:${m.toString().padStart(2,'0')}:00`)
  return isBefore(apptDateTime, addHours(new Date(), 2))
}

export function FamilyDashboard() {
  const { family, children } = useFamilyAuth()
  const { zipToZone } = usePracticeZones()
  const navigate = useNavigate()
  const [bookings, setBookings] = useState<BookingRequest[]>([])
  const [loading, setLoading] = useState(true)
  const [cancelTarget, setCancelTarget] = useState<BookingRequest | null>(null)
  const [cancelling, setCancelling] = useState(false)
  const [offers, setOffers] = useState<SlotOffer[]>([])
  const [acceptingOffer, setAcceptingOffer] = useState<string | null>(null)

  async function fetchOffers() {
    if (!family) return
    const waitlistEntries = await familyGetWaitlistEntries({ family_id: family.id, status: 'waiting' }).catch(() => [])
    const ids = waitlistEntries.map((w: { id: string }) => w.id)
    if (!ids.length) { setOffers([]); return }

    const data = await familyGetSlotOffers({ waitlist_entry_ids: ids.join(',') }).catch(() => [])
    setOffers((data ?? []) as SlotOffer[])
  }

  async function fetchBookings() {
    if (!family) return
    const data = await familyGetBookingRequests({ family_id: family.id }).catch(() => [])
    setBookings((data ?? []) as BookingRequest[])
    setLoading(false)
  }

  useEffect(() => { fetchBookings(); fetchOffers() }, [family])

  async function acceptOffer(offer: SlotOffer) {
    setAcceptingOffer(offer.id)
    await familyInvokeNotifications({ type: 'slot_offer_accepted', offerId: offer.id }).catch(() => {})
    setAcceptingOffer(null)
    await Promise.all([fetchOffers(), fetchBookings()])
  }

  async function declineOffer(offerId: string) {
    await familyUpdateSlotOffer(offerId, { status: 'declined' })
    fetchOffers()
  }

  async function confirmCancel() {
    if (!cancelTarget) return
    setCancelling(true)

    await familyUpdateBookingRequest(cancelTarget.id, { status: 'cancelled' })

    // Notify waitlist families in the same zone that this slot opened up
    if (cancelTarget.confirmed_provider_id && cancelTarget.zone) {
      const matchingZips = Object.entries(zipToZone)
        .filter(([, z]) => z === cancelTarget.zone)
        .map(([zip]) => zip)
      if (matchingZips.length > 0) {
        familyInvokeNotifications({
          type: 'slot_opened',
          providerId: cancelTarget.confirmed_provider_id,
          zone: cancelTarget.zone,
          visitType: cancelTarget.visit_type,
          date: cancelTarget.preferred_date,
          time: cancelTarget.preferred_time,
          matchingZips,
        }).catch(() => {})
      }
    }

    // Notify provider + admins of the cancellation
    if (cancelTarget.confirmed_provider_id) {
      familyInvokeNotifications({
        type: 'booking_cancelled',
        providerId: cancelTarget.confirmed_provider_id,
        visitType: cancelTarget.visit_type,
        date: cancelTarget.preferred_date,
        time: cancelTarget.preferred_time,
        zone: cancelTarget.zone || '',
        familyName: family?.display_name || family?.email || 'A family',
      }).catch(() => {})
    }

    setCancelling(false)
    setCancelTarget(null)
    fetchBookings()
  }

  if (!family) return null

  const upcoming = bookings.filter(b => b.status !== 'cancelled' && new Date(b.preferred_date + 'T23:59:59') >= new Date())
  const past = bookings.filter(b => b.status !== 'cancelled' && new Date(b.preferred_date + 'T23:59:59') < new Date())
  const cancelled = bookings.filter(b => b.status === 'cancelled').slice(0, 2)

  const feeWarning = cancelTarget
    && IN_PERSON_TYPES.includes(cancelTarget.visit_type)
    && isWithin2Hours(cancelTarget)

  const greeting = family.display_name
    ? `Welcome back, ${family.display_name.split(' ')[0]}!`
    : 'Welcome back!'

  return (
    <div className="space-y-6">

      {/* Header */}
      <div className="bg-white border border-[#E8E8E4] rounded-xl p-6 shadow-sm">
        <div className="flex items-start justify-between">
          <div>
            <h1 className="font-display text-2xl font-medium text-[#1A1A2E]">{greeting}</h1>
            <p className="text-[13px] text-[#999] mt-1">
              {children.length} child{children.length !== 1 ? 'ren' : ''} on file
              {family.zip && ` · ${family.zip}`}
            </p>
          </div>
          <Button onClick={() => navigate('/family/book')}>
            <CalendarPlus size={15} /> Book a visit
          </Button>
        </div>

        {children.length > 0 && (
          <div className="flex gap-2 mt-4 flex-wrap">
            {children.map(child => (
              <div key={child.id} className="flex items-center gap-2 bg-[#FAFAF8] border border-[#E8E8E4] rounded-lg px-3 py-2">
                <div className="w-7 h-7 rounded-full bg-[#EEEDFE] flex items-center justify-center text-[11px] font-medium text-[#3C3489]">
                  {child.display_label.charAt(0).toUpperCase()}
                </div>
                <div className="text-[13px] font-medium text-[#1A1A2E]">{child.display_label}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Slot offers */}
      {offers.length > 0 && (
        <div>
          <h2 className="text-[13px] font-semibold text-[#1D9E75] uppercase tracking-wider mb-3 flex items-center gap-1.5">
            <Sparkles size={13} /> A spot opened up for you!
          </h2>
          <div className="space-y-3">
            {offers.map(offer => (
              <div key={offer.id} className="bg-white border-2 border-[#1D9E75] rounded-xl p-4 shadow-sm">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="font-display text-[15px] font-medium text-[#1A1A2E] mb-1">
                      {offer.visit_type || 'In-home visit'} with {offer.provider_name}
                    </div>
                    <div className="flex items-center gap-3 text-[12px] text-[#555] flex-wrap">
                      <span className="flex items-center gap-1">
                        <Clock size={11} />
                        {format(new Date(offer.offered_date + 'T12:00:00'), 'EEEE, MMMM d')} at {offer.offered_time}
                      </span>
                      {offer.zone && <span>· {offer.zone}</span>}
                    </div>
                    <p className="text-[11px] text-[#999] mt-1.5">
                      This offer expires {format(new Date(offer.expires_at), 'MMM d')} at {format(new Date(offer.expires_at), 'h:mm a')}
                    </p>
                  </div>
                </div>
                <div className="flex gap-2 mt-3">
                  <Button variant="teal" size="sm" className="flex-1"
                    loading={acceptingOffer === offer.id}
                    onClick={() => acceptOffer(offer)}>
                    Yes, book this slot
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => declineOffer(offer.id)}>
                    No thanks
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Upcoming */}
      {upcoming.length > 0 && (
        <div>
          <h2 className="text-[13px] font-semibold text-[#555] uppercase tracking-wider mb-3">Upcoming appointments</h2>
          <div className="space-y-2">
            {upcoming.map(b => (
              <BookingCard key={b.id} booking={b} onCancel={() => setCancelTarget(b)} />
            ))}
          </div>
        </div>
      )}

      {/* Empty state */}
      {!loading && bookings.filter(b => b.status !== 'cancelled').length === 0 && (
        <div className="bg-white border border-[#E8E8E4] rounded-xl p-10 text-center shadow-sm">
          <CalendarPlus size={28} className="text-[#aeaeb2] mx-auto mb-3" />
          <h3 className="font-display text-lg font-medium text-[#1A1A2E] mb-1">No appointments yet</h3>
          <p className="text-[13px] text-[#999] mb-5">Book your first visit with Pediatric Housecalls.</p>
          <Button onClick={() => navigate('/family/book')}>Book a visit</Button>
        </div>
      )}

      {/* Past */}
      {past.length > 0 && (
        <div>
          <h2 className="text-[13px] font-semibold text-[#555] uppercase tracking-wider mb-3">Past visits</h2>
          <div className="space-y-2">
            {past.slice(0, 3).map(b => <BookingCard key={b.id} booking={b} past />)}
          </div>
        </div>
      )}

      {/* Cancelled */}
      {cancelled.length > 0 && (
        <div>
          <h2 className="text-[13px] font-semibold text-[#999] uppercase tracking-wider mb-3">Cancelled</h2>
          <div className="space-y-2 opacity-50">
            {cancelled.map(b => <BookingCard key={b.id} booking={b} past />)}
          </div>
        </div>
      )}

      {/* Cancel confirmation modal */}
      {cancelTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" onClick={() => setCancelTarget(null)} />
          <div className="relative bg-white rounded-2xl shadow-xl w-full max-w-sm p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-display text-lg font-medium text-[#1A1A2E]">Cancel appointment?</h2>
              <button onClick={() => setCancelTarget(null)} className="p-1.5 rounded-lg hover:bg-[#F1EFE8] text-[#999]">
                <X size={16} />
              </button>
            </div>

            <div className="p-3 bg-[#FAFAF8] border border-[#E8E8E4] rounded-lg text-[13px] text-[#555] mb-4 space-y-1">
              <div className="font-medium text-[#1A1A2E]">{cancelTarget.visit_type}</div>
              <div className="flex items-center gap-1.5 text-[#999]">
                <Clock size={11} />
                {format(new Date(cancelTarget.preferred_date + 'T12:00:00'), 'EEEE, MMMM d')} at {cancelTarget.preferred_time}
              </div>
              {cancelTarget.preferred_provider && (
                <div className="text-[#999]">{cancelTarget.preferred_provider}</div>
              )}
            </div>

            {feeWarning && (
              <div className="flex items-start gap-2.5 p-3 bg-[#FAEEDA] border border-[#FAC775] rounded-lg text-[13px] text-[#633806] mb-4">
                <AlertTriangle size={15} className="flex-shrink-0 mt-0.5" />
                <div>
                  <strong>$75 cancellation fee applies.</strong> This is an in-person visit being cancelled within 2 hours of the scheduled time. The fee will be charged to your card on file.
                </div>
              </div>
            )}

            {!feeWarning && (
              <p className="text-[13px] text-[#555] mb-4">
                This cancellation is outside the 2-hour window — no fee will be charged.
              </p>
            )}

            <div className="flex gap-2">
              <Button variant="secondary" className="flex-1" onClick={() => setCancelTarget(null)}>
                Keep appointment
              </Button>
              <Button variant="danger" className="flex-1" loading={cancelling} onClick={confirmCancel}>
                {feeWarning ? 'Cancel & accept fee' : 'Cancel appointment'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function BookingCard({ booking, past = false, onCancel }: {
  booking: BookingRequest
  past?: boolean
  onCancel?: () => void
}) {
  const vt = VISIT_TYPE_INFO[booking.visit_type as keyof typeof VISIT_TYPE_INFO]
  const statusColor = booking.status === 'confirmed'
    ? { bg: '#E1F5EE', text: '#085041', label: 'Confirmed' }
    : booking.status === 'pending'
    ? { bg: '#FAEEDA', text: '#633806', label: 'Pending' }
    : { bg: '#F1EFE8', text: '#888780', label: 'Cancelled' }

  const isUpcoming = !past && booking.status !== 'cancelled'

  return (
    <div className={`bg-white border border-[#E8E8E4] rounded-xl p-4 shadow-sm ${past ? 'opacity-70' : ''}`}>
      <div className="flex items-start gap-3">
        <div className="w-10 h-10 rounded-xl flex items-center justify-center text-xl flex-shrink-0"
          style={{ background: vt?.bg || '#EEEDFE' }}>
          {vt?.icon || '📅'}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-display text-[15px] font-medium text-[#1A1A2E]">{booking.visit_type}</span>
            <span className="text-[11px] px-2 py-0.5 rounded-full font-medium"
              style={{ background: statusColor.bg, color: statusColor.text }}>
              {statusColor.label}
            </span>
          </div>
          <div className="flex items-center gap-3 mt-1 text-[12px] text-[#999]">
            <span className="flex items-center gap-1">
              <Clock size={11} />
              {format(new Date(booking.preferred_date + 'T12:00:00'), 'EEE, MMM d')} at {booking.preferred_time}
            </span>
            {booking.preferred_provider && <span>· {booking.preferred_provider}</span>}
          </div>
          <div className="text-[11px] text-[#aeaeb2] mt-1">Ref: {booking.reference_code}</div>
        </div>

        {isUpcoming && onCancel && (
          <button onClick={onCancel}
            className="flex-shrink-0 text-[12px] text-[#999] hover:text-[#791F1F] hover:bg-[#FCEBEB] px-2.5 py-1.5 rounded-lg transition-colors font-medium">
            Cancel
          </button>
        )}
      </div>
    </div>
  )
}
