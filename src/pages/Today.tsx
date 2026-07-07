import { useEffect, useRef, useState } from 'react'
import { CheckCircle2, ChevronDown, Navigation, Plus, X, AlertTriangle, Ban, ChevronLeft, ChevronRight, CreditCard, FileText, Video } from 'lucide-react'
import { format, addDays, subDays, isToday, parseISO } from 'date-fns'
import {
  getAppointments, createAppointment, updateAppointment,
  getScheduleBlocks, createScheduleBlock, deleteScheduleBlock,
  getProviders, updateBookingRequest, invokeNotifications,
  getBookingRequests, getChildrenByIds, invokeCharmDetails, searchChildren,
  chargeCard, apiFetch,
} from '../lib/api'
import { EncounterNoteModal } from '../components/EncounterNoteModal'
import { useAuth } from '../contexts/AuthContext'
import { Badge } from '../components/ui/Badge'
import { Button } from '../components/ui/Button'
import { TIME_SLOTS } from '../lib/zipData'
import { usePracticeZones } from '../hooks/usePracticeZones'
import { usePracticeVisitTypes } from '../hooks/usePracticeVisitTypes'
import type { Appointment } from '../types'

function to12h(time24: string): string {
  const [h, m] = time24.split(':').map(Number)
  if (isNaN(h) || isNaN(m)) return time24
  const ampm = h >= 12 ? 'PM' : 'AM'
  return `${h % 12 || 12}:${m.toString().padStart(2, '0')} ${ampm}`
}

function parseTime(raw: string): string {
  const s = raw.trim().toUpperCase()
  const match = s.match(/^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)?$/)
  if (!match) return '00:00'
  let h = parseInt(match[1], 10)
  const mins = match[2] !== undefined ? parseInt(match[2], 10) : 0
  const period = match[3]
  if (period === 'PM' && h !== 12) h += 12
  else if (period === 'AM' && h === 12) h = 0
  return `${h.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}`
}

interface ScheduleBlock {
  id: string
  provider_id: string
  start_date: string
  end_date: string
  start_time: string | null
  end_time: string | null
  all_day: boolean
  reason: string | null
  created_at: string
}

