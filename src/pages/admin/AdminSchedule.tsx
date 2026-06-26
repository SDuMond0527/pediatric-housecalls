import { useEffect, useState } from 'react'
import { Plus, ChevronDown, CheckCircle2, Navigation, ShieldCheck, ShieldX, ShieldQuestion } from 'lucide-react'
import { format } from 'date-fns'
import { getProviders, getAppointments, createAppointment, updateAppointment, updateBookingRequest, invokeNotifications, checkEligibility } from '../../lib/api'
import { Badge } from '../../components/ui/Badge'
import { Button } from '../../components/ui/Button'
import { Modal } from '../../components/ui/Modal'
import { VISIT_TYPES } from '../../lib/constants'
import { ZIP_TO_ZONE } from '../../lib/zipData'
import type { Appointment, Provider } from '../../types'

const VISIT_TYPE_OPTIONS = Object.keys(VISIT_TYPES) as (keyof typeof VISIT_TYPES)[]

function to12h(time24: string): string {
  const [h, m] = time24.split(':').map(Number)
  if (isNaN(h) || isNaN(m)) return time24
  const ampm = h >= 12 ? 'PM' : 'AM'
  return `${h % 12 || 12}:${m.toString().padStart(2, '0')} ${ampm}`
}

export function AdminSchedule() {
  const [providers, setProviders] = useState<Provider[]>([])
  const [appointments, setAppointments] = useState<Appointment[]>([])
  const [filterProvider, setFilterProvider] = useState('')
  const [filterDate, setFilterDate] = useState(format(new Date(), 'yyyy-MM-dd'))
  const [expanded, setExpanded] = useState<string | null>(null)
  const [modalOpen, setModalOpen] = useState(false)
  const [loading, setLoading] = useState(true)
  const [doneTarget, setDoneTarget] = useState<Appointment | null>(null)
  const [doneInstructions, setDoneInstructions] = useState('')
  const [doneSubmitting, setDoneSubmitting] = useState(false)
  const [eligibility, setEligibility] = useState<Record<string, { loading: boolean; data: any | null; error: string | null }>>({})
  const [form, setForm] = useState({
    provider_id: '', visit_type: 'In-home sick visit',
    zip: '', zone: '', address: '', patientName: '', dob: '', gender: '', phone: '', email: '',
    scheduled_time: '09:00', scheduled_date: format(new Date(), 'yyyy-MM-dd'),
  })

  useEffect(() => {
    getProviders().then(data => setProviders((data ?? []) as Provider[])).catch(() => {})
  }, [])

  async function fetchAppointments() {
    setLoading(true)
    const params: Record<string, string> = { scheduled_date: filterDate }
    if (filterProvider) params.provider_id = filterProvider
    const data = await getAppointments(params).catch(() => [])
    setAppointments((data ?? []) as Appointment[])
    setLoading(false)
  }

  useEffect(() => { fetchAppointments() }, [filterDate, filterProvider])

  async function runEligibilityCheck(apptId: string) {
    setEligibility(prev => ({ ...prev, [apptId]: { loading: true, data: null, error: null } }))
    try {
      const data = await checkEligibility(apptId)
      setEligibility(prev => ({ ...prev, [apptId]: { loading: false, data, error: null } }))
    } catch (err: any) {
      setEligibility(prev => ({ ...prev, [apptId]: { loading: false, data: null, error: err.message ?? 'Eligibility check failed.' } }))
    }
  }

  async function submitDone() {
    if (!doneTarget) return
    setDoneSubmitting(true)
    const instructions = doneInstructions.trim() || null
    // Update status separately so it always succeeds even if after_visit_instructions column is missing
    await updateAppointment(doneTarget.id, { status: 'done' })
    if (instructions) {
      void updateAppointment(doneTarget.id, { after_visit_instructions: instructions })
    }
    if (instructions && doneTarget.charm_appointment_id) {
      void updateBookingRequest(doneTarget.charm_appointment_id, { after_visit_instructions: instructions })
    }
    void invokeNotifications({ type: 'post_visit_email', appointmentId: doneTarget.id })
    setAppointments(prev => prev.map(a => a.id === doneTarget!.id ? { ...a, status: 'done' } : a))
    setDoneTarget(null)
    setDoneInstructions('')
    setDoneSubmitting(false)
  }

  async function addAppointment() {
    const noteParts: string[] = []
    if (form.patientName) noteParts.push(`PATIENT:${form.patientName}`)
    if (form.dob) noteParts.push(`DOB:${form.dob}`)
    if (form.gender) noteParts.push(`GENDER:${form.gender}`)
    const fullAddr = form.address
      ? (form.zip && !form.address.includes(form.zip) ? `${form.address.trim()} ${form.zip}` : form.address)
      : ''
    if (fullAddr) noteParts.push(`ADDR:${fullAddr}`)
    if (form.email) noteParts.push(`PARENTEMAIL:${form.email}`)
    if (form.phone) noteParts.push(`PARENTPHONE:${form.phone}`)

    await createAppointment({
      provider_id: form.provider_id,
      visit_type: form.visit_type,
      zone: form.zone || form.address || 'Unspecified',
      scheduled_time: form.scheduled_time,
      scheduled_date: form.scheduled_date,
      status: 'upcoming',
      notes: noteParts.length ? noteParts.join('|') : null,
    })
    setModalOpen(false)
    fetchAppointments()
    setForm(f => ({ ...f, provider_id: '', zip: '', zone: '', address: '', patientName: '', dob: '', gender: '', phone: '', email: '' }))
  }

  const grouped = providers
    .filter(p => !filterProvider || p.id === filterProvider)
    .map(p => ({
      provider: p,
      appts: appointments.filter(a => a.provider_id === p.id),
    }))
    .filter(g => g.appts.length > 0)

  return (
    <div>
      <div className="bg-white border-b border-[#E8E8E4] px-6 py-4 flex items-center justify-between sticky top-0 z-10">
        <div className="font-display text-[18px] font-medium text-[#1A1A2E]">Schedule</div>
        <div className="flex items-center gap-2">
          <input type="date" value={filterDate} onChange={e => setFilterDate(e.target.value)}
            className="text-[13px] px-3 py-1.5 border border-[#E8E8E4] rounded-lg font-sans" />
          <select value={filterProvider} onChange={e => setFilterProvider(e.target.value)}
            className="text-[13px] px-3 py-1.5 border border-[#E8E8E4] rounded-lg font-sans">
            <option value="">All providers</option>
            {providers.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <Button size="sm" onClick={() => setModalOpen(true)}><Plus size={13} /> Add appointment</Button>
        </div>
      </div>

      <div className="p-6 space-y-6">
        {!loading && grouped.length === 0 && (
          <div className="text-center py-16 text-[#999] text-[14px]">No appointments for this date.</div>
        )}
        {grouped.map(({ provider, appts }) => (
          <div key={provider.id}>
            <div className="flex items-center gap-2 mb-2">
              <div className="w-7 h-7 rounded-full flex items-center justify-center text-[11px] font-medium flex-shrink-0"
                style={{ background: provider.avatar_color, color: provider.avatar_text_color }}>
                {provider.initials}
              </div>
              <span className="text-[13px] font-medium text-[#1A1A2E]">{provider.name}</span>
              <Badge variant="gray">{appts.length} appt{appts.length !== 1 ? 's' : ''}</Badge>
            </div>
            <div className="space-y-1.5 ml-9">
              {appts.map(appt => {
                const vt = VISIT_TYPES[appt.visit_type]
                const isExpanded = expanded === appt.id
                return (
                  <div key={appt.id}
                    className={`border rounded-lg overflow-hidden cursor-pointer transition-all ${isExpanded ? 'border-[#7F77DD]' : 'border-[#E8E8E4] bg-white hover:border-[#AFA9EC]'}`}
                    onClick={() => setExpanded(isExpanded ? null : appt.id)}>
                    <div className="flex items-center gap-3 px-4 py-2.5">
                      <span className="text-[12px] text-[#555] w-14 flex-shrink-0">{to12h(appt.scheduled_time)}</span>
                      <span className="font-display text-[14px] font-medium text-[#1A1A2E] flex-1">{appt.visit_type}</span>
                      <span className="text-[12px] text-[#555] hidden sm:block">{appt.zone}{appt.duration_minutes && appt.duration_minutes > 60 ? ` · ${appt.duration_minutes} min` : ''}</span>
                      <Badge color={vt?.color} textColor={vt?.textColor}>{vt?.badge || appt.visit_type}</Badge>
                      {appt.status === 'done' && <Badge variant="teal">Done</Badge>}
                      <ChevronDown size={13} className={`text-[#999] transition-transform ${isExpanded ? 'rotate-180' : ''}`} />
                    </div>
                    {isExpanded && (
                      <div className="px-4 pb-4 border-t border-[#E8E8E4] pt-3" onClick={e => e.stopPropagation()}>
                        {(() => {
                          const NOTE_LABELS: Record<string, string> = {
                            CC: 'Chief complaint', NOTES: 'Additional notes',
                            ALLERGY: 'Allergies', MEDS: 'Medications', PMH: 'Medical history',
                            VAX: 'Vaccination status', PCP: 'Primary care physician',
                            PHARMACY: 'Preferred pharmacy', INSURANCE: 'Insurance',
                            CHILDREN: 'Children seen', PARENTEMAIL: 'Parent email',
                            PARENTPHONE: 'Parent phone', GENDER: 'Sex',
                            CARDFRONT: 'Insurance card front', CARDBACK: 'Insurance card back',
                          }
                          const noteMap: Record<string, string> = {}
                          ;(appt.notes || '').split('|').forEach((part: string) => {
                            const colon = part.indexOf(':')
                            if (colon > 0) {
                              const k = part.slice(0, colon).trim()
                              const v = part.slice(colon + 1).trim()
                              if (!['Ref', 'ADDR'].includes(k) && v) noteMap[k] = v
                            }
                          })
                          const addr = appt.notes?.split('|').find(p => p.startsWith('ADDR:'))?.replace('ADDR:', '').trim()
                          return (
                            <div className="mb-3 space-y-2">
                              {noteMap.PARENTPHONE && (
                                <div className="bg-[#FAFAF8] border border-[#E8E8E4] rounded-lg p-3 flex items-center justify-between gap-3">
                                  <div>
                                    <div className="text-[10px] font-semibold text-[#7F77DD] uppercase tracking-wider mb-0.5">Parent phone</div>
                                    <div className="text-[14px] font-medium text-[#1A1A2E]">{noteMap.PARENTPHONE}</div>
                                  </div>
                                  <a href={`tel:${noteMap.PARENTPHONE}`} onClick={e => e.stopPropagation()}
                                     className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-[#7F77DD] text-white text-[11px] font-medium hover:bg-[#534AB7] transition-colors flex-shrink-0">
                                    Call
                                  </a>
                                </div>
                              )}
                              {Object.keys(noteMap).filter(k => k !== 'PARENTPHONE').length > 0 ? (
                                <div className="bg-[#FAFAF8] border border-[#E8E8E4] rounded-lg p-3 space-y-1.5">
                                  <div className="text-[10px] font-semibold text-[#7F77DD] uppercase tracking-wider mb-2">Visit details</div>
                                  {Object.entries(noteMap).filter(([k]) => k !== 'PARENTPHONE').map(([k, v]) => (
                                    <div key={k} className="text-[13px]">
                                      <span className="text-[#999] text-[11px] block">{NOTE_LABELS[k] || k}</span>
                                      {(k === 'CARDFRONT' || k === 'CARDBACK') ? (
                                        <a href={v} target="_blank" rel="noopener noreferrer">
                                          <img src={v} alt={NOTE_LABELS[k]} className="mt-1 max-h-28 rounded border border-[#E8E8E4] object-contain" />
                                        </a>
                                      ) : v}
                                    </div>
                                  ))}
                                </div>
                              ) : (
                                <div className="p-3 bg-[#EEEDFE] border border-[#AFA9EC] rounded-lg text-[12px] text-[#3C3489]">
                                  No intake data on file for this appointment.
                                </div>
                              )}
                              <div className="grid grid-cols-2 gap-2">
                                <div className="bg-[#F6F5FF] rounded-lg p-2.5">
                                  <div className="text-[10px] font-medium text-[#3C3489] uppercase tracking-wider mb-1">Visit type</div>
                                  <div className="text-[13px] text-[#1A1A2E]">{appt.visit_type}</div>
                                </div>
                                <div className="bg-[#F6F5FF] rounded-lg p-2.5">
                                  <div className="text-[10px] font-medium text-[#3C3489] uppercase tracking-wider mb-1">Zone</div>
                                  <div className="text-[13px] text-[#1A1A2E]">{appt.zone}</div>
                                </div>
                                {addr && (
                                  <div className="col-span-2 bg-[#F6F5FF] rounded-lg p-2.5">
                                    <div className="text-[10px] font-medium text-[#3C3489] uppercase tracking-wider mb-1">Visit address</div>
                                    <div className="flex items-center justify-between gap-2">
                                      <div className="text-[13px] text-[#1A1A2E]">{addr}</div>
                                      <a href={`https://maps.google.com/maps?daddr=${encodeURIComponent(addr)}`}
                                        target="_blank" rel="noopener noreferrer"
                                        onClick={e => e.stopPropagation()}
                                        className="flex items-center gap-1 px-2 py-1 rounded-lg bg-[#7F77DD] text-white text-[11px] font-medium hover:bg-[#534AB7] transition-colors flex-shrink-0">
                                        <Navigation size={11} /> Navigate
                                      </a>
                                    </div>
                                  </div>
                                )}
                              </div>
                            </div>
                          )
                        })()}
                        {/* Insurance eligibility */}
                        <div className="mt-3">
                          {(() => {
                            const elig = eligibility[appt.id]
                            if (!elig) {
                              return (
                                <button
                                  onClick={() => runEligibilityCheck(appt.id)}
                                  className="flex items-center gap-1.5 text-[12px] font-medium text-[#7F77DD] hover:text-[#534AB7] transition-colors">
                                  <ShieldQuestion size={13} /> Check insurance eligibility
                                </button>
                              )
                            }
                            if (elig.loading) {
                              return <p className="text-[12px] text-[#999]">Checking eligibility…</p>
                            }
                            if (elig.error) {
                              return (
                                <div className="flex items-start gap-2 p-3 bg-[#FEF3E8] border border-[#FAC775] rounded-lg">
                                  <ShieldX size={14} className="text-[#c45c00] flex-shrink-0 mt-0.5" />
                                  <div>
                                    <p className="text-[12px] font-semibold text-[#633806]">Eligibility check failed</p>
                                    <p className="text-[11px] text-[#633806] mt-0.5">{elig.error}</p>
                                  </div>
                                </div>
                              )
                            }
                            const d = elig.data
                            const fmt$ = (n: number | null) => n != null ? `$${n.toFixed(2)}` : '—'
                            return (
                              <div className={`border rounded-lg overflow-hidden ${d.active ? 'border-[#1D9E75]' : 'border-[#e05252]'}`}>
                                <div className={`flex items-center gap-2 px-3 py-2 ${d.active ? 'bg-[#E1F5EE]' : 'bg-[#FDEAEA]'}`}>
                                  {d.active
                                    ? <ShieldCheck size={14} className="text-[#085041]" />
                                    : <ShieldX size={14} className="text-[#c00]" />}
                                  <span className={`text-[12px] font-semibold ${d.active ? 'text-[#085041]' : 'text-[#c00]'}`}>
                                    {d.active ? 'Coverage active' : 'Coverage inactive'}
                                  </span>
                                  {d.insuranceProvider && (
                                    <span className="text-[11px] text-[#555] ml-auto">{d.insuranceProvider}</span>
                                  )}
                                </div>
                                <div className="bg-white px-3 py-2.5 grid grid-cols-2 gap-x-4 gap-y-1.5">
                                  {d.planName && (
                                    <div className="col-span-2">
                                      <span className="text-[10px] text-[#999] block">Plan</span>
                                      <span className="text-[12px] text-[#1A1A2E]">{d.planName}</span>
                                    </div>
                                  )}
                                  {d.memberId && (
                                    <div>
                                      <span className="text-[10px] text-[#999] block">Member ID</span>
                                      <span className="text-[12px] text-[#1A1A2E]">{d.memberId}</span>
                                    </div>
                                  )}
                                  {d.groupNumber && (
                                    <div>
                                      <span className="text-[10px] text-[#999] block">Group #</span>
                                      <span className="text-[12px] text-[#1A1A2E]">{d.groupNumber}</span>
                                    </div>
                                  )}
                                  {d.deductible?.individual?.total != null && (
                                    <div>
                                      <span className="text-[10px] text-[#999] block">Individual deductible</span>
                                      <span className="text-[12px] text-[#1A1A2E]">
                                        {fmt$(d.deductible.individual.remaining)} remaining of {fmt$(d.deductible.individual.total)}
                                      </span>
                                    </div>
                                  )}
                                  {d.deductible?.family?.total != null && (
                                    <div>
                                      <span className="text-[10px] text-[#999] block">Family deductible</span>
                                      <span className="text-[12px] text-[#1A1A2E]">
                                        {fmt$(d.deductible.family.remaining)} remaining of {fmt$(d.deductible.family.total)}
                                      </span>
                                    </div>
                                  )}
                                  {d.outOfPocket?.individual?.total != null && (
                                    <div>
                                      <span className="text-[10px] text-[#999] block">OOP max (individual)</span>
                                      <span className="text-[12px] text-[#1A1A2E]">
                                        {fmt$(d.outOfPocket.individual.remaining)} remaining of {fmt$(d.outOfPocket.individual.total)}
                                      </span>
                                    </div>
                                  )}
                                  {d.copay != null && (
                                    <div>
                                      <span className="text-[10px] text-[#999] block">Copay</span>
                                      <span className="text-[12px] text-[#1A1A2E]">{fmt$(d.copay)}</span>
                                    </div>
                                  )}
                                  {d.coinsurance != null && (
                                    <div>
                                      <span className="text-[10px] text-[#999] block">Coinsurance</span>
                                      <span className="text-[12px] text-[#1A1A2E]">{d.coinsurance}%</span>
                                    </div>
                                  )}
                                </div>
                                <div className="px-3 py-1.5 border-t border-[#F1EFE8] bg-[#FAFAF8]">
                                  <button onClick={() => runEligibilityCheck(appt.id)}
                                    className="text-[11px] text-[#999] hover:text-[#7F77DD] transition-colors">
                                    Re-check
                                  </button>
                                </div>
                              </div>
                            )
                          })()}
                        </div>

                        {appt.status !== 'done' && (
                          <Button variant="teal" size="xs" className="mt-3" onClick={() => { setDoneTarget(appt); setDoneInstructions('') }}>
                            <CheckCircle2 size={12} /> Mark complete
                          </Button>
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        ))}
      </div>

      {/* ── Mark complete modal ── */}
      {doneTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" onClick={() => !doneSubmitting && setDoneTarget(null)} />
          <div className="relative bg-white rounded-2xl shadow-xl w-full max-w-sm p-6">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-full bg-[#E1F5EE] flex items-center justify-center flex-shrink-0">
                <CheckCircle2 size={18} className="text-[#1D9E75]" />
              </div>
              <h2 className="font-display text-lg font-medium text-[#1A1A2E]">Mark visit complete</h2>
            </div>
            <div className="p-3 bg-[#FAFAF8] border border-[#E8E8E4] rounded-lg text-[13px] mb-4 space-y-0.5">
              <div className="font-medium text-[#1A1A2E]">{doneTarget.visit_type}</div>
              <div className="text-[#999]">{doneTarget.zone}</div>
            </div>
            <div className="mb-4">
              <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-1.5">
                After-visit instructions <span className="text-[#999] normal-case font-normal">(optional)</span>
              </label>
              <textarea rows={4}
                placeholder="e.g. Rest and fluids for 48 hours. Recheck temperature in the morning. Call if fever returns above 102°F."
                value={doneInstructions}
                onChange={e => setDoneInstructions(e.target.value)}
                className="w-full px-3 py-2.5 border border-[#E8E8E4] rounded-lg text-[14px] font-sans outline-none focus:border-[#1D9E75] resize-none" />
              <p className="text-[11px] text-[#999] mt-1">If provided, the family will see this in their app under past visits.</p>
            </div>
            <div className="flex gap-2">
              <Button variant="secondary" className="flex-1" onClick={() => setDoneTarget(null)} disabled={doneSubmitting}>Cancel</Button>
              <Button variant="teal" className="flex-1" loading={doneSubmitting} onClick={submitDone}>
                <CheckCircle2 size={14} /> Mark complete
              </Button>
            </div>
          </div>
        </div>
      )}

      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title="Add appointment" size="lg">
        <div className="space-y-3">

          <div className="text-[10px] font-semibold text-[#7F77DD] uppercase tracking-wider pt-1">Provider</div>
          <div>
            <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-1">Assigned provider</label>
            <select value={form.provider_id} onChange={e => setForm(f => ({ ...f, provider_id: e.target.value }))}
              className="w-full px-3 py-2 border border-[#E8E8E4] rounded-lg text-[13px] font-sans bg-white">
              <option value="">Select provider...</option>
              {providers.map(p => <option key={p.id} value={p.id}>{p.name} — {p.zones?.join(', ') || p.role}</option>)}
            </select>
          </div>

          <div className="text-[10px] font-semibold text-[#7F77DD] uppercase tracking-wider pt-1">Patient information</div>
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2">
              <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-1">Patient name</label>
              <input type="text" placeholder="First and last name" value={form.patientName}
                onChange={e => setForm(f => ({ ...f, patientName: e.target.value }))}
                className="w-full px-3 py-2 border border-[#E8E8E4] rounded-lg text-[13px] font-sans" />
            </div>
            <div>
              <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-1">Date of birth</label>
              <input type="text" placeholder="MM-DD-YYYY" value={form.dob}
                onChange={e => setForm(f => ({ ...f, dob: e.target.value }))}
                className="w-full px-3 py-2 border border-[#E8E8E4] rounded-lg text-[13px] font-sans" />
            </div>
            <div>
              <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-1">Sex</label>
              <select value={form.gender} onChange={e => setForm(f => ({ ...f, gender: e.target.value }))}
                className="w-full px-3 py-2 border border-[#E8E8E4] rounded-lg text-[13px] font-sans bg-white">
                <option value="">Select…</option>
                <option value="Male">Male</option>
                <option value="Female">Female</option>
                <option value="Other">Other</option>
              </select>
            </div>
            <div>
              <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-1">Phone</label>
              <input type="tel" placeholder="(704) 555-1234" value={form.phone}
                onChange={e => setForm(f => ({ ...f, phone: e.target.value }))}
                className="w-full px-3 py-2 border border-[#E8E8E4] rounded-lg text-[13px] font-sans" />
            </div>
            <div className="col-span-2">
              <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-1">Email</label>
              <input type="email" placeholder="parent@email.com" value={form.email}
                onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
                className="w-full px-3 py-2 border border-[#E8E8E4] rounded-lg text-[13px] font-sans" />
            </div>
          </div>

          <div className="text-[10px] font-semibold text-[#7F77DD] uppercase tracking-wider pt-1">Appointment details</div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-1">Visit type</label>
              <select value={form.visit_type} onChange={e => setForm(f => ({ ...f, visit_type: e.target.value }))}
                className="w-full px-3 py-2 border border-[#E8E8E4] rounded-lg text-[13px] font-sans bg-white">
                {VISIT_TYPE_OPTIONS.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            <div>
              <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-1">Date</label>
              <input type="date" value={form.scheduled_date} onChange={e => setForm(f => ({ ...f, scheduled_date: e.target.value }))}
                className="w-full px-3 py-2 border border-[#E8E8E4] rounded-lg text-[13px] font-sans" />
            </div>
            <div className="col-span-2">
              <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-1">Visit address</label>
              <input type="text" placeholder="123 Main St, Charlotte, NC" value={form.address}
                onChange={e => setForm(f => ({ ...f, address: e.target.value }))}
                className="w-full px-3 py-2 border border-[#E8E8E4] rounded-lg text-[13px] font-sans" />
            </div>
            <div>
              <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-1">Zip code</label>
              <input type="text" placeholder="28277" maxLength={5} value={form.zip}
                onChange={e => {
                  const zip = e.target.value
                  const detectedZone = zip.length === 5 ? (ZIP_TO_ZONE[zip] || '') : ''
                  setForm(f => ({ ...f, zip, zone: detectedZone || f.zone }))
                }}
                className="w-full px-3 py-2 border border-[#E8E8E4] rounded-lg text-[13px] font-sans" />
            </div>
            <div>
              <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-1">
                Zone {form.zip.length === 5 && ZIP_TO_ZONE[form.zip] && <span className="text-[#1D9E75] normal-case font-normal">· auto-detected</span>}
              </label>
              <input type="text" placeholder="e.g. SouthPark" value={form.zone}
                onChange={e => setForm(f => ({ ...f, zone: e.target.value }))}
                className="w-full px-3 py-2 border border-[#E8E8E4] rounded-lg text-[13px] font-sans" />
            </div>
            <div>
              <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-1">Time</label>
              <input type="time" value={form.scheduled_time} onChange={e => setForm(f => ({ ...f, scheduled_time: e.target.value }))}
                className="w-full px-3 py-2 border border-[#E8E8E4] rounded-lg text-[13px] font-sans" />
            </div>
          </div>
        </div>
        <div className="flex gap-2 mt-4">
          <Button variant="secondary" size="sm" onClick={() => setModalOpen(false)}>Cancel</Button>
          <Button size="sm" onClick={addAppointment} disabled={!form.provider_id || !form.zone}>Add appointment</Button>
        </div>
      </Modal>
    </div>
  )
}
