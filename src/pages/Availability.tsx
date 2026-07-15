import { useEffect, useState } from 'react'
import { Plus, X, CalendarDays, CheckCircle2, ChevronLeft, ChevronRight, List } from 'lucide-react'
import {
  format, isPast, parseISO, startOfMonth, endOfMonth,
  eachDayOfInterval, getDay, addMonths, subMonths, isToday, isBefore, startOfDay,
} from 'date-fns'
import {
  getAvailability, upsertAvailabilityOverride, deleteAvailabilityOverride,
  createZoneRestriction, deleteZoneRestriction,
  createTimeBlock, deleteTimeBlock,
  upsertVisitTypeAvailability,
  getProviders,
} from '../lib/api'
import { useAuth } from '../contexts/AuthContext'
import { Button } from '../components/ui/Button'
import { Modal } from '../components/ui/Modal'
import { usePracticeVisitTypes } from '../hooks/usePracticeVisitTypes'
import type { ZoneRestriction, TimeBlock } from '../types'

interface AvailabilityOverride {
  id: string
  provider_id: string
  date: string
  is_available: boolean
  start_time: string | null
  end_time: string | null
  note: string | null
}

interface VisitTypeAvail {
  id: string | null
  provider_id: string
  visit_type: string
  is_active: boolean
  start_time: string
  end_time: string
}


const ALL_TIMES: string[] = (() => {
  const times: string[] = []
  for (let h = 6; h <= 23; h++) {
    for (let m = 0; m < 60; m += 30) {
      if (h === 23 && m > 0) break
      const ampm = h >= 12 ? 'PM' : 'AM'
      const h12 = h % 12 || 12
      times.push(`${h12}:${m.toString().padStart(2, '0')} ${ampm}`)
    }
  }
  return times
})()

const TIME_OPTIONS_START = ALL_TIMES
const TIME_OPTIONS_END   = ALL_TIMES

function fmt24to12(t: string) {
  const [h, m] = t.split(':').map(Number)
  const ampm = h >= 12 ? 'PM' : 'AM'
  return `${h % 12 || 12}:${m.toString().padStart(2,'0')} ${ampm}`
}
function fmt12to24(t: string) {
  const [time, ampm] = t.split(' ')
  let [h, m] = time.split(':').map(Number)
  if (ampm === 'PM' && h !== 12) h += 12
  if (ampm === 'AM' && h === 12) h = 0
  return `${h.toString().padStart(2,'0')}:${m.toString().padStart(2,'0')}`
}

function defaultVisitTypeAvail(providerId: string, visitTypeNames: string[]): VisitTypeAvail[] {
  return visitTypeNames.map(vt => ({
    id: null,
    provider_id: providerId,
    visit_type: vt,
    is_active: true,
    start_time: '08:00',
    end_time: '17:00',
  }))
}

