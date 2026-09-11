import { useEffect, useState } from 'react'
import { MapPin, Clock, AlertCircle, Plus, X, AlertTriangle } from 'lucide-react'
import {
  getBroadcasts, createBroadcast, updateBroadcast,
  createAppointment, invokeNotifications, updateWaitlistEntry,
  apiFetch,
} from '../lib/api'
import { useAuth } from '../contexts/AuthContext'
import { Badge } from '../components/ui/Badge'
import { Button } from '../components/ui/Button'
import { Input } from '../components/ui/Input'
import { format } from 'date-fns'
import type { Broadcast } from '../types'

const REQUEST_TYPES = [
  'MD/NP needed — virtual visit to go with CMA visit',
  'MD/NP needed — virtual visit screening for IV fluids',
  'CMA needed — in-home visit',
  'RN needed — IV fluids in-home (telemedicine screening included)',
]

function BroadcastPatientDetails({ bc, child }: { bc: Broadcast; child: any }) {
  const name = [child?.first_name, child?.last_name].filter(Boolean).join(' ') || `${bc.patient_first_name || ''} ${bc.patient_last_name || ''}`.trim()
  const familyName = child?.family_display_name || ''
  const dob = child?.date_of_birth ? String(child.date_of_birth).split('T')[0] : (bc.patient_dob ? String(bc.patient_dob).split('T')[0] : '')
  const sex = child?.gender || ''
  const phone = child?.parent_phone || child?.family_phone || bc.family_phone || ''
  const email = child?.parent_email || child?.family_email || bc.family_email || ''
  const address = [child?.parent_address || child?.family_address_line1, child?.parent_city || child?.family_city].filter(Boolean).join(', ') || bc.patient_address || ''
  const allergies = child?.allergies || ''
  const meds = child?.current_medications || ''
  const pmh = child?.medical_history || ''
  const pcp = child?.pcp || ''
  const pharmacy = child?.preferred_pharmacy || ''
  const insurance = child?.insurance_provider || ''
  const memberId = child?.insurance_member_id || ''
  const groupNum = child?.insurance_group_number || ''
  const subscriber = child?.insurance_subscriber_name || ''
  const subscriberDob = child?.insurance_subscriber_dob ? String(child.insurance_subscriber_dob).split('T')[0] : ''
  const subscriberSex = child?.insurance_subscriber_gender || ''
  const cardFront = child?.insurance_card_front_url || ''
  const cardBack = child?.insurance_card_back_url || ''

  const F = ({ label, value }: { label: string; value: string }) => value ? (
    <div className="text-[13px]"><span className="text-[#999] text-[11px] block">{label}</span>{value}</div>
  ) : null

  const patientHas = name || familyName || dob || sex || phone || email || address
  const clinicalHas = allergies || meds || pmh || pcp || pharmacy
  const insuranceHas = insurance || memberId || groupNum || subscriber || subscriberDob || subscriberSex || cardFront || cardBack

  if (!patientHas && !clinicalHas && !insuranceHas) return null

  return (
    <div className="mt-3 space-y-2">
      {patientHas && (
        <div className="bg-white border border-[#E8E8E4] rounded-lg p-3 space-y-1.5">
          <div className="text-[10px] font-semibold text-[#7F77DD] uppercase tracking-wider mb-1">Patient</div>
          {name && <div className="text-[13px]"><span className="text-[#999] text-[11px] block">Name</span><strong>{name}</strong></div>}
          <F label="Family" value={familyName} />
          <F label="Date of birth" value={dob} />
          <F label="Sex" value={sex} />
          {phone && (
            <div className="text-[13px]">
              <span className="text-[#999] text-[11px] block">Phone</span>
              <div className="flex items-center justify-between gap-2">
                <span>{phone}</span>
                <a href={`tel:${phone}`} onClick={e => e.stopPropagation()}
                   className="px-2 py-0.5 rounded bg-[#7F77DD] text-white text-[11px] font-medium hover:bg-[#534AB7] transition-colors flex-shrink-0">Call</a>
              </div>
            </div>
          )}
          <F label="Email" value={email} />
          <F label="Address" value={address} />
        </div>
      )}
      {clinicalHas && (
        <div className="bg-white border border-[#E8E8E4] rounded-lg p-3 space-y-1.5">
          <div className="text-[10px] font-semibold text-[#7F77DD] uppercase tracking-wider mb-1">Clinical</div>
          <F label="Allergies" value={allergies} />
          <F label="Medications" value={meds} />
          <F label="Medical history / PMH" value={pmh} />
          <F label="PCP" value={pcp} />
          <F label="Preferred pharmacy" value={pharmacy} />
        </div>
      )}
      {insuranceHas && (
        <div className="bg-white border border-[#E8E8E4] rounded-lg p-3 space-y-1.5">
          <div className="text-[10px] font-semibold text-[#7F77DD] uppercase tracking-wider mb-1">Insurance</div>
          <F label="Insurance" value={insurance} />
          <F label="Member ID" value={memberId} />
          <F label="Group #" value={groupNum} />
          <F label="Subscriber name" value={subscriber} />
          <F label="Subscriber DOB" value={subscriberDob} />
          <F label="Subscriber sex" value={subscriberSex} />
          {(cardFront || cardBack) && (
            <div className="flex gap-2 mt-1 flex-wrap">
              {cardFront && <a href={cardFront} target="_blank" rel="noopener noreferrer"><img src={cardFront} alt="Insurance card front" className="max-h-24 rounded border border-[#E8E8E4] object-contain" /></a>}
              {cardBack && <a href={cardBack} target="_blank" rel="noopener noreferrer"><img src={cardBack} alt="Insurance card back" className="max-h-24 rounded border border-[#E8E8E4] object-contain" /></a>}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function defaultAcceptTime() {
  const now = new Date()
  const m = Math.ceil(now.getMinutes() / 15) * 15
  if (m === 60) { now.setHours(now.getHours() + 1, 0, 0, 0) } else { now.setMinutes(m, 0, 0) }
  return `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`
}

export function Broadcasts() {
  const { provider } = useAuth()
  const [broadcasts, setBroadcasts] = useState<Broadcast[]>([])
  const [loading, setLoading] = useState(true)
  const [acting, setActing] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  // Cached child record lookup for each broadcast so we can render the same
  // full patient info block that waitlist / appointment cards show. Keyed by
  // broadcast id. Resolved lazily via name-search + phone/DOB disambiguation.
  const [broadcastChildren, setBroadcastChildren] = useState<Record<string, any>>({})
  const [submitting, setSubmitting] = useState(false)
  const [form, setForm] = useState({
    patient_first_name: '',
    patient_last_name: '',
    patient_dob: '',
    patient_address: '',
    family_phone: '',
    family_email: '',
    request_type: '',
    cma_specific: '',
    complaint: '',
    is_urgent: false,
  })

  // Accept modal state
  const [acceptingBc, setAcceptingBc] = useState<Broadcast | null>(null)
  const [acceptDate, setAcceptDate] = useState(format(new Date(), 'yyyy-MM-dd'))
  const [acceptTime, setAcceptTime] = useState(defaultAcceptTime)

  async function fetchBroadcasts() {
    const data = await getBroadcasts({ open_only: 'true' })
    setBroadcasts((data ?? []) as Broadcast[])
    setLoading(false)
  }

  function fmtTime24(t: string | null): string {
    if (!t) return ''
    const [h, m] = t.split(':').map(Number)
    const ampm = h >= 12 ? 'PM' : 'AM'
    const h12 = h % 12 || 12
    return `${h12}:${m.toString().padStart(2, '0')} ${ampm}`
  }

  async function claimPairing(bc: Broadcast) {
    if (!provider) return
    setActing(bc.id)
    try {
      // RN IV solo — the MD/NP already saw the patient in person and ordered
      // fluids. No paired telemedicine visit is created; just add the RN's
      // visit to their schedule.
      const isRnIvSolo = bc.visit_type === 'In-home IV fluids – RN only'

      const isInHomeNeeded = bc.pairing_role_needed === 'CMA' || bc.pairing_role_needed === 'RN'
      // Reference code shared across both twin appointments so cancel/reschedule
      // cascades and paired-provider notification lookups can find the pair.
      const pairRef = 'PUC-' + Math.floor(10000 + Math.random() * 90000)
      const partnerLabel = isInHomeNeeded
        ? `${bc.pairing_initiator_name} (MD/NP — telemedicine)`
        : `${bc.pairing_initiator_name} (CMA — in-home)`
      // Resolve child_id from the same lookup the display side already did so
      // the claiming provider's Today card can pull the full child record.
      const resolvedChild = broadcastChildren[bc.id] ?? null
      const resolvedChildId: string | null = resolvedChild?.id ?? null
      const patientFull = [bc.patient_first_name, bc.patient_last_name].filter(Boolean).join(' ')
      const noteParts = isRnIvSolo ? [
        `From broadcast · ordered by ${bc.created_by_name}`,
        patientFull ? `PATIENT:${patientFull}` : '',
        bc.patient_dob ? `DOB:${bc.patient_dob}` : '',
        bc.complaint ? `RNORDER:${bc.complaint}` : '',
        bc.patient_address ? `ADDR:${bc.patient_address}` : '',
        bc.family_email ? `PARENTEMAIL:${bc.family_email}` : '',
        bc.family_phone ? `PARENTPHONE:${bc.family_phone}` : '',
      ].filter(Boolean) : [
        `Ref: ${pairRef}`,
        `Paired from broadcast`,
        patientFull ? `PATIENT:${patientFull}` : '',
        bc.patient_dob ? `DOB:${bc.patient_dob}` : '',
        bc.complaint ? `CC:${bc.complaint}` : '',
        bc.patient_address ? `ADDR:${bc.patient_address}` : '',
        bc.family_email ? `PARENTEMAIL:${bc.family_email}` : '',
        bc.family_phone ? `PARENTPHONE:${bc.family_phone}` : '',
        `PARTNER:${partnerLabel}`,
      ].filter(Boolean)

      // Pass state (fixes bug where on-call lookup silently failed because the
      // zone was a street address) and second_provider_id so createAppointmentCore
      // uses the pairing initiator as the paired provider instead of the on-call
      // schedule. The initiator committed to being the MD/NP for this specific
      // pair via the broadcast — respect that.
      const apptResult = await createAppointment({
        provider_id: provider.id,
        visit_type: bc.visit_type || 'CMA + tele',
        zone: (bc as any).zone || bc.patient_address || 'Broadcast',
        scheduled_time: bc.scheduled_time || '09:00',
        scheduled_date: bc.scheduled_date || format(new Date(), 'yyyy-MM-dd'),
        status: 'upcoming',
        notes: noteParts.join('|'),
        state: (bc as any).state || null,
        // Solo RN IV: no second_provider_id — visit_type is not in DUAL_TYPES
        // so the appointments API will create a single row and skip pairing.
        ...(!isRnIvSolo && isInHomeNeeded && bc.pairing_initiator_id ? { second_provider_id: bc.pairing_initiator_id } : {}),
        ...(resolvedChildId ? { child_id: resolvedChildId } : {}),
      })

      if ((apptResult as any)?.error) {
        // Overlap on primary or secondary — surface it and leave broadcast open.
        alert((apptResult as any).error)
        setActing(null)
        return
      }

      await updateBroadcast(bc.id, { is_open: false })

      // If the broadcast was spawned by a waitlist entry, mark it converted now
      // that the visit is actually booked.
      if ((bc as any).waitlist_entry_id) {
        await updateWaitlistEntry((bc as any).waitlist_entry_id, { status: 'converted', converted_provider_id: provider.id }).catch(() => {})
      }

      invokeNotifications({
        type: 'pairing_claimed',
        broadcastId: bc.id,
        claimedByName: provider.name,
        claimedById: provider.id,
      }).catch(() => {})

      setBroadcasts(prev => prev.filter(b => b.id !== bc.id))
    } finally {
      setActing(null)
    }
  }

  useEffect(() => { fetchBroadcasts() }, [])

  // Hydrate patient records for any newly-loaded broadcasts. Name search is
  // practice-scoped server-side; we disambiguate multiple matches locally by
  // family phone and DOB from the broadcast.
  useEffect(() => {
    broadcasts.forEach(async bc => {
      if (bc.id in broadcastChildren) return
      const name = `${bc.patient_first_name || ''} ${bc.patient_last_name || ''}`.trim()
      if (!name) return
      try {
        const rows = await apiFetch<any[]>(`/api/children?search=${encodeURIComponent(name)}`)
        if (!rows?.length) { setBroadcastChildren(prev => ({ ...prev, [bc.id]: null })); return }
        const notePhoneDigits = String(bc.family_phone || '').replace(/\D/g, '')
        const noteDob = bc.patient_dob ? String(bc.patient_dob).split('T')[0] : ''
        const scored = rows.map((c: any) => {
          const cPhone = String(c.parent_phone || c.family_phone || '').replace(/\D/g, '')
          const cDob = c.date_of_birth ? String(c.date_of_birth).split('T')[0] : ''
          let score = 0
          if (notePhoneDigits && cPhone && notePhoneDigits === cPhone) score += 2
          if (noteDob && cDob && noteDob === cDob) score += 1
          return { c, score }
        })
        scored.sort((a, b) => b.score - a.score)
        setBroadcastChildren(prev => ({ ...prev, [bc.id]: scored[0]?.c ?? null }))
      } catch {
        setBroadcastChildren(prev => ({ ...prev, [bc.id]: null }))
      }
    })
  }, [broadcasts])

  async function submitBroadcast() {
    const isCmaRequest = form.request_type === 'CMA needed — in-home visit'
    if (!provider || !form.patient_first_name || !form.patient_last_name || !form.request_type) return
    if (isCmaRequest && !form.cma_specific) return
    setSubmitting(true)

    const combinedComplaint = isCmaRequest
      ? `Specific need: ${form.cma_specific}${form.complaint ? '\nNotes: ' + form.complaint : ''}`
      : form.complaint || null

    const bc = await createBroadcast({
      patient_first_name: form.patient_first_name,
      patient_last_name: form.patient_last_name,
      patient_dob: form.patient_dob || null,
      patient_address: form.patient_address || null,
      family_phone: form.family_phone || null,
      family_email: form.family_email || null,
      state: provider.states?.[0] || null,
      request_type: form.request_type,
      complaint: combinedComplaint,
      is_urgent: form.is_urgent,
      is_open: true,
      created_by: provider.id,
      created_by_name: `${provider.role} ${provider.name}`,
    })

    if (bc) {
      invokeNotifications({ type: 'broadcast', broadcastId: bc.id }).catch(() => {})
    }

    setSubmitting(false)
    setCreating(false)
    setForm({ patient_first_name: '', patient_last_name: '', patient_dob: '', patient_address: '', family_phone: '', family_email: '', request_type: '', cma_specific: '', complaint: '', is_urgent: false })
    fetchBroadcasts()
  }

  function openAcceptModal(bc: Broadcast) {
    setAcceptingBc(bc)
    // Prefer the target date the ordering provider suggested (RN IV solo path)
    // and let the RN change it if she needs to.
    setAcceptDate(bc.scheduled_date || format(new Date(), 'yyyy-MM-dd'))
    setAcceptTime(defaultAcceptTime())
  }

  async function confirmAccept() {
    if (!provider || !acceptingBc) return
    const bc = acceptingBc
    setActing(bc.id)
    setAcceptingBc(null)

    const isRnIvSolo = bc.visit_type === 'In-home IV fluids – RN only'
    const isCmaSolo  = bc.visit_type === 'In-home diagnostics – CMA only'
    const isSolo = isRnIvSolo || isCmaSolo

    // Resolve the child_id the same way the display hydration already does,
    // so the claiming provider's Today card can pull the full child record
    // (address, allergies, insurance, pharmacy, PCP, etc.) — otherwise it
    // renders only the fields we can pack into notes.
    const resolvedChild = broadcastChildren[bc.id] ?? null
    const resolvedChildId: string | null = resolvedChild?.id ?? null

    const patientFull = [bc.patient_first_name, bc.patient_last_name].filter(Boolean).join(' ')
    const noteParts = [`Broadcast: ${patientFull}`]
    if (patientFull) noteParts.push(`PATIENT:${patientFull}`)
    if (bc.patient_dob) noteParts.push(`DOB:${bc.patient_dob}`)
    if (bc.patient_address) noteParts.push(`ADDR:${bc.patient_address}`)
    if (bc.family_phone) noteParts.push(`PARENTPHONE:${bc.family_phone}`)
    if (bc.family_email) noteParts.push(`PARENTEMAIL:${bc.family_email}`)
    if (bc.complaint) {
      // Solo visit types — complaint carries the ordering provider's orders
      // (weight/volume/notes for RN IV, test list/notes for CMA diagnostics).
      // Tag distinctly so the claimer's Today card renders the purple
      // "RN orders" / "CMA orders" block instead of a generic chief complaint.
      const tag = isRnIvSolo ? 'RNORDER' : isCmaSolo ? 'CMAORDER' : 'CC'
      noteParts.push(`${tag}:${bc.complaint}`)
    }
    if (!isSolo) noteParts.push(`Request: ${bc.request_type}`)

    await createAppointment({
      provider_id: provider.id,
      visit_type: bc.visit_type || (bc.request_type === 'In-person house call' ? 'In-home sick visit' : 'Video telemedicine'),
      zone: bc.patient_address || (bc as any).zone || 'Broadcast',
      scheduled_time: acceptTime,
      scheduled_date: acceptDate,
      ...(resolvedChildId ? { child_id: resolvedChildId } : {}),
      status: 'upcoming',
      notes: noteParts.join('|'),
    })

    await updateBroadcast(bc.id, { is_open: false })

    invokeNotifications({
      type: 'broadcast_accepted',
      broadcastId: bc.id,
      acceptedByName: provider.name,
      acceptedById: provider.id,
      acceptedDate: acceptDate,
      acceptedTime: acceptTime,
    }).catch(() => {})

    setBroadcasts(prev => prev.filter(b => b.id !== bc.id))
    setActing(null)
  }

  async function pass(id: string) {
    setActing(id)
    await updateBroadcast(id, { is_open: false })
    setBroadcasts(prev => prev.filter(b => b.id !== id))
    setActing(null)
  }

  const isCmaRequest = form.request_type === 'CMA needed — in-home visit'
  const formValid = form.patient_first_name && form.patient_last_name && form.request_type && (!isCmaRequest || form.cma_specific)

  return (
    <div>
      <div className="bg-white border-b border-[#E8E8E4] px-6 py-4 flex items-center justify-between sticky top-0 z-10">
        <div className="font-display text-[18px] font-medium text-[#1A1A2E]">Broadcasts</div>
        <div className="flex items-center gap-2">
          <Badge variant="amber">{broadcasts.length} open request{broadcasts.length !== 1 ? 's' : ''}</Badge>
          <Button variant="teal" size="sm" onClick={() => setCreating(true)}>
            <Plus size={13} /> New broadcast
          </Button>
        </div>
      </div>

      <div className="p-6 max-w-2xl">
        <p className="text-[13px] text-[#555] mb-5 leading-relaxed">
          Broadcast a patient request to all providers in your state. Anyone can accept and it will be added to their schedule automatically.
        </p>

        {loading ? (
          <div className="text-[#999] text-sm">Loading...</div>
        ) : broadcasts.length === 0 ? (
          <div className="text-center py-16">
            <div className="w-12 h-12 rounded-xl bg-[#F1EFE8] flex items-center justify-center mx-auto mb-3">
              <AlertCircle size={20} className="text-[#999]" />
            </div>
            <p className="text-[14px] text-[#999]">No open broadcast requests right now.</p>
          </div>
        ) : (
          <div className="space-y-3">
            {/* Pairing requests — shown above general broadcasts */}
            {broadcasts.filter(bc => bc.pairing_role_needed).map(bc => {
              const myRole = provider?.role
              const isMdNp = myRole === 'MD' || myRole === 'PNP'
              const isCma = myRole === 'CMA'
              const isRn = myRole === 'RN'
              const isRnIvSolo = bc.visit_type === 'In-home IV fluids – RN only'
              const isCmaSolo = bc.visit_type === 'In-home diagnostics – CMA only'
              const isSolo = isRnIvSolo || isCmaSolo
              const canClaim =
                (bc.pairing_role_needed === 'MD/NP' && isMdNp) ||
                (bc.pairing_role_needed === 'CMA' && isCma) ||
                (bc.pairing_role_needed === 'RN' && isRn)
              const claimLabel = isRnIvSolo
                ? 'Accept IV fluids visit'
                : isCmaSolo
                  ? 'Accept CMA visit'
                  : bc.pairing_role_needed === 'MD/NP'
                    ? 'Claim telemedicine half'
                    : 'Claim in-home half'
              const dateStr = bc.scheduled_date
                ? format(new Date(bc.scheduled_date + 'T12:00:00'), 'EEE, MMM d')
                : null
              return (
                <div key={bc.id} className="border-2 border-[#AFA9EC] bg-[#F5F4FE] rounded-xl p-4">
                  <div className="flex items-center gap-2 mb-2 flex-wrap">
                    <Badge variant="purple">{isRnIvSolo ? 'RN — IV fluids' : isCmaSolo ? 'CMA — in-home diagnostics' : `${bc.pairing_role_needed} pairing needed`}</Badge>
                    <span className="text-[12px] text-[#7F77DD]">{isSolo ? `ordered by ${bc.created_by_name}` : `via ${bc.pairing_initiator_name}`}</span>
                  </div>
                  <div className="font-display text-[15px] font-medium text-[#1A1A2E] mb-1">
                    {bc.patient_first_name} {bc.patient_last_name}
                  </div>
                  <div className="space-y-0.5 text-[13px] text-[#555] mb-3">
                    {dateStr && bc.scheduled_time && (
                      <p className="flex items-center gap-1 text-[#3C3489] font-medium">
                        <Clock size={11} /> {dateStr} at {fmtTime24(bc.scheduled_time)}
                      </p>
                    )}
                    {isSolo && bc.complaint ? (
                      <div className="mt-2 mb-1 p-2.5 bg-white border border-[#AFA9EC] rounded-lg">
                        <div className="text-[10px] font-semibold text-[#7F77DD] uppercase tracking-wider mb-1">{isRnIvSolo ? 'RN orders' : 'CMA orders'}</div>
                        <div className="text-[13px] text-[#1A1A2E] font-medium">{bc.complaint}</div>
                      </div>
                    ) : (
                      bc.complaint && <p><span className="text-[#999] text-[11px] uppercase tracking-wider">Notes </span>{bc.complaint}</p>
                    )}
                    {bc.patient_address && <p className="flex items-start gap-1"><MapPin size={11} className="mt-0.5 flex-shrink-0 text-[#999]" />{bc.patient_address}</p>}
                  </div>
                  <BroadcastPatientDetails bc={bc} child={broadcastChildren[bc.id] ?? null} />
                  <div className="flex gap-2 mt-3">
                    {canClaim ? (
                      <Button variant="teal" size="sm" loading={acting === bc.id} onClick={() => isSolo ? openAcceptModal(bc) : claimPairing(bc)}>
                        {claimLabel}
                      </Button>
                    ) : (
                      <span className="text-[12px] text-[#999] self-center italic">Needs {bc.pairing_role_needed}</span>
                    )}
                    <Button variant="secondary" size="sm" disabled={acting === bc.id} onClick={() => pass(bc.id)}>
                      Pass
                    </Button>
                  </div>
                </div>
              )
            })}

            {/* General broadcasts */}
            {broadcasts.filter(bc => !bc.pairing_role_needed).map(bc => (
              <div key={bc.id}
                className={`border rounded-xl p-4 ${bc.is_urgent ? 'border-[#FAC775] bg-[#FAEEDA]' : 'border-[#E8E8E4] bg-white'}`}>
                <div className="mb-3">
                  <div className="flex items-center gap-2 flex-wrap mb-2">
                    <span className="font-display text-[15px] font-medium text-[#1A1A2E]">
                      {bc.patient_first_name} {bc.patient_last_name}
                    </span>
                    {bc.is_urgent && <Badge variant="red">Urgent</Badge>}
                    <Badge variant="purple">{bc.request_type}</Badge>
                  </div>
                  <div className="space-y-1 text-[13px] text-[#555]">
                    {bc.patient_dob && (
                      <p><span className="text-[#999] text-[11px] uppercase tracking-wider">DOB </span>{bc.patient_dob}</p>
                    )}
                    {bc.patient_address && (
                      <p className="flex items-start gap-1">
                        <MapPin size={11} className="text-[#999] flex-shrink-0 mt-0.5" />
                        {bc.patient_address}
                      </p>
                    )}
                    {bc.complaint && (
                      <p><span className="text-[#999] text-[11px] uppercase tracking-wider">Notes </span>{bc.complaint}</p>
                    )}
                    {bc.created_by_name && (
                      <p className="flex items-center gap-1 text-[12px] text-[#999] mt-2">
                        <Clock size={11} />
                        Sent by {bc.created_by_name} · {format(new Date(bc.created_at), 'MMM d, h:mm a')}
                      </p>
                    )}
                  </div>
                </div>
                <BroadcastPatientDetails bc={bc} child={broadcastChildren[bc.id] ?? null} />
                <div className="flex gap-2 mt-3">
                  <Button variant="teal" size="sm" loading={acting === bc.id} onClick={() => openAcceptModal(bc)}>
                    Accept — add to my schedule
                  </Button>
                  <Button variant="secondary" size="sm" disabled={acting === bc.id} onClick={() => pass(bc.id)}>
                    Pass
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Accept modal — date/time picker */}
      {acceptingBc && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" onClick={() => setAcceptingBc(null)} />
          <div className="relative bg-white rounded-2xl shadow-xl w-full max-w-sm p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-display text-lg font-medium text-[#1A1A2E]">Confirm acceptance</h2>
              <button onClick={() => setAcceptingBc(null)} className="p-1.5 rounded-lg hover:bg-[#F1EFE8] text-[#999]">
                <X size={16} />
              </button>
            </div>
            <p className="text-[13px] text-[#555] mb-4">
              <strong>{acceptingBc.patient_first_name} {acceptingBc.patient_last_name}</strong> · {acceptingBc.request_type}
            </p>
            <div className="space-y-3 mb-5">
              <Input label="Date" type="date" value={acceptDate}
                onChange={e => setAcceptDate(e.target.value)} />
              <Input label="Time" type="time" value={acceptTime}
                onChange={e => setAcceptTime(e.target.value)} />
            </div>
            <div className="flex gap-2">
              <Button variant="secondary" className="flex-1" onClick={() => setAcceptingBc(null)}>Cancel</Button>
              <Button variant="teal" className="flex-1" onClick={confirmAccept} disabled={!acceptDate || !acceptTime}>
                Confirm accept
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* New broadcast modal */}
      {creating && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" onClick={() => setCreating(false)} />
          <div className="relative bg-white rounded-2xl shadow-xl w-full max-w-sm p-6 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-display text-lg font-medium text-[#1A1A2E]">New broadcast</h2>
              <button onClick={() => setCreating(false)} className="p-1.5 rounded-lg hover:bg-[#F1EFE8] text-[#999]">
                <X size={16} />
              </button>
            </div>

            <div className="space-y-3 mb-5">
              <div className="grid grid-cols-2 gap-3">
                <Input label="First name *" placeholder="Emma" value={form.patient_first_name}
                  onChange={e => setForm(f => ({ ...f, patient_first_name: e.target.value }))} />
                <Input label="Last name *" placeholder="Smith" value={form.patient_last_name}
                  onChange={e => setForm(f => ({ ...f, patient_last_name: e.target.value }))} />
              </div>
              <Input label="Date of birth" type="date" value={form.patient_dob}
                onChange={e => setForm(f => ({ ...f, patient_dob: e.target.value }))} />
              <Input label="Full address" placeholder="123 Main St, Charlotte, NC 28078" value={form.patient_address}
                onChange={e => setForm(f => ({ ...f, patient_address: e.target.value }))} />
              <div className="border-t border-[#E8E8E4] pt-3">
                <p className="text-[11px] font-medium text-[#555] uppercase tracking-wider mb-2">Parent contact — for acceptance notification</p>
                <div className="space-y-2">
                  <Input label="Parent phone" type="tel" placeholder="+17045550100" value={form.family_phone}
                    onChange={e => setForm(f => ({ ...f, family_phone: e.target.value }))} />
                  <Input label="Parent email" type="email" placeholder="parent@email.com" value={form.family_email}
                    onChange={e => setForm(f => ({ ...f, family_email: e.target.value }))} />
                </div>
              </div>
              <div>
                <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-1">
                  Request type <span className="text-[#ff3b30]">*</span>
                </label>
                <select value={form.request_type} onChange={e => setForm(f => ({ ...f, request_type: e.target.value }))}
                  className="w-full px-3 py-2.5 border border-[#E8E8E4] rounded-lg text-[14px] font-sans bg-white outline-none focus:border-[#7F77DD]">
                  <option value="">Select...</option>
                  {REQUEST_TYPES.map(rt => <option key={rt} value={rt}>{rt}</option>)}
                </select>
              </div>
              {isCmaRequest && (
                <div>
                  <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-1">
                    Specific need <span className="text-[#ff3b30]">*</span>
                  </label>
                  <textarea value={form.cma_specific} onChange={e => setForm(f => ({ ...f, cma_specific: e.target.value }))}
                    placeholder="What do you need the CMA to do? (e.g. wound check, medication admin, vitals...)"
                    rows={2}
                    className="w-full px-3 py-2.5 border border-[#E8E8E4] rounded-lg text-[14px] font-sans resize-none outline-none focus:border-[#7F77DD] bg-white" />
                </div>
              )}
              <div>
                <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-1">
                  Notes
                </label>
                <textarea value={form.complaint} onChange={e => setForm(f => ({ ...f, complaint: e.target.value }))}
                  placeholder="Any additional details..."
                  rows={3}
                  className="w-full px-3 py-2.5 border border-[#E8E8E4] rounded-lg text-[14px] font-sans resize-none outline-none focus:border-[#7F77DD] bg-white" />
              </div>
              <button onClick={() => setForm(f => ({ ...f, is_urgent: !f.is_urgent }))}
                className={`w-full flex items-center gap-3 p-3 rounded-xl border-2 transition-all text-left ${form.is_urgent ? 'border-[#F09595] bg-[#FCEBEB]' : 'border-[#E8E8E4] bg-white hover:border-[#AFA9EC]'}`}>
                <div className={`w-5 h-5 rounded border-2 flex items-center justify-center transition-all flex-shrink-0 ${form.is_urgent ? 'bg-[#791F1F] border-[#791F1F]' : 'border-[#D0D0CC]'}`}>
                  {form.is_urgent && <AlertTriangle size={11} className="text-white" />}
                </div>
                <span className={`text-[13px] font-medium ${form.is_urgent ? 'text-[#791F1F]' : 'text-[#555]'}`}>Mark as urgent</span>
              </button>
            </div>

            <div className="flex gap-2">
              <Button variant="secondary" className="flex-1" onClick={() => setCreating(false)}>Cancel</Button>
              <Button variant="teal" className="flex-1" disabled={!formValid} loading={submitting} onClick={submitBroadcast}>
                Send broadcast
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