export function Today() {
  const { provider } = useAuth()
  const { zipToZone } = usePracticeZones()
  const { visitTypes, byType } = usePracticeVisitTypes()
  const [appts, setAppts] = useState<Appointment[]>([])
  const [loading, setLoading] = useState(true)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [viewDate, setViewDate] = useState(format(new Date(), 'yyyy-MM-dd'))
  const [charmDetails, setCharmDetails] = useState<Record<string, any>>({})

  // Add appointment
  const [adding, setAdding] = useState(false)
  const [addForm, setAddForm] = useState({ visitType: 'In-home sick visit', zip: '', zone: '', address: '', patientName: '', dob: '', gender: '', phone: '', email: '', insurancePayer: '', insuranceMemberId: '', insuranceGroup: '', subscriberName: '', subscriberDob: '', subscriberGender: '', date: '', time: '', notes: '' })
  const [addCustomTime, setAddCustomTime] = useState('')
  const [addSubmitting, setAddSubmitting] = useState(false)
  const [allProviders, setAllProviders] = useState<{ id: string; name: string }[]>([])
  const [addForProviderId, setAddForProviderId] = useState('')

  // Patient search
  const [patientSearch, setPatientSearch] = useState('')
  const [patientResults, setPatientResults] = useState<any[]>([])
  const [patientSearching, setPatientSearching] = useState(false)
  const [selectedPatient, setSelectedPatient] = useState<any | null>(null)
  const patientSearchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Cancel appointment
  const [cancelTarget, setCancelTarget] = useState<Appointment | null>(null)
  const [cancelling, setCancelling] = useState(false)

  // Mark done
  const [doneTarget, setDoneTarget] = useState<Appointment | null>(null)
  const [doneInstructions, setDoneInstructions] = useState('')
  const [doneSubmitting, setDoneSubmitting] = useState(false)

  // Charge card
  const [chargeTarget, setChargeTarget] = useState<Appointment | null>(null)
  const [chargeAmountStr, setChargeAmountStr] = useState('')
  const [chargeSubmitting, setChargeSubmitting] = useState(false)
  const [chargeError, setChargeError] = useState<string | null>(null)
  const [chargeSuccess, setChargeSuccess] = useState<{ amount: number; last4?: string } | null>(null)

  // Send note to parent
  const [noteTarget, setNoteTarget] = useState<Appointment | null>(null)
  const [noteText, setNoteText] = useState('')
  const [noteSending, setNoteSending] = useState(false)
  const [noteSent, setNoteSent] = useState(false)

  // Chart note (EMR)
  const [noteModalAppt, setNoteModalAppt] = useState<Appointment | null>(null)
  const [noteModalChildId, setNoteModalChildId] = useState<string | null>(null)

  async function submitCharge() {
    if (!chargeTarget || !chargeAmountStr) return
    const dollars = parseFloat(chargeAmountStr)
    if (isNaN(dollars) || dollars < 0.5) { setChargeError('Minimum charge is $0.50'); return }
    const amountCents = Math.round(dollars * 100)
    setChargeSubmitting(true)
    setChargeError(null)
    try {
      const result = await chargeCard(chargeTarget.id, amountCents)
      setChargeSuccess({ amount: amountCents, last4: result.last4 })
      setAppts(prev => prev.map(a => a.id === chargeTarget!.id
        ? { ...a, notes: (a.notes || '') + `|CHARGE_ID:${result.paymentId}|CHARGED_CENTS:${amountCents}` }
        : a
      ))
      setTimeout(() => { setChargeTarget(null); setChargeAmountStr(''); setChargeSuccess(null) }, 2500)
    } catch (e: any) {
      setChargeError(e.message ?? 'Payment failed')
    } finally {
      setChargeSubmitting(false)
    }
  }

  async function submitNote() {
    if (!noteTarget || !noteText.trim()) return
    setNoteSending(true)
    try {
      await invokeNotifications({ type: 'provider_note', appointmentId: noteTarget.id, message: noteText.trim() })
      setNoteSent(true)
      setTimeout(() => { setNoteTarget(null); setNoteText(''); setNoteSent(false) }, 1500)
    } finally {
      setNoteSending(false)
    }
  }

  async function openChartNote(appt: Appointment) {
    let childId: string | null = null
    if (appt.notes) {
      const refMatch = appt.notes.match(/Ref: (PUC-\d+)/)
      if (refMatch) {
        const bookings = await getBookingRequests({ reference_code: refMatch[1] }).catch(() => [] as any[])
        const booking = bookings?.[0]
        childId = booking?.child_ids?.[0] ?? null
      }
    }
    setNoteModalChildId(childId)
    setNoteModalAppt(appt)
  }

  // Schedule blocks
  const [blocks, setBlocks] = useState<ScheduleBlock[]>([])
  const [blocking, setBlocking] = useState(false)
  const [blockSubmitting, setBlockSubmitting] = useState(false)
  const [blockForm, setBlockForm] = useState({
    mode: 'single' as 'single' | 'range',
    startDate: '',
    endDate: '',
    allDay: true,
    startTime: '',
    endTime: '',
    reason: '',
  })

  const today = format(new Date(), 'yyyy-MM-dd')

  async function fetchAppts() {
    if (!provider) return
    const data = await getAppointments({ provider_id: provider.id, scheduled_date: viewDate })
    setAppts((data ?? []) as Appointment[])
    setLoading(false)
  }

  async function fetchBlocks() {
    if (!provider) return
    const data = await getScheduleBlocks({ provider_id: provider.id, date: viewDate })
    setBlocks((data ?? []) as ScheduleBlock[])
  }

  useEffect(() => { fetchAppts(); fetchBlocks(); setExpanded(null); setCharmDetails({}) }, [provider, viewDate])

  useEffect(() => {
    if (!provider) return
    getProviders({ exclude_admin: 'true' })
      .then((data) => setAllProviders((data ?? []) as { id: string; name: string }[]))
  }, [provider])

  async function fetchCharmDetails(appt: Appointment) {
    if (charmDetails[appt.id]) return

    let charmPatientId = appt.charm_patient_id
    let charmAppointmentId = appt.charm_appointment_id

    // If no charm_patient_id stored, look it up via reference code in notes
    if (!charmPatientId && appt.notes) {
      const refMatch = appt.notes.match(/Ref: (PUC-\d+)/)
      if (refMatch) {
        const bookings = await getBookingRequests({ reference_code: refMatch[1] })
        const booking = bookings?.[0]
        if (booking?.child_ids?.length) {
          const kids = await getChildrenByIds([booking.child_ids[0]])
          const child = kids?.[0]
          charmPatientId = child?.charm_patient_id || null
          charmAppointmentId = booking.charm_appointment_id || null
        }
      }
    }

    if (!charmPatientId) {
      setCharmDetails(prev => ({ ...prev, [appt.id]: { notFound: true } }))
      return
    }

    const data = await invokeCharmDetails({ charm_patient_id: charmPatientId, charm_appointment_id: charmAppointmentId }).catch(() => null)
    if (data?.ok) setCharmDetails(prev => ({ ...prev, [appt.id]: data }))
    else setCharmDetails(prev => ({ ...prev, [appt.id]: { notFound: true } }))
  }

  async function submitDone() {
    if (!doneTarget) return
    setDoneSubmitting(true)
    const instructions = doneInstructions.trim() || null
    await updateAppointment(doneTarget.id, { status: 'done', after_visit_instructions: instructions })
    if (instructions && doneTarget.charm_appointment_id) {
      void updateBookingRequest(doneTarget.charm_appointment_id, { after_visit_instructions: instructions })
    }
    void invokeNotifications({ type: 'post_visit_email', appointmentId: doneTarget.id, instructions })
    setAppts(prev => prev.map(a => a.id === doneTarget!.id ? { ...a, status: 'done' } : a))
    setDoneTarget(null)
    setDoneInstructions('')
    setDoneSubmitting(false)
  }

  function openAdd() {
    setAddForProviderId(provider?.id || '')
    setAddForm({ visitType: 'In-home sick visit', zip: '', zone: '', address: '', patientName: '', dob: '', gender: '', phone: '', email: '', insurancePayer: '', insuranceMemberId: '', insuranceGroup: '', subscriberName: '', subscriberDob: '', subscriberGender: '', date: viewDate, time: '', notes: '' })
    setAddCustomTime('')
    setPatientSearch('')
    setPatientResults([])
    setSelectedPatient(null)
    setAdding(true)
  }

  function onPatientSearchChange(q: string) {
    setPatientSearch(q)
    setSelectedPatient(null)
    if (patientSearchTimer.current) clearTimeout(patientSearchTimer.current)
    if (!q.trim()) { setPatientResults([]); return }
    patientSearchTimer.current = setTimeout(async () => {
      setPatientSearching(true)
      const results = await searchChildren(q).catch(() => [])
      setPatientResults(results)
      setPatientSearching(false)
    }, 300)
  }

  function selectPatient(child: any) {
    setSelectedPatient(child)
    setPatientSearch('')
    setPatientResults([])
    const dob = child.date_of_birth
      ? (child.date_of_birth instanceof Date ? child.date_of_birth.toISOString() : String(child.date_of_birth)).split('T')[0]
      : ''
    const zip = child.family_zip || ''
    setAddForm(f => ({
      ...f,
      patientName: [child.first_name, child.last_name].filter(Boolean).join(' ') || child.display_label || '',
      dob,
      gender: child.gender || '',
      phone: child.family_phone || '',
      email: child.family_email || '',
      address: child.family_address || '',
      zip,
      zone: zip ? (zipToZone[zip] || '') : '',
    }))
  }

  async function submitAdd() {
    const effectiveTime = addForm.time === '__custom__' ? addCustomTime : addForm.time
    if (!provider || !addForm.date || !effectiveTime || !addForm.visitType) return
    setAddSubmitting(true)

    const time24 = parseTime(effectiveTime)

    const noteParts = []
    if (addForm.patientName) noteParts.push(`PATIENT:${addForm.patientName}`)
    if (addForm.dob) noteParts.push(`DOB:${addForm.dob}`)
    if (addForm.gender) noteParts.push(`GENDER:${addForm.gender}`)
    const fullAddr = addForm.address
      ? (addForm.zip && !addForm.address.includes(addForm.zip) ? `${addForm.address.trim()} ${addForm.zip}` : addForm.address)
      : ''
    if (fullAddr) noteParts.push(`ADDR:${fullAddr}`)
    if (addForm.email) noteParts.push(`PARENTEMAIL:${addForm.email}`)
    if (addForm.phone) noteParts.push(`PARENTPHONE:${addForm.phone}`)
    if (addForm.insurancePayer) noteParts.push(`INSURANCE:${addForm.insurancePayer}`)
    if (addForm.insuranceMemberId) noteParts.push(`MEMBERID:${addForm.insuranceMemberId}`)
    if (addForm.insuranceGroup) noteParts.push(`GROUPNUM:${addForm.insuranceGroup}`)
    if (addForm.subscriberName) noteParts.push(`SUBSCRIBER:${addForm.subscriberName}`)
    if (addForm.subscriberDob) noteParts.push(`SUBSCRIBERDOB:${addForm.subscriberDob}`)
    if (addForm.subscriberGender) noteParts.push(`SUBSCRIBERGENDER:${addForm.subscriberGender}`)
    if (addForm.notes) noteParts.push(`NOTES:${addForm.notes}`)

    const providerId = addForProviderId || provider.id
    const assignedProvider = allProviders.find(p => p.id === providerId)

    await createAppointment({
      provider_id: providerId,
      visit_type: addForm.visitType,
      zone: addForm.zone || addForm.address || 'Unspecified',
      scheduled_time: time24,
      scheduled_date: addForm.date,
      status: 'upcoming',
      notes: noteParts.join('|') || null,
    })

    // Save patient to children table so they appear in patient search
    if (addForm.patientName) {
      const [firstName, ...rest] = addForm.patientName.trim().split(' ')
      const lastName = rest.join(' ')
      apiFetch('/api/children', {
        method: 'POST',
        body: JSON.stringify({
          first_name: firstName || null,
          last_name: lastName || null,
          date_of_birth: addForm.dob || null,
          gender: addForm.gender || null,
          insurance_provider: addForm.insurancePayer || null,
          insurance_member_id: addForm.insuranceMemberId || null,
          insurance_group_number: addForm.insuranceGroup || null,
          insurance_subscriber_name: addForm.subscriberName || null,
          insurance_subscriber_dob: addForm.subscriberDob || null,
          insurance_subscriber_gender: addForm.subscriberGender || null,
        }),
      }).catch(() => {})
    }

    setAddSubmitting(false)
    setAdding(false)
    fetchAppts()

    invokeNotifications({
      type: 'appointment_added',
      providerName: assignedProvider?.name || provider.name,
      visitType: addForm.visitType,
      zone: addForm.zone || addForm.address || 'Unspecified',
      date: addForm.date,
      time: effectiveTime,
      parentEmail: addForm.email || null,
    }).catch(() => {})
  }

  async function confirmCancel() {
    if (!cancelTarget || !provider) return
    setCancelling(true)

    await updateAppointment(cancelTarget.id, { status: 'cancelled' })

    setAppts(prev => prev.map(a => a.id === cancelTarget.id ? { ...a, status: 'cancelled' } : a))

    invokeNotifications({
      type: 'appointment_cancelled',
      appointmentId: cancelTarget.id,
    }).catch(() => {})

    const matchingZips = Object.entries(zipToZone)
      .filter(([, z]) => z === cancelTarget.zone)
      .map(([zip]) => zip)

    if (matchingZips.length > 0) {
      invokeNotifications({
        type: 'slot_opened',
        providerId: provider.id,
        providerName: provider.name,
        zone: cancelTarget.zone,
        visitType: cancelTarget.visit_type,
        date: cancelTarget.scheduled_date,
        time: to12h(cancelTarget.scheduled_time),
        matchingZips,
      }).catch(() => {})
    }

    setCancelling(false)
    setCancelTarget(null)
  }

  function openBlock() {
    setBlockForm({ mode: 'single', startDate: today, endDate: today, allDay: true, startTime: '', endTime: '', reason: '' })
    setBlocking(true)
  }

  async function submitBlock() {
    if (!provider || !blockForm.startDate) return
    if (!blockForm.allDay && (!blockForm.startTime || !blockForm.endTime)) return
    setBlockSubmitting(true)

    await createScheduleBlock({
      provider_id: provider.id,
      start_date: blockForm.startDate,
      end_date: blockForm.mode === 'range' ? blockForm.endDate : blockForm.startDate,
      all_day: blockForm.allDay,
      start_time: blockForm.allDay ? null : blockForm.startTime,
      end_time: blockForm.allDay ? null : blockForm.endTime,
      reason: blockForm.reason || null,
    })

    setBlockSubmitting(false)
    setBlocking(false)
    fetchBlocks()
  }

  async function deleteBlock(id: string) {
    await deleteScheduleBlock(id)
    setBlocks(prev => prev.filter(b => b.id !== id))
  }

  const done = appts.filter(a => a.status === 'done').length
  const inProgress = appts.filter(a => a.status === 'in-progress').length
  const remaining = appts.filter(a => a.status === 'upcoming').length

  const greeting = () => {
    const h = new Date().getHours()
    if (h < 12) return 'Good morning'
    if (h < 17) return 'Good afternoon'
    return 'Good evening'
  }

  if (!provider) return null

  const firstName = provider.name.split(' ').slice(-2)[0]

  // Available end times must come after the selected start time
  const endTimeOptions = blockForm.startTime
    ? TIME_SLOTS.slice(TIME_SLOTS.indexOf(blockForm.startTime) + 1)
    : TIME_SLOTS

  return (
    <div>
      {/* ── Header ── */}
      <div className="bg-white border-b border-[#E8E8E4] px-6 py-4 flex items-center justify-between sticky top-0 z-10">
        <div className="font-display text-[18px] font-medium text-[#1A1A2E]">
          {greeting()}, {firstName}!
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1 bg-[#F1EFE8] rounded-lg px-1 py-1">
            <button onClick={() => setViewDate(format(subDays(parseISO(viewDate), 1), 'yyyy-MM-dd'))}
              className="p-1 rounded hover:bg-white transition-colors">
              <ChevronLeft size={14} className="text-[#555]" />
            </button>
            <span className="text-[13px] font-medium text-[#1A1A2E] px-2 min-w-[140px] text-center">
              {isToday(parseISO(viewDate)) ? 'Today' : format(parseISO(viewDate), 'EEE, MMM d')}
            </span>
            <button onClick={() => setViewDate(format(addDays(parseISO(viewDate), 1), 'yyyy-MM-dd'))}
              className="p-1 rounded hover:bg-white transition-colors">
              <ChevronRight size={14} className="text-[#555]" />
            </button>
          </div>
          {!isToday(parseISO(viewDate)) && (
            <button onClick={() => setViewDate(today)}
              className="text-[12px] text-[#7F77DD] hover:underline">
              Back to today
            </button>
          )}
          <Badge variant="purple">{appts.length} appointments</Badge>
          <Button variant="secondary" size="sm" onClick={openBlock}>
            <Ban size={13} /> Block time
          </Button>
          <Button variant="teal" size="sm" onClick={openAdd}>
            <Plus size={13} /> Add appointment
          </Button>
        </div>
      </div>

      <div className="p-6">

        {/* ── Stat cards ── */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-2.5 mb-6">
          {[
            { label: 'Total today', value: appts.length, color: '#1A1A2E' },
            { label: 'Completed',   value: done,         color: '#1D9E75' },
            { label: 'In progress', value: inProgress,   color: '#7F77DD' },
            { label: 'Remaining',   value: remaining,    color: '#555' },
          ].map(s => (
            <div key={s.label} className="bg-white border border-[#E8E8E4] rounded-lg p-4 shadow-sm">
              <div className="font-display text-2xl font-medium mb-0.5" style={{ color: s.color }}>{loading ? '—' : s.value}</div>
              <div className="text-[12px] text-[#555]">{s.label}</div>
            </div>
          ))}
        </div>

        {/* ── Today's schedule blocks ── */}
        {blocks.length > 0 && (
          <div className="mb-4 space-y-2">
            {blocks.map(block => (
              <div key={block.id} className="flex items-center gap-3 px-4 py-3 bg-[#FAEEDA] border border-[#FAC775] rounded-lg">
                <Ban size={15} className="text-[#633806] flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="text-[14px] font-medium text-[#633806]">
                    {block.all_day ? 'Schedule blocked — all day' : `Schedule blocked · ${block.start_time} – ${block.end_time}`}
                  </div>
                  <div className="flex items-center gap-3 text-[12px] text-[#7A4A18] mt-0.5">
                    {block.reason && <span>{block.reason}</span>}
                    {block.start_date !== block.end_date && (
                      <span>
                        {format(new Date(block.start_date + 'T12:00:00'), 'MMM d')} –{' '}
                        {format(new Date(block.end_date + 'T12:00:00'), 'MMM d')}
                      </span>
                    )}
                  </div>
                </div>
                <button onClick={() => deleteBlock(block.id)}
                  title="Remove block"
                  className="p-1.5 rounded-lg hover:bg-[#FAC775]/60 text-[#633806] flex-shrink-0 transition-colors">
                  <X size={14} />
                </button>
              </div>
            ))}
          </div>
        )}

        {/* ── Appointments list ── */}
        {!loading && appts.length === 0 ? (
          <div className="text-center py-16 text-[#999] text-[14px]">
            No appointments scheduled for today.
          </div>
        ) : (
          <div className="space-y-2">
            {appts.map(appt => {
              const vt = byType[appt.visit_type]
              const isExpanded = expanded === appt.id


              return (
                <div key={appt.id}
                  className={`border rounded-lg overflow-hidden transition-all cursor-pointer ${isExpanded ? 'border-[#7F77DD] bg-[#EEEDFE]/30' : 'border-[#E8E8E4] bg-white hover:border-[#AFA9EC]'}`}
                  onClick={() => { const next = isExpanded ? null : appt.id; setExpanded(next); if (next) fetchCharmDetails(appt) }}>

                  <div className="flex items-center gap-3 px-4 py-3">
                    <div className="text-[13px] font-medium text-[#555] w-16 flex-shrink-0">{to12h(appt.scheduled_time)}</div>
                    <div className="flex-1 min-w-0">
                      <div className={`font-display text-[15px] font-medium ${isExpanded ? 'text-[#3C3489]' : 'text-[#1A1A2E]'}`}>{appt.visit_type}</div>
                      <div className="text-[12px] text-[#555] mt-0.5">{appt.zone}{appt.duration_minutes && appt.duration_minutes > 60 ? ` · ${appt.duration_minutes} min` : ''}</div>
                    </div>
                    <Badge color={vt?.badge_color} textColor={vt?.badge_text_color}>{vt?.badge_label || appt.visit_type}</Badge>
                    {appt.status === 'done' && <Badge variant="teal">Completed</Badge>}
                    {appt.status === 'in-progress' && <Badge variant="purple">In progress</Badge>}
                    <ChevronDown size={14} className={`text-[#999] transition-transform flex-shrink-0 ${isExpanded ? 'rotate-180' : ''}`} />
                  </div>

                  {isExpanded && (
                    <div className="px-4 pb-4 border-t border-[#AFA9EC]/40 pt-3" onClick={e => e.stopPropagation()}>
                      {(() => {
                        const chargedCentsMatch = appt.notes?.match(/CHARGED_CENTS:(\d+)/)
                        const chargedCents = chargedCentsMatch ? parseInt(chargedCentsMatch[1]) : null
                        return (
                          <div className="flex gap-2 flex-wrap mb-3">
                            {appt.status !== 'done' && appt.status !== 'cancelled' ? (
                              <Button variant="teal" size="sm" onClick={() => { setDoneTarget(appt); setDoneInstructions('') }}>
                                <CheckCircle2 size={13} /> Mark complete
                              </Button>
                            ) : appt.status === 'done' ? (
                              <Badge variant="teal">Visit completed</Badge>
                            ) : null}
                            <Button variant="secondary" size="sm" onClick={() => { setNoteTarget(appt); setNoteText((provider as any)?.secure_text_number ? `\n\nIf you have questions, you can reach me securely at ${(provider as any).secure_text_number}.` : ''); setNoteSent(false) }}>
                              Send note
                            </Button>
                            <Button variant="secondary" size="sm" onClick={() => openChartNote(appt)}>
                              <FileText size={13} /> Chart note
                            </Button>
                            {appt.status !== 'cancelled' && (
                              chargedCents != null ? (
                                <span className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-[#E1F5EE] text-[#1D9E75] text-[12px] font-medium border border-[#1D9E75]/20">
                                  <CreditCard size={12} /> Charged ${(chargedCents / 100).toFixed(2)}
                                </span>
                              ) : (
                                <Button variant="secondary" size="sm" onClick={() => { setChargeTarget(appt); setChargeAmountStr(''); setChargeError(null); setChargeSuccess(null) }}>
                                  <CreditCard size={13} /> Charge card
                                </Button>
                              )
                            )}
                            {appt.visit_type === 'Video telemedicine' && appt.status !== 'cancelled' && (
                              <Button variant="secondary" size="sm" onClick={() => window.open('https://doxy.me/v2/account/dashboard', '_blank')}>
                                <Video size={13} /> Start video visit
                              </Button>
                            )}
                            {appt.status !== 'cancelled' && appt.status !== 'done' && (
                              <Button variant="danger" size="sm" onClick={() => setCancelTarget(appt)}>
                                <X size={13} /> Cancel visit
                              </Button>
                            )}
                            {appt.status === 'cancelled' && <Badge variant="amber">Cancelled</Badge>}
                          </div>
                        )
                      })()}
                      {(() => {
                        const NOTE_LABELS: Record<string, string> = {
                          PATIENT: 'Patient name', DOB: 'Date of birth',
                          CC: 'Chief complaint', NOTES: 'Additional notes',
                          ALLERGY: 'Allergies', MEDS: 'Medications', PMH: 'Medical history',
                          VAX: 'Vaccination status', PCP: 'Primary care physician',
                          PHARMACY: 'Preferred pharmacy', INSURANCE: 'Insurance',
                          MEMBERID: 'Member ID', GROUPNUM: 'Group #',
                          SUBSCRIBER: 'Subscriber name', SUBSCRIBERDOB: 'Subscriber DOB', SUBSCRIBERGENDER: 'Subscriber sex',
                          CHILDREN: 'Children seen', PARENTEMAIL: 'Parent email',
                          PARENTPHONE: 'Parent phone', GENDER: 'Sex',
                          CARDFRONT: 'Insurance card front', CARDBACK: 'Insurance card back',
                        }

                        // Always parse clinical data from notes — no API needed
                        const noteMap: Record<string, string> = {}
                        ;(appt.notes || '').split('|').forEach((part: string) => {
                          const colon = part.indexOf(':')
                          if (colon > 0) {
                            const k = part.slice(0, colon).trim()
                            const v = part.slice(colon + 1).trim()
                            if (!['Ref', 'ADDR'].includes(k) && v) noteMap[k] = v
                          }
                        })

                        const cd = charmDetails[appt.id]
                        const p = cd?.patient || {}

                        return (
                          <div className="mb-3 space-y-2">
                            {/* Patient demographics from Charm */}
                            {cd && !cd.notFound && (
                              <div className="bg-[#FAFAF8] border border-[#E8E8E4] rounded-lg p-3 space-y-1.5">
                                <div className="text-[10px] font-semibold text-[#7F77DD] uppercase tracking-wider mb-2">Patient</div>
                                {p.first_name && <div className="text-[13px]"><span className="text-[#999] text-[11px]">Name </span><strong>{p.first_name} {p.last_name}</strong></div>}
                                {p.dob && <div className="text-[13px]"><span className="text-[#999] text-[11px]">DOB </span>{p.dob}</div>}
                                {p.gender && <div className="text-[13px]"><span className="text-[#999] text-[11px]">Sex </span>{p.gender}</div>}
                                {p.phone && <div className="text-[13px]"><span className="text-[#999] text-[11px]">Phone </span>{p.phone}</div>}
                                {cd.allergies && <div className="text-[13px]"><span className="text-[#999] text-[11px]">Allergies </span>{cd.allergies}</div>}
                              </div>
                            )}
                            {/* Fallback: show patient info from notes when Charm hasn't synced */}
                            {cd?.notFound && noteMap.PATIENT && (
                              <div className="bg-[#FAFAF8] border border-[#E8E8E4] rounded-lg p-3 space-y-1.5">
                                <div className="text-[10px] font-semibold text-[#7F77DD] uppercase tracking-wider mb-2">Patient</div>
                                <div className="text-[13px]"><span className="text-[#999] text-[11px]">Name </span><strong>{noteMap.PATIENT}</strong></div>
                                {noteMap.DOB && <div className="text-[13px]"><span className="text-[#999] text-[11px]">DOB </span>{noteMap.DOB}</div>}
                              </div>
                            )}
                            {!cd && (
                              <div className="p-2 text-[11px] text-[#999] italic">Loading patient info…</div>
                            )}

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

                            {/* Clinical intake data from appointment notes — always shown */}
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
                                No intake data — this appointment was added manually or booked before intake tracking was enabled.
                              </div>
                            )}
                          </div>
                        )
                      })()}
                      <div className="grid grid-cols-2 gap-2 mb-3">
                        {[
                          { label: 'Visit type', value: appt.visit_type },
                          { label: 'Zone',       value: appt.zone },
                        ].map(d => (
                          <div key={d.label} className="bg-[#7F77DD]/6 rounded-lg p-2.5">
                            <div className="text-[10px] font-medium text-[#3C3489] uppercase tracking-wider mb-1">{d.label}</div>
                            <div className="text-[13px] text-[#1A1A2E]">{d.value}</div>
                          </div>
                        ))}
                        {(() => {
                          const addr = appt.notes?.split('|').find(p => p.startsWith('ADDR:'))?.replace('ADDR:', '')
                          return addr ? (
                            <div className="col-span-2 bg-[#7F77DD]/6 rounded-lg p-2.5">
                              <div className="text-[10px] font-medium text-[#3C3489] uppercase tracking-wider mb-1">Visit address</div>
                              <div className="flex items-center justify-between gap-2">
                                <div className="text-[13px] text-[#1A1A2E]">{addr}</div>
                                <a
                                  href={`https://maps.google.com/maps?daddr=${encodeURIComponent(addr)}`}
                                  target="_blank" rel="noopener noreferrer"
                                  onClick={e => e.stopPropagation()}
                                  className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-[#7F77DD] text-white text-[11px] font-medium hover:bg-[#534AB7] transition-colors flex-shrink-0">
                                  <Navigation size={11} /> Navigate
                                </a>
                              </div>
                            </div>
                          ) : null
                        })()}
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* ── Block time modal ── */}
      {blocking && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" onClick={() => !blockSubmitting && setBlocking(false)} />
          <div className="relative bg-white rounded-2xl shadow-xl w-full max-w-sm p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-display text-lg font-medium text-[#1A1A2E]">Block schedule</h2>
              <button onClick={() => setBlocking(false)} className="p-1.5 rounded-lg hover:bg-[#F1EFE8] text-[#999]">
                <X size={16} />
              </button>
            </div>

            {/* Single / Range toggle */}
            <div className="flex gap-1 p-1 bg-[#F1EFE8] rounded-lg mb-4">
              {(['single', 'range'] as const).map(mode => (
                <button key={mode}
                  onClick={() => setBlockForm(f => ({ ...f, mode, endDate: f.startDate }))}
                  className={`flex-1 py-1.5 text-[13px] font-medium rounded-md transition-all ${blockForm.mode === mode ? 'bg-white text-[#1A1A2E] shadow-sm' : 'text-[#555]'}`}>
                  {mode === 'single' ? 'Single day' : 'Date range'}
                </button>
              ))}
            </div>

            <div className="space-y-3 mb-5">
              {/* Date fields */}
              <div className={blockForm.mode === 'range' ? 'grid grid-cols-2 gap-2' : ''}>
                <div>
                  <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-1">
                    {blockForm.mode === 'range' ? 'Start date' : 'Date'}
                  </label>
                  <input type="date" value={blockForm.startDate}
                    onChange={e => setBlockForm(f => ({ ...f, startDate: e.target.value, endDate: f.mode === 'single' ? e.target.value : (f.endDate < e.target.value ? e.target.value : f.endDate) }))}
                    className="w-full px-3 py-2.5 border border-[#E8E8E4] rounded-lg text-[14px] font-sans outline-none focus:border-[#7F77DD]" />
                </div>
                {blockForm.mode === 'range' && (
                  <div>
                    <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-1">End date</label>
                    <input type="date" value={blockForm.endDate} min={blockForm.startDate}
                      onChange={e => setBlockForm(f => ({ ...f, endDate: e.target.value }))}
                      className="w-full px-3 py-2.5 border border-[#E8E8E4] rounded-lg text-[14px] font-sans outline-none focus:border-[#7F77DD]" />
                  </div>
                )}
              </div>

              {/* All-day toggle */}
              <div className="flex items-center justify-between py-1">
                <span className="text-[13px] font-medium text-[#1A1A2E]">All day</span>
                <button
                  onClick={() => setBlockForm(f => ({ ...f, allDay: !f.allDay, startTime: '', endTime: '' }))}
                  className={`w-10 h-6 rounded-full transition-colors relative flex-shrink-0 ${blockForm.allDay ? 'bg-[#7F77DD]' : 'bg-[#D0D0CC]'}`}>
                  <span className={`absolute top-1 w-4 h-4 bg-white rounded-full shadow transition-transform ${blockForm.allDay ? 'translate-x-5' : 'translate-x-1'}`} />
                </button>
              </div>

              {/* Specific hours */}
              {!blockForm.allDay && (
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-1">Start time</label>
                    <select value={blockForm.startTime}
                      onChange={e => setBlockForm(f => ({ ...f, startTime: e.target.value, endTime: '' }))}
                      className="w-full px-3 py-2.5 border border-[#E8E8E4] rounded-lg text-[13px] font-sans outline-none focus:border-[#7F77DD] bg-white">
                      <option value="">Select</option>
                      {TIME_SLOTS.map(s => <option key={s} value={s}>{s}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-1">End time</label>
                    <select value={blockForm.endTime}
                      onChange={e => setBlockForm(f => ({ ...f, endTime: e.target.value }))}
                      className="w-full px-3 py-2.5 border border-[#E8E8E4] rounded-lg text-[13px] font-sans outline-none focus:border-[#7F77DD] bg-white"
                      disabled={!blockForm.startTime}>
                      <option value="">Select</option>
                      {endTimeOptions.map(s => <option key={s} value={s}>{s}</option>)}
                    </select>
                  </div>
                </div>
              )}

              {/* Reason */}
              <div>
                <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-1">
                  Reason <span className="text-[#999] normal-case font-normal">(optional)</span>
                </label>
                <input type="text" value={blockForm.reason}
                  placeholder="e.g. Personal time off, School event, Family obligation"
                  onChange={e => setBlockForm(f => ({ ...f, reason: e.target.value }))}
                  className="w-full px-3 py-2.5 border border-[#E8E8E4] rounded-lg text-[14px] font-sans outline-none focus:border-[#7F77DD]" />
              </div>
            </div>

            <div className="flex gap-2">
              <Button variant="secondary" className="flex-1" onClick={() => setBlocking(false)}>Cancel</Button>
              <Button variant="primary" className="flex-1"
                disabled={!blockForm.startDate || (!blockForm.allDay && (!blockForm.startTime || !blockForm.endTime))}
                loading={blockSubmitting}
                onClick={submitBlock}>
                <Ban size={14} /> Block time
              </Button>
            </div>
          </div>
        </div>
      )}

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

      {/* ── Send note modal ── */}
      {noteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" onClick={() => !noteSending && setNoteTarget(null)} />
          <div className="relative bg-white rounded-2xl shadow-xl w-full max-w-sm p-6">
            <h2 className="font-display text-lg font-medium text-[#1A1A2E] mb-1">Send a note to parent</h2>
            <p className="text-[12px] text-[#999] mb-4">{noteTarget.visit_type} · {format(new Date(noteTarget.scheduled_date + 'T12:00:00'), 'MMM d')} at {to12h(noteTarget.scheduled_time)}</p>
            {noteSent ? (
              <div className="text-center py-4 text-[#1D9E75] font-medium">Note sent!</div>
            ) : (
              <>
                <textarea
                  className="w-full border border-[#E8E8E4] rounded-lg p-3 text-[13px] text-[#1A1A2E] placeholder:text-[#bbb] resize-none focus:outline-none focus:ring-2 focus:ring-[#1D9E75]/30 focus:border-[#1D9E75]"
                  rows={5}
                  placeholder="Type your message to the parent here..."
                  value={noteText}
                  onChange={e => setNoteText(e.target.value)}
                  autoFocus
                />
                <div className="flex gap-2 mt-3">
                  <Button variant="secondary" className="flex-1" onClick={() => setNoteTarget(null)} disabled={noteSending}>Cancel</Button>
                  <Button variant="primary" className="flex-1" loading={noteSending} onClick={submitNote} disabled={!noteText.trim()}>Send note</Button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* ── Cancel appointment modal ── */}
      {cancelTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" onClick={() => !cancelling && setCancelTarget(null)} />
          <div className="relative bg-white rounded-2xl shadow-xl w-full max-w-sm p-6">
            <div className="flex items-center gap-3 mb-3">
              <div className="w-10 h-10 rounded-full bg-[#FCEBEB] flex items-center justify-center flex-shrink-0">
                <AlertTriangle size={18} className="text-[#791F1F]" />
              </div>
              <h2 className="font-display text-lg font-medium text-[#1A1A2E]">Cancel this visit?</h2>
            </div>

            <div className="p-3 bg-[#FAFAF8] border border-[#E8E8E4] rounded-lg text-[13px] text-[#555] mb-3 space-y-1">
              <div className="font-medium text-[#1A1A2E]">{cancelTarget.visit_type}</div>
              <div className="text-[#999]">
                {format(new Date(cancelTarget.scheduled_date + 'T12:00:00'), 'EEEE, MMMM d')} at {to12h(cancelTarget.scheduled_time)}
              </div>
              <div className="text-[#999]">{cancelTarget.zone}</div>
            </div>

            <div className="p-3 bg-[#E1F5EE] border border-[#9FDECA] rounded-lg text-[12px] text-[#085041] mb-5 leading-relaxed">
              Any families on the waitlist in the <strong>{cancelTarget.zone}</strong> area will automatically
              receive an email and text letting them know this slot has opened up.
            </div>

            <div className="flex gap-2">
              <Button variant="secondary" className="flex-1" onClick={() => setCancelTarget(null)} disabled={cancelling}>Keep visit</Button>
              <Button variant="danger" className="flex-1" loading={cancelling} onClick={confirmCancel}>Cancel visit</Button>
            </div>
          </div>
        </div>
      )}

      {/* ── Add appointment modal ── */}
      {adding && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" onClick={() => setAdding(false)} />
          <div className="relative bg-white rounded-2xl shadow-xl w-full max-w-sm p-6 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-display text-lg font-medium text-[#1A1A2E]">Add appointment</h2>
              <button onClick={() => setAdding(false)} className="p-1.5 rounded-lg hover:bg-[#F1EFE8] text-[#999]">
                <X size={16} />
              </button>
            </div>

            <div className="space-y-3 mb-5">

              {allProviders.length > 0 && (
                <div>
                  <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-1">Assign to provider</label>
                  <select value={addForProviderId} onChange={e => setAddForProviderId(e.target.value)}
                    className="w-full px-3 py-2.5 border border-[#E8E8E4] rounded-lg text-[14px] font-sans bg-white outline-none focus:border-[#7F77DD]">
                    {allProviders.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                </div>
              )}

              <div className="text-[10px] font-semibold text-[#7F77DD] uppercase tracking-wider pt-1">Patient information</div>

              {/* Patient search */}
              <div className="relative">
                <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-1">Search existing patient</label>
                {selectedPatient ? (
                  <div className="flex items-center justify-between px-3 py-2.5 border border-[#1D9E75] rounded-lg bg-[#F0FAF6]">
                    <div>
                      <div className="text-[13px] font-medium text-[#1A1A2E]">
                        {[selectedPatient.first_name, selectedPatient.last_name].filter(Boolean).join(' ') || selectedPatient.display_label}
                      </div>
                      {selectedPatient.family_display_name && (
                        <div className="text-[11px] text-[#999]">{selectedPatient.family_display_name}</div>
                      )}
                    </div>
                    <button onClick={() => { setSelectedPatient(null); setAddForm(f => ({ ...f, patientName: '', dob: '', gender: '', phone: '', email: '', address: '', zip: '', zone: '' })) }}
                      className="text-[11px] text-[#999] hover:text-[#1A1A2E] ml-2">× Clear</button>
                  </div>
                ) : (
                  <>
                    <input type="text" placeholder="Type a child's name…" value={patientSearch}
                      onChange={e => onPatientSearchChange(e.target.value)}
                      className="w-full px-3 py-2.5 border border-[#E8E8E4] rounded-lg text-[14px] font-sans outline-none focus:border-[#7F77DD]" />
                    {patientSearching && (
                      <div className="mt-1 px-3 py-2 text-[12px] text-[#999]">Searching…</div>
                    )}
                    {!patientSearching && patientSearch.trim() && patientResults.length === 0 && (
                      <div className="mt-1 px-3 py-2 text-[12px] text-[#999]">No patients found</div>
                    )}
                    {!patientSearching && patientResults.length > 0 && (
                      <div className="mt-1 border border-[#E8E8E4] rounded-xl overflow-hidden">
                        {patientResults.map(child => (
                          <button key={child.id} onClick={() => selectPatient(child)}
                            className="w-full text-left px-3 py-2.5 hover:bg-[#FAFAF8] border-b border-[#F1EFE8] last:border-0">
                            <div className="text-[13px] font-medium text-[#1A1A2E]">
                              {[child.first_name, child.last_name].filter(Boolean).join(' ') || child.display_label}
                            </div>
                            <div className="text-[11px] text-[#999]">
                              {child.family_display_name || child.family_email || ''}
                              {child.date_of_birth ? ` · DOB ${String(child.date_of_birth instanceof Date ? child.date_of_birth.toISOString() : child.date_of_birth).split('T')[0]}` : ''}
                            </div>
                          </button>
                        ))}
                      </div>
                    )}
                  </>
                )}
              </div>

              <div>
                <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-1">Patient name</label>
                <input type="text" placeholder="First and last name" value={addForm.patientName}
                  onChange={e => setAddForm(f => ({ ...f, patientName: e.target.value }))}
                  className="w-full px-3 py-2.5 border border-[#E8E8E4] rounded-lg text-[14px] font-sans outline-none focus:border-[#7F77DD]" />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-1">Date of birth</label>
                  <input type="text" placeholder="MM-DD-YYYY" value={addForm.dob}
                    onChange={e => setAddForm(f => ({ ...f, dob: e.target.value }))}
                    className="w-full px-3 py-2.5 border border-[#E8E8E4] rounded-lg text-[14px] font-sans outline-none focus:border-[#7F77DD]" />
                </div>
                <div>
                  <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-1">Sex</label>
                  <select value={addForm.gender} onChange={e => setAddForm(f => ({ ...f, gender: e.target.value }))}
                    className="w-full px-3 py-2.5 border border-[#E8E8E4] rounded-lg text-[14px] font-sans outline-none focus:border-[#7F77DD] bg-white">
                    <option value="">Select…</option>
                    <option value="Male">Male</option>
                    <option value="Female">Female</option>
                    <option value="Other">Other</option>
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-1">Phone</label>
                  <input type="tel" placeholder="(704) 555-1234" value={addForm.phone}
                    onChange={e => setAddForm(f => ({ ...f, phone: e.target.value }))}
                    className="w-full px-3 py-2.5 border border-[#E8E8E4] rounded-lg text-[14px] font-sans outline-none focus:border-[#7F77DD]" />
                </div>
                <div>
                  <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-1">Email</label>
                  <input type="email" placeholder="parent@email.com" value={addForm.email}
                    onChange={e => setAddForm(f => ({ ...f, email: e.target.value }))}
                    className="w-full px-3 py-2.5 border border-[#E8E8E4] rounded-lg text-[14px] font-sans outline-none focus:border-[#7F77DD]" />
                </div>
              </div>

              <div className="text-[10px] font-semibold text-[#7F77DD] uppercase tracking-wider pt-1">Insurance</div>

              <div>
                <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-1">Insurance payer</label>
                <input type="text" placeholder="BlueCross BlueShield" value={addForm.insurancePayer}
                  onChange={e => setAddForm(f => ({ ...f, insurancePayer: e.target.value }))}
                  className="w-full px-3 py-2.5 border border-[#E8E8E4] rounded-lg text-[14px] font-sans outline-none focus:border-[#7F77DD]" />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-1">Member ID</label>
                  <input type="text" placeholder="XYZ123456" value={addForm.insuranceMemberId}
                    onChange={e => setAddForm(f => ({ ...f, insuranceMemberId: e.target.value }))}
                    className="w-full px-3 py-2.5 border border-[#E8E8E4] rounded-lg text-[14px] font-sans outline-none focus:border-[#7F77DD]" />
                </div>
                <div>
                  <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-1">Group #</label>
                  <input type="text" placeholder="GRP001" value={addForm.insuranceGroup}
                    onChange={e => setAddForm(f => ({ ...f, insuranceGroup: e.target.value }))}
                    className="w-full px-3 py-2.5 border border-[#E8E8E4] rounded-lg text-[14px] font-sans outline-none focus:border-[#7F77DD]" />
                </div>
              </div>

              <div>
                <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-1">Subscriber name</label>
                <input type="text" placeholder="John Smith" value={addForm.subscriberName}
                  onChange={e => setAddForm(f => ({ ...f, subscriberName: e.target.value }))}
                  className="w-full px-3 py-2.5 border border-[#E8E8E4] rounded-lg text-[14px] font-sans outline-none focus:border-[#7F77DD]" />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-1">Subscriber DOB</label>
                  <input type="date" value={addForm.subscriberDob}
                    onChange={e => setAddForm(f => ({ ...f, subscriberDob: e.target.value }))}
                    className="w-full px-3 py-2.5 border border-[#E8E8E4] rounded-lg text-[14px] font-sans outline-none focus:border-[#7F77DD]" />
                </div>
                <div>
                  <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-1">Subscriber sex</label>
                  <select value={addForm.subscriberGender} onChange={e => setAddForm(f => ({ ...f, subscriberGender: e.target.value }))}
                    className="w-full px-3 py-2.5 border border-[#E8E8E4] rounded-lg text-[14px] font-sans outline-none focus:border-[#7F77DD] bg-white">
                    <option value="">Select…</option>
                    <option value="Male">Male</option>
                    <option value="Female">Female</option>
                    <option value="Other">Other</option>
                  </select>
                </div>
              </div>

              <div className="text-[10px] font-semibold text-[#7F77DD] uppercase tracking-wider pt-1">Appointment details</div>

              <div>
                <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-1">Visit type</label>
                <select value={addForm.visitType}
                  onChange={e => setAddForm(f => ({ ...f, visitType: e.target.value }))}
                  className="w-full px-3 py-2.5 border border-[#E8E8E4] rounded-lg text-[14px] font-sans outline-none focus:border-[#7F77DD] bg-white">
                  {visitTypes.map(vt => <option key={vt.visit_type} value={vt.visit_type}>{vt.visit_type}</option>)}
                </select>
              </div>

              <div>
                <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-1">Visit address</label>
                <input type="text" placeholder="123 Main St, Charlotte, NC" value={addForm.address}
                  onChange={e => setAddForm(f => ({ ...f, address: e.target.value }))}
                  className="w-full px-3 py-2.5 border border-[#E8E8E4] rounded-lg text-[14px] font-sans outline-none focus:border-[#7F77DD]" />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-1">Zip code</label>
                  <input type="text" placeholder="28277" maxLength={5} value={addForm.zip}
                    onChange={e => {
                      const zip = e.target.value
                      const detectedZone = zip.length === 5 ? (zipToZone[zip] || '') : ''
                      setAddForm(f => ({ ...f, zip, zone: detectedZone || f.zone }))
                    }}
                    className="w-full px-3 py-2.5 border border-[#E8E8E4] rounded-lg text-[14px] font-sans outline-none focus:border-[#7F77DD]" />
                </div>
                <div>
                  <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-1">
                    Zone {addForm.zip.length === 5 && zipToZone[addForm.zip] && <span className="text-[#1D9E75] normal-case font-normal">· auto-detected</span>}
                  </label>
                  <input type="text" placeholder="e.g. SouthPark" value={addForm.zone}
                    onChange={e => setAddForm(f => ({ ...f, zone: e.target.value }))}
                    className="w-full px-3 py-2.5 border border-[#E8E8E4] rounded-lg text-[14px] font-sans outline-none focus:border-[#7F77DD]" />
                </div>
              </div>

              <div>
                <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-1">Date</label>
                <input type="date" value={addForm.date}
                  onChange={e => setAddForm(f => ({ ...f, date: e.target.value }))}
                  className="w-full px-3 py-2.5 border border-[#E8E8E4] rounded-lg text-[14px] font-sans outline-none focus:border-[#7F77DD]" />
              </div>

              <div>
                <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-1">Time</label>
                <div className="grid grid-cols-4 gap-1.5 mb-1.5">
                  {TIME_SLOTS.map(slot => (
                    <button key={slot} type="button" onClick={() => { setAddForm(f => ({ ...f, time: slot })); setAddCustomTime('') }}
                      className={`py-1.5 text-center text-[12px] rounded-lg border-2 transition-all font-sans ${addForm.time === slot ? 'bg-[#7F77DD] border-[#7F77DD] text-white' : 'border-[#E8E8E4] bg-white hover:border-[#AFA9EC] text-[#1A1A2E]'}`}>
                      {slot}
                    </button>
                  ))}
                  <button type="button" onClick={() => setAddForm(f => ({ ...f, time: '__custom__' }))}
                    className={`py-1.5 text-center text-[12px] rounded-lg border-2 transition-all font-sans col-span-2 ${addForm.time === '__custom__' ? 'bg-[#7F77DD] border-[#7F77DD] text-white' : 'border-[#E8E8E4] bg-white hover:border-[#AFA9EC] text-[#1A1A2E]'}`}>
                    Custom time…
                  </button>
                </div>
                {addForm.time === '__custom__' && (
                  <input type="text" autoFocus value={addCustomTime} onChange={e => setAddCustomTime(e.target.value)}
                    placeholder="e.g. 6:30 PM"
                    className="w-full px-3 py-2 border border-[#7F77DD] rounded-lg text-[14px] font-sans outline-none mt-1" />
                )}
              </div>

              <div>
                <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-1">Notes <span className="text-[#999] normal-case font-normal">(optional)</span></label>
                <textarea rows={2} placeholder="e.g. Parent texted directly, 2 children" value={addForm.notes}
                  onChange={e => setAddForm(f => ({ ...f, notes: e.target.value }))}
                  className="w-full px-3 py-2.5 border border-[#E8E8E4] rounded-lg text-[14px] font-sans outline-none focus:border-[#7F77DD] resize-none" />
              </div>
            </div>

            <div className="flex gap-2">
              <Button variant="secondary" className="flex-1" onClick={() => setAdding(false)}>Cancel</Button>
              <Button variant="teal" className="flex-1" disabled={!addForm.date || !(addForm.time === '__custom__' ? addCustomTime : addForm.time)} loading={addSubmitting} onClick={submitAdd}>
                <CheckCircle2 size={14} /> Add to schedule
              </Button>
            </div>
          </div>
        </div>
      )}
      {/* ── Chart note modal ── */}
      {noteModalAppt && (
        <EncounterNoteModal
          appointment={noteModalAppt}
          childId={noteModalChildId}
          providerId={provider.id}
          onClose={() => setNoteModalAppt(null)}
        />
      )}

      {/* ── Charge card modal ── */}
      {chargeTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" onClick={() => !chargeSubmitting && setChargeTarget(null)} />
          <div className="relative bg-white rounded-2xl shadow-xl w-full max-w-sm p-6">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-full bg-[#EEEDFE] flex items-center justify-center flex-shrink-0">
                <CreditCard size={18} className="text-[#7F77DD]" />
              </div>
              <h2 className="font-display text-lg font-medium text-[#1A1A2E]">Charge card on file</h2>
            </div>

            <div className="p-3 bg-[#FAFAF8] border border-[#E8E8E4] rounded-lg text-[13px] mb-4 space-y-0.5">
              <div className="font-medium text-[#1A1A2E]">{chargeTarget.visit_type}</div>
              <div className="text-[#999]">{chargeTarget.zone}</div>
            </div>

            {chargeSuccess ? (
              <div className="text-center py-4">
                <div className="text-[#1D9E75] font-medium text-[15px]">Payment successful!</div>
                <div className="text-[13px] text-[#999] mt-1">
                  ${(chargeSuccess.amount / 100).toFixed(2)} charged{chargeSuccess.last4 ? ` to card ending in ${chargeSuccess.last4}` : ''}
                </div>
              </div>
            ) : (
              <>
                <div className="mb-4">
                  <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-1.5">Amount to charge</label>
                  <div className="relative">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-[#555] text-[15px]">$</span>
                    <input
                      type="number"
                      min="0.50"
                      step="0.01"
                      placeholder="0.00"
                      value={chargeAmountStr}
                      onChange={e => { setChargeAmountStr(e.target.value); setChargeError(null) }}
                      className="w-full pl-7 pr-3 py-2.5 border border-[#E8E8E4] rounded-lg text-[16px] font-sans outline-none focus:border-[#7F77DD]"
                      autoFocus
                    />
                  </div>
                  {chargeError && (
                    <p className="text-[12px] text-red-500 mt-1">{chargeError}</p>
                  )}
                </div>

                <div className="flex gap-2">
                  <Button variant="secondary" className="flex-1" onClick={() => setChargeTarget(null)} disabled={chargeSubmitting}>Cancel</Button>
                  <Button variant="primary" className="flex-1" loading={chargeSubmitting}
                    disabled={!chargeAmountStr || parseFloat(chargeAmountStr) < 0.5}
                    onClick={submitCharge}>
                    <CreditCard size={14} /> Charge ${chargeAmountStr ? parseFloat(chargeAmountStr).toFixed(2) : '0.00'}
                  </Button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