export function Availability() {
  const { provider } = useAuth()
  const isAdmin = !!provider?.is_admin
  const { visitTypes, byType } = usePracticeVisitTypes()

  // Admin provider picker
  const [allProviders, setAllProviders] = useState<{ id: string; name: string; role: string }[]>([])
  const [selectedProviderId, setSelectedProviderId] = useState<string>('')
  const viewingProviderId = isAdmin ? selectedProviderId : (provider?.id ?? '')
  const viewingProviderRole = isAdmin
    ? (allProviders.find(p => p.id === selectedProviderId)?.role ?? '')
    : (provider?.role ?? '')

  useEffect(() => {
    if (!isAdmin) return
    getProviders().then((rows: any[]) => {
      const active = rows.filter((p: any) => p.is_active !== false)
        .sort((a: any, b: any) => a.name.localeCompare(b.name))
      setAllProviders(active)
      if (active.length > 0) setSelectedProviderId(active[0].id)
    }).catch(() => {})
  }, [isAdmin])

  const [visitTypeAvail, setVisitTypeAvail] = useState<VisitTypeAvail[]>([])
  const [zoneRestrictions, setZoneRestrictions] = useState<ZoneRestriction[]>([])
  const [timeBlocks, setTimeBlocks] = useState<TimeBlock[]>([])
  const [overrides, setOverrides] = useState<AvailabilityOverride[]>([])
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [savingOverride, setSavingOverride] = useState(false)
  const [zoneModal, setZoneModal] = useState(false)
  const [blockModal, setBlockModal] = useState(false)
  const [overrideModal, setOverrideModal] = useState(false)
  const [overrideDateView, setOverrideDateView] = useState<'list' | 'calendar'>('calendar')
  const [calMonth, setCalMonth] = useState(() => new Date())
  const [newZone, setNewZone] = useState({ zone: '', start: '8:00 AM', end: '12:00 PM' })
  const [newBlock, setNewBlock] = useState<{
    label: string; blockType: 'recurring' | 'date'
    days: string; time_range: string
    date: string; start: string; end: string
  }>({ label: '', blockType: 'recurring', days: 'Mon–Fri', time_range: '3:30–4:00 PM', date: '', start: '8:00 AM', end: '5:00 PM' })
  const [newOverride, setNewOverride] = useState({
    date: '',
    is_available: true,
    start: '8:00 AM',
    end: '5:00 PM',
    note: '',
  })

  const [savedVisitTypes, setSavedVisitTypes] = useState<VisitTypeAvail[]>([])

  useEffect(() => {
    if (!viewingProviderId) return
    getAvailability(viewingProviderId).then(({ overrides: ov, zoneRestrictions: zr, timeBlocks: tb, visitTypes: saved }) => {
      setSavedVisitTypes((saved ?? []) as VisitTypeAvail[])
      setZoneRestrictions((zr ?? []) as ZoneRestriction[])
      setTimeBlocks((tb ?? []) as TimeBlock[])
      setOverrides(((ov ?? []) as any[]).map(o => ({ ...o, date: (o.date as string).split('T')[0] })) as AvailabilityOverride[])
    })
  }, [viewingProviderId])

  // Re-merge whenever saved rows or practice visit types change
  useEffect(() => {
    if (!viewingProviderId || visitTypes.length === 0) return
    const defaults = defaultVisitTypeAvail(viewingProviderId, visitTypes.map(v => v.visit_type))
    const merged = defaults.map(def => {
      const existing = savedVisitTypes.find(s => s.visit_type === def.visit_type)
      return existing ?? def
    })
    setVisitTypeAvail(merged)
  }, [viewingProviderId, visitTypes, savedVisitTypes])

  function toggleVisitType(visitType: string) {
    setVisitTypeAvail(prev => prev.map(v =>
      v.visit_type === visitType ? { ...v, is_active: !v.is_active } : v
    ))
  }

  function updateVisitTypeTime(visitType: string, field: 'start_time' | 'end_time', val: string) {
    setVisitTypeAvail(prev => prev.map(v =>
      v.visit_type === visitType ? { ...v, [field]: fmt12to24(val) } : v
    ))
  }

  async function save() {
    if (!viewingProviderId) return
    setSaving(true)
    try {
      const rows = visitTypeAvail.map(v => ({
        id: v.id ?? undefined,
        provider_id: viewingProviderId,
        visit_type: v.visit_type,
        is_active: v.is_active,
        start_time: v.start_time,
        end_time: v.end_time,
      }))
      const upserted = await upsertVisitTypeAvailability(viewingProviderId, rows)
      if (upserted) {
        setVisitTypeAvail(prev => prev.map(v => {
          const fresh = (upserted as VisitTypeAvail[]).find(u => u.visit_type === v.visit_type)
          return fresh ? fresh : v
        }))
      }
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch (e) {
      alert('Save failed: ' + (e instanceof Error ? e.message : 'Unknown error'))
    } finally {
      setSaving(false)
    }
  }

  async function addZoneRestriction() {
    if (!viewingProviderId || !newZone.zone) return
    try {
      const data = await createZoneRestriction({
        provider_id: viewingProviderId, zone: newZone.zone,
        start_time: fmt12to24(newZone.start), end_time: fmt12to24(newZone.end),
      })
      if (data) setZoneRestrictions(prev => [...prev, data as ZoneRestriction])
      setZoneModal(false)
      setNewZone({ zone: '', start: '8:00 AM', end: '12:00 PM' })
    } catch (e) {
      alert('Failed to save zone restriction: ' + (e instanceof Error ? e.message : 'Unknown error'))
    }
  }

  async function removeZone(id: string) {
    await deleteZoneRestriction(id)
    setZoneRestrictions(prev => prev.filter(z => z.id !== id))
  }

  async function addTimeBlock() {
    if (!viewingProviderId || !newBlock.label) return
    if (newBlock.blockType === 'date' && !newBlock.date) return
    try {
      const payload = newBlock.blockType === 'date'
        ? { provider_id: viewingProviderId, label: newBlock.label, date: newBlock.date, start_time: fmt12to24(newBlock.start), end_time: fmt12to24(newBlock.end) }
        : { provider_id: viewingProviderId, label: newBlock.label, days: newBlock.days, time_range: newBlock.time_range }
      const data = await createTimeBlock(payload)
      if (data) setTimeBlocks(prev => [...prev, data as TimeBlock])
      setBlockModal(false)
      setNewBlock({ label: '', blockType: 'recurring', days: 'Mon–Fri', time_range: '3:30–4:00 PM', date: '', start: '8:00 AM', end: '5:00 PM' })
    } catch (e) {
      alert('Failed to save time block: ' + (e instanceof Error ? e.message : 'Unknown error'))
    }
  }

  async function removeBlock(id: string) {
    await deleteTimeBlock(id)
    setTimeBlocks(prev => prev.filter(b => b.id !== id))
  }

  async function addOverride() {
    if (!viewingProviderId || !newOverride.date) return
    setSavingOverride(true)
    const savedDate = newOverride.date
    try {
      const payload = {
        date: savedDate,
        is_available: newOverride.is_available,
        start_time: newOverride.is_available ? fmt12to24(newOverride.start) : null,
        end_time: newOverride.is_available ? fmt12to24(newOverride.end) : null,
        note: newOverride.note || null,
      }
      await upsertAvailabilityOverride(viewingProviderId, payload)
      // Re-fetch from server; normalize date format (Neon may return full ISO timestamp)
      const fresh = await getAvailability(viewingProviderId)
      const normalized = (fresh.overrides ?? []).map((o: any) => ({
        ...o,
        date: (o.date as string).split('T')[0],
      }))
      setOverrides(normalized as AvailabilityOverride[])
      // Navigate calendar to show the saved date's month
      setCalMonth(new Date(savedDate + 'T12:00:00'))
      setOverrideDateView('calendar')
      setOverrideModal(false)
      setNewOverride({ date: '', is_available: true, start: '8:00 AM', end: '5:00 PM', note: '' })
    } catch (e) {
      alert('Failed to save: ' + (e instanceof Error ? e.message : 'Unknown error'))
    } finally {
      setSavingOverride(false)
    }
  }

  async function removeOverride(id: string) {
    await deleteAvailabilityOverride(id)
    setOverrides(prev => prev.filter(o => o.id !== id))
  }

  const upcomingOverrides = overrides.filter(o => !isPast(parseISO(o.date)))
  const pastOverrides = overrides.filter(o => isPast(parseISO(o.date)))

  const overrideByDate = Object.fromEntries(overrides.map(o => [o.date, o]))

  function openOverrideForDate(dateStr: string) {
    const existing = overrideByDate[dateStr]
    if (existing) {
      setNewOverride({
        date: existing.date,
        is_available: existing.is_available,
        start: existing.start_time ? fmt24to12(existing.start_time) : '8:00 AM',
        end: existing.end_time ? fmt24to12(existing.end_time) : '5:00 PM',
        note: existing.note ?? '',
      })
    } else {
      setNewOverride({ date: dateStr, is_available: true, start: '8:00 AM', end: '5:00 PM', note: '' })
    }
    setOverrideModal(true)
  }

  const calDays = eachDayOfInterval({ start: startOfMonth(calMonth), end: endOfMonth(calMonth) })
  const calStartPad = getDay(calDays[0])

  return (
    <div>
      <div className="bg-white border-b border-[#E8E8E4] px-6 py-4 flex items-center justify-between sticky top-0 z-10">
        <div>
          <div className="font-display text-[18px] font-medium text-[#1A1A2E]">Availability settings</div>
          {isAdmin && allProviders.length > 0 && (
            <div className="flex items-center gap-2 mt-1">
              <span className="text-[12px] text-[#999]">Viewing:</span>
              <select
                value={selectedProviderId}
                onChange={e => setSelectedProviderId(e.target.value)}
                className="text-[13px] font-medium text-[#1A1A2E] border border-[#E8E8E4] rounded-lg px-2.5 py-1 bg-white font-sans focus:border-[#7F77DD] outline-none"
              >
                {allProviders.map(p => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </div>
          )}
        </div>
        <Button variant="primary" size="sm" loading={saving} onClick={save}>
          {saved ? 'Saved!' : 'Save changes'}
        </Button>
      </div>

      <div className="p-6 space-y-5 max-w-2xl">

        {/* VISIT TYPE AVAILABILITY */}
        <div className="bg-white border border-[#E8E8E4] rounded-lg p-5 shadow-sm">
          <div className="font-display text-[16px] font-medium text-[#1A1A2E] mb-1">Visit type–specific hours</div>
          <p className="text-[13px] text-[#555] mb-4 leading-relaxed">
            Toggle on the visit types you offer, and optionally restrict the hours you're available for each type.
          </p>
          <div className="space-y-2">
            {visitTypeAvail.filter(v => {
              const isMdOrPnp = viewingProviderRole === 'MD' || viewingProviderRole === 'PNP'
              const isOnCallType = v.visit_type === 'CMA + telemedicine' || v.visit_type === 'IV fluids telemedicine screening'
              return !(isMdOrPnp && isOnCallType)
            }).map(v => {
              const config = byType[v.visit_type]
              return (
                <div key={v.visit_type} className="border border-[#E8E8E4] rounded-lg px-4 py-3">
                  <div className="flex items-center justify-between">
                    <span
                      className="text-[12px] font-medium px-2.5 py-1 rounded-full"
                      style={{ background: config?.badge_color ?? '#F0F0EE', color: config?.badge_text_color ?? '#555' }}
                    >
                      {config?.badge_label ?? v.visit_type}
                    </span>
                    <button onClick={() => toggleVisitType(v.visit_type)}
                      className={`w-9 h-5 rounded-full relative transition-colors ${v.is_active ? 'bg-[#1D9E75]' : 'bg-[#D0D0CC]'}`}>
                      <span className={`absolute w-4 h-4 bg-white rounded-full top-0.5 transition-all shadow-sm ${v.is_active ? 'left-[18px]' : 'left-0.5'}`} />
                    </button>
                  </div>
                  {v.is_active && (
                    <div className="flex items-center gap-2 mt-2 flex-wrap">
                      <span className="text-[12px] text-[#555]">Hours:</span>
                      <select value={fmt24to12(v.start_time)} onChange={e => updateVisitTypeTime(v.visit_type, 'start_time', e.target.value)}
                        className="text-[13px] px-2 py-1 border border-[#E8E8E4] rounded-md font-sans">
                        {TIME_OPTIONS_START.map(t => <option key={t}>{t}</option>)}
                      </select>
                      <span className="text-[12px] text-[#555]">to</span>
                      <select value={fmt24to12(v.end_time)} onChange={e => updateVisitTypeTime(v.visit_type, 'end_time', e.target.value)}
                        className="text-[13px] px-2 py-1 border border-[#E8E8E4] rounded-md font-sans">
                        {TIME_OPTIONS_END.map(t => <option key={t}>{t}</option>)}
                      </select>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>

        {/* ZONE-HOUR CUSTOMIZATIONS */}
        <div className="bg-white border border-[#E8E8E4] rounded-lg p-5 shadow-sm">
          <div className="font-display text-[16px] font-medium text-[#1A1A2E] mb-1">Zone-hour customizations</div>
          <p className="text-[13px] text-[#555] mb-4 leading-relaxed">Restrict hours you're available within specific zones.</p>
          <div className="space-y-2">
            {zoneRestrictions.map(z => (
              <div key={z.id} className="flex items-center gap-2 p-3 bg-[#FAFAF8] rounded-lg flex-wrap">
                <span className="bg-[#EEEDFE] text-[#3C3489] text-[11px] font-medium px-2.5 py-1 rounded-full">{z.zone}</span>
                <span className="text-[12px] text-[#555]">only</span>
                <span className="text-[13px] font-medium text-[#1A1A2E]">{fmt24to12(z.start_time)} – {fmt24to12(z.end_time)}</span>
                <button onClick={() => removeZone(z.id)} className="ml-auto p-1 rounded hover:bg-[#FCEBEB] text-[#999] hover:text-[#791F1F]"><X size={13} /></button>
              </div>
            ))}
          </div>
          <Button variant="secondary" size="sm" className="mt-3" onClick={() => setZoneModal(true)}>
            <Plus size={13} /> Add zone restriction
          </Button>
        </div>

        {/* TIME BLOCKS */}
        <div className="bg-white border border-[#E8E8E4] rounded-lg p-5 shadow-sm">
          <div className="font-display text-[16px] font-medium text-[#1A1A2E] mb-1">Time blocks</div>
          <p className="text-[13px] text-[#555] mb-4 leading-relaxed">Block times that should never be bookable — either recurring (e.g. school pickup) or a one-time date.</p>
          <div className="space-y-2">
            {timeBlocks.map(b => (
              <div key={b.id} className="flex items-center justify-between bg-[#FCEBEB] border border-[#F09595] rounded-lg px-3 py-2.5">
                {b.date
                  ? <span className="text-[12px] text-[#791F1F]">
                      <strong>{b.label}</strong> · {format(parseISO(b.date.split('T')[0]), 'EEE MMM d')}
                      {b.start_time && b.end_time ? ` · ${fmt24to12(b.start_time)} – ${fmt24to12(b.end_time)}` : ''}
                    </span>
                  : <span className="text-[12px] text-[#791F1F]"><strong>{b.label}</strong> · {b.days} · {b.time_range}</span>
                }
                <button onClick={() => removeBlock(b.id)} className="p-1 rounded hover:bg-[#F09595]/20 text-[#791F1F]"><X size={13} /></button>
              </div>
            ))}
          </div>
          <Button variant="secondary" size="sm" className="mt-3" onClick={() => setBlockModal(true)}>
            <Plus size={13} /> Add time block
          </Button>
        </div>

        {/* DATE-SPECIFIC OVERRIDES */}
        <div className="bg-white border border-[#E8E8E4] rounded-lg p-5 shadow-sm">
          <div className="flex items-center justify-between mb-1">
            <div className="flex items-center gap-2">
              <CalendarDays size={16} className="text-[#7F77DD]" />
              <div className="font-display text-[16px] font-medium text-[#1A1A2E]">Date-specific availability</div>
            </div>
            <div className="flex items-center gap-2">
              <div className="flex rounded-lg border border-[#E8E8E4] overflow-hidden">
                <button
                  onClick={() => setOverrideDateView('calendar')}
                  className={`px-2.5 py-1.5 text-[12px] font-medium transition-colors flex items-center gap-1 ${overrideDateView === 'calendar' ? 'bg-[#1A1A2E] text-white' : 'text-[#555] hover:bg-[#F1EFE8]'}`}
                >
                  <CalendarDays size={12} /> Calendar
                </button>
                <button
                  onClick={() => setOverrideDateView('list')}
                  className={`px-2.5 py-1.5 text-[12px] font-medium transition-colors flex items-center gap-1 border-l border-[#E8E8E4] ${overrideDateView === 'list' ? 'bg-[#1A1A2E] text-white' : 'text-[#555] hover:bg-[#F1EFE8]'}`}
                >
                  <List size={12} /> List
                </button>
              </div>
              <Button variant="primary" size="sm" onClick={() => {
                setNewOverride({ date: '', is_available: true, start: '8:00 AM', end: '5:00 PM', note: '' })
                setOverrideModal(true)
              }}>
                <Plus size={13} /> Add date
              </Button>
            </div>
          </div>
          <p className="text-[13px] text-[#555] mb-4 leading-relaxed">
            Set custom hours or mark yourself unavailable for specific dates. These override your weekly schedule.
          </p>

          {/* CALENDAR VIEW */}
          {overrideDateView === 'calendar' && (
            <div>
              {/* Month navigation */}
              <div className="flex items-center justify-between mb-3">
                <button
                  onClick={() => setCalMonth(m => subMonths(m, 1))}
                  className="p-1.5 rounded-lg hover:bg-[#F1EFE8] text-[#555]"
                >
                  <ChevronLeft size={16} />
                </button>
                <span className="text-[14px] font-medium text-[#1A1A2E]">
                  {format(calMonth, 'MMMM yyyy')}
                </span>
                <button
                  onClick={() => setCalMonth(m => addMonths(m, 1))}
                  className="p-1.5 rounded-lg hover:bg-[#F1EFE8] text-[#555]"
                >
                  <ChevronRight size={16} />
                </button>
              </div>

              {/* Day-of-week headers */}
              <div className="grid grid-cols-7 mb-1">
                {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(d => (
                  <div key={d} className="text-center text-[11px] font-semibold text-[#999] uppercase tracking-wider py-1">
                    {d}
                  </div>
                ))}
              </div>

              {/* Calendar grid */}
              <div className="grid grid-cols-7 gap-1">
                {/* Leading empty cells */}
                {Array.from({ length: calStartPad }).map((_, i) => (
                  <div key={`pad-${i}`} />
                ))}

                {calDays.map(day => {
                  const dateStr = format(day, 'yyyy-MM-dd')
                  const override = overrideByDate[dateStr]
                  const past = isBefore(day, startOfDay(new Date()))
                  const today = isToday(day)

                  let cellBg = 'bg-white hover:bg-[#F1EFE8] border-[#E8E8E4]'
                  let dateNumColor = 'text-[#1A1A2E]'
                  let subText: string | null = null
                  let subColor = 'text-[#555]'

                  if (override) {
                    if (override.is_available) {
                      cellBg = past
                        ? 'bg-[#E1F5EE]/50 border-[#5DCAA5]/50 opacity-60'
                        : 'bg-[#E1F5EE] border-[#5DCAA5] hover:bg-[#C8EFE1]'
                      subText = override.start_time && override.end_time
                        ? `${fmt24to12(override.start_time).replace(' AM','a').replace(' PM','p')} – ${fmt24to12(override.end_time).replace(' AM','a').replace(' PM','p')}`
                        : 'Available'
                      subColor = 'text-[#085041]'
                    } else {
                      cellBg = past
                        ? 'bg-[#FCEBEB]/50 border-[#F09595]/50 opacity-60'
                        : 'bg-[#FCEBEB] border-[#F09595] hover:bg-[#F9D5D5]'
                      subText = 'Off'
                      subColor = 'text-[#791F1F]'
                      dateNumColor = 'text-[#791F1F]'
                    }
                  } else if (past) {
                    cellBg = 'bg-white border-[#E8E8E4] opacity-40'
                  }

                  return (
                    <button
                      key={dateStr}
                      onClick={() => openOverrideForDate(dateStr)}
                      className={`relative rounded-lg border p-1.5 text-left transition-colors min-h-[52px] ${cellBg} ${today ? 'ring-2 ring-[#7F77DD] ring-offset-1' : ''}`}
                    >
                      <div className={`text-[12px] font-semibold ${dateNumColor}`}>
                        {format(day, 'd')}
                      </div>
                      {subText && (
                        <div className={`text-[10px] leading-tight mt-0.5 font-medium ${subColor}`}>
                          {subText}
                        </div>
                      )}
                      {override && (
                        <button
                          onClick={e => { e.stopPropagation(); removeOverride(override.id) }}
                          className="absolute top-0.5 right-0.5 p-0.5 rounded text-[#999] hover:text-[#555] hover:bg-black/10"
                        >
                          <X size={10} />
                        </button>
                      )}
                    </button>
                  )
                })}
              </div>

              {/* Legend */}
              <div className="flex items-center gap-4 mt-3 pt-3 border-t border-[#E8E8E4]">
                <div className="flex items-center gap-1.5">
                  <div className="w-3 h-3 rounded bg-[#E1F5EE] border border-[#5DCAA5]" />
                  <span className="text-[11px] text-[#555]">Custom hours</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <div className="w-3 h-3 rounded bg-[#FCEBEB] border border-[#F09595]" />
                  <span className="text-[11px] text-[#555]">Off</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <div className="w-3 h-3 rounded bg-white border-2 border-[#7F77DD]" />
                  <span className="text-[11px] text-[#555]">Today</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <div className="w-3 h-3 rounded bg-white border border-[#E8E8E4]" />
                  <span className="text-[11px] text-[#555]">Weekly schedule</span>
                </div>
              </div>
            </div>
          )}

          {/* LIST VIEW */}
          {overrideDateView === 'list' && (
            <div>
              {upcomingOverrides.length === 0 && pastOverrides.length === 0 && (
                <div className="text-center py-6 text-[#999] text-[13px]">
                  No date overrides set. Your weekly schedule applies to all dates.
                </div>
              )}

              {upcomingOverrides.length > 0 && (
                <div className="mb-4">
                  <p className="text-[11px] font-semibold text-[#555] uppercase tracking-wider mb-2">Upcoming</p>
                  <div className="space-y-2">
                    {upcomingOverrides.map(o => (
                      <div key={o.id} className={`flex items-center gap-3 p-3 rounded-lg border ${o.is_available ? 'bg-[#E1F5EE] border-[#5DCAA5]' : 'bg-[#FCEBEB] border-[#F09595]'}`}>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-[14px] font-medium text-[#1A1A2E]">
                              {format(parseISO(o.date), 'EEEE, MMMM d, yyyy')}
                            </span>
                            {o.is_available ? (
                              <span className="text-[11px] px-2 py-0.5 rounded-full bg-[#1D9E75] text-white font-medium">Available</span>
                            ) : (
                              <span className="text-[11px] px-2 py-0.5 rounded-full bg-[#791F1F] text-white font-medium">Unavailable</span>
                            )}
                          </div>
                          {o.is_available && o.start_time && o.end_time && (
                            <div className="text-[12px] text-[#555] mt-0.5">
                              {fmt24to12(o.start_time)} – {fmt24to12(o.end_time)}
                            </div>
                          )}
                          {o.note && <div className="text-[12px] text-[#555] mt-0.5 italic">{o.note}</div>}
                        </div>
                        <button onClick={() => removeOverride(o.id)}
                          className="p-1.5 rounded-lg hover:bg-black/10 text-[#555] flex-shrink-0">
                          <X size={13} />
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {pastOverrides.length > 0 && (
                <div>
                  <p className="text-[11px] font-semibold text-[#999] uppercase tracking-wider mb-2">Past</p>
                  <div className="space-y-1.5">
                    {pastOverrides.slice(-3).map(o => (
                      <div key={o.id} className="flex items-center gap-3 p-2.5 rounded-lg border border-[#E8E8E4] bg-[#FAFAF8] opacity-60">
                        <div className="flex-1 text-[13px] text-[#555]">
                          {format(parseISO(o.date), 'MMMM d, yyyy')} ·{' '}
                          {o.is_available && o.start_time && o.end_time
                            ? `${fmt24to12(o.start_time)} – ${fmt24to12(o.end_time)}`
                            : 'Unavailable'}
                        </div>
                        <button onClick={() => removeOverride(o.id)} className="p-1 text-[#999] hover:text-[#555]"><X size={12} /></button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <Modal open={zoneModal} onClose={() => setZoneModal(false)} title="Add zone restriction" size="sm">
        <div className="space-y-4">
          <div>
            <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-1">Zone</label>
            <input value={newZone.zone} onChange={e => setNewZone(p => ({ ...p, zone: e.target.value }))}
              className="w-full px-3 py-2 border border-[#E8E8E4] rounded-lg text-sm font-sans" placeholder="Zone name" />
          </div>
          <div className="flex gap-3">
            <div className="flex-1">
              <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-1">From</label>
              <select value={newZone.start} onChange={e => setNewZone(p => ({ ...p, start: e.target.value }))}
                className="w-full px-3 py-2 border border-[#E8E8E4] rounded-lg text-sm font-sans">
                {TIME_OPTIONS_START.map(t => <option key={t}>{t}</option>)}
              </select>
            </div>
            <div className="flex-1">
              <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-1">To</label>
              <select value={newZone.end} onChange={e => setNewZone(p => ({ ...p, end: e.target.value }))}
                className="w-full px-3 py-2 border border-[#E8E8E4] rounded-lg text-sm font-sans">
                {TIME_OPTIONS_END.map(t => <option key={t}>{t}</option>)}
              </select>
            </div>
          </div>
          <div className="flex gap-2 pt-1">
            <Button variant="secondary" size="sm" onClick={() => setZoneModal(false)}>Cancel</Button>
            <Button variant="primary" size="sm" onClick={addZoneRestriction}>Add restriction</Button>
          </div>
        </div>
      </Modal>

      <Modal open={blockModal} onClose={() => setBlockModal(false)} title="Add time block" size="sm">
        <div className="space-y-4">
          <div>
            <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-1">Label</label>
            <input value={newBlock.label} onChange={e => setNewBlock(p => ({ ...p, label: e.target.value }))}
              className="w-full px-3 py-2 border border-[#E8E8E4] rounded-lg text-sm font-sans" placeholder="e.g. School pickup" />
          </div>
          <div>
            <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-2">Type</label>
            <div className="flex gap-2">
              <button onClick={() => setNewBlock(p => ({ ...p, blockType: 'recurring' }))}
                className={`flex-1 py-2 rounded-lg border-2 text-[13px] font-medium transition-all ${newBlock.blockType === 'recurring' ? 'border-[#1A1A2E] bg-[#1A1A2E] text-white' : 'border-[#E8E8E4] text-[#555]'}`}>
                Recurring
              </button>
              <button onClick={() => setNewBlock(p => ({ ...p, blockType: 'date' }))}
                className={`flex-1 py-2 rounded-lg border-2 text-[13px] font-medium transition-all ${newBlock.blockType === 'date' ? 'border-[#1A1A2E] bg-[#1A1A2E] text-white' : 'border-[#E8E8E4] text-[#555]'}`}>
                One-time date
              </button>
            </div>
          </div>
          {newBlock.blockType === 'recurring' ? (
            <>
              <div>
                <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-1">Days</label>
                <input value={newBlock.days} onChange={e => setNewBlock(p => ({ ...p, days: e.target.value }))}
                  className="w-full px-3 py-2 border border-[#E8E8E4] rounded-lg text-sm font-sans" placeholder="e.g. Mon–Fri" />
              </div>
              <div>
                <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-1">Time range</label>
                <input value={newBlock.time_range} onChange={e => setNewBlock(p => ({ ...p, time_range: e.target.value }))}
                  className="w-full px-3 py-2 border border-[#E8E8E4] rounded-lg text-sm font-sans" placeholder="e.g. 3:30–4:00 PM" />
              </div>
            </>
          ) : (
            <>
              <div>
                <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-1">Date</label>
                <input type="date" value={newBlock.date}
                  min={new Date().toISOString().split('T')[0]}
                  onChange={e => setNewBlock(p => ({ ...p, date: e.target.value }))}
                  className="w-full px-3 py-2 border border-[#E8E8E4] rounded-lg text-sm font-sans" />
              </div>
              <div className="flex gap-3">
                <div className="flex-1">
                  <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-1">From</label>
                  <select value={newBlock.start} onChange={e => setNewBlock(p => ({ ...p, start: e.target.value }))}
                    className="w-full px-3 py-2 border border-[#E8E8E4] rounded-lg text-sm font-sans">
                    {TIME_OPTIONS_START.map(t => <option key={t}>{t}</option>)}
                  </select>
                </div>
                <div className="flex-1">
                  <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-1">To</label>
                  <select value={newBlock.end} onChange={e => setNewBlock(p => ({ ...p, end: e.target.value }))}
                    className="w-full px-3 py-2 border border-[#E8E8E4] rounded-lg text-sm font-sans">
                    {TIME_OPTIONS_END.map(t => <option key={t}>{t}</option>)}
                  </select>
                </div>
              </div>
            </>
          )}
          <div className="flex gap-2 pt-1">
            <Button variant="secondary" size="sm" onClick={() => setBlockModal(false)}>Cancel</Button>
            <Button variant="primary" size="sm"
              disabled={!newBlock.label || (newBlock.blockType === 'date' && !newBlock.date)}
              onClick={addTimeBlock}>
              Add block
            </Button>
          </div>
        </div>
      </Modal>

      <Modal open={overrideModal} onClose={() => setOverrideModal(false)} title="Set date-specific availability" size="sm">
        <div className="space-y-4">
          <div>
            <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-1">Date</label>
            <input type="date" value={newOverride.date}
              min={new Date().toISOString().split('T')[0]}
              onChange={e => setNewOverride(p => ({ ...p, date: e.target.value }))}
              className="w-full px-3 py-2 border border-[#E8E8E4] rounded-lg text-sm font-sans" />
          </div>

          <div>
            <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-2">Availability</label>
            <div className="flex gap-2">
              <button onClick={() => setNewOverride(p => ({ ...p, is_available: true }))}
                className={`flex-1 py-2 rounded-lg border-2 text-[13px] font-medium transition-all ${newOverride.is_available ? 'border-[#1D9E75] bg-[#E1F5EE] text-[#085041]' : 'border-[#E8E8E4] text-[#555]'}`}>
                Available
              </button>
              <button onClick={() => setNewOverride(p => ({ ...p, is_available: false }))}
                className={`flex-1 py-2 rounded-lg border-2 text-[13px] font-medium transition-all ${!newOverride.is_available ? 'border-[#F09595] bg-[#FCEBEB] text-[#791F1F]' : 'border-[#E8E8E4] text-[#555]'}`}>
                Unavailable
              </button>
            </div>
          </div>

          {newOverride.is_available && (
            <div className="flex gap-3">
              <div className="flex-1">
                <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-1">From</label>
                <select value={newOverride.start} onChange={e => setNewOverride(p => ({ ...p, start: e.target.value }))}
                  className="w-full px-3 py-2 border border-[#E8E8E4] rounded-lg text-sm font-sans">
                  {TIME_OPTIONS_START.map(t => <option key={t}>{t}</option>)}
                </select>
              </div>
              <div className="flex-1">
                <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-1">To</label>
                <select value={newOverride.end} onChange={e => setNewOverride(p => ({ ...p, end: e.target.value }))}
                  className="w-full px-3 py-2 border border-[#E8E8E4] rounded-lg text-sm font-sans">
                  {TIME_OPTIONS_END.map(t => <option key={t}>{t}</option>)}
                </select>
              </div>
            </div>
          )}

          <div>
            <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-1">Note (optional)</label>
            <input value={newOverride.note} onChange={e => setNewOverride(p => ({ ...p, note: e.target.value }))}
              placeholder="e.g. Vacation, conference, school event..."
              className="w-full px-3 py-2 border border-[#E8E8E4] rounded-lg text-sm font-sans" />
          </div>

          <div className="flex gap-2 pt-1">
            <Button variant="secondary" size="sm" onClick={() => setOverrideModal(false)}>Cancel</Button>
            <Button variant="primary" size="sm" disabled={!newOverride.date} loading={savingOverride} onClick={addOverride}>
              <CheckCircle2 size={13} /> Save date
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  )
}
