import { useEffect, useState } from 'react'
import { format, parseISO } from 'date-fns'
import { getAvailabilityOverview } from '../../lib/api'

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function fmt24to12(t: string) {
  const [h, m] = t.split(':').map(Number)
  const ampm = h >= 12 ? 'PM' : 'AM'
  return `${h % 12 || 12}:${m.toString().padStart(2, '0')} ${ampm}`
}

interface Provider { id: string; name: string; role: string; initials: string; avatar_color: string; avatar_text_color: string }
interface AvailDay { provider_id: string; day_of_week: number; is_active: boolean; start_time: string; end_time: string }
interface Override { provider_id: string; date: string; is_available: boolean; start_time: string | null; end_time: string | null; note: string | null }

export function AdminAvailability() {
  const [providers, setProviders] = useState<Provider[]>([])
  const [availability, setAvailability] = useState<AvailDay[]>([])
  const [overrides, setOverrides] = useState<Override[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    getAvailabilityOverview().then((data: any) => {
      setProviders(data.providers ?? [])
      setAvailability(data.availability ?? [])
      setOverrides(data.overrides ?? [])
    }).catch(() => {}).finally(() => setLoading(false))
  }, [])

  if (loading) return <div className="p-8 text-[#999] text-[13px]">Loading…</div>

  return (
    <div>
      <div className="bg-white border-b border-[#E8E8E4] px-6 py-4 sticky top-0 z-10">
        <div className="font-display text-[18px] font-medium text-[#1A1A2E]">Provider availability</div>
        <div className="text-[12px] text-[#999] mt-0.5">Weekly schedules and upcoming date changes for all active providers</div>
      </div>

      <div className="p-6 space-y-4 max-w-5xl">
        {providers.length === 0 && (
          <p className="text-[13px] text-[#999]">No active providers found.</p>
        )}
        {providers.map(p => {
          const days = availability.filter(a => a.provider_id === p.id)
          const providerOverrides = overrides.filter(o => o.provider_id === p.id)
          const workingDays = days.filter(d => d.is_active)

          return (
            <div key={p.id} className="bg-white border border-[#E8E8E4] rounded-xl p-5 shadow-sm">
              {/* Provider header */}
              <div className="flex items-center gap-3 mb-4">
                <div className="w-9 h-9 rounded-full flex items-center justify-center text-[12px] font-semibold flex-shrink-0"
                  style={{ background: p.avatar_color || '#EEEDFE', color: p.avatar_text_color || '#3C3489' }}>
                  {p.initials}
                </div>
                <div>
                  <div className="font-medium text-[15px] text-[#1A1A2E]">{p.name}</div>
                  <div className="text-[11px] text-[#999] uppercase tracking-wider">{p.role}</div>
                </div>
                {workingDays.length === 0 && (
                  <span className="ml-auto text-[12px] text-[#999] italic">No schedule set</span>
                )}
              </div>

              {/* Weekly schedule grid */}
              {days.length > 0 && (
                <div className="grid grid-cols-7 gap-1.5 mb-4">
                  {DAYS.map((label, dow) => {
                    const day = days.find(d => d.day_of_week === dow)
                    const active = day?.is_active ?? false
                    return (
                      <div key={dow} className={`rounded-lg p-2 text-center border ${active ? 'bg-[#E1F5EE] border-[#5DCAA5]' : 'bg-[#FAFAF8] border-[#E8E8E4] opacity-50'}`}>
                        <div className={`text-[11px] font-semibold mb-1 ${active ? 'text-[#085041]' : 'text-[#999]'}`}>{label}</div>
                        {active && day ? (
                          <div className="text-[10px] text-[#085041] leading-tight">
                            {fmt24to12(day.start_time).replace(' AM','a').replace(' PM','p')}
                            <br />
                            {fmt24to12(day.end_time).replace(' AM','a').replace(' PM','p')}
                          </div>
                        ) : (
                          <div className="text-[10px] text-[#ccc]">Off</div>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}

              {/* Upcoming date overrides */}
              {providerOverrides.length > 0 && (
                <div className="border-t border-[#E8E8E4] pt-3">
                  <p className="text-[11px] font-semibold text-[#555] uppercase tracking-wider mb-2">Upcoming schedule changes (next 60 days)</p>
                  <div className="space-y-1.5">
                    {providerOverrides.map((o, i) => (
                      <div key={i} className={`flex items-center gap-3 px-3 py-2 rounded-lg text-[12px] ${o.is_available ? 'bg-[#E1F5EE] text-[#085041]' : 'bg-[#FCEBEB] text-[#791F1F]'}`}>
                        <span className="font-semibold whitespace-nowrap">{format(parseISO(o.date), 'EEE, MMM d')}</span>
                        <span>
                          {o.is_available
                            ? (o.start_time && o.end_time ? `${fmt24to12(o.start_time)} – ${fmt24to12(o.end_time)}` : 'Available')
                            : 'Unavailable'}
                        </span>
                        {o.note && <span className="text-[11px] opacity-70 italic">{o.note}</span>}
                      </div>
                    ))}
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
