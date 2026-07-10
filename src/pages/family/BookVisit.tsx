import { useState, useRef, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { ChevronLeft, Check, Plus, User, Upload, X, Camera } from 'lucide-react'
import {
  getProviderByName,
  getProvidersByRole,
  getProvidersByNamesWithSecureText,
  getSchedulingData,
  familyCreateAppointment,
  familyCreateBookingRequest,
  familyCreateWaitlistEntry,
  createChild,
  updateMyFamily,
  updateChild,
  familyInvokeNotifications,
  invokeCharmAppointment,
} from '../../lib/api'
import { useFamilyAuth } from '../../contexts/FamilyAuthContext'
import { getFamilyAccessToken } from '../../contexts/FamilyAuthContext'
import { Button } from '../../components/ui/Button'
import { Input } from '../../components/ui/Input'
import { VISIT_TYPE_INFO, TIME_SLOTS } from '../../lib/zipData'
import { usePracticeZones } from '../../hooks/usePracticeZones'
import { getProvidersByZone, getProvidersByState } from '../../lib/api'
import { usePracticeVisitTypes } from '../../hooks/usePracticeVisitTypes'
import { format } from 'date-fns'
import { PRACTICE_NAME, VENMO_HANDLE } from '../../lib/practice'

// ─── Types ────────────────────────────────────────────────────────────────────

const STEPS_DEFAULT = ['Who & visit type', 'About each child', 'When & where', 'Confirm']
const STEPS_IV      = ['Who & visit type', 'About each child', 'IV Fluids screening', 'When & where', 'Confirm']
const STEPS_CPR     = ['Visit type', 'Participants', 'When & where', 'Confirm']

interface ChildIntake {
  childId: string
  displayLabel: string
  hasProfile: boolean
  cardOnFile: boolean
  // Profile fields (first booking only — saved to Charm)
  firstName: string
  lastName: string
  dateOfBirth: string
  gender: string
  insuranceProvider: string
  insuranceMemberId: string
  insuranceGroupNumber: string
  insuranceSubscriberName: string
  insuranceSubscriberDob: string
  insuranceSubscriberGender: string
  insuranceCardFrontUrl: string
  insuranceCardBackUrl: string
  selfPay: boolean
  allergies: string
  currentMedications: string
  medicalHistory: string
  preferredPharmacy: string
  pcp: string
  vaccinationStatus: string
  phiSharingConsent: boolean
  // Per-appointment (every booking)
  chiefComplaint: string
  additionalInfo: string
  textVisitPhotos: string[]
}


function getAvailableSlots(leadMin: number, date: string): string[] {
  const today = new Date().toISOString().split('T')[0]
  if (date !== today) return TIME_SLOTS

  const cutoff = new Date(Date.now() + leadMin * 60_000)

  return TIME_SLOTS.filter(slot => {
    const [t, ampm] = slot.split(' ')
    let [h, m] = t.split(':').map(Number)
    if (ampm === 'PM' && h !== 12) h += 12
    if (ampm === 'AM' && h === 12) h = 0
    const slotTime = new Date()
    slotTime.setHours(h, m, 0, 0)
    return slotTime > cutoff
  })
}

interface IvFluidsIntake {
  weight: string
  symptomOnset: string
  symptoms: string
  fluidIntake: string
  oralRehydration: string
  lastUrination: string
  diarrhea: string
  vomiting: string
  activityLevel: string
  mouthDryness: string
  tears: string
  hasFever: string
  highestTemp: string
  redFlags: string[]
  otherConditions: string
  recentIvFluids: string
  consentUnderstood: boolean
  availableTimes: string
}

interface BookingState {
  visitType: string
  selectedChildIds: string[]
  childIntakes: Record<string, ChildIntake>
  activeChildTab: string
  ivFluidsIntake: IvFluidsIntake
  zip: string
  state: string
  zone: string
  provider: string
  visitAddress: string
  date: string
  time: string
  participantCount: number
  participantNames: string
}

const RED_FLAGS = [
  'Severe belly pain',
  'Stiff neck',
  'Trouble breathing',
  'Confusion',
  'Severe relentless headache',
  'Bloody vomit or stool',
  'Blue lips or skin',
  'Seizures',
  'Diabetes',
  'Known kidney disease',
  'None of the above',
]

function emptyIvFluids(): IvFluidsIntake {
  return {
    weight: '', symptomOnset: '', symptoms: '', fluidIntake: '',
    oralRehydration: '', lastUrination: '', diarrhea: '',
    vomiting: '', activityLevel: '', mouthDryness: '',
    tears: '', hasFever: '', highestTemp: '',
    redFlags: [], otherConditions: '', recentIvFluids: '',
    consentUnderstood: false, availableTimes: '',
  }
}


const VAX_OPTIONS = [
  { value: 'fully_vaccinated', label: 'Fully vaccinated to date', desc: 'Following the CDC/AAP recommended schedule' },
  { value: 'delayed',          label: 'Delayed or alternative schedule', desc: 'Modified timeline or selected vaccines' },
  { value: 'unvaccinated',     label: 'We do not vaccinate', desc: 'This child has not received vaccines' },
]

function to24hr(time: string) {
  const [t, ampm] = time.split(' ')
  let [h, m] = t.split(':').map(Number)
  if (ampm === 'PM' && h !== 12) h += 12
  if (ampm === 'AM' && h === 12) h = 0
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`
}

function emptyIntake(childId: string, displayLabel: string, hasProfile: boolean, child?: import('../../../src/types/family').Child): ChildIntake {
  return {
    childId, displayLabel, hasProfile,
    cardOnFile: !!(child?.insurance_card_front_url && child?.insurance_card_back_url),
    firstName: child?.first_name || '', lastName: child?.last_name || '', dateOfBirth: child?.date_of_birth || '', gender: '',
    insuranceProvider: child?.insurance_provider || '',
    insuranceMemberId: child?.insurance_member_id || '',
    insuranceGroupNumber: child?.insurance_group_number || '',
    insuranceSubscriberName: '', insuranceSubscriberDob: '', insuranceSubscriberGender: '',
    insuranceCardFrontUrl: child?.insurance_card_front_url || '',
    insuranceCardBackUrl: child?.insurance_card_back_url || '',
    selfPay: false,
    allergies: child?.allergies || 'NKDA', currentMedications: child?.current_medications || 'None',
    medicalHistory: child?.medical_history || '', preferredPharmacy: child?.preferred_pharmacy || '',
    pcp: child?.pcp || '', vaccinationStatus: 'fully_vaccinated',
    phiSharingConsent: false,
    chiefComplaint: '', additionalInfo: '', textVisitPhotos: [],
  }
}

// ─── Main component ────────────────────────────────────────────────────────────

export function BookVisit() {
  const { family, children, refreshFamily } = useFamilyAuth()
  const { zipToZone, zipToState, waitlistZones } = usePracticeZones()
  const { byType } = usePracticeVisitTypes()
  const navigate = useNavigate()
  const [step, setStep] = useState(0)
  const [booking, setBooking] = useState<BookingState>({
    visitType: '', selectedChildIds: [], childIntakes: {},
    activeChildTab: '', ivFluidsIntake: emptyIvFluids(),
    zip: family?.zip || '', state: family?.state || zipToState[family?.zip || ''] || '',
    zone: zipToZone[family?.zip || ''] || '', provider: '', visitAddress: '', date: '', time: '',
    participantCount: 1, participantNames: '',
  })

  const isIvFluids = booking.visitType === 'In-home IV fluids'
  const isCpr = byType[booking.visitType]?.is_cpr ?? false
  const STEPS = isIvFluids ? STEPS_IV : isCpr ? STEPS_CPR : STEPS_DEFAULT

  // Logical step indices adjust when IV fluids step is inserted
  const STEP_INTAKE   = 1
  const STEP_IV       = 2
  const STEP_LOCATION = isIvFluids ? 3 : 2
  const STEP_CONFIRM  = isIvFluids ? 4 : 3
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [confirmed, setConfirmed] = useState<string | null>(null)
  const [referralSource, setReferralSource] = useState('')
  const [agreementsAccepted, setAgreementsAccepted] = useState(false)
  const needsAgreements = !(family as any)?.agreements_accepted_at
  const [paymentPolicyAccepted, setPaymentPolicyAccepted] = useState(false)
  const needsPaymentPolicy = !(family as any)?.payment_policy_accepted_at
  const [convFee, setConvFee] = useState<{ fee: number; code: string; basis: string } | null>(null)
  const [convFeeLoading, setConvFeeLoading] = useState(false)
  const [waitlistOpen, setWaitlistOpen] = useState(false)
  const [waitlistDone, setWaitlistDone] = useState(false)
  const [waitlistTime, setWaitlistTime] = useState('')
  const [waitlistNotes, setWaitlistNotes] = useState('')
  const [waitlistComplaint, setWaitlistComplaint] = useState('')
  const [waitlistChildId, setWaitlistChildId] = useState('')
  const [waitlistPatient, setWaitlistPatient] = useState('')
  const [waitlistDOB, setWaitlistDOB] = useState('')
  const [waitlistPhone, setWaitlistPhone] = useState('')
  const [waitlistAddress, setWaitlistAddress] = useState('')
  const [waitlistAllergies, setWaitlistAllergies] = useState('')
  const [waitlistMedications, setWaitlistMedications] = useState('')
  const [waitlistPMH, setWaitlistPMH] = useState('')
  const [waitlistPCP, setWaitlistPCP] = useState('')
  const [waitlistPharmacy, setWaitlistPharmacy] = useState('')
  const [waitlistInsurance, setWaitlistInsurance] = useState('')
  const [waitlistInsuranceMemberId, setWaitlistInsuranceMemberId] = useState('')
  const [waitlistInsuranceGroupNum, setWaitlistInsuranceGroupNum] = useState('')
  const [waitlistInsuranceSubscriber, setWaitlistInsuranceSubscriber] = useState('')
  const [waitlistSubmitting, setWaitlistSubmitting] = useState(false)
  const [secureTextProviders, setSecureTextProviders] = useState<{name: string; role: string; secure_text_number: string}[]>([])
  const [addingChild, setAddingChild] = useState(false)
  const [bookedSlots, setBookedSlots] = useState<{ time: string; duration: number }[]>([])
  const [allSlotsBooked, setAllSlotsBooked] = useState(false)
  const [slotsChecking, setSlotsChecking] = useState(false)
  const [visitTypeWindow, setVisitTypeWindow] = useState<{ start: string; end: string } | null>(null)
  const [firstAvailResult, setFirstAvailResult] = useState<{ provider: string; time: string } | null>(null)
  const [findingFirstAvail, setFindingFirstAvail] = useState(false)
  const [cmaAvailResult, setCmaAvailResult] = useState<{ name: string; firstSlot: string } | null>(null)
  const [cmaProvidersForZone, setCmaProvidersForZone] = useState<{ name: string; role: string; initials: string; color: string; textColor: string }[]>([])
  const [regularZoneProviders, setRegularZoneProviders] = useState<{ name: string; role: string; initials: string; color: string; textColor: string }[]>([])
  const [ivZoneProviders, setIvZoneProviders] = useState<{ name: string; role: string; initials: string; color: string; textColor: string }[]>([])

  const isTelemedicine = (vt: string) => vt === 'Video telemedicine' || vt === 'Text visit'

  useEffect(() => {
    const isIv = booking.visitType === 'In-home IV fluids'
    const isCma = booking.visitType === 'CMA + telemedicine'
    const isTele = isTelemedicine(booking.visitType)
    if (isTele) {
      if (!booking.state) { setRegularZoneProviders([]); return }
      getProvidersByState(booking.state)
        .then(providers => setRegularZoneProviders(
          providers.map((p: any) => ({
            name: p.name, role: p.role, initials: p.initials,
            color: p.avatar_color, textColor: p.avatar_text_color,
          }))
        ))
        .catch(() => setRegularZoneProviders([]))
      return
    }
    if (!booking.zone) { setRegularZoneProviders([]); setIvZoneProviders([]); return }
    if (!isIv && !isCma) {
      getProvidersByZone(booking.zone)
        .then(providers => setRegularZoneProviders(
          providers
            .filter((p: any) => p.role !== 'RN' && p.role !== 'CMA')
            .map((p: any) => ({
              name: p.name, role: p.role, initials: p.initials,
              color: p.avatar_color, textColor: p.avatar_text_color,
            }))
        ))
        .catch(() => setRegularZoneProviders([]))
    }
    getProvidersByRole({ role: 'RN', is_active: 'true', zone: booking.zone })
      .then(providers => setIvZoneProviders(providers.map((p: any) => ({
        name: p.name, role: p.role, initials: p.initials,
        color: p.avatar_color || '#E1F5EE', textColor: p.avatar_text_color || '#085041',
      }))))
      .catch(() => setIvZoneProviders([]))
  }, [booking.zone, booking.state, booking.visitType])

  useEffect(() => {
    if (booking.provider === '__first_available__') {
      if (booking.date) findFirstAvailable(booking.date)
    } else if (booking.provider && booking.date) {
      loadBookedTimes(booking.provider, booking.date)
    }
  }, [booking.provider, booking.date])

  // Check CMA availability whenever no in-person slots exist on the selected date/zone
  useEffect(() => {
    setCmaAvailResult(null)
    if (!booking.date || !booking.zone || booking.visitType === 'CMA + telemedicine') return
    const noLeadSlots = getAvailableSlots(byType[booking.visitType]?.lead_minutes ?? 60, booking.date).length === 0
    if (noLeadSlots) findCmaAvailability(booking.date, booking.zone)
  }, [booking.date, booking.zone, booking.visitType])

  useEffect(() => {
    if (!allSlotsBooked || !booking.date || !booking.zone || booking.visitType === 'CMA + telemedicine') return
    findCmaAvailability(booking.date, booking.zone)
  }, [allSlotsBooked])

  useEffect(() => {
    if (step !== STEP_CONFIRM) return
    if (!(byType[booking.visitType]?.has_convenience_fee ?? true)) return
    const resolvedProvider = booking.provider === '__first_available__' ? firstAvailResult?.provider : booking.provider
    if (!resolvedProvider || !booking.visitAddress || !booking.date || !booking.time) return
    setConvFee(null)
    setConvFeeLoading(true)
    void (async () => {
      try {
        const prov = await getProviderByName(resolvedProvider)
        if (!prov) { setConvFeeLoading(false); return }
        const res = await fetch('/api/convenience-fee', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ providerId: prov.id, appointmentAddress: booking.visitAddress, date: booking.date, time: to24hr(booking.time), visitType: booking.visitType }),
        })
        const data = res.ok ? await res.json() : null
        if (data?.ok) setConvFee({ fee: data.fee, code: data.code, basis: data.basis })
      } catch { /* silent */ }
      setConvFeeLoading(false)
    })()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step])
  const [newChildLabel, setNewChildLabel] = useState('')

  // ─── Child selection ─────────────────────────────────────────────────────────

  function toggleChild(childId: string, displayLabel: string, hasProfile: boolean) {
    const isSelected = booking.selectedChildIds.includes(childId)
    const newIds = isSelected
      ? booking.selectedChildIds.filter(id => id !== childId)
      : [...booking.selectedChildIds, childId]

    const newIntakes = { ...booking.childIntakes }
    if (!isSelected && !newIntakes[childId]) {
      const child = children.find(c => c.id === childId)
      newIntakes[childId] = emptyIntake(childId, displayLabel, hasProfile, child)
    }

    setBooking(b => ({
      ...b,
      selectedChildIds: newIds,
      childIntakes: newIntakes,
      activeChildTab: newIds[0] || '',
    }))
  }

  async function addNewChild() {
    if (!newChildLabel.trim() || !family) return
    const data = await createChild({ display_label: newChildLabel.trim(), family_id: family.id }).catch(() => null)
    if (data) {
      await refreshFamily()
      toggleChild(data.id, data.display_label, false)
    }
    setNewChildLabel('')
    setAddingChild(false)
  }

  // ─── Intake field update ──────────────────────────────────────────────────────

  function setIntake(childId: string, field: keyof ChildIntake, value: string) {
    setBooking(b => ({
      ...b,
      childIntakes: {
        ...b.childIntakes,
        [childId]: { ...b.childIntakes[childId], [field]: value },
      },
    }))
  }

  function setIntakePhotos(childId: string, photos: string[]) {
    setBooking(b => ({
      ...b,
      childIntakes: {
        ...b.childIntakes,
        [childId]: { ...b.childIntakes[childId], textVisitPhotos: photos },
      },
    }))
  }

  // ─── Location ────────────────────────────────────────────────────────────────

  // Returns the provider's effective working window for a date, or null if they're off.
  // Checks day-of-week availability and date-specific overrides.
  async function getProviderDayWindow(providerId: string, date: string): Promise<{ start: string; end: string } | null> {
    const dayOfWeek = new Date(date + 'T12:00:00').getDay()
    const sched = await getSchedulingData(providerId, { date })
    const dayAvail = sched?.availability
    const override = sched?.override
    if (override) {
      if (!override.is_available) return null
      return { start: override.start_time || dayAvail?.start_time || '08:00', end: override.end_time || dayAvail?.end_time || '17:00' }
    }
    if (!dayAvail) {
      // No schedule row → weekends off by default, weekdays on
      return (dayOfWeek === 0 || dayOfWeek === 6) ? null : { start: '08:00', end: '17:00' }
    }
    if (!dayAvail.is_active) return null
    return { start: dayAvail.start_time, end: dayAvail.end_time }
  }

  async function loadBookedTimes(providerName: string, date: string) {
    if (!providerName || !date) { setBookedSlots([]); setAllSlotsBooked(false); setSlotsChecking(false); setVisitTypeWindow(null); return }
    setSlotsChecking(true)
    try {
    const provRow = await getProviderByName(providerName)
    if (!provRow) { setBookedSlots([]); setAllSlotsBooked(false); setSlotsChecking(false); setVisitTypeWindow(null); return }

    // Check day-of-week / override availability first
    const dayWindow = await getProviderDayWindow(provRow.id, date)
    if (!dayWindow) {
      setBookedSlots([]); setAllSlotsBooked(true); setSlotsChecking(false); setVisitTypeWindow(null)
      return
    }

    // Fetch this provider's scheduling data for the selected visit type (includes visitTypeAvail + bookedTimes)
    const sched = await getSchedulingData(provRow.id, { date, visit_type: booking.visitType })
    const vtaRow = sched?.visitTypeAvail
    // Visit type window takes precedence over day window; fall back to day window if no vta record
    const window = vtaRow && vtaRow.is_active
      ? { start: vtaRow.start_time as string, end: vtaRow.end_time as string }
      : dayWindow
    setVisitTypeWindow(window)

    const bookedSlotsList = sched?.bookedSlots ?? []
    setBookedSlots(bookedSlotsList)

    const leadTimeSlots = getAvailableSlots(byType[booking.visitType]?.lead_minutes ?? 60, date)
    const freeSlots = leadTimeSlots.filter(slot => {
      const [t, ampm] = slot.split(' ')
      let [h, m] = t.split(':').map(Number)
      if (ampm === 'PM' && h !== 12) h += 12
      if (ampm === 'AM' && h === 12) h = 0
      const slotMin = h * 60 + m
      const [wsh, wsm] = window.start.split(':').map(Number)
      const [weh, wem] = window.end.split(':').map(Number)
      if (slotMin < wsh * 60 + wsm || slotMin >= weh * 60 + wem) return false
      return !bookedSlotsList.some(({ time: bt, duration }) => {
        const [bh, bm] = bt.split(':').map(Number)
        const bookedMin = bh * 60 + bm
        return slotMin >= bookedMin && slotMin < bookedMin + duration
      })
    })
    setAllSlotsBooked(freeSlots.length === 0)
    setSlotsChecking(false)
    } catch {
      setBookedSlots([]); setAllSlotsBooked(false); setSlotsChecking(false); setVisitTypeWindow(null)
    }
  }

  async function onZipChange(zip: string) {
    const st = zipToState[zip] || ''
    const zone = zipToZone[zip] || ''
    // Preserve existing state when zip isn't in our zone map (e.g. telemedicine patients outside in-home service area)
    setBooking(b => ({ ...b, zip, state: st || b.state, zone, provider: '' }))
    setWaitlistDone(false)
    setAllSlotsBooked(false)
    setSlotsChecking(false)
    setSecureTextProviders([])
    setCmaAvailResult(null)
    setCmaProvidersForZone([])

    if (zip.length === 5 && zone) {
      // Served zip — load secure text numbers for providers assigned to this zone
      // (IV fluids: show only the RNs who cover this specific zone)
      const ivRows = booking.visitType === 'In-home IV fluids'
        ? await getProvidersByRole({ role: 'RN', is_active: 'true', zone }).catch(() => [] as any[])
        : []
      const providerNames = booking.visitType === 'In-home IV fluids'
        ? (ivRows as any[]).map((p: any) => p.name)
        : regularZoneProviders.map(p => p.name)
      if (providerNames.length > 0) {
        const data = await getProvidersByNamesWithSecureText(providerNames).catch(() => [])
        setSecureTextProviders((data ?? []).filter((p: any) => p.secure_text_number) as any)
      }
    }
    // Unserved zip — no provider numbers shown (waitlist only)
  }

  async function findFirstAvailable(date: string) {
    const providers = isIvFluids ? ivZoneProviders : regularZoneProviders
    if (!date || providers.length === 0) return
    setFindingFirstAvail(true)
    setFirstAvailResult(null)
    setAllSlotsBooked(false)

    const leadTimeSlots = getAvailableSlots(byType[booking.visitType]?.lead_minutes ?? 60, date)

    const slotMin = (slot: string) => {
      const [t, ampm] = slot.split(' ')
      let [h, m] = t.split(':').map(Number)
      if (ampm === 'PM' && h !== 12) h += 12
      if (ampm === 'AM' && h === 12) h = 0
      return h * 60 + m
    }

    const results = await Promise.all(providers.map(async p => {
      const provRow = await getProviderByName(p.name)
      if (!provRow) return null
      const dayWindow = await getProviderDayWindow(provRow.id, date)
      if (!dayWindow) return null
      const sched = await getSchedulingData(provRow.id, { date, visit_type: booking.visitType })
      const vtaRow = sched?.visitTypeAvail
      const window = vtaRow?.is_active ? { start: vtaRow.start_time as string, end: vtaRow.end_time as string } : dayWindow
      const bookedList = sched?.bookedSlots ?? []
      const free = leadTimeSlots.filter(slot => {
        const sm = slotMin(slot)
        const [wsh, wsm] = window.start.split(':').map(Number)
        const [weh, wem] = window.end.split(':').map(Number)
        if (sm < wsh * 60 + wsm || sm >= weh * 60 + wem) return false
        return !bookedList.some(({ time: bt, duration }) => {
          const [bh, bm] = bt.split(':').map(Number)
          const bm2 = bh * 60 + bm
          return sm >= bm2 && sm < bm2 + duration
        })
      })
      return free.length > 0 ? { name: p.name, firstSlot: free[0] } : null
    }))

    const available = results.filter(Boolean) as { name: string; firstSlot: string }[]
    if (available.length === 0) {
      setAllSlotsBooked(true)
      setFindingFirstAvail(false)
      return
    }
    available.sort((a, b) => slotMin(a.firstSlot) - slotMin(b.firstSlot))
    const winner = available[0]
    setFirstAvailResult({ provider: winner.name, time: winner.firstSlot })
    setBooking(b => ({ ...b, time: winner.firstSlot }))
    setFindingFirstAvail(false)
  }

  async function findCmaAvailability(date: string, zone: string) {
    if (!date || !zone) return
    // Query CMAs from DB whose zones include this zone
    const cmaRows = await getProvidersByRole({ role: 'CMA', is_active: 'true', zone }).catch(() => [])
    if (!cmaRows?.length) return

    setCmaProvidersForZone(
      (cmaRows ?? []).map((r: any) => ({
        name: r.name, role: r.role,
        initials: r.initials || r.name.split(' ').map((w: string) => w[0]).join('').slice(0, 2),
        color: r.avatar_color || '#EEEDFE',
        textColor: r.avatar_text_color || '#3C3489',
      }))
    )
    const cmaNames = (cmaRows ?? []).map((r: any) => r.name as string)

    const leadTimeSlots = getAvailableSlots(byType['CMA + telemedicine']?.lead_minutes ?? 60, date)
    if (leadTimeSlots.length === 0) return

    const slotMin = (slot: string) => {
      const [t, ampm] = slot.split(' ')
      let [h, m] = t.split(':').map(Number)
      if (ampm === 'PM' && h !== 12) h += 12
      if (ampm === 'AM' && h === 12) h = 0
      return h * 60 + m
    }

    const results = await Promise.all(cmaNames.map(async name => {
      const provRow = await getProviderByName(name)
      if (!provRow) return null
      const dayWindow = await getProviderDayWindow(provRow.id, date)
      if (!dayWindow) return null
      const sched = await getSchedulingData(provRow.id, { date, visit_type: 'CMA + telemedicine' })
      const vtaRow = sched?.visitTypeAvail
      const window = vtaRow?.is_active ? { start: vtaRow.start_time as string, end: vtaRow.end_time as string } : dayWindow
      const bookedList = sched?.bookedSlots ?? []
      const free = leadTimeSlots.filter(slot => {
        const sm = slotMin(slot)
        const [wsh, wsm] = window.start.split(':').map(Number)
        const [weh, wem] = window.end.split(':').map(Number)
        if (sm < wsh * 60 + wsm || sm >= weh * 60 + wem) return false
        return !bookedList.some(({ time: bt, duration }) => {
          const [bh, bm] = bt.split(':').map(Number)
          const bm2 = bh * 60 + bm
          return sm >= bm2 && sm < bm2 + duration
        })
      })
      return free.length > 0 ? { name, firstSlot: free[0] } : null
    }))

    const available = results.filter(Boolean) as { name: string; firstSlot: string }[]
    if (available.length > 0) {
      available.sort((a, b) => slotMin(a.firstSlot) - slotMin(b.firstSlot))
      setCmaAvailResult(available[0])
    }
  }

  async function submitWaitlist() {
    if (!family) return
    setWaitlistSubmitting(true)

    const noteParts: string[] = []
    noteParts.push(`Family: ${family.display_name || family.email}`)
    noteParts.push(`Email: ${family.email}`)
    if ((family as any).phone) noteParts.push(`Phone: ${(family as any).phone}`)

    // If a known child was selected, pull their info from the profile
    const selectedChild = waitlistChildId ? children.find(c => c.id === waitlistChildId) : null
    if (selectedChild) {
      const name = [selectedChild.first_name, selectedChild.last_name].filter(Boolean).join(' ') || selectedChild.display_label
      noteParts.push(`Patient: ${name}`)
      if (selectedChild.date_of_birth) noteParts.push(`DOB: ${selectedChild.date_of_birth}`)
      if (selectedChild.allergies) noteParts.push(`Allergies: ${selectedChild.allergies}`)
      if (selectedChild.current_medications) noteParts.push(`Medications: ${selectedChild.current_medications}`)
      if (selectedChild.medical_history) noteParts.push(`PMH: ${selectedChild.medical_history}`)
      if (selectedChild.pcp) noteParts.push(`PCP: ${selectedChild.pcp}`)
      if (selectedChild.preferred_pharmacy) noteParts.push(`Pharmacy: ${selectedChild.preferred_pharmacy}`)
      if (selectedChild.insurance_provider) noteParts.push(`Insurance: ${selectedChild.insurance_provider}`)
      if (selectedChild.insurance_member_id) noteParts.push(`Member ID: ${selectedChild.insurance_member_id}`)
      if (selectedChild.insurance_group_number) noteParts.push(`Group #: ${selectedChild.insurance_group_number}`)
    } else {
      if (waitlistPatient) noteParts.push(`Patient: ${waitlistPatient}`)
      if (waitlistDOB) noteParts.push(`DOB: ${waitlistDOB}`)
      if (waitlistPhone) noteParts.push(`Phone: ${waitlistPhone}`)
      if (waitlistAddress) noteParts.push(`Address: ${waitlistAddress}`)
      if (waitlistAllergies) noteParts.push(`Allergies: ${waitlistAllergies}`)
      if (waitlistMedications) noteParts.push(`Medications: ${waitlistMedications}`)
      if (waitlistPMH) noteParts.push(`PMH: ${waitlistPMH}`)
      if (waitlistPCP) noteParts.push(`PCP: ${waitlistPCP}`)
      if (waitlistPharmacy) noteParts.push(`Pharmacy: ${waitlistPharmacy}`)
      if (waitlistInsurance) noteParts.push(`Insurance: ${waitlistInsurance}`)
      if (waitlistInsuranceMemberId) noteParts.push(`Member ID: ${waitlistInsuranceMemberId}`)
      if (waitlistInsuranceGroupNum) noteParts.push(`Group #: ${waitlistInsuranceGroupNum}`)
      if (waitlistInsuranceSubscriber) noteParts.push(`Subscriber: ${waitlistInsuranceSubscriber}`)
    }

    if (waitlistComplaint) noteParts.push(`Complaint: ${waitlistComplaint}`)
    if (booking.date) noteParts.push(`Requested date: ${booking.date}`)
    if (waitlistNotes) noteParts.push(`Parent notes: ${waitlistNotes}`)

    await familyCreateWaitlistEntry({
      family_id: family.id,
      visit_type: booking.visitType || null,
      zip: booking.zip,
      state: booking.state || null,
      preferred_time_window: waitlistTime || null,
      notes: noteParts.join(' | '),
      status: 'waiting',
    }).catch(() => null)

    setWaitlistSubmitting(false)
    setWaitlistOpen(false)
    setWaitlistDone(true)
  }

  const isCmaVisit = booking.visitType === 'CMA + telemedicine'
  const isTele = isTelemedicine(booking.visitType)
  const zoneProviders = isIvFluids
    ? ivZoneProviders
    : isCmaVisit && cmaProvidersForZone.length > 0
      ? cmaProvidersForZone
      : regularZoneProviders
  const noAvailableSlots = booking.date
    ? getAvailableSlots(byType[booking.visitType]?.lead_minutes ?? 60, booking.date).length === 0
    : false

  // ─── Validation ──────────────────────────────────────────────────────────────

  function step1Valid() {
    if (!booking.visitType) return false
    if (!isCpr && booking.selectedChildIds.length === 0) return false
    return true
  }

  function step2Valid() {
    return booking.selectedChildIds.every(id => {
      const intake = booking.childIntakes[id]
      if (!intake) return false
      if (!intake.chiefComplaint) return false
      if (!intake.selfPay && !intake.hasProfile && !intake.cardOnFile && (!intake.insuranceCardFrontUrl || !intake.insuranceCardBackUrl)) return false
      if (!intake.hasProfile) {
        if (!intake.firstName || !intake.lastName || !intake.dateOfBirth) return false
        if (!intake.selfPay && (!intake.insuranceProvider || !intake.insuranceMemberId)) return false
      }
      return true
    })
  }

  // ─── Submit ───────────────────────────────────────────────────────────────────

  async function submit() {
    setSubmitting(true)
    const ref = 'PUC-' + Math.floor(10000 + Math.random() * 90000)

    if (isCpr) {
      // CPR class booking — simplified flow, always Melissa Jesse
      const melissaRow = await getProviderByName('Melissa Jesse')
      const melissaUid = melissaRow?.id || null

      const cprNotes = [
        `Ref: ${ref}`,
        `ADDR:${booking.visitAddress}`,
        `PARENTEMAIL:${family!.email}`,
        `PARTICIPANTS:${booking.participantCount}`,
        booking.participantNames ? `ATTENDEES:${booking.participantNames}` : '',
      ].filter(Boolean).join('|')

      if (melissaUid) {
        await familyCreateAppointment({
          provider_id: melissaUid,
          visit_type: booking.visitType,
          zone: 'CPR Class',
          scheduled_time: to24hr(booking.time),
          scheduled_date: booking.date,
          status: 'upcoming',
          notes: cprNotes,
          duration_minutes: 180,
        })
      }

      const newBooking = await familyCreateBookingRequest({
        family_id: family!.id,
        child_ids: [],
        visit_type: booking.visitType,
        preferred_provider: 'Melissa Jesse',
        zone: 'CPR Class',
        state: 'NC',
        preferred_date: booking.date,
        preferred_time: booking.time,
        status: 'confirmed',
        confirmed_provider_id: melissaUid,
        reference_code: ref,
        notes: cprNotes,
      }).catch(() => null)

      if (newBooking?.id) {
        familyInvokeNotifications({ type: 'cpr_booking', bookingRequestId: newBooking.id }).catch(() => {})
      }

      if (needsAgreements) {
        updateMyFamily({ agreements_accepted_at: new Date().toISOString() }).catch(() => {})
      }
      if (needsPaymentPolicy) {
        updateMyFamily({ payment_policy_accepted_at: new Date().toISOString() }).catch(() => {})
      }

      setSubmitting(false)
      setConfirmed(ref)
      return
    }

    const effectiveProvider = booking.provider === '__first_available__'
      ? (firstAvailResult?.provider || '')
      : booking.provider
    const providerRow = await getProviderByName(effectiveProvider)
    const providerUid = providerRow?.id || null
    let appointmentDbId: string | null = null

    if (providerUid) {
      const noteParts = [`Ref: ${ref}`]
      if (booking.visitAddress) noteParts.push(`ADDR:${booking.visitAddress}`)
      noteParts.push(`PARENTEMAIL:${family!.email}`)
      if ((family as any)?.phone) noteParts.push(`PARENTPHONE:${(family as any).phone}`)

      // Store clinical intake data for all selected children
      const childCount = booking.selectedChildIds.length
      if (childCount > 1) noteParts.push(`CHILDREN:${childCount} children`)
      const firstIntake = booking.childIntakes[booking.selectedChildIds[0]] || {}
      if (firstIntake.firstName || firstIntake.lastName) noteParts.push(`PATIENT:${firstIntake.firstName || ''} ${firstIntake.lastName || ''}`.trim())
      if (firstIntake.dateOfBirth) noteParts.push(`DOB:${firstIntake.dateOfBirth}`)
      if (firstIntake.chiefComplaint)    noteParts.push(`CC:${firstIntake.chiefComplaint}`)
      if (firstIntake.additionalInfo)    noteParts.push(`NOTES:${firstIntake.additionalInfo}`)
      if (firstIntake.textVisitPhotos?.length) firstIntake.textVisitPhotos.filter(Boolean).forEach(url => noteParts.push(`PHOTO:${url}`))
      if (firstIntake.allergies)         noteParts.push(`ALLERGY:${firstIntake.allergies}`)
      if (firstIntake.currentMedications) noteParts.push(`MEDS:${firstIntake.currentMedications}`)
      if (firstIntake.medicalHistory)    noteParts.push(`PMH:${firstIntake.medicalHistory}`)
      if (firstIntake.vaccinationStatus) noteParts.push(`VAX:${firstIntake.vaccinationStatus}`)
      if (firstIntake.pcp)               noteParts.push(`PCP:${firstIntake.pcp}`)
      if (firstIntake.preferredPharmacy) noteParts.push(`PHARMACY:${firstIntake.preferredPharmacy}`)
      if (firstIntake.insuranceProvider) {
        const ins = [
          firstIntake.insuranceProvider,
          firstIntake.insuranceMemberId ? `MID:${firstIntake.insuranceMemberId}` : '',
          firstIntake.insuranceGroupNumber ? `GRP:${firstIntake.insuranceGroupNumber}` : '',
          firstIntake.insuranceSubscriberName ? `SUB:${firstIntake.insuranceSubscriberName}` : '',
          firstIntake.insuranceSubscriberDob ? `SUBDOB:${firstIntake.insuranceSubscriberDob}` : '',
          firstIntake.insuranceSubscriberGender ? `SUBGENDER:${firstIntake.insuranceSubscriberGender}` : '',
        ].filter(Boolean).join(' | ')
        noteParts.push(`INSURANCE:${ins}`)
      }
      if (firstIntake.insuranceCardFrontUrl) noteParts.push(`CARDFRONT:${firstIntake.insuranceCardFrontUrl}`)
      if (firstIntake.insuranceCardBackUrl)  noteParts.push(`CARDBACK:${firstIntake.insuranceCardBackUrl}`)
      if (!firstIntake.hasProfile) noteParts.push(`PHI_CONSENT:${firstIntake.phiSharingConsent ? 'yes' : 'no'}`)

      if (isIvFluids) {
        const iv = booking.ivFluidsIntake
        noteParts.push([
          `IV SCREENING`,
          iv.weight ? `Weight: ${iv.weight}` : '',
          `Onset: ${iv.symptomOnset}`,
          `Symptoms: ${iv.symptoms}`,
          `Fluid intake: ${iv.fluidIntake}`,
          `ORS tried: ${iv.oralRehydration}`,
          `Last urination: ${iv.lastUrination}`,
          `Diarrhea: ${iv.diarrhea}`,
          `Vomiting: ${iv.vomiting}`,
          `Activity: ${iv.activityLevel}`,
          `Mouth dry: ${iv.mouthDryness}`,
          `Tears: ${iv.tears}`,
          `Fever: ${iv.hasFever}${iv.highestTemp ? ` (${iv.highestTemp})` : ''}`,
          `Red flags: ${iv.redFlags.join(', ')}`,
          iv.otherConditions ? `Other conditions: ${iv.otherConditions}` : '',
          `Recent IV: ${iv.recentIvFluids}`,
          `Available: ${iv.availableTimes}`,
        ].filter(Boolean).join(' | '))
      }
      const apptRecord = await familyCreateAppointment({
        provider_id: providerUid,
        visit_type: booking.visitType,
        zone: booking.zone,
        scheduled_time: to24hr(booking.time),
        scheduled_date: booking.date,
        status: 'upcoming',
        notes: noteParts.join('|'),
        duration_minutes: (byType[booking.visitType]?.duration_minutes ?? 60) + ((byType[booking.visitType]?.per_child_extra_minutes ?? 0) * Math.max(0, booking.selectedChildIds.length - 1)),
      }).catch(() => null)
      appointmentDbId = apptRecord?.id || null
    }

    const newBooking = await familyCreateBookingRequest({
      family_id: family!.id,
      child_ids: booking.selectedChildIds,
      visit_type: booking.visitType,
      preferred_provider: effectiveProvider || null,
      zone: booking.zone || null,
      state: booking.state || null,
      preferred_date: booking.date,
      preferred_time: booking.time,
      status: 'confirmed',
      confirmed_provider_id: providerUid,
      reference_code: ref,
      ...(convFee ? { convenience_fee: convFee.fee } : {}),
    }).catch(() => null)

    if (!newBooking?.id) {
      setSubmitError('Something went wrong submitting your booking. Please try again or call us directly.')
      setSubmitting(false)
      return
    }

    // Sync to Charm Health (non-blocking)
    invokeCharmAppointment({ bookingRequestId: newBooking.id, childIntakes: booking.childIntakes, appointmentDbId }).catch(() => {})

    // Send confirmation email to parent + notification to provider (non-blocking)
    familyInvokeNotifications({ bookingRequestId: newBooking.id }).catch(() => {})

    // Save profile data so it's pre-filled on future bookings
    await Promise.allSettled([
      ...booking.selectedChildIds.map(childId => {
        const intake = booking.childIntakes[childId]
        if (!intake) return Promise.resolve()
        const update: Record<string, unknown> = {
          insurance_provider: intake.selfPay ? 'Self-Pay' : (intake.insuranceProvider || null),
          insurance_member_id: intake.selfPay ? null : (intake.insuranceMemberId || null),
          insurance_group_number: intake.insuranceGroupNumber || null,
          insurance_subscriber_name: intake.insuranceSubscriberName || null,
          insurance_subscriber_dob: intake.insuranceSubscriberDob || null,
          insurance_subscriber_gender: intake.insuranceSubscriberGender || null,
          preferred_pharmacy: intake.preferredPharmacy || null,
          pcp: intake.pcp || null,
        }
        if (!intake.hasProfile) {
          Object.assign(update, {
            phi_sharing_consent: intake.phiSharingConsent,
            first_name: intake.firstName || null,
            last_name: intake.lastName || null,
            date_of_birth: intake.dateOfBirth || null,
            gender: intake.gender || null,
            allergies: intake.allergies || null,
            current_medications: intake.currentMedications || null,
            medical_history: intake.medicalHistory || null,
          })
        }
        return updateChild(childId, update)
      }),
      ...Object.entries(booking.childIntakes)
        .filter(([, intake]) => intake.insuranceCardFrontUrl && intake.insuranceCardBackUrl)
        .map(([childId, intake]) => updateChild(childId, {
          insurance_card_front_url: intake.insuranceCardFrontUrl,
          insurance_card_back_url: intake.insuranceCardBackUrl,
        })),
    ])
    await refreshFamily()

    if (referralSource.trim() && !(family as any)?.referral_source) {
      updateMyFamily({ referral_source: referralSource.trim() }).catch(() => {})
    }
    if (needsAgreements) {
      updateMyFamily({ agreements_accepted_at: new Date().toISOString() }).catch(() => {})
    }
    if (needsPaymentPolicy) {
      updateMyFamily({ payment_policy_accepted_at: new Date().toISOString() }).catch(() => {})
    }

    setSubmitting(false)
    setConfirmed(ref)
  }

  // ─── Confirmation screen ──────────────────────────────────────────────────────

  if (confirmed) {
    const selectedChildren = children.filter(c => booking.selectedChildIds.includes(c.id))
    return (
      <div className="bg-white border border-[#E8E8E4] rounded-xl p-8 shadow-sm text-center">
        <div className="w-14 h-14 rounded-full bg-[#EAF3DE] flex items-center justify-center mx-auto mb-4">
          <Check size={24} className="text-[#27500A]" strokeWidth={2.5} />
        </div>
        <h2 className="font-display text-2xl font-medium text-[#1A1A2E] mb-2">You're confirmed!</h2>
        <p className="text-[13px] text-[#555] mb-5 leading-relaxed max-w-sm mx-auto">
          Your appointment is booked. You'll receive a reminder before your visit.
        </p>
        <div className="bg-[#FAFAF8] border border-[#E8E8E4] rounded-lg p-4 max-w-xs mx-auto text-left text-[13px] text-[#555] space-y-1 mb-4">
          <div><strong className="text-[#1A1A2E]">{booking.visitType}</strong></div>
          {isCpr ? (
            <>
              <div>{booking.participantCount} participant{booking.participantCount > 1 ? 's' : ''}</div>
              {booking.participantNames && <div>{booking.participantNames}</div>}
              <div>Melissa Jesse</div>
            </>
          ) : (
            <>
              <div>{selectedChildren.map(c => c.display_label).join(' & ')}</div>
              {booking.provider && <div>{booking.provider === '__first_available__' ? firstAvailResult?.provider : booking.provider}</div>}
              {booking.zone && <div>{booking.zone}</div>}
            </>
          )}
          <div>{format(new Date(booking.date + 'T12:00:00'), 'EEEE, MMMM d, yyyy')}</div>
          <div>{booking.time}</div>
          {booking.visitAddress && <div>{booking.visitAddress}</div>}
        </div>
        <div className="text-[11px] text-[#999] font-mono mb-6">Reference: {confirmed}</div>
        {isCpr ? (
          <div className="bg-[#FDEDEC] border border-[#F5B7B1] rounded-lg p-3 max-w-sm mx-auto text-[13px] text-[#922B21] text-left mb-6 space-y-2">
            <div><strong>Next steps:</strong></div>
            <div>1. Check your email for the e-learning link — all attendees must complete it before class.</div>
            <div>2. Send payment via Venmo <strong>@{VENMO_HANDLE}</strong> (${booking.participantCount * 80}).</div>
            <div>3. Email attendee names to <strong>deeringmel@me.com</strong>.</div>
          </div>
        ) : (
          <div className="bg-[#E1F5EE] border border-[#5DCAA5] rounded-lg p-3 max-w-sm mx-auto text-[13px] text-[#085041] text-left mb-6">
            {booking.visitType === 'Video telemedicine' ? (
              <span>Check your email for a confirmation with a link to our virtual visit room. Please log in at your scheduled time. Once you check in to the virtual waiting room, your provider will be notified and your video visit will begin shortly after that.</span>
            ) : booking.visitType === 'Text visit' ? (
              <span>Your provider will text you at your scheduled time.</span>
            ) : (
              <span><strong>What happens next:</strong> Your provider will arrive at your home at your scheduled time!</span>
            )}
          </div>
        )}
        <div className="flex gap-2 justify-center">
          <Button variant="secondary" onClick={() => navigate('/family/dashboard')}>Back to dashboard</Button>
          <Button onClick={() => {
            setConfirmed(null); setStep(0)
            setBooking({ visitType: '', selectedChildIds: [], childIntakes: {}, activeChildTab: '', ivFluidsIntake: emptyIvFluids(), zip: family?.zip || '', state: family?.state || zipToState[family?.zip || ''] || '', zone: zipToZone[family?.zip || ''] || '', provider: '', visitAddress: '', date: '', time: '', participantCount: 1, participantNames: '' })
          }}>Book another visit</Button>
        </div>
      </div>
    )
  }

  // ─── Step renders ─────────────────────────────────────────────────────────────

  const selectedChildren = children.filter(c => booking.selectedChildIds.includes(c.id))

  return (
    <div>
      <ProgressBar step={step} steps={STEPS} />

      {/* ── STEP 0: Who + visit type ── */}
      {step === 0 && (
        <Step
          title={isCpr ? 'Select visit type' : 'Who needs to be seen?'}
          sub={isCpr ? 'CPR classes are available to households anywhere — Melissa Jesse will come to you.' : 'Select all children being seen at this visit. You can book multiple siblings at once.'}>

          {/* Visit type */}
          <p className="text-[12px] font-semibold text-[#555] uppercase tracking-wider mb-2">Visit type</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-6">
            {Object.entries(VISIT_TYPE_INFO).filter(([type]) => type !== 'CMA + telemedicine').map(([type, info]) => (
              <button key={type} onClick={() => setBooking(b => ({ ...b, visitType: type }))}
                className={`text-left p-4 rounded-xl border-2 transition-all ${booking.visitType === type ? 'border-[#7F77DD] bg-[#EEEDFE]' : 'border-[#E8E8E4] bg-white hover:border-[#AFA9EC]'}`}>
                <div className="flex items-start gap-3">
                  <div className="w-9 h-9 rounded-xl flex items-center justify-center text-lg flex-shrink-0" style={{ background: info.bg }}>{info.icon}</div>
                  <div className="flex-1 min-w-0">
                    <div className="font-display text-[14px] font-medium text-[#1A1A2E]">{type}</div>
                    <div className="text-[11px] text-[#555] mt-0.5">{info.duration}</div>
                  </div>
                  {booking.visitType === type && <div className="w-5 h-5 rounded-full bg-[#7F77DD] flex items-center justify-center flex-shrink-0"><Check size={10} className="text-white" /></div>}
                </div>
              </button>
            ))}
          </div>

          {/* Child selection — hidden for CPR */}
          {!isCpr && <p className="text-[12px] font-semibold text-[#555] uppercase tracking-wider mb-2">
            Which children? <span className="normal-case font-normal text-[#999]">Select all being seen today</span>
          </p>}
          {!isCpr && <>
          <div className="space-y-2">
            {children.length === 0 && (
              <div className="p-4 border border-[#E8E8E4] rounded-xl text-[13px] text-[#999] text-center">
                No children on file. Please update your profile first.
              </div>
            )}
            {children.map(c => {
              const selected = booking.selectedChildIds.includes(c.id)
              const hasProfile = !!(c.charm_patient_id || c.first_name)
              return (
                <button key={c.id} onClick={() => toggleChild(c.id, c.display_label, hasProfile)}
                  className={`w-full flex items-center gap-3 p-3.5 rounded-xl border-2 transition-all text-left ${selected ? 'border-[#7F77DD] bg-[#EEEDFE]' : 'border-[#E8E8E4] bg-white hover:border-[#AFA9EC]'}`}>
                  <div className="w-10 h-10 rounded-full flex items-center justify-center text-[13px] font-medium flex-shrink-0"
                    style={{ background: selected ? '#7F77DD' : '#F1EFE8', color: selected ? '#fff' : '#555' }}>
                    {c.display_label.charAt(0).toUpperCase()}
                  </div>
                  <div className="flex-1">
                    <div className="text-[14px] font-medium text-[#1A1A2E]">{c.display_label}</div>
                    {hasProfile && <div className="text-[11px] text-[#1D9E75]">Profile on file</div>}
                    {!hasProfile && <div className="text-[11px] text-[#999]">Profile needed at booking</div>}
                  </div>
                  <div className={`w-6 h-6 rounded-full border-2 flex items-center justify-center flex-shrink-0 transition-all ${selected ? 'bg-[#7F77DD] border-[#7F77DD]' : 'border-[#D0D0CC]'}`}>
                    {selected && <Check size={12} className="text-white" strokeWidth={3} />}
                  </div>
                </button>
              )
            })}

            {/* Add new child inline */}
            {addingChild ? (
              <div className="p-3.5 border-2 border-[#7F77DD] rounded-xl bg-[#EEEDFE]">
                <div className="flex items-center gap-2 mb-2">
                  <Input placeholder="Name or label (e.g. Emma, my son)"
                    value={newChildLabel} onChange={e => setNewChildLabel(e.target.value)}
                    className="flex-1" />
                </div>
                <div className="flex gap-2">
                  <Button variant="secondary" size="sm" onClick={() => { setAddingChild(false); setNewChildLabel('') }}>Cancel</Button>
                  <Button size="sm" disabled={!newChildLabel.trim()} onClick={addNewChild}>Add & select</Button>
                </div>
              </div>
            ) : (
              <button onClick={() => setAddingChild(true)}
                className="w-full flex items-center gap-3 p-3.5 rounded-xl border-2 border-dashed border-[#E8E8E4] hover:border-[#7F77DD] hover:bg-[#FAFAF8] transition-all text-[#999] hover:text-[#7F77DD]">
                <div className="w-10 h-10 rounded-full bg-[#F1EFE8] flex items-center justify-center flex-shrink-0">
                  <Plus size={16} />
                </div>
                <span className="text-[14px] font-medium">Add another child</span>
              </button>
            )}
          </div>

          {booking.selectedChildIds.length > 1 && (
            <div className="mt-3 p-3 bg-[#E1F5EE] border border-[#5DCAA5] rounded-lg text-[12px] text-[#085041]">
              <strong>{booking.selectedChildIds.length} children selected</strong> — we see siblings together at the same house call visit.
            </div>
          )}
          </>}

          <NavButtons nextDisabled={!step1Valid()} onNext={() => setStep(STEP_INTAKE)} />
        </Step>
      )}

      {/* ── STEP 1: CPR participants OR child profiles ── */}
      {step === STEP_INTAKE && isCpr && (
        <Step title="Participants" sub="Tell us who will be attending the CPR class. Maximum 6 participants.">
          <div className="space-y-5">
            <div>
              <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-2">Number of participants <span className="text-[#E74C3C]">*</span></label>
              <div className="flex gap-2">
                {[1,2,3,4,5,6].map(n => (
                  <button key={n} onClick={() => setBooking(b => ({ ...b, participantCount: n }))}
                    className={`w-10 h-10 rounded-lg border-2 text-[15px] font-medium transition-all ${booking.participantCount === n ? 'bg-[#E74C3C] border-[#E74C3C] text-white' : 'border-[#E8E8E4] bg-white text-[#1A1A2E] hover:border-[#E74C3C]'}`}>
                    {n}
                  </button>
                ))}
              </div>
              <p className="text-[11px] text-[#aeaeb2] mt-2">$80 per person · {booking.participantCount} × $80 = <strong>${booking.participantCount * 80}</strong></p>
            </div>

            <div>
              <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-1">
                Attendee names and email addresses <span className="text-[#E74C3C]">*</span>
              </label>
              <textarea value={booking.participantNames}
                onChange={e => setBooking(b => ({ ...b, participantNames: e.target.value }))}
                placeholder={"e.g.\nJane Smith, jane@email.com\nJohn Smith, john@email.com"}
                rows={4}
                className="w-full px-3 py-2.5 border border-[#E8E8E4] rounded-lg text-[14px] font-sans resize-none outline-none focus:border-[#E74C3C] bg-white" />
            </div>

            <div>
              <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-1">
                Visit address <span className="text-[#E74C3C]">*</span>
              </label>
              <input value={booking.visitAddress}
                onChange={e => setBooking(b => ({ ...b, visitAddress: e.target.value }))}
                placeholder="123 Main St, Charlotte, NC 28078"
                className="w-full px-3 py-2.5 border border-[#E8E8E4] rounded-lg text-[14px] font-sans focus:border-[#E74C3C] focus:ring-2 focus:ring-[#E74C3C]/10 outline-none" />
              <p className="text-[11px] text-[#aeaeb2] mt-1">Melissa will arrive 30 minutes early to set up.</p>
            </div>

            <div className="p-3.5 bg-[#FDEDEC] border border-[#F5B7B1] rounded-xl text-[13px] text-[#922B21]">
              <strong>Before class day:</strong> All participants must complete the online e-learning module. You'll receive a link by email after booking.
            </div>
          </div>

          <NavButtons
            onBack={() => setStep(0)}
            nextDisabled={!booking.visitAddress || !booking.participantNames.trim()}
            onNext={() => {
              setBooking(b => ({ ...b, provider: 'Melissa Jesse' }))
              loadBookedTimes('Melissa Jesse', booking.date)
              setStep(STEP_LOCATION)
            }}
          />
        </Step>
      )}

      {step === STEP_INTAKE && !isCpr && (
        <Step
          title="About each child"
          sub={selectedChildren.length > 1 ? "Complete a profile and describe today's symptoms for each child." : "Complete the profile and describe today's symptoms."}>

          {/* Tabs for multiple children */}
          {selectedChildren.length > 1 && (
            <div className="flex gap-1 mb-5 border-b border-[#E8E8E4]">
              {selectedChildren.map(c => (
                <button key={c.id} onClick={() => setBooking(b => ({ ...b, activeChildTab: c.id }))}
                  className={`px-4 py-2 text-[13px] font-medium transition-all border-b-2 -mb-px ${booking.activeChildTab === c.id ? 'border-[#7F77DD] text-[#7F77DD]' : 'border-transparent text-[#999] hover:text-[#555]'}`}>
                  {c.display_label}
                  {booking.childIntakes[c.id]?.chiefComplaint &&
                   (booking.childIntakes[c.id]?.hasProfile || booking.childIntakes[c.id]?.firstName) && (
                    <span className="ml-1.5 w-4 h-4 rounded-full bg-[#1D9E75] inline-flex items-center justify-center">
                      <Check size={9} className="text-white" strokeWidth={3} />
                    </span>
                  )}
                </button>
              ))}
            </div>
          )}

          {/* Show intake form for active (or only) child */}
          {selectedChildren
            .filter(c => selectedChildren.length === 1 || c.id === booking.activeChildTab)
            .map(c => {
              const intake = booking.childIntakes[c.id]
              if (!intake) return null
              return (
                <ChildIntakeFormSection
                  key={c.id}
                  intake={intake}
                  visitType={booking.visitType}
                  onChange={(field, value) => setIntake(c.id, field, value)}
                  onConsentChange={val => setBooking(b => ({
                    ...b,
                    childIntakes: { ...b.childIntakes, [c.id]: { ...b.childIntakes[c.id], phiSharingConsent: val } },
                  }))}
                  onPhotosChange={photos => setIntakePhotos(c.id, photos)}
                  onSelfPayChange={val => setBooking(b => ({
                    ...b,
                    childIntakes: { ...b.childIntakes, [c.id]: { ...b.childIntakes[c.id], selfPay: val } },
                  }))}
                />
              )
            })
          }

          <NavButtons onBack={() => setStep(0)} nextDisabled={!step2Valid()} onNext={() => setStep(isIvFluids ? STEP_IV : STEP_LOCATION)} />
        </Step>
      )}

      {/* ── STEP 2 (IV only): IV Fluids Pre-Screening ── */}
      {isIvFluids && step === STEP_IV && (
        <Step title="IV Fluids Pre-Screening" sub="Please answer all questions so our provider can prepare for your visit.">
          <div className="space-y-6">

            <div className="bg-[#FEF3E8] border border-[#F5943A]/30 rounded-xl p-4">
              <p className="text-[13px] font-semibold text-[#633806] mb-1">Weight requirement</p>
              <p className="text-[13px] text-[#633806]/80">We can only administer in-home IV fluids to children who weigh <strong>55 lbs (25 kg) or more</strong>. If your child weighs less than 55 lbs, we will not be able to provide this service.</p>
            </div>

            <IvQ label="1. What is your child's current weight?">
              <input value={booking.ivFluidsIntake.weight}
                onChange={e => setBooking(b => ({ ...b, ivFluidsIntake: { ...b.ivFluidsIntake, weight: e.target.value } }))}
                placeholder="e.g. 62 lbs"
                className="w-full px-3 py-2.5 border border-[#E8E8E4] rounded-lg text-[14px] font-sans outline-none focus:border-[#7F77DD]" />
            </IvQ>

            <IvQ label="2. When did symptoms begin?">
              <IvRadios field="symptomOnset" options={['Today', 'Yesterday', '2–3 days ago', 'More than 3 days ago']} iv={booking.ivFluidsIntake} set={f => setBooking(b => ({ ...b, ivFluidsIntake: { ...b.ivFluidsIntake, ...f } }))} />
            </IvQ>

            <IvQ label="3. What symptoms is your child having?">
              <textarea value={booking.ivFluidsIntake.symptoms}
                onChange={e => setBooking(b => ({ ...b, ivFluidsIntake: { ...b.ivFluidsIntake, symptoms: e.target.value } }))}
                placeholder="Describe all symptoms..."
                rows={3}
                className="w-full px-3 py-2.5 border border-[#E8E8E4] rounded-lg text-[14px] font-sans resize-none outline-none focus:border-[#7F77DD] bg-white" />
            </IvQ>

            <IvQ label="4. Has your child been able to drink fluids today?">
              <IvRadios field="fluidIntake" options={['Yes, normally', 'Some, but much less than usual', 'Very little', 'Not at all / all oral fluids are coming back up']} iv={booking.ivFluidsIntake} set={f => setBooking(b => ({ ...b, ivFluidsIntake: { ...b.ivFluidsIntake, ...f } }))} />
            </IvQ>

            <IvQ label="5. Have you tried oral rehydration solution (Pedialyte or electrolyte drinks — small, frequent sips)?">
              <IvRadios field="oralRehydration" options={['Yes — and it helped', 'Yes — but child vomits it up', 'Yes — but child refuses', 'No']} iv={booking.ivFluidsIntake} set={f => setBooking(b => ({ ...b, ivFluidsIntake: { ...b.ivFluidsIntake, ...f } }))} />
            </IvQ>

            <IvQ label="6. When did your child last urinate?">
              <IvRadios field="lastUrination" options={['Within the last 4 hours', '4–8 hours ago', '8–12 hours ago', 'More than 12 hours ago', 'Not sure']} iv={booking.ivFluidsIntake} set={f => setBooking(b => ({ ...b, ivFluidsIntake: { ...b.ivFluidsIntake, ...f } }))} />
            </IvQ>

            <IvQ label="7. Has your child had diarrhea?">
              <IvRadios field="diarrhea" options={['No', 'Yes — mild (1–3 times/day)', 'Yes — frequent (4+ times/day)']} iv={booking.ivFluidsIntake} set={f => setBooking(b => ({ ...b, ivFluidsIntake: { ...b.ivFluidsIntake, ...f } }))} />
            </IvQ>

            <IvQ label="8. Has your child been vomiting?">
              <IvRadios field="vomiting" options={['No', 'Yes — 1–2 times', 'Yes — 3–5 times', 'Yes — more than 5 times']} iv={booking.ivFluidsIntake} set={f => setBooking(b => ({ ...b, ivFluidsIntake: { ...b.ivFluidsIntake, ...f } }))} />
            </IvQ>

            <IvQ label="9. How is your child acting right now?">
              <IvRadios field="activityLevel" options={['Normal', 'A little tired', 'Very tired / weak', 'Hard to wake up / unusually sleepy']} iv={booking.ivFluidsIntake} set={f => setBooking(b => ({ ...b, ivFluidsIntake: { ...b.ivFluidsIntake, ...f } }))} />
            </IvQ>

            <IvQ label="10. Are their lips or mouth dry?">
              <IvRadios field="mouthDryness" options={['No', 'A little', 'Very dry / cracked', 'Not sure']} iv={booking.ivFluidsIntake} set={f => setBooking(b => ({ ...b, ivFluidsIntake: { ...b.ivFluidsIntake, ...f } }))} />
            </IvQ>

            <IvQ label="11. Do they make tears when crying?">
              <IvRadios field="tears" options={['Yes', 'No', 'Not sure']} iv={booking.ivFluidsIntake} set={f => setBooking(b => ({ ...b, ivFluidsIntake: { ...b.ivFluidsIntake, ...f } }))} />
            </IvQ>

            <IvQ label="12. Has your child had a fever?">
              <IvRadios field="hasFever" options={['Yes', 'No']} iv={booking.ivFluidsIntake} set={f => setBooking(b => ({ ...b, ivFluidsIntake: { ...b.ivFluidsIntake, ...f } }))} />
              {booking.ivFluidsIntake.hasFever === 'Yes' && (
                <div className="mt-2">
                  <input value={booking.ivFluidsIntake.highestTemp}
                    onChange={e => setBooking(b => ({ ...b, ivFluidsIntake: { ...b.ivFluidsIntake, highestTemp: e.target.value } }))}
                    placeholder="What was the highest temperature? (e.g. 102.4°F)"
                    className="w-full px-3 py-2.5 border border-[#E8E8E4] rounded-lg text-[14px] font-sans outline-none focus:border-[#7F77DD]" />
                </div>
              )}
            </IvQ>

            <IvQ label="13. Does your child have any of the following? (Check all that apply)">
              <div className="space-y-2">
                {RED_FLAGS.map(flag => {
                  const isNone = flag === 'None of the above'
                  const checked = booking.ivFluidsIntake.redFlags.includes(flag)
                  return (
                    <button key={flag} onClick={() => setBooking(b => {
                      const current = b.ivFluidsIntake.redFlags
                      let next: string[]
                      if (isNone) {
                        next = checked ? [] : ['None of the above']
                      } else {
                        const withoutNone = current.filter(f => f !== 'None of the above')
                        next = checked ? withoutNone.filter(f => f !== flag) : [...withoutNone, flag]
                      }
                      return { ...b, ivFluidsIntake: { ...b.ivFluidsIntake, redFlags: next } }
                    })}
                      className={`w-full flex items-center gap-3 p-3 rounded-xl border-2 transition-all text-left
                        ${checked
                          ? isNone ? 'border-[#1D9E75] bg-[#E1F5EE]' : 'border-[#F09595] bg-[#FCEBEB]'
                          : 'border-[#E8E8E4] bg-white hover:border-[#AFA9EC]'}`}>
                      <div className={`w-4 h-4 rounded border-2 flex-shrink-0 flex items-center justify-center transition-all
                        ${checked ? (isNone ? 'bg-[#1D9E75] border-[#1D9E75]' : 'bg-[#791F1F] border-[#791F1F]') : 'border-[#D0D0CC]'}`}>
                        {checked && <Check size={10} className="text-white" strokeWidth={3} />}
                      </div>
                      <span className={`text-[13px] font-medium ${checked ? (isNone ? 'text-[#085041]' : 'text-[#791F1F]') : 'text-[#1A1A2E]'}`}>{flag}</span>
                    </button>
                  )
                })}
              </div>
            </IvQ>

            <IvQ label="14. Any other chronic medical conditions?">
              <input value={booking.ivFluidsIntake.otherConditions}
                onChange={e => setBooking(b => ({ ...b, ivFluidsIntake: { ...b.ivFluidsIntake, otherConditions: e.target.value } }))}
                placeholder="List any conditions, or leave blank if none"
                className="w-full px-3 py-2.5 border border-[#E8E8E4] rounded-lg text-[14px] font-sans outline-none focus:border-[#7F77DD]" />
            </IvQ>

            <IvQ label="15. Has your child received IV fluids recently?">
              <IvRadios field="recentIvFluids" options={['Yes', 'No']} iv={booking.ivFluidsIntake} set={f => setBooking(b => ({ ...b, ivFluidsIntake: { ...b.ivFluidsIntake, ...f } }))} />
            </IvQ>

            <IvQ label="16. Available times for your nurse visit">
              <input value={booking.ivFluidsIntake.availableTimes}
                onChange={e => setBooking(b => ({ ...b, ivFluidsIntake: { ...b.ivFluidsIntake, availableTimes: e.target.value } }))}
                placeholder='e.g. "Any time today" or "Any time before 5pm"'
                className="w-full px-3 py-2.5 border border-[#E8E8E4] rounded-lg text-[14px] font-sans outline-none focus:border-[#7F77DD]" />
              <p className="text-[11px] text-[#aeaeb2] mt-1">Your RN will come to your home after a video visit with one of our providers.</p>
            </IvQ>

            <button onClick={() => setBooking(b => ({ ...b, ivFluidsIntake: { ...b.ivFluidsIntake, consentUnderstood: !b.ivFluidsIntake.consentUnderstood } }))}
              className={`w-full flex items-start gap-3 p-4 rounded-xl border-2 transition-all text-left ${booking.ivFluidsIntake.consentUnderstood ? 'border-[#1D9E75] bg-[#E1F5EE]' : 'border-[#E8E8E4] bg-white hover:border-[#AFA9EC]'}`}>
              <div className={`w-5 h-5 rounded border-2 flex-shrink-0 flex items-center justify-center mt-0.5 transition-all ${booking.ivFluidsIntake.consentUnderstood ? 'bg-[#1D9E75] border-[#1D9E75]' : 'border-[#D0D0CC]'}`}>
                {booking.ivFluidsIntake.consentUnderstood && <Check size={11} className="text-white" strokeWidth={3} />}
              </div>
              <span className={`text-[13px] leading-relaxed ${booking.ivFluidsIntake.consentUnderstood ? 'text-[#085041] font-medium' : 'text-[#555]'}`}>
                I understand that IV fluids will only be provided if medically necessary after a video visit with one of the {PRACTICE_NAME} providers.
              </span>
            </button>

          </div>

          <NavButtons
            onBack={() => setStep(STEP_INTAKE)}
            nextDisabled={
              !booking.ivFluidsIntake.symptomOnset ||
              !booking.ivFluidsIntake.symptoms ||
              !booking.ivFluidsIntake.fluidIntake ||
              !booking.ivFluidsIntake.oralRehydration ||
              !booking.ivFluidsIntake.lastUrination ||
              !booking.ivFluidsIntake.diarrhea ||
              !booking.ivFluidsIntake.vomiting ||
              !booking.ivFluidsIntake.activityLevel ||
              !booking.ivFluidsIntake.mouthDryness ||
              !booking.ivFluidsIntake.tears ||
              !booking.ivFluidsIntake.hasFever ||
              booking.ivFluidsIntake.redFlags.length === 0 ||
              !booking.ivFluidsIntake.recentIvFluids ||
              !booking.ivFluidsIntake.availableTimes ||
              !booking.ivFluidsIntake.consentUnderstood
            }
            onNext={() => setStep(STEP_LOCATION)}
          />
        </Step>
      )}

      {/* ── When + where ── */}
      {step === STEP_LOCATION && (
        <Step title="When & where" sub="Choose your date, time, and provider.">
          <div className="mb-5">
            <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-1">Visit date</label>
            <input type="date" value={booking.date} min={new Date().toISOString().split('T')[0]}
              onChange={e => { setBooking(b => ({ ...b, date: e.target.value, time: '' })); loadBookedTimes(booking.provider, e.target.value) }}
              className="px-3 py-2.5 border border-[#E8E8E4] rounded-lg text-[14px] font-sans" />
          </div>

          {booking.date && (() => {
            const availableSlots = (slotsChecking || allSlotsBooked) ? [] : getAvailableSlots(byType[booking.visitType]?.lead_minutes ?? 60, booking.date).filter(slot => {
              const [t, ampm] = slot.split(' ')
              let [h, m] = t.split(':').map(Number)
              if (ampm === 'PM' && h !== 12) h += 12
              if (ampm === 'AM' && h === 12) h = 0
              const slotMin = h * 60 + m
              // Filter by provider's allowed hours for this visit type
              if (visitTypeWindow) {
                const [wsh, wsm] = visitTypeWindow.start.split(':').map(Number)
                const [weh, wem] = visitTypeWindow.end.split(':').map(Number)
                if (slotMin < wsh * 60 + wsm || slotMin >= weh * 60 + wem) return false
              }
              // Check if any booked appointment overlaps this slot
              return !bookedSlots.some(({ time: bt, duration }) => {
                const [bh, bm] = bt.split(':').map(Number)
                const bookedMin = bh * 60 + bm
                return slotMin >= bookedMin && slotMin < bookedMin + duration
              })
            })
            return (
              <div className="mb-5">
                <p className="text-[12px] font-semibold text-[#555] uppercase tracking-wider mb-2">Available times</p>
                {slotsChecking ? (
                  <div className="text-center py-5 border border-[#E8E8E4] rounded-lg bg-[#FAFAF8]">
                    <p className="text-[13px] text-[#999]">Checking availability…</p>
                  </div>
                ) : availableSlots.length === 0 ? (
                  <div className="text-center py-5 border border-[#E8E8E4] rounded-lg bg-[#FAFAF8]">
                    <p className="text-[13px] text-[#999]">
                      {allSlotsBooked ? 'No availability on this date.' : 'No more same-day slots available.'}
                    </p>
                    <p className="text-[12px] text-[#bbb] mt-1">
                      {allSlotsBooked ? 'This provider is not available on the selected date. Try a different date.' : 'Please select a future date to continue.'}
                    </p>
                  </div>
                ) : (
                  <div className="grid grid-cols-4 gap-1.5">
                    {availableSlots.map(slot => (
                      <button key={slot} onClick={() => setBooking(b => ({ ...b, time: slot }))}
                        className={`py-2 text-center text-[12px] rounded-lg border-2 transition-all font-sans ${booking.time === slot ? 'bg-[#7F77DD] border-[#7F77DD] text-white' : 'border-[#E8E8E4] bg-white hover:border-[#AFA9EC] text-[#1A1A2E]'}`}>
                        {slot}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )
          })()}

          {/* Address shown in location step only for non-CPR types (CPR collects it in participants step) */}
          {!isCpr && (byType[booking.visitType]?.is_in_home ?? true) && (
            <div className="mb-5">
              <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-1">
                Visit address <span className="text-[#ff3b30]">*</span>
              </label>
              <input value={booking.visitAddress}
                onChange={e => setBooking(b => ({ ...b, visitAddress: e.target.value }))}
                placeholder="123 Main St, Charlotte, NC 28078"
                className="w-full px-3 py-2.5 border border-[#E8E8E4] rounded-lg text-[14px] font-sans focus:border-[#7F77DD] focus:ring-2 focus:ring-[#7F77DD]/10 outline-none" />
              <p className="text-[11px] text-[#aeaeb2] mt-1">Where should your provider come? This is shared with your provider for navigation.</p>
            </div>
          )}

          {/* CPR: show selected address as read-only confirmation */}
          {isCpr && booking.visitAddress && (
            <div className="mb-5 p-3 bg-[#FDEDEC] border border-[#F5B7B1] rounded-lg text-[13px] text-[#922B21]">
              <span className="font-semibold">Address: </span>{booking.visitAddress}
            </div>
          )}

          {/* Zip / zone / provider selection — hidden for CPR */}
          {!isCpr && <>
          <div className="grid grid-cols-2 gap-3 mb-4">
            <div>
              <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-1">State</label>
              <select value={booking.state} onChange={e => setBooking(b => ({ ...b, state: e.target.value }))}
                className="w-full px-3 py-2.5 border border-[#E8E8E4] rounded-lg text-[14px] font-sans bg-white">
                <option value="">Select state</option>
                <option value="NC">North Carolina</option>
                <option value="SC">South Carolina</option>
                <option value="VA">Virginia</option>
              </select>
            </div>
            <div>
              <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-1">Zip code</label>
              <input value={booking.zip} onChange={e => onZipChange(e.target.value)} maxLength={5} placeholder="e.g. 28078"
                className="w-full px-3 py-2.5 border border-[#E8E8E4] rounded-lg text-[14px] font-sans" />
            </div>
          </div>

          {booking.zip.length === 5 && !waitlistDone && !isTele &&
           (!booking.zone || waitlistZones.includes(booking.zone) || regularZoneProviders.length === 0) && (
            <div className="border border-[#FAC775] bg-[#FAEEDA] rounded-xl p-4 mb-4 space-y-3">
              <div>
                <p className="text-[14px] font-semibold text-[#633806]">We don't currently serve zip code {booking.zip}.</p>
                <p className="text-[13px] text-[#633806] mt-1 leading-relaxed">
                  We're always expanding — join our waitlist and we'll contact you as soon as we have a provider in your area.
                </p>
              </div>
              <button onClick={() => {
                const firstId = booking.selectedChildIds[0]
                const intake = firstId ? booking.childIntakes[firstId] : null
                const labels = booking.selectedChildIds.map(id => booking.childIntakes[id]?.displayLabel).filter(Boolean)
                setWaitlistPatient(labels.join(', '))
                setWaitlistComplaint(intake?.chiefComplaint || '')
                setWaitlistAddress(booking.visitAddress || '')
                setWaitlistOpen(true)
              }}
                className="w-full py-2.5 bg-[#EF9F27] text-white rounded-xl text-[13px] font-semibold hover:bg-[#BA7517] transition-colors">
                Join the waitlist
              </button>
            </div>
          )}

          {booking.date && booking.zone && !waitlistZones.includes(booking.zone) && zoneProviders.length > 0 && (noAvailableSlots || allSlotsBooked) && !waitlistDone && (
            <div className="mb-4 space-y-2">
              <p className="text-[13px] font-semibold text-[#633806]">
                {booking.provider && booking.provider !== '__first_available__' ? `No availability with ${booking.provider} on this date.` : 'No availability on this date.'}
              </p>
              <div className={`flex gap-3 items-stretch`}>
                {/* Waitlist card */}
                <div className="flex-1 border border-[#FAC775] bg-[#FAEEDA] rounded-xl p-4 flex flex-col gap-3">
                  <div>
                    <p className="text-[13px] font-semibold text-[#633806]">Join our waitlist</p>
                    <p className="text-[12px] text-[#633806] mt-1 leading-relaxed">
                      We'll reach out as soon as a spot opens up on your preferred date.
                    </p>
                  </div>
                  <button onClick={() => {
                    const firstId = booking.selectedChildIds[0]
                    const intake = firstId ? booking.childIntakes[firstId] : null
                    const labels = booking.selectedChildIds.map(id => booking.childIntakes[id]?.displayLabel).filter(Boolean)
                    setWaitlistPatient(labels.join(', '))
                    setWaitlistComplaint(intake?.chiefComplaint || '')
                    setWaitlistAddress(booking.visitAddress || '')
                    setWaitlistOpen(true)
                  }}
                    className="mt-auto w-full py-2.5 bg-[#EF9F27] text-white rounded-xl text-[13px] font-semibold hover:bg-[#BA7517] transition-colors">
                    Join the waitlist
                  </button>
                </div>

                {/* CMA + telemedicine card — shown when CMAs cover this zone */}
                {cmaProvidersForZone.length > 0 && (
                  <div className="flex-1 bg-[#E6F1FB] border border-[#A3C4E8] rounded-xl p-4 flex flex-col gap-3">
                    <div>
                      <p className="text-[13px] font-semibold text-[#0C447C]">CMA + telemedicine visit</p>
                      <p className="text-[12px] text-[#1A3560] mt-1 leading-relaxed">
                        One of our in-home techs comes to you for diagnostics (ear exam, strep, urine, flu/COVID testing) while our provider sees you virtually.
                      </p>
                      {cmaAvailResult && (
                        <p className="text-[12px] text-[#1A3560] mt-1">
                          <strong>{cmaAvailResult.name}</strong> available at <strong>{cmaAvailResult.firstSlot}</strong>.
                        </p>
                      )}
                    </div>
                    <button
                      onClick={() => {
                        const result = cmaAvailResult
                        setCmaAvailResult(null)
                        if (result) {
                          setBooking(b => ({ ...b, visitType: 'CMA + telemedicine', provider: result.name, time: result.firstSlot }))
                          loadBookedTimes(result.name, booking.date)
                        } else {
                          setBooking(b => ({ ...b, visitType: 'CMA + telemedicine', provider: '' }))
                        }
                      }}
                      className="mt-auto w-full py-2.5 bg-[#0C447C] text-white rounded-xl text-[13px] font-semibold hover:bg-[#0a3666] transition-colors">
                      Schedule this option
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}

          {waitlistDone && (
            <div className="border border-[#5DCAA5] bg-[#E1F5EE] rounded-xl p-4 mb-4">
              <p className="text-[14px] font-semibold text-[#085041]">You're on the waitlist!</p>
              <p className="text-[13px] text-[#085041] mt-1">We'll reach out as soon as we have a provider available in your area.</p>
            </div>
          )}
          {booking.zone && (
            <div className="p-3 rounded-lg bg-[#EEEDFE] border border-[#AFA9EC] text-[13px] text-[#3C3489] mb-4">
              Zone: <strong>{booking.zone}</strong>
            </div>
          )}

          {zoneProviders.length > 0 && (
            <div>
              <p className="text-[12px] font-semibold text-[#555] uppercase tracking-wider mb-2">Provider</p>
              <div className="space-y-2 mb-4">
                {zoneProviders.length > 1 && (
                  <button
                    onClick={() => {
                      setFirstAvailResult(null)
                      setBooking(b => ({ ...b, provider: '__first_available__', time: '' }))
                      if (booking.date) findFirstAvailable(booking.date)
                    }}
                    className={`w-full flex items-center gap-3 p-3 rounded-xl border-2 transition-all text-left ${booking.provider === '__first_available__' ? 'border-[#1D9E75] bg-[#E1F5EE]' : 'border-[#E8E8E4] bg-white hover:border-[#A8DDD0]'}`}>
                    <div className="w-10 h-10 rounded-full flex items-center justify-center text-[16px] flex-shrink-0 bg-[#E1F5EE]">⚡</div>
                    <div className="flex-1">
                      <div className="font-display text-[14px] font-medium text-[#1A1A2E]">First available provider</div>
                      <div className="text-[12px] text-[#555]">
                        {booking.provider === '__first_available__'
                          ? findingFirstAvail
                            ? 'Checking availability…'
                            : firstAvailResult
                              ? `${firstAvailResult.provider} · ${firstAvailResult.time}`
                              : booking.date ? 'No availability on this date — try another' : 'Select a date first'
                          : 'Automatically assigned to the soonest available'}
                      </div>
                    </div>
                    {booking.provider === '__first_available__' && firstAvailResult && (
                      <div className="w-5 h-5 rounded-full bg-[#1D9E75] flex items-center justify-center flex-shrink-0"><Check size={10} className="text-white" /></div>
                    )}
                  </button>
                )}
                {zoneProviders.map(p => (
                  <button key={p.name} onClick={() => { setFirstAvailResult(null); setBooking(b => ({ ...b, provider: p.name, time: '' })); loadBookedTimes(p.name, booking.date) }}
                    className={`w-full flex items-center gap-3 p-3 rounded-xl border-2 transition-all text-left ${booking.provider === p.name ? 'border-[#7F77DD] bg-[#EEEDFE]' : 'border-[#E8E8E4] bg-white hover:border-[#AFA9EC]'}`}>
                    <div className="w-10 h-10 rounded-full flex items-center justify-center text-[13px] font-medium flex-shrink-0"
                      style={{ background: p.color, color: p.textColor }}>{p.initials}</div>
                    <div className="flex-1">
                      <div className="font-display text-[14px] font-medium text-[#1A1A2E]">{p.name}</div>
                      <div className="text-[12px] text-[#555]">{p.role}</div>
                    </div>
                    {booking.provider === p.name && <div className="w-5 h-5 rounded-full bg-[#7F77DD] flex items-center justify-center"><Check size={10} className="text-white" /></div>}
                  </button>
                ))}
              </div>

              {secureTextProviders.length > 0 && (
                <div className="border border-[#E8E8E4] rounded-xl p-4 bg-[#FAFAF8]">
                  <p className="text-[12px] font-semibold text-[#555] uppercase tracking-wider mb-1">Need to reach a provider directly?</p>
                  <p className="text-[12px] text-[#999] mb-3">Text your zone's providers using their secure numbers — separate from their personal cell phones.</p>
                  <div className="space-y-2">
                    {secureTextProviders.map((p: any) => (
                      <a key={p.name} href={`sms:${p.secure_text_number}`}
                        className="flex items-center justify-between p-3 bg-white rounded-lg border border-[#E8E8E4] hover:border-[#7F77DD] hover:bg-[#EEEDFE] transition-all">
                        <div>
                          <div className="text-[13px] font-medium text-[#1A1A2E]">{p.name}</div>
                          <div className="text-[11px] text-[#999]">{p.role}</div>
                        </div>
                        <div className="text-[13px] font-semibold text-[#7F77DD]">{p.secure_text_number}</div>
                      </a>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          </>}

          <NavButtons
            onBack={() => setStep(isCpr ? STEP_INTAKE : isIvFluids ? STEP_IV : STEP_INTAKE)}
            nextDisabled={
              isCpr
                ? (!booking.date || !booking.time)
                : (!booking.date || !booking.time || !booking.zone ||
                   waitlistZones.includes(booking.zone) ||
                   zoneProviders.length === 0 ||
                   (!booking.provider && zoneProviders.length > 0) ||
                   (booking.provider === '__first_available__' && !firstAvailResult) ||
                   ((byType[booking.visitType]?.is_in_home ?? true) && !booking.visitAddress))
            }
            onNext={() => setStep(STEP_CONFIRM)} />
        </Step>
      )}

      {/* ── STEP 3: Confirm ── */}
      {step === STEP_CONFIRM && (
        <Step title="Review your appointment" sub="Confirm everything looks correct before submitting.">
          <div className="divide-y divide-[#E8E8E4] mb-5">
            {(isCpr ? [
              ['Visit type', booking.visitType],
              ['Instructor', 'Melissa Jesse'],
              ['Participants', `${booking.participantCount} person${booking.participantCount > 1 ? 's' : ''}`],
              ['Date', format(new Date(booking.date + 'T12:00:00'), 'EEEE, MMMM d, yyyy')],
              ['Time', booking.time],
              ['Address', booking.visitAddress],
              ...(booking.participantNames ? [['Attendees', booking.participantNames]] : []),
            ] : [
              ['Visit type', booking.visitType],
              ['Children', selectedChildren.map(c => c.display_label).join(' & ')],
              ['Provider', booking.provider === '__first_available__' ? (firstAvailResult?.provider || 'Any available') : (booking.provider || 'Any available')],
              ['Zone', booking.zone],
              ['Date', format(new Date(booking.date + 'T12:00:00'), 'EEEE, MMMM d, yyyy')],
              ['Time', booking.time],
              ...(booking.visitAddress ? [['Address', booking.visitAddress]] : []),
            ]).map(([label, value]) => (
              <div key={label} className="flex justify-between py-3 text-[14px]">
                <span className="text-[#555]">{label}</span>
                <span className="font-medium text-[#1A1A2E] text-right max-w-[55%]">{value}</span>
              </div>
            ))}
            {!isCpr && (byType[booking.visitType]?.has_convenience_fee ?? true) && (
              <div className="flex justify-between py-3 text-[14px]">
                <span className="text-[#555]">Estimated convenience fee</span>
                <span className="font-medium text-[#1A1A2E]">
                  {convFeeLoading ? <span className="text-[#999] text-[12px]">Calculating…</span>
                    : convFee ? `$${convFee.fee}`
                    : <span className="text-[#999] text-[12px]">Unavailable</span>}
                </span>
              </div>
            )}
          </div>

          {isCpr ? (
            <div className="space-y-3 mb-5">
              <div className="p-3.5 bg-[#FDEDEC] border border-[#F5B7B1] rounded-xl text-[13px] text-[#922B21]">
                <strong>E-learning required:</strong> After booking, you'll receive an e-learning link by email. All participants must complete it before class day.
              </div>
              <div className="p-3.5 bg-[#E8F8F5] border border-[#A9DFBF] rounded-xl text-[13px] text-[#1E8449]">
                <strong>Payment:</strong> Venmo <strong>@{VENMO_HANDLE}</strong> — ${booking.participantCount * 80} total (${booking.participantCount} × $80).
              </div>
              <div className="p-3.5 bg-[#EBF5FB] border border-[#AED6F1] rounded-xl text-[13px] text-[#1A5276]">
                <strong>Attendee names:</strong> Please email the full names of all attendees to <strong>deeringmel@me.com</strong> so Melissa can prepare completion cards.
              </div>
            </div>
          ) : (
            <>
              {selectedChildren.map(c => {
                const intake = booking.childIntakes[c.id]
                if (!intake?.chiefComplaint) return null
                return (
                  <div key={c.id} className="mb-3 p-3 bg-[#FAFAF8] border border-[#E8E8E4] rounded-lg">
                    <div className="text-[12px] font-semibold text-[#555] mb-1">{c.display_label}</div>
                    <div className="text-[13px] text-[#1A1A2E]"><span className="text-[#999]">Complaint: </span>{intake.chiefComplaint}</div>
                  </div>
                )
              })}

              {!(family as any)?.referral_source && (
                <div className="mb-4">
                  <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-1.5">
                    How did you hear about us? <span className="text-[#999] normal-case font-normal">(optional)</span>
                  </label>
                  <input type="text" value={referralSource} onChange={e => setReferralSource(e.target.value)}
                    placeholder="e.g. Google, friend referral, pediatrician..."
                    className="w-full px-3 py-2.5 border border-[#E8E8E4] rounded-lg text-[14px] font-sans outline-none focus:border-[#00B5B8]" />
                </div>
              )}
              <div className="p-3 rounded-lg bg-[#FAEEDA] border border-[#FAC775] text-[12px] text-[#633806] mb-5">
                <strong>Cancellation policy:</strong> Cancellations within 2 hours of your appointment for in-person visits are subject to a $75 fee.
              </div>
              {isIvFluids && (
                <div className="mb-4 p-3 bg-[#FAFAF8] border border-[#E8E8E4] rounded-lg text-[13px] space-y-1">
                  <div className="text-[12px] font-semibold text-[#555] uppercase tracking-wider mb-2">IV Fluids screening</div>
                  <div><span className="text-[#999]">Symptoms: </span>{booking.ivFluidsIntake.symptoms}</div>
                  <div><span className="text-[#999]">Onset: </span>{booking.ivFluidsIntake.symptomOnset}</div>
                  <div><span className="text-[#999]">Fluid intake: </span>{booking.ivFluidsIntake.fluidIntake}</div>
                  <div><span className="text-[#999]">Vomiting: </span>{booking.ivFluidsIntake.vomiting}</div>
                  <div><span className="text-[#999]">Last urination: </span>{booking.ivFluidsIntake.lastUrination}</div>
                  <div><span className="text-[#999]">Available times: </span>{booking.ivFluidsIntake.availableTimes}</div>
                </div>
              )}
            </>
          )}
          {needsAgreements && (
            <button onClick={() => setAgreementsAccepted(v => !v)}
              className={`w-full flex items-start gap-3 p-4 rounded-xl border-2 transition-all text-left mb-2 ${agreementsAccepted ? 'border-[#7F77DD] bg-[#EEEDFE]' : 'border-[#E8E8E4] bg-white hover:border-[#AFA9EC]'}`}>
              <div className={`w-5 h-5 rounded border-2 flex-shrink-0 flex items-center justify-center mt-0.5 transition-all ${agreementsAccepted ? 'bg-[#7F77DD] border-[#7F77DD]' : 'border-[#D0D0CC]'}`}>
                {agreementsAccepted && <Check size={11} className="text-white" strokeWidth={3} />}
              </div>
              <span className={`text-[13px] leading-relaxed ${agreementsAccepted ? 'text-[#3C3489] font-medium' : 'text-[#555]'}`}>
                By checking, you accept our{' '}
                <span className="underline">Terms of Service</span>, acknowledge that you have read and understood our{' '}
                <span className="underline">Privacy Policy</span>, and consent to receive SMS communications about your appointments and/or waitlist availability from {PRACTICE_NAME}. Message frequency may vary. Message and data rates may apply. Reply HELP for help or STOP to opt-out.{' '}
                <span className="text-[#ff3b30]">*</span>
              </span>
            </button>
          )}

          {needsPaymentPolicy && (
            <div className="mb-2">
              <div className="text-[11px] font-semibold text-[#555] uppercase tracking-wider mb-1.5">Payment Policy</div>
              <div className="max-h-48 overflow-y-auto border border-[#E8E8E4] rounded-xl bg-[#FAFAF8] p-4 text-[12px] text-[#555] leading-relaxed mb-3 space-y-3">
                <p className="font-bold text-[#1A1A2E] uppercase">WE NOW REQUIRE ALL FAMILIES TO HAVE AN UPDATED CREDIT CARD SAVED ON FILE, EVEN IF YOU ONLY PLAN ON USING US ONE TIME.</p>
                <p>{PRACTICE_NAME} requires a valid credit card number at the time of the appointment request but no charges will be made to the card at that time. A convenience fee will be charged to this credit card after the visit has been completed. This is a non-covered service, meaning that it is in addition to your copay, and is simply the cost to cover our time and travel to your home. If the provider assigned to your area is unavailable, we are often able to pull other providers from other areas, but there may be an added convenience fee to offset the extra distance/travel time. We will make every effort to accommodate an appointment with a provider in your area to help keep cost down, but please understand the constraints of travel time, particularly during busy times of year.</p>
                <p>If using insurance, we will file the claim for the visit with your insurance company for you, and it often takes the insurance company 90 days to process the claims. Once the claim has been processed, we will email a billing statement to you, to notify you if any portion of the cost of the visit was applied toward your deductible, leaving you responsible for the remaining (or full) amount. We will give you the choice of paying online through Bill Flash. If not paid online through Bill Flash within 2 weeks, your credit card on file will automatically be charged for the amount owed and an itemized receipt will automatically be emailed to you.</p>
                <p>Many employee-sponsored health insurance plans have moved to high-deductible plans, leaving a large burden of the cost to the patient. Knowing whether or not you have met your annual deductible, and knowing your particular plan's policy regarding urgent care visits, will allow you to anticipate what percentage of the cost of a housecall visit you will be responsible for.</p>
                <p>Your credit card information will always be fully protected and encrypted by our off-site, card-processing partner, and not on our computers, as required by industry standards (Payment Card Industry Data Security Standard – PCI-DSS).</p>
                <p>For questions about billing, please email <strong>info@pedshousecalls.com</strong> or call our Patient Services Coordinator, Pam, at <strong>704-315-7697</strong>.</p>
              </div>
              <button onClick={() => setPaymentPolicyAccepted(v => !v)}
                className={`w-full flex items-start gap-3 p-4 rounded-xl border-2 transition-all text-left ${paymentPolicyAccepted ? 'border-[#1D9E75] bg-[#E1F5EE]' : 'border-[#E8E8E4] bg-white hover:border-[#7DCFB8]'}`}>
                <div className={`w-5 h-5 rounded border-2 flex-shrink-0 flex items-center justify-center mt-0.5 transition-all ${paymentPolicyAccepted ? 'bg-[#1D9E75] border-[#1D9E75]' : 'border-[#D0D0CC]'}`}>
                  {paymentPolicyAccepted && <Check size={11} className="text-white" strokeWidth={3} />}
                </div>
                <span className={`text-[13px] leading-relaxed ${paymentPolicyAccepted ? 'text-[#085041] font-medium' : 'text-[#555]'}`}>
                  I have read and understand the payment policy.{' '}
                  <span className="text-[#ff3b30]">*</span>
                </span>
              </button>
            </div>
          )}

          {submitError && (
            <div className="p-3 rounded-lg bg-[#FCEBEB] text-[13px] text-[#791F1F] mb-3">{submitError}</div>
          )}
          <NavButtons
            onBack={() => setStep(STEP_LOCATION)}
            nextLabel="Confirm appointment"
            loading={submitting}
            nextDisabled={(needsAgreements && !agreementsAccepted) || (needsPaymentPolicy && !paymentPolicyAccepted)}
            onNext={() => { setSubmitError(null); submit() }}
          />
        </Step>
      )}

      {/* ── Waitlist modal ── */}
      {waitlistOpen && (() => {
        const profiledChildren = children.filter(c => c.first_name || c.charm_patient_id)
        const hasProfiles = profiledChildren.length > 0
        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" onClick={() => setWaitlistOpen(false)} />
            <div className="relative bg-white rounded-2xl shadow-xl w-full max-w-sm p-6 max-h-[90vh] overflow-y-auto">
              <h2 className="font-display text-lg font-medium text-[#1A1A2E] mb-1">Join the waitlist</h2>
              <p className="text-[13px] text-[#555] mb-5 leading-relaxed">
                We'll notify you as soon as we have a provider available in <strong>{booking.zip}</strong>.
              </p>
              <div className="space-y-4">

                {hasProfiles ? (
                  <>
                    {/* Returning family — simplified form */}
                    {profiledChildren.length > 1 && (
                      <div>
                        <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-1">Which child is this for? <span className="text-[#ff3b30]">*</span></label>
                        <select value={waitlistChildId} onChange={e => setWaitlistChildId(e.target.value)}
                          className="w-full px-3 py-2.5 border border-[#E8E8E4] rounded-lg text-[14px] font-sans bg-white outline-none focus:border-[#7F77DD]">
                          <option value="">Select a child</option>
                          {profiledChildren.map(c => (
                            <option key={c.id} value={c.id}>{c.display_label}</option>
                          ))}
                        </select>
                      </div>
                    )}
                    {profiledChildren.length === 1 && !waitlistChildId && (() => { setTimeout(() => setWaitlistChildId(profiledChildren[0].id), 0); return null })()}

                    <div>
                      <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-1">Symptoms / chief complaint <span className="text-[#ff3b30]">*</span></label>
                      <textarea value={waitlistComplaint} onChange={e => setWaitlistComplaint(e.target.value)}
                        placeholder="Describe what's going on..."
                        rows={3}
                        className="w-full px-3 py-2.5 border border-[#E8E8E4] rounded-lg text-[14px] font-sans resize-none outline-none focus:border-[#7F77DD] bg-white" />
                    </div>

                    <div>
                      <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-1">Preferred time window</label>
                      <select value={waitlistTime} onChange={e => setWaitlistTime(e.target.value)}
                        className="w-full px-3 py-2.5 border border-[#E8E8E4] rounded-lg text-[14px] font-sans bg-white">
                        <option value="">Any time</option>
                        <option>Morning (before noon)</option>
                        <option>Afternoon (noon–5pm)</option>
                        <option>After 5pm</option>
                        <option>Weekdays only</option>
                        <option>Weekends OK</option>
                      </select>
                    </div>

                    <div>
                      <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-1">Additional notes</label>
                      <textarea value={waitlistNotes} onChange={e => setWaitlistNotes(e.target.value)}
                        placeholder="Anything else we should know..."
                        rows={2}
                        className="w-full px-3 py-2.5 border border-[#E8E8E4] rounded-lg text-[14px] font-sans resize-none outline-none focus:border-[#7F77DD] bg-white" />
                    </div>
                  </>
                ) : (
                  <>
                    {/* New family — full form */}
                    <div className="text-[10px] font-semibold text-[#999] uppercase tracking-widest pt-1">Patient information</div>
                    <div>
                      <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-1">Patient name <span className="text-[#ff3b30]">*</span></label>
                      <input value={waitlistPatient} onChange={e => setWaitlistPatient(e.target.value)}
                        placeholder="Child's full name"
                        className="w-full px-3 py-2.5 border border-[#E8E8E4] rounded-lg text-[14px] font-sans outline-none focus:border-[#7F77DD] bg-white" />
                    </div>
                    <div>
                      <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-1">Date of birth</label>
                      <input type="date" value={waitlistDOB} onChange={e => setWaitlistDOB(e.target.value)}
                        className="w-full px-3 py-2.5 border border-[#E8E8E4] rounded-lg text-[14px] font-sans outline-none focus:border-[#7F77DD] bg-white" />
                    </div>
                    <div>
                      <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-1">Contact phone number</label>
                      <input type="tel" value={waitlistPhone} onChange={e => setWaitlistPhone(e.target.value)}
                        placeholder="(704) 555-0000"
                        className="w-full px-3 py-2.5 border border-[#E8E8E4] rounded-lg text-[14px] font-sans outline-none focus:border-[#7F77DD] bg-white" />
                    </div>
                    <div>
                      <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-1">Visit address</label>
                      <input value={waitlistAddress} onChange={e => setWaitlistAddress(e.target.value)}
                        placeholder="123 Main St, City, State"
                        className="w-full px-3 py-2.5 border border-[#E8E8E4] rounded-lg text-[14px] font-sans outline-none focus:border-[#7F77DD] bg-white" />
                    </div>

                    <div className="text-[10px] font-semibold text-[#999] uppercase tracking-widest pt-2">Clinical information</div>
                    <div>
                      <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-1">Symptoms / chief complaint <span className="text-[#ff3b30]">*</span></label>
                      <textarea value={waitlistComplaint} onChange={e => setWaitlistComplaint(e.target.value)}
                        placeholder="Describe what's going on..."
                        rows={2}
                        className="w-full px-3 py-2.5 border border-[#E8E8E4] rounded-lg text-[14px] font-sans resize-none outline-none focus:border-[#7F77DD] bg-white" />
                    </div>
                    <div>
                      <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-1">Allergies</label>
                      <input value={waitlistAllergies} onChange={e => setWaitlistAllergies(e.target.value)}
                        placeholder="e.g. Penicillin, peanuts — or 'NKDA'"
                        className="w-full px-3 py-2.5 border border-[#E8E8E4] rounded-lg text-[14px] font-sans outline-none focus:border-[#7F77DD] bg-white" />
                    </div>
                    <div>
                      <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-1">Current medications</label>
                      <textarea value={waitlistMedications} onChange={e => setWaitlistMedications(e.target.value)}
                        placeholder="List any current medications and doses..."
                        rows={2}
                        className="w-full px-3 py-2.5 border border-[#E8E8E4] rounded-lg text-[14px] font-sans resize-none outline-none focus:border-[#7F77DD] bg-white" />
                    </div>
                    <div>
                      <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-1">Past medical history</label>
                      <textarea value={waitlistPMH} onChange={e => setWaitlistPMH(e.target.value)}
                        placeholder="Chronic conditions, prior hospitalizations, surgeries..."
                        rows={2}
                        className="w-full px-3 py-2.5 border border-[#E8E8E4] rounded-lg text-[14px] font-sans resize-none outline-none focus:border-[#7F77DD] bg-white" />
                    </div>

                    <div className="text-[10px] font-semibold text-[#999] uppercase tracking-widest pt-2">Providers & pharmacy</div>
                    <div>
                      <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-1">Primary care provider</label>
                      <input value={waitlistPCP} onChange={e => setWaitlistPCP(e.target.value)}
                        placeholder="e.g. Dr. Smith, Charlotte Pediatrics, 456 Park Rd, Charlotte, NC 28209"
                        className="w-full px-3 py-2.5 border border-[#E8E8E4] rounded-lg text-[14px] font-sans outline-none focus:border-[#7F77DD] bg-white" />
                    </div>
                    <div>
                      <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-1">Preferred pharmacy</label>
                      <input value={waitlistPharmacy} onChange={e => setWaitlistPharmacy(e.target.value)}
                        placeholder="e.g. CVS, 123 Main St, Charlotte, NC 28078"
                        className="w-full px-3 py-2.5 border border-[#E8E8E4] rounded-lg text-[14px] font-sans outline-none focus:border-[#7F77DD] bg-white" />
                    </div>

                    <div className="text-[10px] font-semibold text-[#999] uppercase tracking-widest pt-2">Insurance</div>
                    <div>
                      <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-1">Insurance provider</label>
                      <input value={waitlistInsurance} onChange={e => setWaitlistInsurance(e.target.value)}
                        placeholder="e.g. Blue Cross Blue Shield"
                        className="w-full px-3 py-2.5 border border-[#E8E8E4] rounded-lg text-[14px] font-sans outline-none focus:border-[#7F77DD] bg-white" />
                    </div>
                    <div>
                      <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-1">Member ID</label>
                      <input value={waitlistInsuranceMemberId} onChange={e => setWaitlistInsuranceMemberId(e.target.value)}
                        placeholder="Member / subscriber ID"
                        className="w-full px-3 py-2.5 border border-[#E8E8E4] rounded-lg text-[14px] font-sans outline-none focus:border-[#7F77DD] bg-white" />
                    </div>
                    <div>
                      <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-1">Group number</label>
                      <input value={waitlistInsuranceGroupNum} onChange={e => setWaitlistInsuranceGroupNum(e.target.value)}
                        placeholder="Group #"
                        className="w-full px-3 py-2.5 border border-[#E8E8E4] rounded-lg text-[14px] font-sans outline-none focus:border-[#7F77DD] bg-white" />
                    </div>
                    <div>
                      <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-1">Subscriber name (if different from patient)</label>
                      <input value={waitlistInsuranceSubscriber} onChange={e => setWaitlistInsuranceSubscriber(e.target.value)}
                        placeholder="Subscriber's full name"
                        className="w-full px-3 py-2.5 border border-[#E8E8E4] rounded-lg text-[14px] font-sans outline-none focus:border-[#7F77DD] bg-white" />
                    </div>

                    <div className="text-[10px] font-semibold text-[#999] uppercase tracking-widest pt-2">Scheduling</div>
                    <div>
                      <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-1">Preferred time window</label>
                      <select value={waitlistTime} onChange={e => setWaitlistTime(e.target.value)}
                        className="w-full px-3 py-2.5 border border-[#E8E8E4] rounded-lg text-[14px] font-sans bg-white">
                        <option value="">Any time</option>
                        <option>Morning (before noon)</option>
                        <option>Afternoon (noon–5pm)</option>
                        <option>After 5pm</option>
                        <option>Weekdays only</option>
                        <option>Weekends OK</option>
                      </select>
                    </div>
                    <div>
                      <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-1">Additional notes</label>
                      <textarea value={waitlistNotes} onChange={e => setWaitlistNotes(e.target.value)}
                        placeholder="Anything else we should know..."
                        rows={2}
                        className="w-full px-3 py-2.5 border border-[#E8E8E4] rounded-lg text-[14px] font-sans resize-none outline-none focus:border-[#7F77DD] bg-white" />
                    </div>
                  </>
                )}

                <div className="flex gap-2 pt-1">
                  <Button variant="secondary" size="sm" className="flex-1" onClick={() => setWaitlistOpen(false)}>Cancel</Button>
                  <Button size="sm" className="flex-1" loading={waitlistSubmitting} onClick={submitWaitlist}>
                    Join waitlist
                  </Button>
                </div>
              </div>
            </div>
          </div>
        )
      })()}
    </div>
  )
}

function compressToJpeg(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    const objectUrl = URL.createObjectURL(file)
    img.onload = () => {
      URL.revokeObjectURL(objectUrl)
      const MAX = 1400
      let w = img.width, h = img.height
      if (w > MAX || h > MAX) {
        if (w > h) { h = Math.round(h * MAX / w); w = MAX }
        else { w = Math.round(w * MAX / h); h = MAX }
      }
      const canvas = document.createElement('canvas')
      canvas.width = w
      canvas.height = h
      canvas.getContext('2d')!.drawImage(img, 0, 0, w, h)
      resolve(canvas.toDataURL('image/jpeg', 0.82))
    }
    img.onerror = () => reject(new Error('Failed to read image'))
    img.src = objectUrl
  })
}

// ─── Child intake form section ─────────────────────────────────────────────────

function ChildIntakeFormSection({ intake, visitType, onChange, onConsentChange, onPhotosChange, onSelfPayChange }: {
  intake: ChildIntake
  visitType: string
  onChange: (field: keyof ChildIntake, value: string) => void
  onConsentChange: (val: boolean) => void
  onPhotosChange: (photos: string[]) => void
  onSelfPayChange: (val: boolean) => void
}) {
  const frontRef = useRef<HTMLInputElement>(null)
  const backRef = useRef<HTMLInputElement>(null)
  const photoRefs = [useRef<HTMLInputElement>(null), useRef<HTMLInputElement>(null)]
  const [uploading, setUploading] = useState<'front' | 'back' | null>(null)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [photoUploading, setPhotoUploading] = useState<number | null>(null)
  const [photoError, setPhotoError] = useState<string | null>(null)

  async function uploadVisitPhoto(file: File, slot: number) {
    setPhotoUploading(slot)
    setPhotoError(null)
    try {
      const token = await getFamilyAccessToken()
      const data = await compressToJpeg(file)
      const filename = `visit-photos/${intake.childId || 'unknown'}/${Date.now()}-${slot}.jpg`
      const res = await fetch('/api/upload-insurance-card', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ data, filename }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || 'Upload failed')
      const next = [...(intake.textVisitPhotos || [])]
      next[slot] = json.url
      onPhotosChange(next)
    } catch (e: any) {
      setPhotoError(e?.message || 'Upload failed')
    } finally {
      setPhotoUploading(null)
    }
  }

  async function uploadCard(file: File, side: 'front' | 'back') {
    setUploading(side)
    setUploadError(null)
    try {
      const token = await getFamilyAccessToken()
      const data = await compressToJpeg(file)
      const filename = `insurance-cards/${intake.childId || 'unknown'}/${side}-${Date.now()}.jpg`
      const res = await fetch('/api/upload-insurance-card', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ data, filename }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || 'Upload failed')
      onChange(side === 'front' ? 'insuranceCardFrontUrl' : 'insuranceCardBackUrl', json.url)
    } catch (e: any) {
      setUploadError(e?.message || 'Upload failed')
    } finally {
      setUploading(null)
    }
  }

  return (
    <div className="space-y-5">

      {/* Profile section — only shown if no existing Charm chart */}
      {!intake.hasProfile && (
        <div className="border border-[#E8E8E4] rounded-xl p-4 bg-[#FAFAF8]">
          <div className="flex items-center gap-2 mb-3">
            <User size={14} className="text-[#7F77DD]" />
            <p className="text-[12px] font-semibold text-[#1A1A2E] uppercase tracking-wider">Child's profile</p>
            <span className="text-[11px] text-[#999]">— saved for future visits</span>
          </div>

          {/* Name + DOB */}
          <div className="grid grid-cols-2 gap-3 mb-3">
            <Input label="Legal first name" placeholder="Emma" value={intake.firstName} onChange={e => onChange('firstName', e.target.value)} />
            <Input label="Legal last name" placeholder="Smith" value={intake.lastName} onChange={e => onChange('lastName', e.target.value)} />
          </div>
          <div className="grid grid-cols-2 gap-3 mb-4">
            <Input label="Date of birth" type="date" value={intake.dateOfBirth} onChange={e => onChange('dateOfBirth', e.target.value)} />
            <div>
              <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-1">Sex</label>
              <select value={intake.gender} onChange={e => onChange('gender', e.target.value)}
                className="w-full px-3 py-2.5 border border-[#E8E8E4] rounded-lg text-[14px] font-sans bg-white focus:border-[#7F77DD] outline-none">
                <option value="">Select</option>
                <option value="Male">Male</option>
                <option value="Female">Female</option>
                <option value="Unknown">Prefer not to say</option>
              </select>
            </div>
          </div>

          {/* Insurance */}
          <div className="border-t border-[#E8E8E4] pt-4 mt-1">
            <p className="text-[11px] font-semibold text-[#555] uppercase tracking-wider mb-3">Insurance</p>

            {/* Self-pay toggle */}
            <button
              type="button"
              onClick={() => onSelfPayChange(!intake.selfPay)}
              className={`w-full flex items-start gap-3 p-3.5 rounded-xl border-2 transition-all text-left mb-3 ${intake.selfPay ? 'border-[#1D9E75] bg-[#E1F5EE]' : 'border-[#E8E8E4] bg-white hover:border-[#AFA9EC]'}`}
            >
              <div className={`w-5 h-5 rounded border-2 flex-shrink-0 flex items-center justify-center mt-0.5 transition-all ${intake.selfPay ? 'bg-[#1D9E75] border-[#1D9E75]' : 'border-[#D0D0CC]'}`}>
                {intake.selfPay && <Check size={11} className="text-white" strokeWidth={3} />}
              </div>
              <div>
                <span className={`text-[13px] font-medium block ${intake.selfPay ? 'text-[#085041]' : 'text-[#333]'}`}>
                  We are self-pay
                </span>
                <span className="text-[12px] text-[#999]">No insurance — card photos and insurance info are not required</span>
              </div>
            </button>

            {!intake.selfPay && (
              <div className="grid grid-cols-2 gap-3 mb-3">
                <Input label="Insurance provider" placeholder="BCBS NC, Aetna..." value={intake.insuranceProvider} onChange={e => onChange('insuranceProvider', e.target.value)} />
                <Input label="Member ID" placeholder="ABC123456789" value={intake.insuranceMemberId} onChange={e => onChange('insuranceMemberId', e.target.value)} />
                <Input label="Group number" placeholder="GRP001" value={intake.insuranceGroupNumber} onChange={e => onChange('insuranceGroupNumber', e.target.value)} />
                <Input label="Subscriber name" placeholder="Jennifer Smith" value={intake.insuranceSubscriberName} onChange={e => onChange('insuranceSubscriberName', e.target.value)} />
                <Input label="Subscriber date of birth" type="date" value={intake.insuranceSubscriberDob} onChange={e => onChange('insuranceSubscriberDob', e.target.value)} />
                <div>
                  <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-1">Subscriber sex</label>
                  <select value={intake.insuranceSubscriberGender} onChange={e => onChange('insuranceSubscriberGender', e.target.value)}
                    className="w-full px-3 py-2.5 border border-[#E8E8E4] rounded-lg text-[14px] font-sans bg-white focus:border-[#7F77DD] outline-none">
                    <option value="">Select</option>
                    <option value="Male">Male</option>
                    <option value="Female">Female</option>
                  </select>
                </div>
              </div>
            )}
          </div>

          {/* Medical background */}
          <div className="border-t border-[#E8E8E4] pt-4 mt-4">
            <p className="text-[11px] font-semibold text-[#555] uppercase tracking-wider mb-3">Medical background</p>
            <div className="space-y-3">
              <Input label="Drug & food allergies" placeholder="e.g. Penicillin, peanuts — or NKDA" value={intake.allergies} onChange={e => onChange('allergies', e.target.value)} />
              <Input label="Current medications" placeholder="e.g. Zyrtec 5mg daily — or None" value={intake.currentMedications} onChange={e => onChange('currentMedications', e.target.value)} />
              <div>
                <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-1">Medical history</label>
                <textarea value={intake.medicalHistory} onChange={e => onChange('medicalHistory', e.target.value)}
                  placeholder="Chronic conditions, past surgeries, hospitalizations, significant health history — or None"
                  rows={3}
                  className="w-full px-3 py-2.5 border border-[#E8E8E4] rounded-lg text-[14px] font-sans resize-none focus:border-[#7F77DD] focus:ring-2 focus:ring-[#7F77DD]/10 outline-none bg-white" />
              </div>
              <Input label="Preferred pharmacy — include full address" placeholder="e.g. CVS, 123 Main St, Charlotte, NC 28078" value={intake.preferredPharmacy} onChange={e => onChange('preferredPharmacy', e.target.value)} />
              <Input label="Primary care physician — include practice name & address" placeholder="e.g. Dr. Smith, Charlotte Pediatrics, 456 Park Rd, Charlotte, NC 28209" value={intake.pcp} onChange={e => onChange('pcp', e.target.value)} />
            </div>
          </div>

          {/* Vaccination status */}
          <div className="border-t border-[#E8E8E4] pt-4 mt-4">
            <p className="text-[11px] font-semibold text-[#555] uppercase tracking-wider mb-3">Vaccination status</p>
            <div className="space-y-2">
              {VAX_OPTIONS.map(v => (
                <button key={v.value} onClick={() => onChange('vaccinationStatus', v.value)}
                  className={`w-full flex items-center gap-3 p-3 rounded-lg border-2 transition-all text-left ${intake.vaccinationStatus === v.value ? 'border-[#7F77DD] bg-[#EEEDFE]' : 'border-[#E8E8E4] bg-white hover:border-[#AFA9EC]'}`}>
                  <div className={`w-4 h-4 rounded-full border-2 flex-shrink-0 transition-all ${intake.vaccinationStatus === v.value ? 'border-[#7F77DD] bg-[#7F77DD]' : 'border-[#D0D0CC]'}`}>
                    {intake.vaccinationStatus === v.value && <div className="w-1.5 h-1.5 rounded-full bg-white m-auto mt-[2px]" />}
                  </div>
                  <div>
                    <div className="text-[13px] font-medium text-[#1A1A2E]">{v.label}</div>
                    <div className="text-[11px] text-[#555]">{v.desc}</div>
                  </div>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Profile on file */}
      {intake.hasProfile && (
        <div className="p-3 bg-[#E1F5EE] border border-[#5DCAA5] rounded-lg flex items-center gap-2 text-[13px] text-[#085041]">
          <Check size={14} />
          <span><strong>{intake.displayLabel}'s</strong> profile is on file — just tell us what's going on today.</span>
        </div>
      )}


      {/* Pharmacy & PCP — shown for existing patients missing these fields */}
      {intake.hasProfile && (!intake.preferredPharmacy || !intake.pcp) && (
        <div className="border border-[#E8E8E4] rounded-xl p-4 bg-[#FAFAF8]">
          <p className="text-[12px] font-semibold text-[#1A1A2E] uppercase tracking-wider mb-3">Health providers</p>
          <div className="space-y-3">
            <Input label="Preferred pharmacy — include full address" placeholder="e.g. CVS, 123 Main St, Charlotte, NC 28078" value={intake.preferredPharmacy} onChange={e => onChange('preferredPharmacy', e.target.value)} />
            <Input label="Primary care physician — include practice name & address" placeholder="e.g. Dr. Smith, Charlotte Pediatrics, 456 Park Rd, Charlotte, NC 28209" value={intake.pcp} onChange={e => onChange('pcp', e.target.value)} />
          </div>
        </div>
      )}

      {/* Symptoms — every visit */}
      <div className="border border-[#E8E8E4] rounded-xl p-4">
        <p className="text-[12px] font-semibold text-[#1A1A2E] uppercase tracking-wider mb-3">
          Today's visit — {intake.displayLabel}
        </p>
        <div className="space-y-3">
          <div>
            <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-1">
              Chief complaint / symptoms <span className="text-[#ff3b30]">*</span>
            </label>
            <textarea value={intake.chiefComplaint} onChange={e => onChange('chiefComplaint', e.target.value)}
              placeholder="Describe what's going on — e.g. fever of 102°F since yesterday morning, ear pain on the right side, fussy and not eating..."
              rows={3}
              className="w-full px-3 py-2.5 border border-[#E8E8E4] rounded-lg text-[14px] font-sans resize-none focus:border-[#7F77DD] focus:ring-2 focus:ring-[#7F77DD]/10 outline-none bg-white" />
          </div>
          <div>
            <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-1">Anything else we should know?</label>
            <textarea value={intake.additionalInfo} onChange={e => onChange('additionalInfo', e.target.value)}
              placeholder="Recent exposures, medications tried at home, relevant history..."
              rows={2}
              className="w-full px-3 py-2.5 border border-[#E8E8E4] rounded-lg text-[14px] font-sans resize-none focus:border-[#7F77DD] focus:ring-2 focus:ring-[#7F77DD]/10 outline-none bg-white" />
          </div>

          {/* Photo upload — text visits only, up to 2 photos */}
          {visitType === 'Text visit' && (
            <div>
              <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-1">
                Photos <span className="normal-case font-normal text-[#999]">optional — up to 2 (e.g. rash, wound)</span>
              </label>
              <div className="grid grid-cols-2 gap-3">
                {[0, 1].map(slot => {
                  const url = (intake.textVisitPhotos || [])[slot]
                  return (
                    <div key={slot}>
                      <input ref={photoRefs[slot]} type="file" accept="image/*" className="hidden"
                        onChange={e => { if (e.target.files?.[0]) uploadVisitPhoto(e.target.files[0], slot) }} />
                      {url ? (
                        <div className="relative rounded-lg overflow-hidden border border-[#E8E8E4] aspect-square">
                          <img src={url} alt={`Photo ${slot + 1}`} className="w-full h-full object-cover" />
                          <button
                            onClick={() => { const next = [...(intake.textVisitPhotos || [])]; next[slot] = ''; onPhotosChange(next) }}
                            className="absolute top-1 right-1 w-6 h-6 bg-black/50 rounded-full flex items-center justify-center hover:bg-black/70 transition-colors">
                            <X size={12} className="text-white" />
                          </button>
                        </div>
                      ) : (
                        <button onClick={() => photoRefs[slot].current?.click()}
                          disabled={photoUploading === slot}
                          className="w-full aspect-square border-2 border-dashed border-[#E8E8E4] rounded-lg flex flex-col items-center justify-center gap-1 hover:border-[#AFA9EC] transition-colors bg-white disabled:opacity-50">
                          {photoUploading === slot
                            ? <span className="text-[12px] text-[#999]">Uploading…</span>
                            : <>
                                <Camera size={20} className="text-[#D0D0CC]" />
                                <span className="text-[11px] text-[#999]">Add photo</span>
                              </>}
                        </button>
                      )}
                    </div>
                  )
                })}
              </div>
              {photoError && <p className="text-[11px] text-[#DC2626] mt-1">{photoError}</p>}
            </div>
          )}

          {/* Insurance card upload — required for new patients; shown as "tap to update" if card already on file; hidden for established patients without a card */}
          {!intake.selfPay && (!intake.hasProfile || intake.cardOnFile) && <div>
            <p className="text-[11px] font-medium text-[#555] uppercase tracking-wider mb-2">
              Insurance card photos — front & back{' '}
              {intake.cardOnFile
                ? <span className="normal-case font-normal text-[#1D9E75]">on file — tap to update</span>
                : intake.hasProfile
                  ? <span className="normal-case font-normal text-[#999]">optional</span>
                  : <span className="text-[#ff3b30]">*</span>}
            </p>
            <div className="grid grid-cols-2 gap-3">
              {(['front', 'back'] as const).map(side => {
                const url = side === 'front' ? intake.insuranceCardFrontUrl : intake.insuranceCardBackUrl
                const ref = side === 'front' ? frontRef : backRef
                return (
                  <div key={side}>
                    <input ref={ref} type="file" accept="image/*" className="hidden"
                      onChange={e => { if (e.target.files?.[0]) uploadCard(e.target.files[0], side) }} />
                    {url ? (
                      <div className="relative rounded-lg overflow-hidden border border-[#E8E8E4] aspect-[1.6/1]">
                        <img src={url} alt={`Insurance card ${side}`} className="w-full h-full object-cover" />
                        <button onClick={() => onChange(side === 'front' ? 'insuranceCardFrontUrl' : 'insuranceCardBackUrl', '')}
                          className="absolute top-1.5 right-1.5 w-6 h-6 rounded-full bg-black/50 flex items-center justify-center text-white hover:bg-black/70">
                          <X size={12} />
                        </button>
                        <div className="absolute bottom-0 left-0 right-0 bg-black/40 text-white text-[10px] text-center py-1 capitalize">{side}</div>
                      </div>
                    ) : (
                      <button onClick={() => ref.current?.click()}
                        className="w-full aspect-[1.6/1] border-2 border-dashed border-[#E8E8E4] rounded-lg flex flex-col items-center justify-center gap-1.5 hover:border-[#7F77DD] hover:bg-[#FAFAF8] transition-all text-[#999] hover:text-[#7F77DD]">
                        {uploading === side ? (
                          <div className="text-[12px]">Uploading...</div>
                        ) : (
                          <>
                            <Upload size={16} />
                            <div className="text-[12px] font-medium capitalize">{side} of card</div>
                          </>
                        )}
                      </button>
                    )}
                  </div>
                )
              })}
            </div>
            {uploadError && (
              <p className="text-[12px] text-[#791F1F] mt-2">{uploadError}</p>
            )}
          </div>}

          {/* PHI sharing consent — first booking only */}
          <div className="border-t border-[#E8E8E4] pt-4 mt-1">
            <button
              type="button"
              onClick={() => onConsentChange(!intake.phiSharingConsent)}
              className={`w-full flex items-start gap-3 p-4 rounded-xl border-2 transition-all text-left ${intake.phiSharingConsent ? 'border-[#1D9E75] bg-[#E1F5EE]' : 'border-[#E8E8E4] bg-white hover:border-[#AFA9EC]'}`}
            >
              <div className={`w-5 h-5 rounded border-2 flex-shrink-0 flex items-center justify-center mt-0.5 transition-all ${intake.phiSharingConsent ? 'bg-[#1D9E75] border-[#1D9E75]' : 'border-[#D0D0CC]'}`}>
                {intake.phiSharingConsent && <Check size={11} className="text-white" strokeWidth={3} />}
              </div>
              <span className={`text-[13px] leading-relaxed ${intake.phiSharingConsent ? 'text-[#085041] font-medium' : 'text-[#555]'}`}>
                I give {PRACTICE_NAME} permission to share this patient's health information with other doctors and providers involved in the patient's care.
              </span>
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── UI helpers ───────────────────────────────────────────────────────────────

// ─── IV fluids helpers ────────────────────────────────────────────────────────

function IvQ({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="text-[13px] font-semibold text-[#1A1A2E] block mb-2 leading-snug">{label}</label>
      {children}
    </div>
  )
}

function IvRadios({ field, options, iv, set }: {
  field: keyof IvFluidsIntake
  options: string[]
  iv: IvFluidsIntake
  set: (partial: Partial<IvFluidsIntake>) => void
}) {
  return (
    <div className="space-y-1.5">
      {options.map(opt => (
        <button key={opt} onClick={() => set({ [field]: opt })}
          className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl border-2 transition-all text-left
            ${iv[field] === opt ? 'border-[#7F77DD] bg-[#EEEDFE]' : 'border-[#E8E8E4] bg-white hover:border-[#AFA9EC]'}`}>
          <div className={`w-4 h-4 rounded-full border-2 flex-shrink-0 transition-all flex items-center justify-center
            ${iv[field] === opt ? 'border-[#7F77DD] bg-[#7F77DD]' : 'border-[#D0D0CC]'}`}>
            {iv[field] === opt && <div className="w-1.5 h-1.5 rounded-full bg-white" />}
          </div>
          <span className={`text-[13px] ${iv[field] === opt ? 'font-medium text-[#3C3489]' : 'text-[#1A1A2E]'}`}>{opt}</span>
        </button>
      ))}
    </div>
  )
}

// ─── Progress bar ─────────────────────────────────────────────────────────────

function ProgressBar({ step, steps }: { step: number; steps: string[] }) {
  return (
    <div className="flex items-center mb-8">
      {steps.map((label, i) => (
        <div key={i} className="flex items-center flex-1 last:flex-none">
          <div className="flex items-center gap-1.5">
            <div className={`w-6 h-6 rounded-full flex items-center justify-center text-[11px] font-semibold transition-all ${i < step ? 'bg-[#1D9E75] text-white' : i === step ? 'bg-[#7F77DD] text-white' : 'bg-white border border-[#D0D0CC] text-[#999]'}`}>
              {i < step ? <Check size={11} strokeWidth={3} /> : i + 1}
            </div>
            <span className={`text-[11px] hidden sm:block ${i === step ? 'font-medium text-[#1A1A2E]' : i < step ? 'text-[#1D9E75]' : 'text-[#999]'}`}>{label}</span>
          </div>
          {i < steps.length - 1 && <div className={`flex-1 h-px mx-2 ${i < step ? 'bg-[#1D9E75]' : 'bg-[#E8E8E4]'}`} />}
        </div>
      ))}
    </div>
  )
}

function Step({ title, sub, children }: { title: string; sub: string; children: React.ReactNode }) {
  return (
    <div className="bg-white border border-[#E8E8E4] rounded-xl p-6 shadow-sm">
      <h2 className="font-display text-xl font-medium text-[#1A1A2E] mb-1">{title}</h2>
      <p className="text-[13px] text-[#555] mb-5 leading-relaxed">{sub}</p>
      {children}
    </div>
  )
}

function NavButtons({ onBack, onNext, nextDisabled = false, nextLabel = 'Continue', loading = false }: {
  onBack?: () => void; onNext: () => void; nextDisabled?: boolean; nextLabel?: string; loading?: boolean
}) {
  return (
    <div className="flex items-center gap-3 mt-6 pt-5 border-t border-[#E8E8E4]">
      {onBack && (
        <button onClick={onBack} className="flex items-center gap-1.5 text-[13px] text-[#555] hover:text-[#1A1A2E]">
          <ChevronLeft size={15} /> Back
        </button>
      )}
      <div className="ml-auto">
        <Button onClick={onNext} disabled={nextDisabled} loading={loading}>{nextLabel}</Button>
      </div>
    </div>
  )
}
