import { useEffect, useRef, useState } from 'react'
import { Plus, ChevronDown, CheckCircle2, Navigation, ShieldCheck, ShieldX, ShieldQuestion, FileText, Pencil, X, Search, XCircle, Phone } from 'lucide-react'
import { format, addDays } from 'date-fns'
import { getProviders, getAppointments, createAppointment, updateAppointment, updateBookingRequest, invokeNotifications, checkEligibility, getEncounterNote, getVitals, patchEncounterNote, updateEncounterNote, getFeeSchedule, getOnCallSchedule, setOnCallProvider } from '../../lib/api'
import { Badge } from '../../components/ui/Badge'
import { Button } from '../../components/ui/Button'
import { Modal } from '../../components/ui/Modal'
import { usePracticeZones } from '../../hooks/usePracticeZones'
import { usePracticeVisitTypes } from '../../hooks/usePracticeVisitTypes'
import type { Appointment, Provider } from '../../types'

function EligibilityCard({ state, onCheck }: { state: { loading: boolean; data: any; error: string | null } | undefined; onCheck: () => void }) {
  if (!state) {
    return (
      <button onClick={onCheck} className="flex items-center gap-1.5 text-[12px] font-medium text-[#7F77DD] hover:text-[#534AB7] transition-colors">
        <ShieldQuestion size={13} /> Check insurance eligibility
      </button>
    )
  }
  if (state.loading) return <p className="text-[12px] text-[#999]">Checking eligibility…</p>
  if (state.error) {
    return (
      <div className="flex items-start gap-2 p-3 bg-[#FEF3E8] border border-[#FAC775] rounded-lg">
        <ShieldX size={14} className="text-[#c45c00] flex-shrink-0 mt-0.5" />
        <div>
          <p className="text-[12px] font-semibold text-[#633806]">Eligibility check failed</p>
          <p className="text-[11px] text-[#633806] mt-0.5">{state.error}</p>
        </div>
      </div>
    )
  }
  const d = state.data
  if (!d) return (
    <div className="flex items-start gap-2 p-3 bg-[#FEF3E8] border border-[#FAC775] rounded-lg">
      <ShieldX size={14} className="text-[#c45c00] flex-shrink-0 mt-0.5" />
      <div>
        <p className="text-[12px] font-semibold text-[#633806]">Eligibility check failed</p>
        <p className="text-[11px] text-[#633806] mt-0.5">No response from eligibility service. Check Vercel function logs for details.</p>
        <button onClick={onCheck} className="text-[11px] text-[#633806] underline mt-1">Try again</button>
      </div>
    </div>
  )
  const fmt$ = (n: number | null | undefined) => n != null ? `$${n.toFixed(2)}` : '—'
  const active: boolean = !!d.active
  return (
    <div className={`border rounded-lg overflow-hidden ${active ? 'border-[#1D9E75]' : 'border-[#e05252]'}`}>
      <div className={`flex items-center gap-2 px-3 py-2 ${active ? 'bg-[#E1F5EE]' : 'bg-[#FDEAEA]'}`}>
        {active ? <ShieldCheck size={14} className="text-[#085041]" /> : <ShieldX size={14} className="text-[#c00]" />}
        <span className={`text-[12px] font-semibold ${active ? 'text-[#085041]' : 'text-[#c00]'}`}>
          {active ? 'Coverage active' : 'Coverage inactive'}
        </span>
        {d.insuranceProvider && <span className="text-[11px] text-[#555] ml-auto">{d.insuranceProvider}</span>}
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
            <span className="text-[12px] text-[#1A1A2E]">{fmt$(d.deductible.individual.remaining)} remaining of {fmt$(d.deductible.individual.total)}</span>
          </div>
        )}
        {d.deductible?.family?.total != null && (
          <div>
            <span className="text-[10px] text-[#999] block">Family deductible</span>
            <span className="text-[12px] text-[#1A1A2E]">{fmt$(d.deductible.family.remaining)} remaining of {fmt$(d.deductible.family.total)}</span>
          </div>
        )}
        {d.outOfPocket?.individual?.total != null && (
          <div>
            <span className="text-[10px] text-[#999] block">OOP max (individual)</span>
            <span className="text-[12px] text-[#1A1A2E]">{fmt$(d.outOfPocket.individual.remaining)} remaining of {fmt$(d.outOfPocket.individual.total)}</span>
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
        <button onClick={onCheck} className="text-[11px] text-[#999] hover:text-[#7F77DD] transition-colors">Re-check</button>
      </div>
    </div>
  )
}

function to12h(time24: string): string {
  const [h, m] = time24.split(':').map(Number)
  if (isNaN(h) || isNaN(m)) return time24
  const ampm = h >= 12 ? 'PM' : 'AM'
  return `${h % 12 || 12}:${m.toString().padStart(2, '0')} ${ampm}`
}

