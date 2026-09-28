import { useMemo } from 'react'
import { format, addDays, isSameDay, parseISO } from 'date-fns'
import type { Appointment, Provider } from '../types'

interface ScheduleBlock {
  id: string
  provider_id: string
  start_date: string
  end_date: string
  all_day: boolean
  start_time: string | null
  end_time: string | null
  reason: string | null
}

interface AppointmentLike extends Appointment {
  provider_name?: string | null
  child_name?: string | null
}

interface Props {
  weekStartDate: Date
  appointments: AppointmentLike[]
  blocks: ScheduleBlock[]
  providers: Provider[]
  onSelectAppointment: (id: string) => void
  onSelectBlock?: (id: string) => void
  showProviderColors: boolean
  singleProviderId?: string
  childNameById?: Record<string, string>
}

const START_HOUR = 7
const END_HOUR = 20
const HOUR_HEIGHT = 60
const TOTAL_HEIGHT = (END_HOUR - START_HOUR) * HOUR_HEIGHT

// Hand-picked palette for maximum inter-provider distinction. Ordered by
// hue so adjacent indices are clearly different. Assigned by sorting
// providers by id (stable across renders — a provider always gets the
// same slot regardless of which providers are visible). All colors have
// enough contrast against white to render bold white text on top.
const WEEK_PALETTE: Array<{ bg: string; fg: string }> = [
  { bg: '#DC2626', fg: '#ffffff' }, // red
  { bg: '#EA580C', fg: '#ffffff' }, // orange
  { bg: '#CA8A04', fg: '#ffffff' }, // gold
  { bg: '#16A34A', fg: '#ffffff' }, // green
  { bg: '#0891B2', fg: '#ffffff' }, // cyan
  { bg: '#2563EB', fg: '#ffffff' }, // blue
  { bg: '#7C3AED', fg: '#ffffff' }, // purple
  { bg: '#DB2777', fg: '#ffffff' }, // pink
  { bg: '#059669', fg: '#ffffff' }, // emerald
  { bg: '#7C2D12', fg: '#ffffff' }, // brown
]

function minutesFromDayStart(t: string): number {
  const [h, m] = t.split(':').map(Number)
  return (h - START_HOUR) * 60 + m
}

function formatTime12(t: string): string {
  const [h, m] = t.split(':').map(Number)
  if (isNaN(h) || isNaN(m)) return t
  const ampm = h >= 12 ? 'p' : 'a'
  const hr = h % 12 || 12
  return m === 0 ? `${hr}${ampm}` : `${hr}:${m.toString().padStart(2, '0')}${ampm}`
}

// Position overlapping items in the same day column into sub-columns so
// they don't visually stack on top of each other. Simple greedy split
// like a calendar app — each new event lands in the first sub-column
// whose last event ends before this event starts, or a new one otherwise.
function assignColumns<T extends { startMin: number; endMin: number }>(items: T[]): Array<T & { col: number; totalCols: number }> {
  const sorted = [...items].sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin)
  const columns: T[][] = []
  const assigned = sorted.map(item => {
    let col = -1
    for (let i = 0; i < columns.length; i++) {
      const last = columns[i][columns[i].length - 1]
      if (last.endMin <= item.startMin) { col = i; break }
    }
    if (col === -1) { columns.push([item]); col = columns.length - 1 }
    else columns[col].push(item)
    return { ...item, col }
  })
  // Total columns needed at any point overlapping with this item.
  return assigned.map(it => {
    const overlappers = assigned.filter(x => x.startMin < it.endMin && x.endMin > it.startMin)
    const totalCols = Math.max(...overlappers.map(x => x.col)) + 1
    return { ...it, totalCols }
  })
}

