import { useEffect, useRef, useState } from 'react'
import { MapPin, Clock, CheckCircle2, X, Plus, Phone, XCircle, Pencil } from 'lucide-react'
import { format, isValid } from 'date-fns'
import {
  apiFetch, getWaitlistEntries, updateWaitlistEntry,
  createAppointment, invokeNotifications, createWaitlistEntry, createBroadcast,
  getChildrenByFamilyIds, providerUpdateChild as updateChild, providerCreateChild as createChild,
} from '../lib/api'
import { useAuth } from '../contexts/AuthContext'
import { Badge } from '../components/ui/Badge'
import { Button } from '../components/ui/Button'
import { Input } from '../components/ui/Input'
import { TIME_SLOTS } from '../lib/zipData'
import { usePracticeVisitTypes } from '../hooks/usePracticeVisitTypes'
import { DUAL_VISIT_TYPES, isIvFluidsPair } from '../lib/dualVisitTypes'

interface WaitlistEntry {
  id: string
  family_id: string
  family_name: string | null
  family_email: string | null
  family_phone: string | null
  visit_type: string | null
  zip: string
  state: string | null
  preferred_time_window: string | null
  complaint: string | null
  patient_address: string | null
  children_selected: string | null
  requested_date: string | null
  notes: string | null
  status: string
  created_at: string
}

const EMPTY_ADD = {
  name: '', dob: '', email: '', phone: '',
  address: '', city: '', zip: '', state: '',
  gender: '',
  visitType: '', complaint: '',
  preferredDate: '', preferredTime: '',
  allergies: '', medications: '', pmh: '',
  pcp: '', pharmacy: '', vaccinationStatus: '',
  selfPay: false as boolean,
  insurance: '', memberId: '', groupNum: '',
  subscriberName: '', subscriberDob: '', subscriberGender: '', subscriberRelationship: 'Child',
}

const NOTE_ORDER = ['Patient', 'DOB', 'Email', 'Phone', 'Address', 'Allergies', 'Medications', 'PMH', 'PCP', 'Pharmacy', 'Insurance', 'Member ID', 'Group #', 'Complaint']

function parseNotes(notes: string | null): Record<string, string> {
  const map: Record<string, string> = {}
  ;(notes || '').split(' | ').forEach(part => {
    const colon = part.indexOf(': ')
    if (colon > 0) {
      const k = part.slice(0, colon).trim()
      const v = part.slice(colon + 2).trim()
      if (v) map[k] = v
    }
  })
  return map
}

function rebuildNotes(map: Record<string, string>): string {
  const parts: string[] = []
  for (const k of NOTE_ORDER) {
    if (map[k]) parts.push(`${k}: ${map[k]}`)
  }
  for (const [k, v] of Object.entries(map)) {
    if (!NOTE_ORDER.includes(k) && v) parts.push(`${k}: ${v}`)
  }
  return parts.join(' | ')
}

function safeFormat(val: unknown, fmt: string): string {
  try {
    const d = val instanceof Date ? val : new Date(String(val))
    if (!isValid(d)) return ''
    return format(d, fmt)
  } catch { return '' }
}

const STATUS_COLORS: Record<string, { variant: 'amber' | 'blue' | 'teal' | 'gray'; label: string }> = {
  waiting:   { variant: 'amber', label: 'Waiting' },
  contacted: { variant: 'blue',  label: 'Contacted' },
  converted: { variant: 'teal',  label: 'Converted' },
  removed:   { variant: 'gray',  label: 'Removed' },
}