export function AdminSchedule() {
  const { zipToZone } = usePracticeZones()
  const { visitTypes, byType } = usePracticeVisitTypes()
  const [providers, setProviders] = useState<Provider[]>([])
  const [appointments, setAppointments] = useState<Appointment[]>([])
  const [filterProvider, setFilterProvider] = useState('')
  const [filterDate, setFilterDate] = useState(format(new Date(), 'yyyy-MM-dd'))

  // On-call schedule — keyed by `${date}::${state}`
  const [onCallEntries, setOnCallEntries] = useState<Record<string, { id: string; provider_id: string; provider_name: string; initials: string; avatar_color: string; avatar_text_color: string }>>({})
  const [onCallSaving, setOnCallSaving] = useState<string | null>(null)

  const onCallDays = Array.from({ length: 14 }, (_, i) => format(addDays(new Date(), i), 'yyyy-MM-dd'))
  const mdProviders = providers.filter(p => !p.is_admin && p.role !== 'CMA' && p.role !== 'RN')
  const ncProviders = mdProviders.filter(p => (p.states as string[] | undefined)?.includes('NC'))
  const scProviders = mdProviders.filter(p => (p.states as string[] | undefined)?.includes('SC'))
  const [expanded, setExpanded] = useState<string | null>(null)
  const [modalOpen, setModalOpen] = useState(false)
  const [loading, setLoading] = useState(true)
  const [doneTarget, setDoneTarget] = useState<Appointment | null>(null)
  const [doneInstructions, setDoneInstructions] = useState('')
  const [cancelApptTarget, setCancelApptTarget] = useState<Appointment | null>(null)
  const [cancelApptBusy, setCancelApptBusy] = useState(false)
  const [doneSubmitting, setDoneSubmitting] = useState(false)
  const [eligibility, setEligibility] = useState<Record<string, { loading: boolean; data: any | null; error: string | null }>>({})
  const [notes, setNotes] = useState<Record<string, any>>({})
  const [vitals, setVitals] = useState<Record<string, any>>({})
  const [unlockingNote, setUnlockingNote] = useState<string | null>(null)
  const [editNote, setEditNote] = useState<{ apptId: string; section: 'dx' | 'cpt' } | null>(null)
  const [editDx, setEditDx] = useState<Array<{ code: string; name: string }>>([])
  const [editCpt, setEditCpt] = useState<Array<{ code: string; description: string; category: string; charge_amount: number; modifier?: string }>>([])
  const [icdQuery, setIcdQuery] = useState('')
  const [icdResults, setIcdResults] = useState<Array<{ code: string; name: string }>>([])
  const [icdLoading, setIcdLoading] = useState(false)
  const [notePatching, setNotePatching] = useState(false)
  const [noteError, setNoteError] = useState<string | null>(null)
  const [feeSchedule, setFeeSchedule] = useState<any[]>([])
  const [cptPickerOpen, setCptPickerOpen] = useState(false)
  const [cptPickerTab, setCptPickerTab] = useState<'Procedure' | 'Non-Covered Services'>('Procedure')
  const [cptPickerSearch, setCptPickerSearch] = useState('')
  const icdTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [form, setForm] = useState({
    provider_id: '', visit_type: 'In-home sick visit',
    zip: '', zone: '', address: '', patientName: '', dob: '', gender: '', phone: '', email: '',
    scheduled_time: '09:00', scheduled_date: format(new Date(), 'yyyy-MM-dd'),
  })

  useEffect(() => {
    getProviders().then(data => setProviders((data ?? []) as Provider[])).catch(() => {})
    getOnCallSchedule({ start: format(new Date(), 'yyyy-MM-dd'), end: format(addDays(new Date(), 13), 'yyyy-MM-dd') })
      .then(rows => {
        const map: typeof onCallEntries = {}
        for (const r of rows) map[`${r.date}::${r.state}`] = r
        setOnCallEntries(map)
      }).catch(() => {})
  }, [])

  async function saveOnCall(date: string, state: string, providerId: string) {
    const key = `${date}::${state}`
    setOnCallSaving(key)
    try {
      if (providerId) {
        const row = await setOnCallProvider(date, state, providerId)
        const p = providers.find(x => x.id === providerId)
        setOnCallEntries(prev => ({ ...prev, [key]: { ...row, provider_name: p?.name ?? '', initials: p?.initials ?? '', avatar_color: p?.avatar_color ?? '', avatar_text_color: p?.avatar_text_color ?? '' } }))
      } else {
        await setOnCallProvider(date, state, null)
        setOnCallEntries(prev => { const n = { ...prev }; delete n[key]; return n })
      }
    } catch { /* silent */ }
    setOnCallSaving(null)
  }

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
      setEligibility(prev => ({ ...prev, [apptId]: { loading: false, data: data ?? null, error: null } }))
    } catch (err: any) {
      setEligibility(prev => ({ ...prev, [apptId]: { loading: false, data: null, error: err.message || 'Eligibility check failed.' } }))
    }
  }

  async function unlockNote(apptId: string) {
    const n = notes[apptId]
    if (!n?.id) return
    setUnlockingNote(apptId)
    try {
      const updated = await updateEncounterNote(n.id, { is_signed: false })
      setNotes(prev => ({ ...prev, [apptId]: updated }))
    } catch (err: any) {
      alert(err.message || 'Failed to unlock note')
    }
    setUnlockingNote(null)
  }

  function startEditDx(apptId: string) {
    const n = notes[apptId]
    setEditDx(Array.isArray(n?.diagnoses) ? n.diagnoses.map((d: any) => ({ code: d.code, name: d.name ?? d.description ?? '' })) : [])
    setIcdQuery('')
    setIcdResults([])
    setEditNote({ apptId, section: 'dx' })
  }

  function startEditCpt(apptId: string) {
    const n = notes[apptId]
    setEditCpt(Array.isArray(n?.cpt_codes) ? n.cpt_codes.map((c: any) => ({ ...c })) : [])
    setEditNote({ apptId, section: 'cpt' })
    setCptPickerOpen(false)
    setCptPickerSearch('')
    if (feeSchedule.length === 0) getFeeSchedule().then(setFeeSchedule).catch(() => {})
  }

  function searchIcd(q: string) {
    setIcdQuery(q)
    if (icdTimer.current) clearTimeout(icdTimer.current)
    if (!q.trim()) { setIcdResults([]); return }
    setIcdLoading(true)
    icdTimer.current = setTimeout(async () => {
      try {
        const url = `https://clinicaltables.nlm.nih.gov/api/icd10cm/v3/search?sf=code,name&terms=${encodeURIComponent(q)}&maxList=8`
        const data = await fetch(url).then(r => r.json())
        const items: [string, string][] = (data[3] ?? []).map((row: string[]) => [row[0], row[1]])
        setIcdResults(items.map(([code, name]) => ({ code, name })))
      } catch { setIcdResults([]) }
      setIcdLoading(false)
    }, 300)
  }

  async function saveNoteEdit() {
    setNoteError(null)
    if (!editNote) { setNoteError('No edit session — please click Edit again.'); return }
    const apptId = editNote.apptId
    const n = notes[apptId]
    if (!n?.id) { setNoteError('Note not loaded — please collapse and re-expand this appointment.'); return }
    setNotePatching(true)
    try {
      const body = editNote.section === 'dx' ? { diagnoses: editDx } : { cpt_codes: editCpt }
      const updated = await patchEncounterNote(n.id, body)
      setNotes(prev => ({ ...prev, [apptId]: updated }))
      setEditNote(null)
    } catch (err: any) {
      setNoteError(err.message || 'Failed to save')
    }
    setNotePatching(false)
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

  async function confirmCancelAppt() {
    if (!cancelApptTarget) return
    setCancelApptBusy(true)
    await updateAppointment(cancelApptTarget.id, { status: 'cancelled' })
    setAppointments(prev => prev.map(a => a.id === cancelApptTarget!.id ? { ...a, status: 'cancelled' } : a))
    invokeNotifications({ type: 'appointment_cancelled', appointmentId: cancelApptTarget.id }).catch(() => {})
    if (cancelApptTarget.zone) {
      invokeNotifications({
        type: 'slot_opened',
        providerId: cancelApptTarget.provider_id,
        zone: cancelApptTarget.zone,
        visitType: cancelApptTarget.visit_type,
        date: cancelApptTarget.scheduled_date,
        time: cancelApptTarget.scheduled_time,
      }).catch(() => {})
    }
    setCancelApptTarget(null)
    setCancelApptBusy(false)
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

      {/* ── On-call telemedicine schedule ── */}
      <div className="px-6 py-5 border-b border-[#E8E8E4] space-y-5">
        <div className="flex items-center gap-2">
          <Phone size={14} className="text-[#7F77DD]" />
          <span className="text-[13px] font-semibold text-[#1A1A2E]">On-call telemedicine schedule</span>
          <span className="text-[11px] text-[#999]">— assign one provider per state per day</span>
        </div>
        {(['NC', 'SC'] as const).map(state => {
          const stateProviders = state === 'NC' ? ncProviders : scProviders
          return (
            <div key={state}>
              <div className="text-[11px] font-semibold text-[#555] uppercase tracking-wider mb-2">{state === 'NC' ? 'North Carolina' : 'South Carolina'}</div>
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-7 gap-2">
                {onCallDays.map(date => {
                  const key = `${date}::${state}`
                  const entry = onCallEntries[key]
                  const label = format(new Date(date + 'T12:00:00'), 'EEE M/d')
                  const isSaving = onCallSaving === key
                  return (
                    <div key={date} className="border border-[#E8E8E4] rounded-lg p-2.5 bg-white">
                      <div className="text-[10px] font-semibold text-[#999] uppercase tracking-wider mb-1.5">{label}</div>
                      {entry && (
                        <div className="flex items-center gap-1.5 mb-1.5">
                          <div className="w-5 h-5 rounded-full flex items-center justify-center text-[9px] font-medium flex-shrink-0"
                            style={{ background: entry.avatar_color, color: entry.avatar_text_color }}>
                            {entry.initials}
                          </div>
                          <span className="text-[11px] font-medium text-[#1A1A2E] truncate">{entry.provider_name.split(' ').slice(-1)[0]}</span>
                        </div>
                      )}
                      <select
                        value={entry?.provider_id ?? ''}
                        disabled={isSaving || stateProviders.length === 0}
                        onChange={e => saveOnCall(date, state, e.target.value)}
                        className="w-full text-[11px] px-1.5 py-1 border border-[#E8E8E4] rounded bg-white outline-none focus:border-[#7F77DD] disabled:opacity-50">
                        <option value="">Unassigned</option>
                        {stateProviders.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                      </select>
                    </div>
                  )
                })}
              </div>
              {stateProviders.length === 0 && (
                <p className="text-[12px] text-[#999] mt-1">No providers with {state} license on file.</p>
              )}
            </div>
          )
        })}
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
                const vt = byType[appt.visit_type]
                const isExpanded = expanded === appt.id
                return (
                  <div key={appt.id}
                    className={`border rounded-lg overflow-hidden cursor-pointer transition-all ${isExpanded ? 'border-[#7F77DD]' : 'border-[#E8E8E4] bg-white hover:border-[#AFA9EC]'}`}
                    onClick={() => {
                      const next = isExpanded ? null : appt.id
                      setExpanded(next)
                      if (next && !(next in notes)) {
                        getEncounterNote({ appointment_id: next })
                          .then(n => setNotes(prev => ({ ...prev, [next]: n ?? false })))
                          .catch(() => setNotes(prev => ({ ...prev, [next]: false })))
                        getVitals({ appointment_id: next })
                          .then(v => setVitals(prev => ({ ...prev, [next]: v ?? false })))
                          .catch(() => setVitals(prev => ({ ...prev, [next]: false })))
                      }
                    }}>
                    <div className="flex items-center gap-3 px-4 py-2.5">
                      <span className="text-[12px] text-[#555] w-14 flex-shrink-0">{to12h(appt.scheduled_time)}</span>
                      <span className="font-display text-[14px] font-medium text-[#1A1A2E] flex-1">{appt.visit_type}</span>
                      <span className="text-[12px] text-[#555] hidden sm:block">{appt.zone}{appt.duration_minutes && appt.duration_minutes > 60 ? ` · ${appt.duration_minutes} min` : ''}</span>
                      <Badge color={vt?.badge_color} textColor={vt?.badge_text_color}>{vt?.badge_label || appt.visit_type}</Badge>
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
                        {/* Encounter note */}
                        <div className="mt-3 border border-[#E8E8E4] rounded-lg overflow-hidden">
                          <div className="flex items-center gap-2 px-3 py-2 bg-[#FAFAF8] border-b border-[#E8E8E4]">
                            <FileText size={13} className="text-[#7F77DD]" />
                            <span className="text-[11px] font-semibold text-[#555] uppercase tracking-wider">Encounter Note</span>
                            <div className="ml-auto flex items-center gap-2">
                              {notes[appt.id]?.is_signed && (
                                <span className="text-[10px] font-semibold text-[#085041] bg-[#E1F5EE] px-2 py-0.5 rounded-full">Signed</span>
                              )}
                              {notes[appt.id] && (
                                <button
                                  onClick={() => unlockNote(appt.id)}
                                  disabled={unlockingNote === appt.id}
                                  className="text-[11px] font-medium px-2 py-0.5 rounded border border-[#7F77DD] text-[#7F77DD] hover:bg-[#EEEDFE] transition-colors disabled:opacity-50">
                                  {unlockingNote === appt.id ? 'Unlocking…' : 'Unlock note'}
                                </button>
                              )}
                            </div>
                          </div>
                          {!(appt.id in notes) ? (
                            <div className="px-3 py-2 text-[12px] text-[#999]">Loading…</div>
                          ) : !notes[appt.id] ? (
                            <div className="px-3 py-2 text-[12px] text-[#999]">No encounter note on file.</div>
                          ) : (() => {
                            const n = notes[appt.id]
                            const v = vitals[appt.id]
                            const vitalItems = v ? [
                              v.temperature_f   != null && `Temp ${v.temperature_f}°F`,
                              v.heart_rate       != null && `HR ${v.heart_rate}`,
                              v.respiratory_rate != null && `RR ${v.respiratory_rate}`,
                              v.oxygen_saturation!= null && `O₂ ${v.oxygen_saturation}%`,
                              v.weight_lbs       != null && `Wt ${v.weight_lbs} lbs`,
                              v.height_in        != null && `Ht ${v.height_in} in`,
                              v.systolic_bp      != null && v.diastolic_bp != null && `BP ${v.systolic_bp}/${v.diastolic_bp}`,
                            ].filter(Boolean) : []
                            return (
                              <div className="px-3 py-3 space-y-3 text-[12px]">
                                {!n.is_signed && (
                                  <div className="flex items-center gap-2 px-2.5 py-2 bg-[#FEF9EC] border border-[#FAC775] rounded-lg text-[11px] text-[#92520A] font-medium">
                                    Draft — unlocked for editing. Edit diagnoses and CPT codes below, then the provider can re-sign.
                                  </div>
                                )}
                                {n.chief_complaint && (
                                  <div>
                                    <div className="text-[10px] text-[#999] uppercase tracking-wider mb-0.5">Chief Complaint</div>
                                    <div className="text-[#1A1A2E]">{n.chief_complaint}</div>
                                  </div>
                                )}
                                {vitalItems.length > 0 && (
                                  <div>
                                    <div className="text-[10px] text-[#999] uppercase tracking-wider mb-1">Vitals</div>
                                    <div className="flex flex-wrap gap-x-4 gap-y-1 text-[#555]">{vitalItems.map((s, i) => <span key={i}>{s as string}</span>)}</div>
                                  </div>
                                )}
                                {n.subjective && (
                                  <div>
                                    <div className="text-[10px] text-[#999] uppercase tracking-wider mb-0.5">Subjective (HPI)</div>
                                    <div className="text-[#555] whitespace-pre-wrap">{n.subjective}</div>
                                  </div>
                                )}
                                {n.objective && (
                                  <div>
                                    <div className="text-[10px] text-[#999] uppercase tracking-wider mb-0.5">Objective / Physical Exam</div>
                                    <div className="text-[#555] whitespace-pre-wrap">{n.objective}</div>
                                  </div>
                                )}
                                {/* Diagnoses */}
                                {(editNote?.apptId === appt.id && editNote.section === 'dx') ? (
                                  <div className="border border-[#7F77DD] rounded-lg p-3 space-y-2.5 bg-[#FAFAF8]">
                                    <div className="text-[10px] font-semibold text-[#7F77DD] uppercase tracking-wider">Edit ICD-10 Diagnoses</div>
                                    <div className="space-y-1.5">
                                      {editDx.map((d, i) => (
                                        <div key={i} className="flex items-center gap-2">
                                          <span className="font-mono text-[#7F77DD] font-medium text-[12px] w-20 flex-shrink-0">{d.code}</span>
                                          <span className="text-[#555] text-[12px] flex-1">{d.name}</span>
                                          <button onClick={() => setEditDx(prev => prev.filter((_, j) => j !== i))}
                                            className="text-[#999] hover:text-[#c00] transition-colors flex-shrink-0">
                                            <X size={13} />
                                          </button>
                                        </div>
                                      ))}
                                    </div>
                                    <div className="relative">
                                      <div className="flex items-center gap-1.5 border border-[#E8E8E4] rounded-lg px-2.5 py-1.5 bg-white">
                                        <Search size={12} className="text-[#999] flex-shrink-0" />
                                        <input autoFocus value={icdQuery} onChange={e => searchIcd(e.target.value)}
                                          placeholder="Search ICD-10 code or diagnosis name…"
                                          className="flex-1 text-[12px] outline-none bg-transparent placeholder:text-[#ccc]" />
                                        {icdLoading && <span className="text-[10px] text-[#999]">…</span>}
                                      </div>
                                      {icdResults.length > 0 && (
                                        <div className="absolute top-full left-0 right-0 z-20 bg-white border border-[#E8E8E4] rounded-lg shadow-lg mt-1 overflow-hidden">
                                          {icdResults.map(r => (
                                            <button key={r.code} onClick={() => {
                                              if (!editDx.find(d => d.code === r.code)) setEditDx(prev => [...prev, r])
                                              setIcdQuery(''); setIcdResults([])
                                            }} className="w-full text-left px-3 py-2 text-[12px] hover:bg-[#EEEDFE] transition-colors flex items-baseline gap-2">
                                              <span className="font-mono text-[#7F77DD] font-medium flex-shrink-0">{r.code}</span>
                                              <span className="text-[#555]">{r.name}</span>
                                            </button>
                                          ))}
                                        </div>
                                      )}
                                    </div>
                                    {noteError && editNote?.apptId === appt.id && editNote.section === 'dx' && (
                                      <div className="text-[11px] text-red-600 bg-red-50 border border-red-200 rounded px-2 py-1">{noteError}</div>
                                    )}
                                    <div className="flex gap-2 pt-1">
                                      <Button size="xs" variant="secondary" onClick={() => { setEditNote(null); setNoteError(null) }}>Cancel</Button>
                                      <Button size="xs" loading={notePatching} onClick={saveNoteEdit}>Save diagnoses</Button>
                                    </div>
                                  </div>
                                ) : (
                                  <div>
                                    <div className="flex items-center justify-between mb-1">
                                      <div className="text-[10px] text-[#999] uppercase tracking-wider">Diagnoses</div>
                                      <button onClick={() => startEditDx(appt.id)}
                                        className="flex items-center gap-1 text-[11px] text-[#7F77DD] hover:text-[#534AB7] transition-colors">
                                        <Pencil size={10} /> Edit
                                      </button>
                                    </div>
                                    {(n.diagnoses ?? []).length === 0 ? (
                                      <div className="text-[#999] italic text-[12px]">No diagnoses recorded.</div>
                                    ) : (
                                      <div className="space-y-1">
                                        {n.diagnoses.map((d: any, i: number) => (
                                          <div key={i} className="flex items-baseline gap-2">
                                            <span className="font-mono text-[#7F77DD] font-medium">{d.code}</span>
                                            <span className="text-[#555]">{d.name ?? d.description}</span>
                                          </div>
                                        ))}
                                      </div>
                                    )}
                                  </div>
                                )}
                                {n.assessment && (
                                  <div>
                                    <div className="text-[10px] text-[#999] uppercase tracking-wider mb-0.5">Assessment</div>
                                    <div className="text-[#555] whitespace-pre-wrap">{n.assessment}</div>
                                  </div>
                                )}
                                {n.plan && (
                                  <div>
                                    <div className="text-[10px] text-[#999] uppercase tracking-wider mb-0.5">Plan</div>
                                    <div className="text-[#555] whitespace-pre-wrap">{n.plan}</div>
                                  </div>
                                )}
                                {/* CPT Codes */}
                                {(editNote?.apptId === appt.id && editNote.section === 'cpt') ? (
                                  <div className="border border-[#7F77DD] rounded-lg p-3 space-y-2 bg-[#FAFAF8]">
                                    <div className="text-[10px] font-semibold text-[#7F77DD] uppercase tracking-wider">Edit CPT Codes</div>
                                    <div className="space-y-2">
                                      {editCpt.map((c, i) => (
                                        <div key={i} className="flex items-center gap-2">
                                          <span className="font-mono text-[#7F77DD] font-medium text-[12px] w-16 flex-shrink-0">{c.code}</span>
                                          <span className="text-[#555] text-[12px] flex-1 truncate min-w-0">{c.description}</span>
                                          <div className="flex items-center gap-1 flex-shrink-0">
                                            <label className="text-[10px] text-[#999]">Mod:</label>
                                            <input value={c.modifier ?? ''} maxLength={4}
                                              onChange={e => setEditCpt(prev => prev.map((x, j) => j === i ? { ...x, modifier: e.target.value.toUpperCase() } : x))}
                                              placeholder="25"
                                              className="w-12 border border-[#E8E8E4] rounded px-1.5 py-0.5 text-[12px] font-mono uppercase outline-none focus:border-[#7F77DD]" />
                                          </div>
                                          <button onClick={() => setEditCpt(prev => prev.filter((_, j) => j !== i))}
                                            className="text-[#999] hover:text-[#c00] transition-colors flex-shrink-0">
                                            <X size={13} />
                                          </button>
                                        </div>
                                      ))}
                                    </div>
                                    {/* Add code picker */}
                                    <div>
                                      <button
                                        onClick={() => setCptPickerOpen(o => !o)}
                                        className="flex items-center gap-1 text-[12px] text-[#7F77DD] font-medium hover:text-[#534AB7] transition-colors">
                                        <span className="text-base leading-none">+</span> Add procedure or fee
                                      </button>
                                      {cptPickerOpen && (
                                        <div className="mt-1.5 border border-[#E8E8E4] rounded-lg overflow-hidden bg-white">
                                          <div className="p-1.5 border-b border-[#F1EFE8]">
                                            <input autoFocus type="text" placeholder="Search by code or description…"
                                              value={cptPickerSearch}
                                              onChange={e => setCptPickerSearch(e.target.value)}
                                              className="w-full px-2.5 py-1 border border-[#E8E8E4] rounded-lg text-[12px] outline-none focus:border-[#7F77DD]" />
                                          </div>
                                          <div className="flex border-b border-[#F1EFE8]">
                                            {(['Procedure', 'Non-Covered Services'] as const).map(tab => (
                                              <button key={tab} onClick={() => setCptPickerTab(tab)}
                                                className={`flex-1 py-1.5 text-[11px] font-medium transition-colors ${cptPickerTab === tab ? 'text-[#7F77DD] border-b-2 border-[#7F77DD]' : 'text-[#999]'}`}>
                                                {tab === 'Procedure' ? 'Insurance Procedures' : 'Convenience & Self-Pay'}
                                              </button>
                                            ))}
                                          </div>
                                          <div className="max-h-48 overflow-y-auto">
                                            {feeSchedule
                                              .filter(c => c.category === cptPickerTab)
                                              .filter(c => !cptPickerSearch || c.code.toLowerCase().includes(cptPickerSearch.toLowerCase()) || c.description.toLowerCase().includes(cptPickerSearch.toLowerCase()))
                                              .filter(c => !editCpt.find((x: any) => x.code === c.code))
                                              .map((c: any) => (
                                                <button key={c.code}
                                                  onClick={() => { setEditCpt(prev => [...prev, { ...c }]); setCptPickerOpen(false); setCptPickerSearch('') }}
                                                  className="w-full text-left px-3 py-2 hover:bg-[#FAFAF8] border-b border-[#F8F8F6] last:border-0 flex items-center justify-between gap-2 transition-colors">
                                                  <div className="flex items-center gap-2 min-w-0">
                                                    <span className="text-[11px] font-semibold text-[#7F77DD] flex-shrink-0">{c.code}</span>
                                                    <span className="text-[12px] text-[#1A1A2E] truncate">{c.description}</span>
                                                  </div>
                                                  <span className="text-[11px] font-medium text-[#555] flex-shrink-0">${parseFloat(c.charge_amount).toFixed(2)}</span>
                                                </button>
                                              ))}
                                            {feeSchedule.filter(c => c.category === cptPickerTab).filter(c => !cptPickerSearch || c.code.toLowerCase().includes(cptPickerSearch.toLowerCase()) || c.description.toLowerCase().includes(cptPickerSearch.toLowerCase())).filter(c => !editCpt.find((x: any) => x.code === c.code)).length === 0 && (
                                              <div className="px-3 py-2 text-[12px] text-[#999]">No codes match.</div>
                                            )}
                                          </div>
                                        </div>
                                      )}
                                    </div>
                                    <p className="text-[10px] text-[#999]">Enter 2-digit modifier codes (e.g. 25, 59, 26) without the dash.</p>
                                    {noteError && editNote?.apptId === appt.id && editNote.section === 'cpt' && (
                                      <div className="text-[11px] text-red-600 bg-red-50 border border-red-200 rounded px-2 py-1">{noteError}</div>
                                    )}
                                    <div className="flex gap-2 pt-1">
                                      <Button size="xs" variant="secondary" onClick={() => { setEditNote(null); setNoteError(null) }}>Cancel</Button>
                                      <Button size="xs" loading={notePatching} onClick={saveNoteEdit}>Save CPT codes</Button>
                                    </div>
                                  </div>
                                ) : (
                                  <div>
                                    <div className="flex items-center justify-between mb-1">
                                      <div className="text-[10px] text-[#999] uppercase tracking-wider">CPT Codes & Charges</div>
                                      <button onClick={() => startEditCpt(appt.id)}
                                        className="flex items-center gap-1 text-[11px] text-[#7F77DD] hover:text-[#534AB7] transition-colors">
                                        <Pencil size={10} /> Edit
                                      </button>
                                    </div>
                                    {(n.cpt_codes ?? []).length === 0 ? (
                                      <div className="text-[#F59E0B] font-medium">No CPT codes on file — provider must unlock and re-sign note.</div>
                                    ) : (
                                      <div className="space-y-2">
                                        {n.cpt_codes.map((c: any, i: number) => (
                                          <div key={i} className="flex items-center justify-between gap-2">
                                            <div className="flex items-center gap-2 flex-wrap min-w-0">
                                              <span className="font-mono text-[#7F77DD] font-medium flex-shrink-0">{c.code}</span>
                                              <span className="text-[#555] truncate">{c.description}</span>
                                              {c.category === 'Non-Covered Services' && (
                                                <span className="text-[10px] text-[#999] italic flex-shrink-0">non-covered</span>
                                              )}
                                            </div>
                                            <div className="flex items-center gap-2 flex-shrink-0">
                                              <div className="flex items-center gap-1">
                                                <label className="text-[10px] text-[#999] whitespace-nowrap">Mod:</label>
                                                <input
                                                  value={c.modifier ?? ''}
                                                  maxLength={3}
                                                  onChange={e => {
                                                    const val = e.target.value.toUpperCase()
                                                    setNotes(prev => ({
                                                      ...prev,
                                                      [appt.id]: {
                                                        ...prev[appt.id],
                                                        cpt_codes: prev[appt.id].cpt_codes.map((x: any, j: number) => j === i ? { ...x, modifier: val } : x)
                                                      }
                                                    }))
                                                  }}
                                                  onBlur={async () => {
                                                    const currentNote = notes[appt.id]
                                                    if (!currentNote?.id) return
                                                    try {
                                                      await patchEncounterNote(currentNote.id, { cpt_codes: currentNote.cpt_codes })
                                                    } catch { /* silent */ }
                                                  }}
                                                  placeholder="25"
                                                  className="w-12 border border-[#E8E8E4] rounded px-1.5 py-0.5 text-[12px] font-mono uppercase outline-none focus:border-[#7F77DD]"
                                                />
                                              </div>
                                              <span className="text-[#1A1A2E] font-medium">${parseFloat(c.charge_amount ?? 0).toFixed(2)}</span>
                                            </div>
                                          </div>
                                        ))}
                                      </div>
                                    )}
                                  </div>
                                )}
                              </div>
                            )
                          })()}
                        </div>

                        {/* Insurance eligibility */}
                        <div className="mt-3">
                          <EligibilityCard
                            state={eligibility[appt.id]}
                            onCheck={() => runEligibilityCheck(appt.id)}
                          />
                        </div>

                        {appt.status !== 'done' && appt.status !== 'cancelled' && (
                          <div className="flex gap-2 mt-3">
                            <Button variant="teal" size="xs" onClick={() => { setDoneTarget(appt); setDoneInstructions('') }}>
                              <CheckCircle2 size={12} /> Mark complete
                            </Button>
                            <Button variant="danger" size="xs" onClick={() => setCancelApptTarget(appt)}>
                              <XCircle size={12} /> Cancel visit
                            </Button>
                          </div>
                        )}
                        {appt.status === 'cancelled' && (
                          <div className="mt-3 text-[12px] text-[#991B1B] font-medium">Cancelled</div>
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

      {/* ── Cancel appointment modal ── */}
      {cancelApptTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" onClick={() => !cancelApptBusy && setCancelApptTarget(null)} />
          <div className="relative bg-white rounded-2xl shadow-xl w-full max-w-sm p-6">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-full bg-[#FDEDED] flex items-center justify-center flex-shrink-0">
                <XCircle size={18} className="text-[#991B1B]" />
              </div>
              <h2 className="font-display text-lg font-medium text-[#1A1A2E]">Cancel this visit?</h2>
            </div>
            <div className="p-3 bg-[#FAFAF8] border border-[#E8E8E4] rounded-lg text-[13px] mb-4 space-y-0.5">
              <div className="font-medium text-[#1A1A2E]">{cancelApptTarget.visit_type}</div>
              <div className="text-[#999]">{format(new Date(cancelApptTarget.scheduled_date + 'T12:00:00'), 'EEEE, MMMM d')} at {to12h(cancelApptTarget.scheduled_time)}</div>
              {cancelApptTarget.zone && <div className="text-[#999]">{cancelApptTarget.zone}</div>}
            </div>
            <p className="text-[13px] text-[#555] mb-4">The provider and family will be notified. Waitlist families in the same zone will be offered this slot.</p>
            <div className="flex gap-2">
              <Button variant="secondary" className="flex-1" onClick={() => setCancelApptTarget(null)} disabled={cancelApptBusy}>Keep visit</Button>
              <Button variant="danger" className="flex-1" loading={cancelApptBusy} onClick={confirmCancelAppt}>Cancel visit</Button>
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
              {(byType[form.visit_type]?.allowed_roles
                ? providers.filter(p => byType[form.visit_type].allowed_roles!.includes(p.role))
                : providers
              ).map(p => <option key={p.id} value={p.id}>{p.name} — {p.zones?.join(', ') || p.role}</option>)}
            </select>
            {byType[form.visit_type]?.allowed_roles && (
              <p className="text-[11px] text-[#888] mt-1">Only {byType[form.visit_type].allowed_roles!.join(' / ')} providers are eligible for this visit type.</p>
            )}
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
                {visitTypes.map(vt => <option key={vt.visit_type} value={vt.visit_type}>{vt.visit_type}</option>)}
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
                  const detectedZone = zip.length === 5 ? (zipToZone[zip] || '') : ''
                  setForm(f => ({ ...f, zip, zone: detectedZone || f.zone }))
                }}
                className="w-full px-3 py-2 border border-[#E8E8E4] rounded-lg text-[13px] font-sans" />
            </div>
            <div>
              <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-1">
                Zone {form.zip.length === 5 && zipToZone[form.zip] && <span className="text-[#1D9E75] normal-case font-normal">· auto-detected</span>}
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
