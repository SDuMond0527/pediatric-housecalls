import { useEffect, useState } from 'react'
import { CheckCircle2, X, Clock } from 'lucide-react'
import { format, parseISO, addDays } from 'date-fns'
import { getOnCallSchedule, getCmaSchedule, claimShift, invokeNotifications, upsertAvailabilityOverride } from '../lib/api'
import { useAuth } from '../contexts/AuthContext'
import { Badge } from '../components/ui/Badge'
import { Button } from '../components/ui/Button'

interface OnCallEntry {
  date: string
  state: string
  provider_id: string
  provider_name: string
  initials: string
  avatar_color: string
  avatar_text_color: string
  start_time: string | null
  end_time: string | null
}

interface CmaEntry {
  provider_id: string
  name: string
  states: string[]
  role: string
  start_time: string
  end_time: string
}

const STATE_LABELS: Record<string, string> = {
  NC: 'North Carolina',
  SC: 'South Carolina',
  VA: 'Virginia',
}

function fmt12(t: string) {
  const [h, m] = t.split(':').map(Number)
  const ampm = h >= 12 ? 'PM' : 'AM'
  const h12 = h % 12 || 12
  return `${h12}:${m.toString().padStart(2, '0')} ${ampm}`
}

function fmt12to24(t: string) {
  const [time, ampm] = t.split(' ')
  let [h, m] = time.split(':').map(Number)
  if (ampm === 'PM' && h !== 12) h += 12
  if (ampm === 'AM' && h === 12) h = 0
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`
}

function toMins(t: string) {
  const [h, m] = t.split(':').map(Number)
  return h * 60 + m
}

function fromMins(mins: number) {
  return `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`
}

function buildTimeOptions(from24: string, to24: string): string[] {
  const times: string[] = []
  for (let mins = toMins(from24); mins <= toMins(to24); mins += 30) {
    const h = Math.floor(mins / 60)
    const m = mins % 60
    const ampm = h >= 12 ? 'PM' : 'AM'
    const h12 = h % 12 || 12
    times.push(`${h12}:${m.toString().padStart(2, '0')} ${ampm}`)
  }
  return times
}

function computeGaps(
  cmaStart: string,
  cmaEnd: string,
  covered: OnCallEntry[],
): Array<{ start: string; end: string }> {
  const slots = covered
    .map(oc => ({ start: oc.start_time ?? cmaStart, end: oc.end_time ?? cmaEnd }))
    .sort((a, b) => toMins(a.start) - toMins(b.start))

  const gaps: Array<{ start: string; end: string }> = []
  let cursor = toMins(cmaStart)
  const endMins = toMins(cmaEnd)

  for (const slot of slots) {
    const slotStart = toMins(slot.start)
    if (slotStart > cursor) gaps.push({ start: fromMins(cursor), end: fromMins(slotStart) })
    cursor = Math.max(cursor, toMins(slot.end))
  }
  if (cursor < endMins) gaps.push({ start: fromMins(cursor), end: fromMins(endMins) })
  return gaps
}

export function Shifts() {
  const { provider } = useAuth()
  const [onCallMap, setOnCallMap] = useState<Record<string, Record<string, OnCallEntry[]>>>({})
  const [cmaSchedule, setCmaSchedule] = useState<Record<string, CmaEntry[]>>({})
  const [loading, setLoading] = useState(true)
  const [claiming, setClaiming] = useState<{
    date: string
    state: string
    cmaStart: string
    cmaEnd: string
    start: string
    end: string
  } | null>(null)
  const [submitting, setSubmitting] = useState(false)

  async function load() {
    setLoading(true)
    const start = new Date().toISOString().split('T')[0]
    const end = addDays(new Date(), 13).toISOString().split('T')[0]
    const [ocRows, cmaRows] = await Promise.all([
      getOnCallSchedule({ start, end }),
      getCmaSchedule({ start, end }),
    ])
    const ocMap: Record<string, Record<string, OnCallEntry[]>> = {}
    for (const r of (ocRows ?? [])) {
      if (!ocMap[r.date]) ocMap[r.date] = {}
      if (!ocMap[r.date][r.state]) ocMap[r.date][r.state] = []
      ocMap[r.date][r.state].push(r as OnCallEntry)
    }
    setOnCallMap(ocMap)
    setCmaSchedule((cmaRows ?? {}) as Record<string, CmaEntry[]>)
    setLoading(false)
  }

  useEffect(() => { if (provider) load() }, [provider])

  function openClaim(date: string, state: string, defaultStart?: string, defaultEnd?: string) {
    const stateCmas = (cmaSchedule[date] ?? []).filter(c => (c.states ?? []).includes(state))
    const cmaStart = stateCmas.map(c => c.start_time).sort()[0] ?? '09:00'
    const cmaEnd   = stateCmas.map(c => c.end_time).sort().reverse()[0] ?? '17:00'
    setClaiming({
      date, state, cmaStart, cmaEnd,
      start: defaultStart ?? cmaStart,
      end: defaultEnd ?? cmaEnd,
    })
  }

  async function confirmClaim() {
    if (!claiming || !provider) return
    setSubmitting(true)
    try {
      await claimShift(claiming.date, claiming.state, claiming.start, claiming.end)

      upsertAvailabilityOverride(provider.id, {
        date: claiming.date,
        is_available: true,
        start_time: claiming.start,
        end_time: claiming.end,
        note: 'Auto-set from on-call shift pickup',
      }).catch(() => {})

      invokeNotifications({
        type: 'shift_claimed',
        providerName: provider.name,
        providerId: provider.id,
        date: claiming.date,
        state: claiming.state,
      }).catch(() => {})
      setClaiming(null)
      await load()
    } finally {
      setSubmitting(false)
    }
  }

  const providerStates = (provider?.states || []) as string[]

  const dates: string[] = []
  for (let i = 0; i < 14; i++) {
    const d = addDays(new Date(), i).toISOString().split('T')[0]
    if ((cmaSchedule[d] ?? []).length > 0) dates.push(d)
  }

  if (!provider) return null

  const claimingIsPartial = claiming
    ? claiming.start !== claiming.cmaStart || claiming.end !== claiming.cmaEnd
    : false

  const startOptions = claiming ? buildTimeOptions(claiming.cmaStart, claiming.cmaEnd) : []
  const endOptions   = claiming
    ? buildTimeOptions(claiming.cmaStart, claiming.cmaEnd).filter(t => fmt12to24(t) > claiming.start)
    : []

  return (
    <div>
      <div className="bg-white border-b border-[#E8E8E4] px-6 py-4 sticky top-0 z-10">
        <div className="font-display text-[18px] font-medium text-[#1A1A2E]">On-call shifts</div>
        <div className="text-[12px] text-[#999] mt-0.5">
          CMA and IV fluids coverage days — pick up a shift to be the on-call provider
        </div>
      </div>

      <div className="p-6 max-w-2xl">
        <div className="p-3 bg-[#EEEDFE] border border-[#AFA9EC] rounded-lg text-[13px] text-[#3C3489] mb-5 leading-relaxed">
          These are days when CMAs or IV fluids nurses are scheduled to work. When you pick up a shift, the CMA or nurse will reach out to you directly to complete the telemedicine portion of a hybrid visit or to provide a pre-screening visit before administering IV fluids.
        </div>

        {loading && <div className="text-[#999] text-[13px]">Loading...</div>}

        {!loading && dates.length === 0 && (
          <div className="text-center py-16">
            <CheckCircle2 size={24} className="text-[#aeaeb2] mx-auto mb-2" />
            <p className="text-[14px] text-[#999]">No CMA shifts scheduled in the next 14 days.</p>
          </div>
        )}

        <div className="space-y-3">
          {dates.map(date => {
            const cmas = cmaSchedule[date] ?? []
            const coveredStates = (['NC', 'SC', 'VA'] as string[]).filter(s =>
              cmas.some(c => (c.states ?? []).includes(s))
            )
            if (!coveredStates.length) return null

            return (
              <div key={date} className="border border-[#E8E8E4] rounded-xl bg-white shadow-sm overflow-hidden">
                <div className="px-4 py-3 border-b border-[#F1EFE8] bg-[#FAFAF8]">
                  <span className="font-display text-[15px] font-medium text-[#1A1A2E]">
                    {format(parseISO(date), 'EEEE, MMMM d')}
                  </span>
                </div>

                <div className="divide-y divide-[#F1EFE8]">
                  {coveredStates.map(state => {
                    const ocs = onCallMap[date]?.[state] ?? []
                    const stateCmas = cmas.filter(c => (c.states ?? []).includes(state))
                    const cmaStart = stateCmas.map(c => c.start_time).sort()[0] ?? '09:00'
                    const cmaEnd   = stateCmas.map(c => c.end_time).sort().reverse()[0] ?? '17:00'
                    const gaps = computeGaps(cmaStart, cmaEnd, ocs)
                    const myEntry = ocs.find(oc => oc.provider_id === provider.id)
                    const canClaim = providerStates.includes(state) && gaps.length > 0
                    const fullyCovered = ocs.length > 0 && gaps.length === 0

                    return (
                      <div key={state} className="px-4 py-3 space-y-2">
                        {/* State label */}
                        <div className="flex items-center justify-between gap-4">
                          <div className="flex items-center gap-2">
                            <Badge variant={state === 'NC' ? 'purple' : state === 'SC' ? 'teal' : 'amber'}>
                              {state}
                            </Badge>
                            <span className="text-[12px] text-[#999]">{STATE_LABELS[state] ?? state}</span>
                          </div>
                          {fullyCovered && (
                            <Badge variant="teal">Fully covered</Badge>
                          )}
                          {myEntry && !fullyCovered && (
                            <Badge variant="teal">You're covering</Badge>
                          )}
                          {!providerStates.includes(state) && (
                            <span className="text-[11px] text-[#999]">Not licensed in {state}</span>
                          )}
                        </div>

                        {/* CMA / RN info */}
                        {stateCmas.map(c => (
                          <div key={c.provider_id} className="text-[12px] text-[#555]">
                            {c.role === 'RN' ? 'IV fluids RN' : 'CMA'}: {c.name} · {fmt12(c.start_time)}–{fmt12(c.end_time)}
                          </div>
                        ))}

                        {/* Coverage table */}
                        <div className="bg-[#FAFAF8] border border-[#F1EFE8] rounded-lg overflow-hidden">
                          {ocs.length === 0 && gaps.length === 0 && (
                            <div className="px-3 py-2 text-[12px] text-[#999]">
                              On-call: <span className="text-amber-600 font-medium">Unassigned</span>
                            </div>
                          )}

                          {/* Claimed slots */}
                          {ocs
                            .slice()
                            .sort((a, b) => toMins(a.start_time ?? cmaStart) - toMins(b.start_time ?? cmaStart))
                            .map(oc => (
                              <div key={oc.provider_id} className="flex items-center gap-2 px-3 py-2 border-b border-[#F1EFE8] last:border-b-0">
                                <div
                                  className="w-5 h-5 rounded-full text-[9px] font-semibold flex items-center justify-center flex-shrink-0"
                                  style={{ background: oc.avatar_color, color: oc.avatar_text_color }}
                                >
                                  {oc.initials}
                                </div>
                                <span className="text-[12px] font-medium text-[#1A1A2E] flex-1">
                                  {oc.provider_id === provider.id ? 'You' : oc.provider_name}
                                </span>
                                <span className="text-[11px] text-[#555]">
                                  {oc.start_time && oc.end_time
                                    ? `${fmt12(oc.start_time)} – ${fmt12(oc.end_time)}`
                                    : 'Full shift'}
                                </span>
                              </div>
                            ))}

                          {/* Uncovered gaps */}
                          {gaps.map((gap, i) => (
                            <div key={i} className="flex items-center gap-2 px-3 py-2 border-b border-[#F1EFE8] last:border-b-0 bg-amber-50">
                              <div className="w-5 h-5 rounded-full bg-amber-100 flex items-center justify-center flex-shrink-0">
                                <span className="text-[9px] text-amber-600 font-bold">?</span>
                              </div>
                              <span className="text-[12px] text-amber-700 font-medium flex-1">Open</span>
                              <span className="text-[11px] text-amber-600">
                                {fmt12(gap.start)} – {fmt12(gap.end)}
                              </span>
                              {canClaim && (
                                <Button
                                  variant="teal"
                                  size="sm"
                                  onClick={() => openClaim(date, state, gap.start, gap.end)}
                                  className="ml-1"
                                >
                                  Pick up
                                </Button>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {claiming && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" onClick={() => { if (!submitting) setClaiming(null) }} />
          <div className="relative bg-white rounded-2xl shadow-xl w-full max-w-sm p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-display text-lg font-medium text-[#1A1A2E]">Pick up shift</h2>
              <button onClick={() => setClaiming(null)} disabled={submitting}
                className="p-1.5 rounded-lg hover:bg-[#F1EFE8] text-[#999] disabled:opacity-50">
                <X size={16} />
              </button>
            </div>

            <div className="p-3 bg-[#FAFAF8] border border-[#E8E8E4] rounded-lg text-[13px] mb-4 space-y-1">
              <div className="font-medium text-[#1A1A2E]">
                {format(parseISO(claiming.date), 'EEEE, MMMM d')} · {STATE_LABELS[claiming.state] ?? claiming.state}
              </div>
              <div className="text-[#999]">
                Full coverage window: {fmt12(claiming.cmaStart)}–{fmt12(claiming.cmaEnd)}
              </div>
            </div>

            <div className="mb-4">
              <div className="flex items-center gap-1.5 mb-2">
                <Clock size={13} className="text-[#7F77DD]" />
                <span className="text-[12px] font-medium text-[#555] uppercase tracking-wider">Your hours</span>
                {claimingIsPartial && (
                  <button
                    onClick={() => setClaiming(p => p ? { ...p, start: p.cmaStart, end: p.cmaEnd } : p)}
                    className="ml-auto text-[11px] text-[#7F77DD] hover:underline"
                  >
                    Reset to full shift
                  </button>
                )}
              </div>
              <div className="flex gap-2">
                <div className="flex-1">
                  <label className="text-[11px] text-[#999] block mb-1">From</label>
                  <select
                    value={fmt12(claiming.start)}
                    onChange={e => {
                      const newStart = fmt12to24(e.target.value)
                      setClaiming(p => {
                        if (!p) return p
                        const end = p.end > newStart ? p.end : p.cmaEnd
                        return { ...p, start: newStart, end }
                      })
                    }}
                    className="w-full px-3 py-2 border border-[#E8E8E4] rounded-lg text-[13px] font-sans"
                  >
                    {startOptions.map(t => <option key={t}>{t}</option>)}
                  </select>
                </div>
                <div className="flex-1">
                  <label className="text-[11px] text-[#999] block mb-1">To</label>
                  <select
                    value={fmt12(claiming.end)}
                    onChange={e => setClaiming(p => p ? { ...p, end: fmt12to24(e.target.value) } : p)}
                    className="w-full px-3 py-2 border border-[#E8E8E4] rounded-lg text-[13px] font-sans"
                  >
                    {endOptions.map(t => <option key={t}>{t}</option>)}
                  </select>
                </div>
              </div>
              {claimingIsPartial && (
                <p className="text-[11px] text-[#7F77DD] mt-1.5">
                  Partial shift — you'll be on-call {fmt12(claiming.start)}–{fmt12(claiming.end)}
                </p>
              )}
            </div>

            <p className="text-[13px] text-[#555] mb-5">
              The CMA or IV fluids nurse will contact you directly when a patient is added to the schedule. Remember to reach out to families promptly when needed.
            </p>

            <div className="flex gap-2">
              <Button variant="secondary" className="flex-1" onClick={() => setClaiming(null)} disabled={submitting}>
                Cancel
              </Button>
              <Button variant="teal" className="flex-1" loading={submitting} onClick={confirmClaim}>
                <CheckCircle2 size={14} /> Confirm
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