function WaitlistPatientDetails({ entry, child }: { entry: WaitlistEntry; child: any }) {
  const noteMap = parseNotes(entry.notes)
  const name = [child?.first_name, child?.last_name].filter(Boolean).join(' ') || noteMap['Patient'] || ''
  const familyName = child?.family_display_name || entry.family_name || noteMap['Family'] || ''
  const dob = child?.date_of_birth ? String(child.date_of_birth).split('T')[0] : (noteMap['DOB'] ? String(noteMap['DOB']).split('T')[0] : '')
  const sex = child?.gender || ''
  const phone = child?.parent_phone || child?.family_phone || entry.family_phone || noteMap['Phone'] || ''
  const email = child?.parent_email || child?.family_email || entry.family_email || noteMap['Email'] || ''
  const address = [child?.parent_address || child?.family_address_line1, child?.parent_city || child?.family_city].filter(Boolean).join(', ') || entry.patient_address || noteMap['Address'] || ''
  const allergies = child?.allergies || noteMap['Allergies'] || ''
  const meds = child?.current_medications || noteMap['Medications'] || ''
  const pmh = child?.medical_history || noteMap['PMH'] || ''
  const vax = child?.vaccination_status || noteMap['Vaccination status'] || noteMap['Vaccination'] || ''
  const pcp = child?.pcp || noteMap['PCP'] || ''
  const pharmacy = child?.preferred_pharmacy || noteMap['Pharmacy'] || ''
  const insurance = child?.insurance_provider || noteMap['Insurance'] || ''
  const memberId = child?.insurance_member_id || noteMap['Member ID'] || ''
  const groupNum = child?.insurance_group_number || noteMap['Group #'] || ''
  const subscriber = child?.insurance_subscriber_name || ''
  const subscriberDob = child?.insurance_subscriber_dob ? String(child.insurance_subscriber_dob).split('T')[0] : ''
  const subscriberSex = child?.insurance_subscriber_gender || ''
  const cardFront = child?.insurance_card_front_url || ''
  const cardBack = child?.insurance_card_back_url || ''

  const F = ({ label, value }: { label: string; value: string }) => value ? (
    <div className="text-[13px]"><span className="text-[#999] text-[11px] block">{label}</span>{value}</div>
  ) : null

  const patientHas = name || familyName || dob || sex || phone || email || address
  const clinicalHas = allergies || meds || pmh || vax || pcp || pharmacy
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
          <F label="Vaccination status" value={vax} />
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

export function Waitlist() {
  const { provider } = useAuth()
  const { visitTypes } = usePracticeVisitTypes()
  const [entries, setEntries] = useState<WaitlistEntry[]>([])
  // Hydrated child records for each waitlist entry so the card can render
  // every field (allergies, insurance, PCP, pharmacy, subscriber, card
  // images) sourced from the linked child instead of the sparse notes
  // field. See memory: feedback_all_patient_info_required_and_displayed.md
  const [entryChildren, setEntryChildren] = useState<Record<string, any>>({})
  const [loading, setLoading] = useState(true)
  const [accepting, setAccepting] = useState<WaitlistEntry | null>(null)
  const [acceptVisitType, setAcceptVisitType] = useState('')
  const [date, setDate] = useState('')
  const [time, setTime] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [acceptError, setAcceptError] = useState<string | null>(null)
  const [addOpen, setAddOpen] = useState(false)
  const [addForm, setAddForm] = useState(EMPTY_ADD)
  const [addSubmitting, setAddSubmitting] = useState(false)
  const [nameQuery, setNameQuery] = useState('')
  const [searchResults, setSearchResults] = useState<any[]>([])
  const [searchOpen, setSearchOpen] = useState(false)
  const [selectedChild, setSelectedChild] = useState<any | null>(null)
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Edit contact modal
  const [editEntry, setEditEntry] = useState<WaitlistEntry | null>(null)
  const [editName, setEditName] = useState('')
  const [editPhone, setEditPhone] = useState('')
  const [editEmail, setEditEmail] = useState('')
  const [editSubmitting, setEditSubmitting] = useState(false)

  function openEdit(e: WaitlistEntry) {
    const map = parseNotes(e.notes)
    setEditEntry(e)
    setEditName(map['Patient'] || e.family_name || '')
    setEditPhone(e.family_phone || map['Phone'] || '')
    setEditEmail(e.family_email || map['Email'] || '')
  }

  async function saveEdit() {
    if (!editEntry) return
    setEditSubmitting(true)
    const map = parseNotes(editEntry.notes)
    if (editName) map['Patient'] = editName; else delete map['Patient']
    if (editPhone) map['Phone'] = editPhone; else delete map['Phone']
    if (editEmail) map['Email'] = editEmail; else delete map['Email']
    await updateWaitlistEntry(editEntry.id, { notes: rebuildNotes(map) })
    setEditEntry(null)
    setEditSubmitting(false)
    fetchEntries()
  }

  function setField(k: keyof typeof EMPTY_ADD, v: string | boolean) {
    setAddForm(f => ({ ...f, [k]: v }))
  }

  function onNameQueryChange(q: string) {
    setNameQuery(q)
    setField('name', q)
    if (searchTimer.current) clearTimeout(searchTimer.current)
    if (!q.trim()) { setSearchResults([]); setSearchOpen(false); return }
    searchTimer.current = setTimeout(async () => {
      try {
        const results = await apiFetch<any[]>(`/api/children?search=${encodeURIComponent(q.trim())}`)
        setSearchResults(Array.isArray(results) ? results : [])
        setSearchOpen(true)
      } catch {
        setSearchResults([])
        setSearchOpen(false)
      }
    }, 300)
  }

  function selectChild(child: any) {
    const childName = [child.first_name, child.last_name].filter(Boolean).join(' ') || child.display_label || ''
    const rawDob = child.date_of_birth
    const dob = rawDob ? String(rawDob instanceof Date ? rawDob.toISOString() : rawDob).split('T')[0] : ''
    const email = child.parent_email || child.family_email || ''
    const phone = child.parent_phone || child.family_phone || ''
    const address = [child.parent_address || child.family_address_line1, child.parent_city || child.family_city].filter(Boolean).join(', ')
    setSelectedChild(child)
    setSearchOpen(false)
    setAddForm(f => ({
      ...f,
      name: childName,
      dob,
      email,
      phone,
      address,
      zip: child.parent_zip || child.family_zip || '',
      state: child.parent_state || child.family_state || '',
      allergies: child.allergies || '',
      medications: child.current_medications || '',
      pmh: child.medical_history || '',
      pcp: child.pcp || '',
      pharmacy: child.preferred_pharmacy || '',
      insurance: child.insurance_provider || '',
      memberId: child.insurance_member_id || '',
      groupNum: child.insurance_group_number || '',
    }))
  }

  function clearSelectedChild() {
    setSelectedChild(null)
    setNameQuery('')
    setAddForm(EMPTY_ADD)
    setSearchResults([])
  }

  function closeAddModal() {
    setAddOpen(false)
    setAddForm(EMPTY_ADD)
    setNameQuery('')
    setSelectedChild(null)
    setSearchResults([])
    setSearchOpen(false)
  }

  async function submitAdd() {
    // Every REQUIRED_CHILD_FIELDS field must be present. Card photos are
    // gathered later (impossible on a phone call). See:
    // feedback_all_patient_info_required_and_displayed.md.
    const missing =
      !addForm.name?.trim() ? 'Patient name'
      : !addForm.dob ? 'Date of birth'
      : !addForm.gender ? 'Sex'
      : !addForm.phone?.trim() ? 'Phone'
      : !addForm.email?.trim() ? 'Email'
      : !addForm.address?.trim() ? 'Address'
      : !addForm.city?.trim() ? 'City'
      : !addForm.state ? 'State'
      : !addForm.zip?.trim() ? 'Zip'
      : !addForm.allergies?.trim() ? 'Allergies (enter "NKDA" if none)'
      : !addForm.medications?.trim() ? 'Current medications (enter "None" if none)'
      : !addForm.pmh?.trim() ? 'PMH (enter "None" if none)'
      : !addForm.pcp?.trim() ? 'PCP'
      : !addForm.pharmacy?.trim() ? 'Pharmacy'
      : !addForm.vaccinationStatus ? 'Vaccination status'
      : !addForm.complaint?.trim() ? 'Chief complaint'
      : (!addForm.selfPay && !addForm.insurance?.trim()) ? 'Insurance provider'
      : (!addForm.selfPay && !addForm.memberId?.trim()) ? 'Member ID'
      : (!addForm.selfPay && !addForm.groupNum?.trim()) ? 'Group #'
      : (!addForm.selfPay && !addForm.subscriberName?.trim()) ? 'Subscriber name'
      : (!addForm.selfPay && !addForm.subscriberDob) ? 'Subscriber DOB'
      : (!addForm.selfPay && !addForm.subscriberGender) ? 'Subscriber sex'
      : null
    if (missing) { alert(`${missing} is required.`); return }
    setAddSubmitting(true)

    // Save every field the admin typed into a PERMANENT child record — not just
    // stashed in the waitlist entry's notes. This is the same rule the family
    // portal now follows for both booking and waitlist submits. See memory:
    // feedback_save_all_patient_data.md and feedback_no_branches_on_entry_origin.md.
    const [firstName, ...restName] = (addForm.name || '').trim().split(/\s+/)
    const lastName = restName.join(' ')

    let childId: string | null = null
    try {
      const childPayload = {
        gender: addForm.gender,
        parent_phone:  addForm.phone,
        parent_email:  addForm.email,
        parent_address: addForm.address,
        parent_city:   addForm.city,
        parent_state:  addForm.state,
        parent_zip:    addForm.zip,
        pcp:           addForm.pcp,
        preferred_pharmacy: addForm.pharmacy,
        allergies: addForm.allergies,
        current_medications: addForm.medications,
        medical_history: addForm.pmh,
        vaccination_status: addForm.vaccinationStatus,
        insurance_provider:                addForm.selfPay ? 'Self-pay' : addForm.insurance,
        insurance_member_id:               addForm.selfPay ? null : addForm.memberId,
        insurance_group_number:            addForm.selfPay ? null : addForm.groupNum,
        insurance_subscriber_name:         addForm.selfPay ? null : addForm.subscriberName,
        insurance_subscriber_dob:          addForm.selfPay ? null : addForm.subscriberDob,
        insurance_subscriber_gender:       addForm.selfPay ? null : addForm.subscriberGender,
        insurance_subscriber_relationship: addForm.selfPay ? null : addForm.subscriberRelationship,
      }
      if (selectedChild?.id) {
        await updateChild(selectedChild.id, { ...childPayload, date_of_birth: addForm.dob })
        childId = selectedChild.id
      } else {
        const created = await createChild({
          first_name: firstName || null,
          last_name:  lastName || null,
          date_of_birth: addForm.dob,
          ...childPayload,
        })
        childId = created?.id ?? null
      }
    } catch (err: any) {
      console.error('[waitlist admin add] child save failed:', err)
      // Don't block waitlist entry creation — better a note-only entry than losing the request
    }

    // Patient info now saves to the child record + waitlist_entries columns
    // — no more duplicated KEY:value dumps into notes. Display still falls
    // back to parsing notes for legacy pre-fix entries. See:
    // feedback_no_branches_on_entry_origin.md.

    try {
      const preferredWindow = [
        addForm.preferredDate ? new Date(addForm.preferredDate + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '',
        addForm.preferredTime,
      ].filter(Boolean).join(' — ') || null

      const newEntry = await createWaitlistEntry({
        visit_type: addForm.visitType || null,
        zip: addForm.zip,
        state: addForm.state,
        complaint: addForm.complaint,
        preferred_time_window: preferredWindow,
        notes: null,
        child_ids: childId ? [childId] : [],
      })
      if (newEntry?.id) {
        invokeNotifications({ type: 'waitlist', waitlistEntryId: newEntry.id }).catch(() => {})
      }
      setAddSubmitting(false)
      setAddOpen(false)
      setAddForm(EMPTY_ADD)
      setNameQuery('')
      setSelectedChild(null)
      fetchEntries()
    } catch (err: any) {
      setAddSubmitting(false)
      alert(`Failed to add patient to waitlist: ${err?.message || String(err)}`)
    }
  }



  async function fetchEntries() {
    if (!provider) return
    setLoading(true)
    const data = await getWaitlistEntries({})
    const enriched = ((data ?? []) as WaitlistEntry[])
      .filter(e => e.status !== 'removed' && e.status !== 'converted')
      .map(e => {
        const notesFamily  = e.notes?.match(/Family:\s*([^|]+)/)?.[1]?.trim() ?? null
        const notesPatient = e.notes?.match(/Patient:\s*([^|]+)/)?.[1]?.trim() ?? null
        const notesEmail   = e.notes?.match(/Email:\s*([^|]+)/)?.[1]?.trim() ?? null
        const notesPhone   = e.notes?.match(/Phone:\s*([^|]+)/)?.[1]?.trim() ?? null
        return {
          ...e,
          family_name: e.family_name || notesFamily || notesPatient || notesEmail || 'Unknown family',
          family_email: e.family_email || notesEmail || null,
          family_phone: e.family_phone || notesPhone || null,
        }
      })
    setEntries(enriched)
    setLoading(false)
  }

  useEffect(() => { fetchEntries() }, [provider])

  // Hydrate the linked child record for every waitlist entry. Priority order:
  //   1. entry.child_ids[0] — set explicitly by family portal / admin add
  //   2. Fallback: name search + phone/DOB disambiguation from notes
  // Cached in state so we don't refetch on rerender.
  useEffect(() => {
    entries.forEach(async entry => {
      if (entry.id in entryChildren) return
      try {
        const explicitChildIds: string[] = Array.isArray((entry as any).child_ids) ? (entry as any).child_ids : []
        if (explicitChildIds[0]) {
          const rows = await apiFetch<any[]>(`/api/children?ids=${explicitChildIds[0]}`).catch(() => [])
          if (rows?.[0]) { setEntryChildren(prev => ({ ...prev, [entry.id]: rows[0] })); return }
        }
        const noteMap = parseNotes(entry.notes)
        const patientName = noteMap['Patient'] || entry.family_name || ''
        if (!patientName) { setEntryChildren(prev => ({ ...prev, [entry.id]: null })); return }
        const rows = await apiFetch<any[]>(`/api/children?search=${encodeURIComponent(patientName)}`)
        if (!rows?.length) { setEntryChildren(prev => ({ ...prev, [entry.id]: null })); return }
        const notePhone = String(entry.family_phone || noteMap['Phone'] || '').replace(/\D/g, '')
        const noteDob = String(noteMap['DOB'] || '').split('T')[0]
        const scored = rows.map((c: any) => {
          const cPhone = String(c.parent_phone || c.family_phone || '').replace(/\D/g, '')
          const cDob = c.date_of_birth ? String(c.date_of_birth).split('T')[0] : ''
          let score = 0
          if (notePhone && cPhone && notePhone === cPhone) score += 2
          if (noteDob && cDob && noteDob === cDob) score += 1
          return { c, score }
        })
        scored.sort((a, b) => b.score - a.score)
        setEntryChildren(prev => ({ ...prev, [entry.id]: scored[0]?.c ?? null }))
      } catch {
        setEntryChildren(prev => ({ ...prev, [entry.id]: null }))
      }
    })
  }, [entries])

  async function updateStatus(id: string, status: string) {
    await updateWaitlistEntry(id, { status })
    fetchEntries()
  }

  async function acceptEntry() {
    if (!accepting || !provider || !date || !time || submitting) return
    setSubmitting(true)
    setAcceptError(null)

    const [t, ampm] = time.split(' ')
    let [h, m] = t.split(':').map(Number)
    if (ampm === 'PM' && h !== 12) h += 12
    if (ampm === 'AM' && h === 12) h = 0
    const time24 = `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`

    const LABEL_TO_KEY: Record<string, string> = {
      Patient: 'PATIENT', DOB: 'DOB', Email: 'PARENTEMAIL', Phone: 'PARENTPHONE',
      Allergies: 'ALLERGY', Medications: 'MEDS', PMH: 'PMH',
      PCP: 'PCP', Pharmacy: 'PHARMACY', Insurance: 'INSURANCE',
      'Member ID': 'MID', 'Group #': 'GRP',
    }
    const apptNoteParts: string[] = []
    if (accepting.zip) apptNoteParts.push(`ZIP:${accepting.zip}`)
    if (accepting.complaint) apptNoteParts.push(`CC:${accepting.complaint}`)
    if (accepting.preferred_time_window) apptNoteParts.push(`NOTES:Preferred time: ${accepting.preferred_time_window}`)
    ;(accepting.notes || '').split(' | ').forEach(part => {
      const colonIdx = part.indexOf(': ')
      if (colonIdx < 1) return
      const label = part.slice(0, colonIdx).trim()
      const value = part.slice(colonIdx + 2).trim()
      if (!value) return
      if (label === 'Address') {
        apptNoteParts.push(`ADDR:${value}${accepting.state ? ', ' + accepting.state : ''} ${accepting.zip}`.trim())
      } else {
        const key = LABEL_TO_KEY[label]
        if (key) apptNoteParts.push(`${key}:${value}`)
      }
    })

    const finalVisitType = acceptVisitType || accepting.visit_type || 'In-home sick visit'
    const isDual = DUAL_VISIT_TYPES.includes(finalVisitType)
    const acceptorIsInHome = provider.role === 'CMA' || provider.role === 'RN'
    // When an MD/NP accepts a dual-type waitlist entry: don't book yet — send a
    // pairing broadcast. Family and calendars only commit when a CMA/RN claims.
    const mdSendsBroadcast = isDual && !acceptorIsInHome

    try {
      if (mdSendsBroadcast) {
        const isIvFluids = isIvFluidsPair(finalVisitType)
        const pairingRoleNeeded = isIvFluids ? 'RN' : 'CMA'
        const requestType = isIvFluids ? 'In-home RN needed' : 'In-home CMA needed'
        const patientFullName = accepting.family_name || 'Patient'
        const nameParts = patientFullName.trim().split(' ')
        const patientFirst = nameParts.length > 1 ? nameParts.slice(0, -1).join(' ') : patientFullName
        const patientLast = nameParts.length > 1 ? nameParts[nameParts.length - 1] : ''
        const noteMap = parseNotes(accepting.notes)
        const bc = await createBroadcast({
          patient_first_name: patientFirst,
          patient_last_name: patientLast,
          patient_address: noteMap['Address'] || null,
          family_phone: accepting.family_phone || noteMap['Phone'] || null,
          family_email: accepting.family_email || noteMap['Email'] || null,
          state: accepting.state || null,
          zone: accepting.zip || null,
          visit_type: finalVisitType,
          request_type: requestType,
          complaint: accepting.complaint || noteMap['Complaint'] || null,
          is_urgent: false,
          created_by: provider.id,
          created_by_name: `${provider.role} ${provider.name}`,
          pairing_initiator_id: provider.id,
          pairing_initiator_name: `${provider.role} ${provider.name}`,
          pairing_role_needed: pairingRoleNeeded,
          scheduled_date: date,
          scheduled_time: time24,
          waitlist_entry_id: accepting.id,
        }).catch(() => null)
        if (bc?.id) {
          invokeNotifications({ type: 'broadcast', broadcastId: bc.id }).catch(() => {})
        }
        setAccepting(null)
        setDate('')
        setTime('')
        setSubmitting(false)
        fetchEntries()
        return
      }

      // Resolve child_id BEFORE creating the appointment so Today.tsx / the
      // schedule can fetch the child record and surface every field the
      // waitlist card showed (address, allergies, insurance, PCP, etc.).
      // Same resolution rule the follow-up updateChild uses below: explicit
      // child_ids first, then name-match against the family's children.
      let resolvedChildId: string | null = null
      let matchedChildForPatch: any = null
      const noteMapForResolve = parseNotes(accepting.notes)
      try {
        const explicitChildIdsForResolve = Array.isArray((accepting as any).child_ids) ? (accepting as any).child_ids : []
        if (explicitChildIdsForResolve.length > 0) {
          resolvedChildId = explicitChildIdsForResolve[0]
        } else if (accepting.family_id) {
          const patientName = noteMapForResolve['Patient'] || ''
          const [patientFirst, ...restName] = patientName.trim().split(' ')
          const patientLast = restName.join(' ')
          const familyChildren = await getChildrenByFamilyIds([accepting.family_id]).catch(() => [])
          const match = (familyChildren ?? []).find((c: any) => {
            const fn = (c.first_name || '').toLowerCase()
            const ln = (c.last_name || '').toLowerCase()
            return patientFirst && fn === patientFirst.toLowerCase() && (!patientLast || ln === patientLast.toLowerCase())
          })
          if (match) { resolvedChildId = match.id; matchedChildForPatch = match }
        }
      } catch { /* non-blocking */ }

      const apptResult = await createAppointment({
        provider_id: provider.id,
        visit_type: finalVisitType,
        zone: accepting.zip,
        scheduled_time: time24,
        scheduled_date: date,
        status: 'upcoming',
        notes: apptNoteParts.join('|') || `From waitlist · Zip: ${accepting.zip}`,
        ...(resolvedChildId ? { child_id: resolvedChildId } : {}),
        ...(isDual ? { state: accepting.state || null } : {}),
      })

      await updateWaitlistEntry(accepting.id, { status: 'converted', converted_provider_id: provider.id })

      // Save patient data from the waitlist entry into the child's permanent
      // profile — same rule as above: explicit child_ids first, then name match.
      try {
        const noteMap = noteMapForResolve
        const insRaw = noteMap['Insurance'] || ''
        const patientPatch = {
          allergies:               noteMap['Allergies']         || null,
          current_medications:     noteMap['Medications']       || null,
          medical_history:         noteMap['PMH']               || null,
          preferred_pharmacy:      noteMap['Pharmacy']          || null,
          pcp:                     noteMap['PCP']               || null,
          vaccination_status:      noteMap['Vaccination status'] || noteMap['Vaccination'] || null,
          insurance_provider:      insRaw.split(' | ')[0]      || null,
          insurance_member_id:     noteMap['Member ID']         || null,
          insurance_group_number:  noteMap['Group #']           || null,
          parent_phone:            noteMap['Phone']             || accepting.family_phone || null,
          parent_email:            noteMap['Email']             || accepting.family_email || null,
          parent_address:          noteMap['Address']           || null,
          parent_zip:              accepting.zip                || null,
        }

        const explicitChildIds = Array.isArray((accepting as any).child_ids) ? (accepting as any).child_ids : []
        if (explicitChildIds.length > 0) {
          // Await each update so a failure to save patient info surfaces
          // in the outer catch — previously wrapped in .catch(() => {})
          // which meant admin thought the acceptance saved cleanly even
          // when a linked child's record was left stale.
          for (const cid of explicitChildIds as string[]) {
            await updateChild(cid, patientPatch)
          }
        } else if (matchedChildForPatch) {
          await updateChild(matchedChildForPatch.id, patientPatch)
        }
      } catch (e: any) {
        // Log but don't block appointment creation — the appointment IS
        // the primary record. Missing patient-info propagation is worse
        // than losing the appointment; still surface it so admin knows
        // to re-enter the intake data on the chart.
        console.error('[waitlist accept] failed to propagate patient info to child(ren):', e)
        setAcceptError(e?.message ? `Appointment created but patient info didn't save: ${e.message}` : 'Appointment created but patient info didn’t save.')
      }

      const partnerAutoFound = isDual && apptResult?.primary !== undefined && !!apptResult.secondary
      const needsBroadcast = isDual && apptResult?.primary !== undefined && !apptResult.secondary

      // Only notify family when both providers are confirmed — either non-dual or auto-paired
      if (!isDual || partnerAutoFound) {
        invokeNotifications({
          type: 'waitlist_accepted',
          waitlistEntryId: accepting.id,
          providerName: provider.name,
          providerId: provider.id,
          date,
          time,
        }).catch(() => {})
      }

      // Dual visit type — no partner found, fire pairing broadcast; family notified when claimed
      if (needsBroadcast) {
          const noteMap = parseNotes(accepting.notes)
          const patientFullName = noteMap['Patient'] || accepting.family_name || 'Patient'
          const nameParts = patientFullName.trim().split(' ')
          const patientFirst = nameParts.length > 1 ? nameParts.slice(0, -1).join(' ') : patientFullName
          const patientLast = nameParts.length > 1 ? nameParts[nameParts.length - 1] : ''

          const isInHome = provider.role === 'CMA' || provider.role === 'RN'
          const isIvFluids = isIvFluidsPair(finalVisitType)
          const pairingRoleNeeded = isInHome ? 'MD/NP' : (isIvFluids ? 'RN' : 'CMA')
          const requestType = pairingRoleNeeded === 'MD/NP'
            ? 'Telemedicine MD/NP needed'
            : pairingRoleNeeded === 'RN'
              ? 'In-home RN needed'
              : 'In-home CMA needed'

          const bc = await createBroadcast({
            patient_first_name: patientFirst,
            patient_last_name: patientLast,
            patient_address: noteMap['Address'] || null,
            family_phone: accepting.family_phone || noteMap['Phone'] || null,
            family_email: accepting.family_email || noteMap['Email'] || null,
            state: accepting.state || null,
            visit_type: finalVisitType,
            request_type: requestType,
            complaint: accepting.complaint || noteMap['Complaint'] || null,
            is_urgent: false,
            created_by: provider.id,
            created_by_name: `${provider.role} ${provider.name}`,
            related_appointment_id: apptResult.primary.id,
            pairing_initiator_id: provider.id,
            pairing_initiator_name: `${provider.role} ${provider.name}`,
            pairing_role_needed: pairingRoleNeeded,
            scheduled_date: date,
            scheduled_time: time24,
          }).catch(() => null)

          if (bc?.id) {
            invokeNotifications({ type: 'broadcast', broadcastId: bc.id }).catch(() => {})
          }
      }

      setAccepting(null)
      setDate('')
      setTime('')
      fetchEntries()
    } catch (e: any) {
      setAcceptError(e?.message ?? 'Failed to book appointment. Please try again.')
    } finally {
      setSubmitting(false)
    }
  }

  const stateLabel = (s: string | null) =>
    s === 'NC' ? 'North Carolina' : s === 'SC' ? 'South Carolina' : s === 'VA' ? 'Virginia' : s || '—'

  if (!provider) return null

  return (
    <div>
      <div className="bg-white border-b border-[#E8E8E4] px-6 py-4 flex items-center justify-between sticky top-0 z-10">
        <div>
          <div className="font-display text-[18px] font-medium text-[#1A1A2E]">Waitlist</div>
          <div className="text-[12px] text-[#999] mt-0.5">
            Families waiting for an available appointment
          </div>
        </div>
        <div className="flex items-center gap-2">
          {entries.length > 0 && <Badge variant="amber">{entries.length} waiting</Badge>}
          <Button size="sm" onClick={() => { setAddOpen(true); setAddForm(EMPTY_ADD); setNameQuery(''); setSelectedChild(null); setSearchResults([]); setSearchOpen(false) }}>
            <Plus size={13} /> Add patient to waitlist
          </Button>
        </div>
      </div>

      <div className="p-6 space-y-3 max-w-3xl">
        {loading && <div className="text-[#999] text-[13px]">Loading...</div>}

        {!loading && entries.length === 0 && (
          <div className="text-center py-16">
            <CheckCircle2 size={24} className="text-[#aeaeb2] mx-auto mb-2" />
            <p className="text-[14px] text-[#999]">No open waitlist entries right now.</p>
          </div>
        )}

        {entries.map(entry => {
          // Phone/email may live directly on the entry (from family portal) OR
          // parsed out of the free-text notes field (from the admin add-form
          // and legacy entries). Fall back to notes so the card always shows
          // contact info when it exists somewhere.
          const noteMap = parseNotes(entry.notes)
          const displayPhone = entry.family_phone || noteMap['Phone'] || ''
          const displayEmail = entry.family_email || noteMap['Email'] || ''
          return (
          <div key={entry.id} className="border border-[#E8E8E4] rounded-xl p-5 bg-white shadow-sm">
            <div className="flex items-start justify-between gap-4">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap mb-1">
                  <span className="font-display text-[15px] font-medium text-[#1A1A2E]">
                    {entry.family_name || 'Unknown family'}
                  </span>
                  {entry.status && STATUS_COLORS[entry.status] && (
                    <Badge variant={STATUS_COLORS[entry.status].variant}>{STATUS_COLORS[entry.status].label}</Badge>
                  )}
                  {entry.visit_type && <Badge variant="gray">{entry.visit_type}</Badge>}
                </div>

                <div className="flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-[#999] mb-2">
                  <span className="flex items-center gap-1"><MapPin size={11} /> Zip {entry.zip}{entry.state && ` · ${stateLabel(entry.state)}`}</span>
                  {displayPhone && (
                    <a href={`tel:${displayPhone}`} className="flex items-center gap-1 hover:text-[#1A1A2E]">
                      <Phone size={11} /> {displayPhone}
                    </a>
                  )}
                  {displayEmail && (
                    <a href={`mailto:${displayEmail}`} className="flex items-center gap-1 hover:text-[#1A1A2E]">
                      {displayEmail}
                    </a>
                  )}
                  {entry.preferred_time_window && <span className="flex items-center gap-1"><Clock size={11} /> {entry.preferred_time_window}</span>}
                  <span>Waiting since {safeFormat(entry.created_at, 'MMM d, yyyy')}</span>
                </div>

                {(() => {
                  const noteMap = parseNotes(entry.notes)
                  const complaint = entry.complaint || noteMap.Complaint || ''
                  const address = entry.patient_address || noteMap.Address || ''
                  const noteEntries = Object.entries(noteMap).filter(([k]) => k !== 'Complaint' && k !== 'Patient' && k !== 'Address')
                  return (
                    <div className="mt-1 space-y-1">
                      {complaint && (
                        <div className="text-[12px]">
                          <span className="text-[#999]">Chief complaint: </span>
                          <span className="text-[#1A1A2E] font-medium">{complaint}</span>
                        </div>
                      )}
                      {address && (
                        <div className="text-[12px]">
                          <span className="text-[#999]">Address: </span>
                          <span className="text-[#1A1A2E] font-medium">{address}</span>
                        </div>
                      )}
                      {noteMap.Patient && (
                        <div className="text-[12px]">
                          <span className="text-[#999]">Patient: </span>
                          <span className="text-[#1A1A2E] font-medium">{noteMap.Patient}</span>
                        </div>
                      )}
                      {noteEntries.map(([k, v]) => (
                        <div key={k} className="text-[12px]">
                          <span className="text-[#999]">{k}: </span>
                          <span className="text-[#555]">{v}</span>
                        </div>
                      ))}
                    </div>
                  )
                })()}

                {/* Full patient info sourced from the linked child record.
                    Same three-panel Patient / Clinical / Insurance block that
                    appointment cards and broadcast cards render, so every
                    surface shows the same fields. */}
                <WaitlistPatientDetails entry={entry} child={entryChildren[entry.id] ?? null} />
              </div>

              <div className="flex flex-col gap-1.5 flex-shrink-0">
                <Button variant="ghost" size="xs" onClick={() => openEdit(entry)}>
                  <Pencil size={11} /> Edit contact
                </Button>
                {entry.status === 'waiting' && (
                  <Button variant="teal" size="sm" onClick={() => { setAccepting(entry); setAcceptVisitType(entry.visit_type || ''); setDate(''); setTime('') }}>
                    <CheckCircle2 size={11} /> Accept to schedule
                  </Button>
                )}
                <Button variant="danger" size="xs" onClick={() => updateStatus(entry.id, 'removed')}>
                  <XCircle size={11} /> Remove
                </Button>
              </div>
            </div>
          </div>
          )
        })}
      </div>

      {/* Edit contact modal */}
      {editEntry && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" onClick={() => setEditEntry(null)} />
          <div className="relative bg-white rounded-2xl shadow-xl w-full max-w-sm p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-display text-lg font-medium text-[#1A1A2E]">Edit contact info</h2>
              <button onClick={() => setEditEntry(null)} className="p-1.5 rounded-lg hover:bg-[#F1EFE8] text-[#999]"><X size={16} /></button>
            </div>
            <div className="space-y-3">
              <Input label="Patient name" value={editName} onChange={e => setEditName(e.target.value)} />
              <Input label="Phone" placeholder="(704) 555-0000" value={editPhone} onChange={e => setEditPhone(e.target.value)} />
              <Input label="Email" type="email" placeholder="parent@email.com" value={editEmail} onChange={e => setEditEmail(e.target.value)} />
            </div>
            <div className="flex gap-2 mt-5">
              <Button variant="secondary" className="flex-1" onClick={() => setEditEntry(null)}>Cancel</Button>
              <Button variant="teal" className="flex-1" loading={editSubmitting} onClick={saveEdit}>Save</Button>
            </div>
          </div>
        </div>
      )}

      {/* Add patient modal */}
      {addOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" onClick={closeAddModal} />
          <div className="relative bg-white rounded-2xl shadow-xl w-full max-w-md p-6 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-display text-lg font-medium text-[#1A1A2E]">Add patient to waitlist</h2>
              <button onClick={closeAddModal} className="p-1.5 rounded-lg hover:bg-[#F1EFE8] text-[#999]"><X size={16} /></button>
            </div>

            <div className="space-y-3">
              <div className="text-[10px] font-semibold text-[#999] uppercase tracking-widest">Patient info</div>

              <div className="relative">
                <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-1">Patient name *</label>
                {selectedChild ? (
                  <div className="flex items-center gap-2 px-3 py-2.5 border border-[#AFA9EC] rounded-lg bg-[#F5F4FE]">
                    <span className="flex-1 text-[14px] font-medium text-[#1A1A2E]">{addForm.name}</span>
                    <button type="button" onClick={clearSelectedChild} className="text-[#999] hover:text-[#555] flex-shrink-0"><X size={14} /></button>
                  </div>
                ) : (
                  <>
                    <input
                      autoComplete="off"
                      placeholder="Search by name..."
                      value={nameQuery}
                      onChange={e => onNameQueryChange(e.target.value)}
                      onBlur={() => setTimeout(() => setSearchOpen(false), 150)}
                      className="w-full px-3 py-2.5 rounded-lg border border-[#E8E8E4] bg-white focus:border-[#7F77DD] focus:ring-2 focus:ring-[#7F77DD]/10 text-[14px] text-[#1A1A2E] placeholder-[#999] outline-none transition-all"
                    />
                    {searchOpen && searchResults.length > 0 && (
                      <div className="absolute z-20 w-full mt-1 bg-white border border-[#E8E8E4] rounded-lg shadow-lg max-h-48 overflow-y-auto">
                        {searchResults.map(child => {
                          const cn = [child.first_name, child.last_name].filter(Boolean).join(' ') || child.display_label || 'Unknown'
                          const dob = child.date_of_birth ? String(child.date_of_birth instanceof Date ? child.date_of_birth.toISOString() : child.date_of_birth).split('T')[0] : null
                          return (
                            <button key={child.id} type="button" onMouseDown={() => selectChild(child)}
                              className="w-full text-left px-3 py-2.5 hover:bg-[#F5F4FE] border-b border-[#E8E8E4] last:border-0">
                              <div className="text-[14px] font-medium text-[#1A1A2E]">{cn}</div>
                              {dob && <div className="text-[12px] text-[#999]">DOB: {dob}</div>}
                            </button>
                          )
                        })}
                      </div>
                    )}
                    {searchOpen && nameQuery.trim().length > 1 && searchResults.length === 0 && (
                      <div className="absolute z-20 w-full mt-1 bg-white border border-[#E8E8E4] rounded-lg shadow-sm px-3 py-2.5 text-[13px] text-[#999]">
                        No patients found — fill in manually below
                      </div>
                    )}
                  </>
                )}
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-1">Date of birth *</label>
                  <input type="date" value={addForm.dob} onChange={e => setField('dob', e.target.value)}
                    className="w-full px-3 py-2.5 border border-[#E8E8E4] rounded-lg text-[14px] font-sans outline-none focus:border-[#7F77DD]" />
                </div>
                <div>
                  <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-1">Sex *</label>
                  <select value={addForm.gender} onChange={e => setField('gender', e.target.value)}
                    className="w-full px-3 py-2.5 border border-[#E8E8E4] rounded-lg text-[14px] font-sans bg-white outline-none focus:border-[#7F77DD]">
                    <option value="">Select…</option>
                    <option value="Male">Male</option>
                    <option value="Female">Female</option>
                  </select>
                </div>
              </div>
              <Input label="Email *" type="email" placeholder="parent@email.com" value={addForm.email} onChange={e => setField('email', e.target.value)} />
              <Input label="Phone *" placeholder="(704) 555-0000" value={addForm.phone} onChange={e => setField('phone', e.target.value)} />
              <Input label="Visit address *" placeholder="123 Main St" value={addForm.address} onChange={e => setField('address', e.target.value)} />

              <div className="grid grid-cols-3 gap-3">
                <Input label="City *" placeholder="Charlotte" value={addForm.city} onChange={e => setField('city', e.target.value)} />
                <div>
                  <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-1">State *</label>
                  <select value={addForm.state} onChange={e => setField('state', e.target.value)}
                    className="w-full px-3 py-2.5 border border-[#E8E8E4] rounded-lg text-[14px] font-sans bg-white outline-none focus:border-[#7F77DD]">
                    <option value="">Select…</option>
                    <option value="NC">North Carolina</option>
                    <option value="SC">South Carolina</option>
                    <option value="VA">Virginia</option>
                  </select>
                </div>
                <Input label="Zip *" placeholder="28205" value={addForm.zip} onChange={e => setField('zip', e.target.value)} />
              </div>

              <div>
                <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-1">Visit type</label>
                <select value={addForm.visitType} onChange={e => setField('visitType', e.target.value)}
                  className="w-full px-3 py-2.5 border border-[#E8E8E4] rounded-lg text-[14px] font-sans bg-white outline-none focus:border-[#7F77DD]">
                  <option value="">Select…</option>
                  {visitTypes.map(v => <option key={v.visit_type} value={v.visit_type}>{v.badge_label || v.visit_type}</option>)}
                </select>
              </div>

              <div>
                <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-1">Chief complaint *</label>
                <textarea value={addForm.complaint} onChange={e => setField('complaint', e.target.value)}
                  placeholder="Describe symptoms..." rows={2}
                  className="w-full px-3 py-2.5 border border-[#E8E8E4] rounded-lg text-[14px] font-sans resize-none outline-none focus:border-[#7F77DD]" />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-1">Preferred date</label>
                  <input type="date" value={addForm.preferredDate} onChange={e => setField('preferredDate', e.target.value)}
                    min={new Date().toISOString().split('T')[0]}
                    className="w-full px-3 py-2.5 border border-[#E8E8E4] rounded-lg text-[14px] font-sans outline-none focus:border-[#7F77DD]" />
                </div>
                <div>
                  <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-1">Preferred time</label>
                  <select value={addForm.preferredTime} onChange={e => setField('preferredTime', e.target.value)}
                    className="w-full px-3 py-2.5 border border-[#E8E8E4] rounded-lg text-[14px] font-sans bg-white outline-none focus:border-[#7F77DD]">
                    <option value="">Any time</option>
                    <option>Morning (before noon)</option>
                    <option>Afternoon (noon–5pm)</option>
                    <option>After 5pm</option>
                    <option>Weekdays only</option>
                    <option>Weekends OK</option>
                  </select>
                </div>
              </div>

              {!selectedChild && (
                <>
                  <div className="text-[10px] font-semibold text-[#999] uppercase tracking-widest pt-1">Clinical info</div>
                  <Input label="Allergies *" placeholder='e.g. Penicillin — or "NKDA"' value={addForm.allergies} onChange={e => setField('allergies', e.target.value)} />
                  <Input label="Current medications *" placeholder='None, or list medications' value={addForm.medications} onChange={e => setField('medications', e.target.value)} />
                  <Input label="PMH *" placeholder='Significant past medical history — or "None"' value={addForm.pmh} onChange={e => setField('pmh', e.target.value)} />
                  <div className="grid grid-cols-2 gap-3">
                    <Input label="PCP *" placeholder="Primary care provider" value={addForm.pcp} onChange={e => setField('pcp', e.target.value)} />
                    <Input label="Pharmacy *" placeholder="Preferred pharmacy" value={addForm.pharmacy} onChange={e => setField('pharmacy', e.target.value)} />
                  </div>
                  <div>
                    <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-1">Vaccination status *</label>
                    <select value={addForm.vaccinationStatus} onChange={e => setField('vaccinationStatus', e.target.value)}
                      className="w-full px-3 py-2.5 border border-[#E8E8E4] rounded-lg text-[14px] font-sans bg-white outline-none focus:border-[#7F77DD]">
                      <option value="">Select…</option>
                      <option value="fully_vaccinated">Fully vaccinated on schedule</option>
                      <option value="delayed">Delayed / alternative schedule</option>
                      <option value="unvaccinated">Not vaccinated</option>
                    </select>
                  </div>

                  <div className="text-[10px] font-semibold text-[#999] uppercase tracking-widest pt-1">Insurance</div>
                  <label className="flex items-start gap-2 p-3 border border-[#E8E8E4] rounded-lg cursor-pointer hover:bg-[#FAFAF8]">
                    <input type="checkbox" checked={addForm.selfPay}
                      onChange={e => setField('selfPay', e.target.checked)}
                      className="mt-0.5" />
                    <div>
                      <div className="text-[13px] font-medium text-[#1A1A2E]">Self-pay (no insurance)</div>
                      <div className="text-[11px] text-[#999]">Check this if the family is not filing insurance.</div>
                    </div>
                  </label>

                  {!addForm.selfPay && (
                  <>
                  <Input label="Insurance *" placeholder="e.g. BCBS" value={addForm.insurance} onChange={e => setField('insurance', e.target.value)} />
                  <div className="grid grid-cols-2 gap-3">
                    <Input label="Member ID *" value={addForm.memberId} onChange={e => setField('memberId', e.target.value)} />
                    <Input label="Group # *" value={addForm.groupNum} onChange={e => setField('groupNum', e.target.value)} />
                  </div>
                  <Input label="Subscriber name *" placeholder="Full name of policyholder" value={addForm.subscriberName} onChange={e => setField('subscriberName', e.target.value)} />
                  <div className="grid grid-cols-3 gap-3">
                    <div>
                      <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-1">Subscriber DOB *</label>
                      <input type="date" value={addForm.subscriberDob} onChange={e => setField('subscriberDob', e.target.value)}
                        className="w-full px-3 py-2.5 border border-[#E8E8E4] rounded-lg text-[14px] outline-none focus:border-[#7F77DD]" />
                    </div>
                    <div>
                      <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-1">Subscriber sex *</label>
                      <select value={addForm.subscriberGender} onChange={e => setField('subscriberGender', e.target.value)}
                        className="w-full px-3 py-2.5 border border-[#E8E8E4] rounded-lg text-[14px] bg-white outline-none focus:border-[#7F77DD]">
                        <option value="">Select</option>
                        <option value="Male">Male</option>
                        <option value="Female">Female</option>
                      </select>
                    </div>
                    <div>
                      <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-1">Relationship *</label>
                      <select value={addForm.subscriberRelationship} onChange={e => setField('subscriberRelationship', e.target.value)}
                        className="w-full px-3 py-2.5 border border-[#E8E8E4] rounded-lg text-[14px] bg-white outline-none focus:border-[#7F77DD]">
                        <option value="Self">Self</option>
                        <option value="Spouse">Spouse</option>
                        <option value="Child">Child</option>
                        <option value="Other">Other</option>
                      </select>
                    </div>
                  </div>
                  <p className="text-[11px] text-[#999]">Insurance card photos can be uploaded when the family logs in — those aren't required during phone triage.</p>
                  </>
                  )}
                </>
              )}
            </div>

            <div className="flex gap-2 mt-5">
              <Button variant="secondary" className="flex-1" onClick={closeAddModal}>Cancel</Button>
              <Button variant="teal" className="flex-1" loading={addSubmitting} onClick={submitAdd}>
                Add to waitlist
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Accept modal */}
      {accepting && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" onClick={() => setAccepting(null)} />
          <div className="relative bg-white rounded-2xl shadow-xl w-full max-w-sm max-h-[90vh] flex flex-col">
            <div className="flex items-center justify-between px-6 pt-6 pb-4">
              <h2 className="font-display text-lg font-medium text-[#1A1A2E]">Accept waitlist patient</h2>
              <button onClick={() => setAccepting(null)} className="p-1.5 rounded-lg hover:bg-[#F1EFE8] text-[#999]">
                <X size={16} />
              </button>
            </div>

            <div className="px-6 flex-1 overflow-y-auto">
              <div className="p-3 bg-[#FAFAF8] border border-[#E8E8E4] rounded-lg text-[13px] text-[#555] mb-4 space-y-1">
                <div className="font-medium text-[#1A1A2E]">{accepting.family_name}</div>
                <div className="flex items-center gap-1 text-[#999]">
                  <MapPin size={11} /> Zip {accepting.zip} · {stateLabel(accepting.state)}
                </div>
                {accepting.preferred_time_window && (
                  <div className="flex items-center gap-1 text-[#999]">
                    <Clock size={11} /> Preferred: {accepting.preferred_time_window}
                  </div>
                )}
              </div>

              {(() => {
                const modalIsDual = DUAL_VISIT_TYPES.includes(acceptVisitType || accepting.visit_type || '')
                const modalAcceptorIsInHome = provider?.role === 'CMA' || provider?.role === 'RN'
                const modalMdSendsBroadcast = modalIsDual && !modalAcceptorIsInHome
                return modalMdSendsBroadcast ? (
                  <p className="text-[13px] text-[#555] mb-4">
                    This visit needs a {isIvFluidsPair(acceptVisitType) ? 'RN' : 'CMA'} to complete the pair. Confirming will send a broadcast to available {isIvFluidsPair(acceptVisitType) ? 'RNs' : 'CMAs'} — the family will be notified once one claims. No appointment is added to your schedule until then.
                  </p>
                ) : (
                  <p className="text-[13px] text-[#555] mb-4">
                    Choose a visit type, date, and time. The family will be notified and the appointment will be added to your schedule.
                  </p>
                )
              })()}

              <div className="space-y-3 mb-5">
                <div>
                  <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-1">Visit type</label>
                  <select value={acceptVisitType} onChange={e => setAcceptVisitType(e.target.value)}
                    className="w-full px-3 py-2.5 border border-[#E8E8E4] rounded-lg text-[14px] font-sans outline-none focus:border-[#7F77DD] bg-white">
                    <option value="">Select visit type…</option>
                    {visitTypes.map(v => <option key={v.visit_type} value={v.visit_type}>{v.badge_label || v.visit_type}</option>)}
                  </select>
                </div>
                <div>
                  <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-1">Date</label>
                  <input type="date" value={date} min={new Date().toISOString().split('T')[0]}
                    onChange={e => setDate(e.target.value)}
                    className="w-full px-3 py-2.5 border border-[#E8E8E4] rounded-lg text-[14px] font-sans outline-none focus:border-[#7F77DD]" />
                </div>
                {date && (
                  <div>
                    <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-1">Time</label>
                    <div className="grid grid-cols-4 gap-1.5">
                      {TIME_SLOTS.map(slot => (
                        <button key={slot} onClick={() => setTime(slot)}
                          className={`py-1.5 text-center text-[12px] rounded-lg border-2 transition-all font-sans ${
                            time === slot ? 'bg-[#7F77DD] border-[#7F77DD] text-white'
                            : 'border-[#E8E8E4] bg-white hover:border-[#AFA9EC] text-[#1A1A2E]'
                          }`}>
                          {slot}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>

            <div className="px-6 py-4 border-t border-[#E8E8E4]">
              {acceptError && (
                <div className="text-[12px] text-[#DC2626] bg-[#FEE2E2] border border-[#FECACA] rounded-lg px-3 py-2 mb-3">{acceptError}</div>
              )}
              <div className="flex gap-2">
                <Button variant="secondary" className="flex-1" onClick={() => setAccepting(null)}>Cancel</Button>
                {(() => {
                  const modalIsDual = DUAL_VISIT_TYPES.includes(acceptVisitType || accepting.visit_type || '')
                  const modalAcceptorIsInHome = provider?.role === 'CMA' || provider?.role === 'RN'
                  const modalMdSendsBroadcast = modalIsDual && !modalAcceptorIsInHome
                  return (
                    <Button variant="teal" className="flex-1" disabled={!acceptVisitType || !date || !time} loading={submitting} onClick={acceptEntry}>
                      <CheckCircle2 size={14} /> {modalMdSendsBroadcast ? 'Send broadcast' : 'Confirm'}
                    </Button>
                  )
                })()}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