export function WeekBlockView({
  weekStartDate,
  appointments,
  blocks,
  providers,
  onSelectAppointment,
  onSelectBlock,
  showProviderColors,
  singleProviderId,
  childNameById,
}: Props) {
  const days = useMemo(() => {
    return Array.from({ length: 7 }, (_, i) => addDays(weekStartDate, i))
  }, [weekStartDate])

  const providerById = useMemo(() => {
    const m: Record<string, Provider> = {}
    for (const p of providers) m[p.id] = p
    return m
  }, [providers])

  // Stable palette-index-by-provider mapping. Sort by id so a provider
  // always gets the same color slot even when the visible provider set
  // changes (e.g., an inactive provider joins/leaves the list).
  const paletteByProviderId = useMemo(() => {
    const m: Record<string, { bg: string; fg: string }> = {}
    const sorted = [...providers].sort((a, b) => a.id.localeCompare(b.id))
    sorted.forEach((p, i) => { m[p.id] = WEEK_PALETTE[i % WEEK_PALETTE.length] })
    return m
  }, [providers])

  const filteredAppts = useMemo(() => {
    return singleProviderId
      ? appointments.filter(a => a.provider_id === singleProviderId && a.status !== 'cancelled')
      : appointments.filter(a => a.status !== 'cancelled')
  }, [appointments, singleProviderId])

  const filteredBlocks = useMemo(() => {
    return singleProviderId
      ? blocks.filter(b => b.provider_id === singleProviderId)
      : blocks
  }, [blocks, singleProviderId])

  const today = new Date()

  return (
    <div className="border border-[#E8E8E4] rounded-xl bg-white overflow-hidden">
      {/* Header row — day names + dates */}
      <div className="grid grid-cols-[60px_repeat(7,1fr)] border-b border-[#E8E8E4] bg-[#FAFAF8]">
        <div />
        {days.map(d => {
          const isToday = isSameDay(d, today)
          return (
            <div key={d.toISOString()}
              className={`py-2 px-2 text-center border-l border-[#E8E8E4] ${isToday ? 'bg-[#EEEDFE]' : ''}`}>
              <div className="text-[11px] font-medium uppercase tracking-wider text-[#555]">{format(d, 'EEE')}</div>
              <div className={`text-[15px] font-semibold ${isToday ? 'text-[#7F77DD]' : 'text-[#1A1A2E]'}`}>{format(d, 'M/d')}</div>
            </div>
          )
        })}
      </div>

      {/* Scrollable time grid */}
      <div className="overflow-y-auto max-h-[calc(100vh-260px)]">
        <div className="grid grid-cols-[60px_repeat(7,1fr)] relative" style={{ minHeight: TOTAL_HEIGHT }}>
          {/* Time axis */}
          <div className="border-r border-[#E8E8E4]" style={{ height: TOTAL_HEIGHT }}>
            {Array.from({ length: END_HOUR - START_HOUR }, (_, i) => {
              const h = START_HOUR + i
              const label = h < 12 ? `${h} AM` : h === 12 ? '12 PM' : `${h - 12} PM`
              return (
                <div key={h} className="text-[10px] text-[#aeaeb2] pr-1 text-right border-b border-[#F1EFE8]" style={{ height: HOUR_HEIGHT }}>
                  {label}
                </div>
              )
            })}
          </div>

          {/* Day columns */}
          {days.map(d => {
            const dateStr = format(d, 'yyyy-MM-dd')
            const isToday = isSameDay(d, today)

            // Appointments on this day.
            const dayAppts = filteredAppts
              .filter(a => a.scheduled_date === dateStr || (a.scheduled_date && a.scheduled_date.startsWith(dateStr)))
              .map(a => {
                const startMin = minutesFromDayStart(a.scheduled_time)
                const dur = a.duration_minutes || 60
                return { appt: a, startMin, endMin: startMin + dur, dur }
              })
              .filter(x => x.endMin > 0 && x.startMin < TOTAL_HEIGHT)

            const positioned = assignColumns(dayAppts)

            // Blocks that cover any part of this day.
            const dayBlocks = filteredBlocks.filter(b => {
              try {
                const start = parseISO(b.start_date.slice(0, 10))
                const end = parseISO(b.end_date.slice(0, 10))
                return d >= start && d <= end
              } catch { return false }
            })

            return (
              <div key={d.toISOString()} className={`relative border-l border-[#E8E8E4] ${isToday ? 'bg-[#FAFBFE]' : ''}`} style={{ height: TOTAL_HEIGHT }}>
                {/* Hour grid lines */}
                {Array.from({ length: END_HOUR - START_HOUR }, (_, i) => (
                  <div key={i} className="border-b border-[#F1EFE8]" style={{ height: HOUR_HEIGHT }} />
                ))}

                {/* Schedule blocks — hatched gray, behind appointments */}
                {dayBlocks.map(b => {
                  const startMin = b.all_day || !b.start_time ? 0 : Math.max(0, minutesFromDayStart(b.start_time))
                  const endMin   = b.all_day || !b.end_time   ? TOTAL_HEIGHT : Math.min(TOTAL_HEIGHT, minutesFromDayStart(b.end_time))
                  const top      = startMin
                  const height   = Math.max(20, endMin - startMin)
                  // Skip auto-created appt:<id> anchor blocks — they duplicate the appointment visually.
                  if (b.reason && b.reason.startsWith('appt:')) return null
                  return (
                    <div key={b.id}
                      onClick={() => onSelectBlock?.(b.id)}
                      className="absolute left-0 right-0 mx-0.5 rounded bg-[#F1EFE8] border border-[#E0DDCF] text-[#555] px-1 py-0.5 text-[10px] overflow-hidden cursor-pointer"
                      style={{
                        top,
                        height,
                        backgroundImage: 'repeating-linear-gradient(45deg, transparent, transparent 4px, rgba(0,0,0,0.04) 4px, rgba(0,0,0,0.04) 8px)',
                        zIndex: 1,
                      }}
                      title={b.reason ?? 'Blocked'}>
                      <div className="font-medium truncate">{b.reason || 'Blocked'}</div>
                      {!b.all_day && b.start_time && b.end_time && (
                        <div className="text-[9px] opacity-70">{formatTime12(b.start_time)}–{formatTime12(b.end_time)}</div>
                      )}
                    </div>
                  )
                })}

                {/* Appointment blocks */}
                {positioned.map(({ appt, startMin, dur, col, totalCols }) => {
                  const prov = providerById[appt.provider_id]
                  const palette = showProviderColors && prov ? paletteByProviderId[prov.id] : null
                  const bg = palette ? palette.bg : '#7F77DD'
                  const fg = palette ? palette.fg : '#ffffff'
                  const left = (col / totalCols) * 100
                  const width = (1 / totalCols) * 100
                  const childName = appt.child_name || (appt.child_id ? childNameById?.[appt.child_id] : null) || 'No patient linked'
                  const height = Math.max(22, dur - 2)
                  // Below ~44px we can only fit two tight lines; below ~28px
                  // one line. Adjust the content density so short visits
                  // stay legible.
                  const density: 'compact' | 'medium' | 'roomy' =
                    height >= 56 ? 'roomy' : height >= 36 ? 'medium' : 'compact'
                  return (
                    <div key={appt.id}
                      onClick={() => onSelectAppointment(appt.id)}
                      className="absolute rounded px-1.5 py-1 text-[10px] overflow-hidden cursor-pointer hover:brightness-95 transition-all shadow-sm"
                      style={{
                        top: startMin,
                        height,
                        left: `calc(${left}% + 2px)`,
                        width: `calc(${width}% - 4px)`,
                        backgroundColor: bg,
                        color: fg,
                        zIndex: 2,
                      }}
                      title={`${formatTime12(appt.scheduled_time)} · ${appt.visit_type} · ${childName}${prov ? ' · ' + prov.name : ''}`}>
                      {showProviderColors && prov ? (
                        // Admin week: lead with provider name (bold, 11px) + an
                        // initials pill so identifying the provider does not
                        // depend on distinguishing colors. Then patient, then
                        // time + visit type.
                        <>
                          <div className="flex items-center gap-1 mb-0.5">
                            <span className="inline-flex items-center justify-center rounded-full text-[9px] font-bold flex-shrink-0"
                              style={{ background: 'rgba(255,255,255,0.28)', width: 16, height: 16 }}>
                              {prov.initials}
                            </span>
                            <span className="font-bold text-[11px] truncate leading-tight">{prov.name.split(' ')[0]}</span>
                          </div>
                          {density !== 'compact' && (
                            <div className="font-semibold truncate leading-tight">{childName}</div>
                          )}
                          {density === 'roomy' && (
                            <div className="opacity-90 truncate leading-tight text-[9px]">
                              {formatTime12(appt.scheduled_time)} · {appt.visit_type}
                            </div>
                          )}
                        </>
                      ) : (
                        // Provider week (single provider, no color coding needed).
                        <>
                          <div className="font-semibold truncate leading-tight">{formatTime12(appt.scheduled_time)} {childName}</div>
                          <div className="opacity-90 truncate leading-tight">{appt.visit_type}</div>
                        </>
                      )}
                    </div>
                  )
                })}
              </div>
            )
          })}
        </div>
      </div>

      {/* Provider legend for admin week */}
      {showProviderColors && providers.length > 0 && (
        <div className="flex flex-wrap gap-x-3 gap-y-1.5 px-3 py-2 border-t border-[#E8E8E4] bg-[#FAFAF8]">
          {providers.filter(p => p.is_active).map(p => {
            const palette = paletteByProviderId[p.id]
            if (!palette) return null
            return (
              <div key={p.id} className="flex items-center gap-1.5 text-[11px] text-[#1A1A2E]">
                <span className="inline-flex items-center justify-center rounded-full text-[9px] font-bold"
                  style={{ backgroundColor: palette.bg, color: palette.fg, width: 18, height: 18 }}>
                  {p.initials}
                </span>
                {p.name}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
