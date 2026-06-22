import { useEffect, useState } from 'react'
import { startOfWeek, addDays, format, isToday } from 'date-fns'
import { getAppointments } from '../lib/api'
import { useAuth } from '../contexts/AuthContext'
import { Badge } from '../components/ui/Badge'
import { VISIT_TYPES } from '../lib/constants'
import type { Appointment } from '../types'

const HOURS = ['8 AM','9 AM','10 AM','11 AM','12 PM','1 PM','2 PM','3 PM','4 PM','5 PM']
const HOUR_VALS = [8,9,10,11,12,13,14,15,16,17]

export function Week() {
  const { provider } = useAuth()
  const [appts, setAppts] = useState<Appointment[]>([])
  const [loading, setLoading] = useState(true)

  const weekStart = startOfWeek(new Date())
  const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i))

  useEffect(() => {
    if (!provider) return
    const from = format(weekStart, 'yyyy-MM-dd')
    const to = format(addDays(weekStart, 6), 'yyyy-MM-dd')
    getAppointments({ provider_id: provider.id, from, to })
      .then((data) => { setAppts((data ?? []) as Appointment[]); setLoading(false) })
  }, [provider])

  function getApptForCell(day: Date, hour: number) {
    const dateStr = format(day, 'yyyy-MM-dd')
    return appts.filter(a => {
      if (a.scheduled_date !== dateStr) return false
      const h = parseInt(a.scheduled_time.split(':')[0])
      return h === hour
    })
  }

  const totals = {
    total: appts.length,
    sick: appts.filter(a => a.visit_type === 'In-home sick visit').length,
    tele: appts.filter(a => a.visit_type === 'Video telemedicine').length,
    physical: appts.filter(a => a.visit_type === 'Sports physical').length,
  }

  return (
    <div>
      <div className="bg-white border-b border-[#E8E8E4] px-6 py-4 flex items-center justify-between sticky top-0 z-10">
        <div className="font-display text-[18px] font-medium text-[#1A1A2E]">Week view</div>
        <Badge variant="purple">Week of {format(weekStart, 'MMMM d')}</Badge>
      </div>

      <div className="p-6 space-y-5">
        <div className="bg-white border border-[#E8E8E4] rounded-lg overflow-hidden shadow-sm">
          <div className="overflow-x-auto">
            <div style={{ display: 'grid', gridTemplateColumns: '60px repeat(7, 1fr)', minWidth: 600 }}>
              <div className="bg-[#FAFAF8] border-b border-r border-[#E8E8E4] p-2" />
              {days.map(day => (
                <div key={day.toISOString()}
                  className={`border-b border-r border-[#E8E8E4] p-2 text-center last:border-r-0 ${isToday(day) ? 'bg-[#EEEDFE]' : 'bg-[#FAFAF8]'}`}>
                  <div className={`text-[11px] font-medium ${isToday(day) ? 'text-[#3C3489]' : 'text-[#555]'}`}>{format(day, 'EEE')}</div>
                  <div className={`text-[15px] font-semibold mt-0.5 ${isToday(day) ? 'text-[#3C3489]' : 'text-[#1A1A2E]'}`}>{format(day, 'd')}</div>
                </div>
              ))}
              {HOUR_VALS.map((hour, hi) => (
                <>
                  <div key={`h${hour}`} className="border-b border-r border-[#E8E8E4] bg-[#FAFAF8] py-1.5 px-2 text-right text-[11px] text-[#999]">
                    {HOURS[hi]}
                  </div>
                  {days.map(day => {
                    const cellAppts = getApptForCell(day, hour)
                    return (
                      <div key={`${day.toISOString()}-${hour}`}
                        className="border-b border-r border-[#E8E8E4] last:border-r-0 min-h-[36px] p-1">
                        {cellAppts.map(a => {
                          const vt = VISIT_TYPES[a.visit_type]
                          return (
                            <div key={a.id} className="rounded px-1.5 py-0.5 text-[10px] font-medium mb-0.5 leading-snug"
                              style={{ background: vt?.color || '#EEEDFE', color: vt?.textColor || '#3C3489' }}>
                              {a.visit_type.split(' ')[0]}
                            </div>
                          )
                        })}
                      </div>
                    )
                  })}
                </>
              ))}
            </div>
          </div>
        </div>

        <div className="bg-white border border-[#E8E8E4] rounded-lg p-5 shadow-sm">
          <div className="font-display text-[16px] font-medium text-[#1A1A2E] mb-4">This week at a glance</div>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            {[
              { label: 'Appointments', value: totals.total, color: '#1A1A2E' },
              { label: 'Sick visits',   value: totals.sick,    color: '#3C3489' },
              { label: 'Telemedicine',  value: totals.tele,    color: '#085041' },
              { label: 'Physicals',     value: totals.physical,color: '#633806' },
            ].map(s => (
              <div key={s.label} className="border border-[#E8E8E4] rounded-lg p-3">
                <div className="font-display text-2xl font-medium mb-0.5" style={{ color: s.color }}>{loading ? '—' : s.value}</div>
                <div className="text-[12px] text-[#555]">{s.label}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
