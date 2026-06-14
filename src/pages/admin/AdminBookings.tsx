import { useEffect, useState } from 'react'
import { XCircle, Clock, ChevronDown } from 'lucide-react'
import { format } from 'date-fns'
import { supabase } from '../../lib/supabase'
import { Badge } from '../../components/ui/Badge'
import { Button } from '../../components/ui/Button'
import type { BookingRequest, FamilyProfile } from '../../types/family'

interface EnrichedBooking extends BookingRequest {
  family?: FamilyProfile
  childNames?: string[]
}

export function AdminBookings() {
  const [bookings, setBookings] = useState<EnrichedBooking[]>([])
  const [loading, setLoading] = useState(true)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [filter, setFilter] = useState<'confirmed' | 'cancelled' | 'all'>('confirmed')

  async function fetchBookings() {
    setLoading(true)
    let q = supabase.from('booking_requests').select('*').order('created_at', { ascending: false })
    if (filter !== 'all') q = q.eq('status', filter)
    const { data: bData } = await q
    if (!bData) { setLoading(false); return }

    const familyIds = [...new Set(bData.map(b => b.family_id))]
    const childIdsFlat = [...new Set(bData.flatMap(b => b.child_ids))]

    const [{ data: families }, { data: kids }] = await Promise.all([
      supabase.from('family_profiles').select('*').in('id', familyIds),
      supabase.from('children').select('*').in('id', childIdsFlat),
    ])

    const enriched: EnrichedBooking[] = bData.map(b => ({
      ...b,
      family: families?.find(f => f.id === b.family_id),
      childNames: kids?.filter(c => b.child_ids.includes(c.id)).map(c => c.first_name) || [],
    }))

    setBookings(enriched)
    setLoading(false)
  }

  useEffect(() => { fetchBookings() }, [filter])

  async function cancelBooking(id: string) {
    await supabase.from('booking_requests').update({ status: 'cancelled' }).eq('id', id)
    fetchBookings()
  }

  return (
    <div>
      <div className="bg-white border-b border-[#E8E8E4] px-6 py-4 flex items-center justify-between sticky top-0 z-10">
        <div>
          <div className="font-display text-[18px] font-medium text-[#1A1A2E]">Booking history</div>
          <div className="text-[12px] text-[#999] mt-0.5">Appointments are confirmed automatically when families book</div>
        </div>
        <div className="flex gap-1 bg-[#FAFAF8] border border-[#E8E8E4] rounded-lg p-0.5">
          {(['confirmed', 'cancelled', 'all'] as const).map(f => (
            <button key={f} onClick={() => setFilter(f)}
              className={`px-3 py-1.5 rounded-md text-[12px] font-medium capitalize transition-colors ${filter === f ? 'bg-white shadow-sm text-[#1A1A2E]' : 'text-[#999] hover:text-[#555]'}`}>
              {f}
            </button>
          ))}
        </div>
      </div>

      <div className="p-6 space-y-3 max-w-3xl">
        {!loading && bookings.length === 0 && (
          <div className="text-center py-16 text-[#999] text-[14px]">No {filter} booking requests.</div>
        )}

        {bookings.map(b => (
          <div key={b.id} className={`border rounded-xl overflow-hidden bg-white shadow-sm ${b.status === 'pending' ? 'border-[#FAC775]' : 'border-[#E8E8E4]'}`}>
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
                <div className="text-[12px] text-[#999] mt-0.5 flex items-center gap-2 flex-wrap">
                  <span className="flex items-center gap-1"><Clock size={11} />{format(new Date(b.preferred_date + 'T12:00:00'), 'EEE, MMM d')} at {b.preferred_time}</span>
                  <span>· {b.visit_type}</span>
                  {b.zone && <span>· {b.zone}</span>}
                </div>
              </div>
              <ChevronDown size={14} className={`text-[#999] transition-transform flex-shrink-0 ${expanded === b.id ? 'rotate-180' : ''}`} />
            </div>

            {expanded === b.id && (
              <div className="px-5 pb-5 border-t border-[#E8E8E4] pt-4">
                <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-[13px] mb-4">
                  <div><span className="text-[#999]">Contact: </span><span className="font-medium">{b.family?.email}</span></div>
                  <div><span className="text-[#999]">Provider: </span><span className="font-medium">{b.preferred_provider || 'Any'}</span></div>
                  <div><span className="text-[#999]">Zone: </span><span className="font-medium">{b.zone || '—'}</span></div>
                  <div><span className="text-[#999]">State: </span><span className="font-medium">{b.state || '—'}</span></div>
                  {b.charm_appointment_id && (
                    <div className="col-span-2"><span className="text-[#999]">Charm ID: </span><span className="font-mono text-[11px]">{b.charm_appointment_id}</span></div>
                  )}
                  <div className="col-span-2 text-[11px] text-[#aeaeb2]">Ref: {b.reference_code} · Submitted {format(new Date(b.created_at), 'MMM d, h:mm a')}</div>
                </div>

                {b.status !== 'cancelled' && (
                  <Button variant="danger" size="xs" onClick={() => cancelBooking(b.id)}>
                    <XCircle size={12} /> Cancel booking
                  </Button>
                )}
              </div>
            )}
          </div>
        ))}
      </div>

    </div>
  )
}
