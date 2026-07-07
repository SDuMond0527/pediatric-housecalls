import { useEffect, useState } from 'react'
import { MapPin, Clock, CheckCircle2, X } from 'lucide-react'
import { format } from 'date-fns'
import {
  getWaitlistEntries, updateWaitlistEntry,
  createAppointment, invokeNotifications,
} from '../lib/api'
import { useAuth } from '../contexts/AuthContext'
import { Badge } from '../components/ui/Badge'
import { Button } from '../components/ui/Button'
import { TIME_SLOTS } from '../lib/zipData'

interface WaitlistEntry {
  id: string
  family_id: string
  family_name: string | null
  family_email: string | null
  family_phone: string | null
  visit_type: string | null
  zip: string
  state: string | null
  preferred_time_window: string | null
  complaint: string | null
  visit_address: string | null
  children_selected: string | null
  requested_date: string | null
  notes: string | null
  status: string
  created_at: string
}

export function Waitlist() {
  const { provider } = useAuth()
  const [entries, setEntries] = useState<WaitlistEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [accepting, setAccepting] = useState<WaitlistEntry | null>(null)
  const [date, setDate] = useState('')
  const [time, setTime] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [passed, setPassed] = useState<Set<string>>(new Set())

  async function fetchEntries() {
    if (!provider) return
    setLoading(true)
    const data = await getWaitlistEntries({ status: 'waiting' })
    setEntries((data ?? []) as WaitlistEntry[])
    setLoading(false)
  }

  useEffect(() => { fetchEntries() }, [provider])

  async function acceptEntry() {
    if (!accepting || !provider || !date || !time) return
    setSubmitting(true)

    // Convert time to 24hr
    const [t, ampm] = time.split(' ')
    let [h, m] = t.split(':').map(Number)
    if (ampm === 'PM' && h !== 12) h += 12
    if (ampm === 'AM' && h === 12) h = 0
    const time24 = `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`

    // Create appointment
    await createAppointment({
      provider_id: provider.id,
      visit_type: accepting.visit_type || 'In-home sick visit',
      zone: accepting.zip,
      scheduled_time: time24,
      scheduled_date: date,
      status: 'upcoming',
      notes: `From waitlist · Zip: ${accepting.zip}${accepting.preferred_time_window ? ` · Preferred: ${accepting.preferred_time_window}` : ''}`,
    })

    // Mark waitlist entry as converted, recording which provider accepted it
    await updateWaitlistEntry(accepting.id, { status: 'converted', converted_provider_id: provider.id })

    // Notify the family via edge function
    invokeNotifications({
      type: 'waitlist_accepted',
      waitlistEntryId: accepting.id,
      providerName: provider.name,
      providerId: provider.id,
      date,
      time,
    }).catch(() => {})

    setSubmitting(false)
    setAccepting(null)
    setDate('')
    setTime('')
    fetchEntries()
  }

  function passEntry(id: string) {
    setPassed(prev => new Set([...prev, id]))
  }

  const visible = entries.filter(e => !passed.has(e.id))

  const stateLabel = (s: string | null) =>
    s === 'NC' ? 'North Carolina' : s === 'SC' ? 'South Carolina' : s === 'VA' ? 'Virginia' : s || '—'

  if (!provider) return null

  return (
    <div>
      <div className="bg-white border-b border-[#E8E8E4] px-6 py-4 flex items-center justify-between sticky top-0 z-10">
        <div>
          <div className="font-display text-[18px] font-medium text-[#1A1A2E]">Waitlist</div>
          <div className="text-[12px] text-[#999] mt-0.5">
            Families in {provider.states?.join(' & ')} waiting for coverage — accept to add to your schedule
          </div>
        </div>
        {visible.length > 0 && <Badge variant="amber">{visible.length} open</Badge>}
      </div>

      <div className="p-6 max-w-2xl">
        <div className="p-3 bg-[#EEEDFE] border border-[#AFA9EC] rounded-lg text-[13px] text-[#3C3489] mb-5 leading-relaxed">
          These families are outside our current service zones but within your licensed state
          ({provider.states?.join(', ')}). You can accept any entry regardless of zip code.
        </div>

        {loading && <div className="text-[#999] text-[13px]">Loading...</div>}

        {!loading && visible.length === 0 && (
          <div className="text-center py-16">
            <CheckCircle2 size={24} className="text-[#aeaeb2] mx-auto mb-2" />
            <p className="text-[14px] text-[#999]">No open waitlist entries in your state right now.</p>
          </div>
        )}

        <div className="space-y-3">
          {visible.map(entry => (
            <div key={entry.id} className="border border-[#E8E8E4] rounded-xl p-4 bg-white shadow-sm">
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap mb-1">
                    <span className="font-display text-[15px] font-medium text-[#1A1A2E]">
                      {entry.family_name || entry.family_email || 'Unknown family'}
                    </span>
                    <Badge variant={entry.state === 'NC' ? 'purple' : entry.state === 'SC' ? 'teal' : 'amber'}>
                      {stateLabel(entry.state)}
                    </Badge>
                    {entry.visit_type && <Badge variant="gray">{entry.visit_type}</Badge>}
                  </div>

                  {entry.notes && (
                    <div className="mt-1 mb-2 space-y-1">
                      {entry.notes.split(' | ').map((part, i) => {
                        const [label, ...rest] = part.split(': ')
                        const value = rest.join(': ')
                        return value
                          ? <p key={i} className="text-[13px] text-[#1A1A2E]"><span className="text-[#999]">{label}: </span>{value}</p>
                          : <p key={i} className="text-[13px] text-[#555]">{part}</p>
                      })}
                    </div>
                  )}

                  <div className="flex items-center gap-3 text-[12px] text-[#999] flex-wrap">
                    <span className="flex items-center gap-1"><MapPin size={11} /> Zip {entry.zip}</span>
                    {entry.preferred_time_window && <span className="flex items-center gap-1"><Clock size={11} /> {entry.preferred_time_window}</span>}
                    <span>Waiting since {format(new Date(entry.created_at), 'MMM d, h:mm a')}</span>
                  </div>
                </div>
                <div className="flex flex-col gap-1.5 flex-shrink-0">
                  <Button variant="teal" size="sm" onClick={() => { setAccepting(entry); setDate(''); setTime('') }}>
                    Accept and move to my schedule
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => passEntry(entry.id)}>
                    Pass
                  </Button>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Accept modal */}
      {accepting && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" onClick={() => setAccepting(null)} />
          <div className="relative bg-white rounded-2xl shadow-xl w-full max-w-sm p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-display text-lg font-medium text-[#1A1A2E]">Accept waitlist patient</h2>
              <button onClick={() => setAccepting(null)} className="p-1.5 rounded-lg hover:bg-[#F1EFE8] text-[#999]">
                <X size={16} />
              </button>
            </div>

            <div className="p-3 bg-[#FAFAF8] border border-[#E8E8E4] rounded-lg text-[13px] text-[#555] mb-4 space-y-1">
              <div className="font-medium text-[#1A1A2E]">{accepting.visit_type || 'Visit'}</div>
              <div className="flex items-center gap-1 text-[#999]">
                <MapPin size={11} /> Zip {accepting.zip} · {stateLabel(accepting.state)}
              </div>
              {accepting.preferred_time_window && (
                <div className="flex items-center gap-1 text-[#999]">
                  <Clock size={11} /> Preferred: {accepting.preferred_time_window}
                </div>
              )}
            </div>

            <p className="text-[13px] text-[#555] mb-4">
              Pick a date and time. The family will be notified and the appointment will be added to your schedule.
            </p>

            <div className="space-y-3 mb-5">
              <div>
                <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-1">Date</label>
                <input type="date" value={date} min={new Date().toISOString().split('T')[0]}
                  onChange={e => setDate(e.target.value)}
                  className="w-full px-3 py-2.5 border border-[#E8E8E4] rounded-lg text-[14px] font-sans outline-none focus:border-[#7F77DD]" />
              </div>
              {date && (
                <div>
                  <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-1">Time</label>
                  <div className="grid grid-cols-4 gap-1.5">
                    {TIME_SLOTS.map(slot => (
                      <button key={slot} onClick={() => setTime(slot)}
                        className={`py-1.5 text-center text-[12px] rounded-lg border-2 transition-all font-sans ${time === slot ? 'bg-[#7F77DD] border-[#7F77DD] text-white' : 'border-[#E8E8E4] bg-white hover:border-[#AFA9EC] text-[#1A1A2E]'}`}>
                        {slot}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <div className="flex gap-2">
              <Button variant="secondary" className="flex-1" onClick={() => setAccepting(null)}>Cancel</Button>
              <Button variant="teal" className="flex-1" disabled={!date || !time} loading={submitting} onClick={acceptEntry}>
                <CheckCircle2 size={14} /> Confirm
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
