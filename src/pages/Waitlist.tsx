import { useEffect, useRef, useState } from 'react'
import { MapPin, Clock, CheckCircle2, X, Plus, Phone, XCircle, Pencil } from 'lucide-react'
import { format, isValid } from 'date-fns'
import {
  apiFetch, getWaitlistEntries, updateWaitlistEntry,
  createAppointment, invokeNotifications, createWaitlistEntry, createBroadcast,
} from '../lib/api'
import { useAuth } from '../contexts/AuthContext'
import { Badge } from '../components/ui/Badge'
import { Button } from '../components/ui/Button'
import { Input } from '../components/ui/Input'
import { TIME_SLOTS } from '../lib/zipData'
import { usePracticeVisitTypes } from '../hooks/usePracticeVisitTypes'

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
  visit_address: string | null
  children_selected: string | null
  requested_date: string | null
  notes: string | null
  status: string
  created_at: string
}

const EMPTY_ADD = { name: '', dob: '', email: '', phone: '', address: '', zip: '', state: '', visitType: '', complaint: '', preferredDate: '', preferredTime: '', allergies: '', medications: '', pmh: '', pcp: '', pharmacy: '', insurance: '', memberId: '', groupNum: '' }

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

export function Waitlist() {
  const { provider } = useAuth()
  const { visitTypes } = usePracticeVisitTypes()
  const [entries, setEntries] = useState<WaitlistEntry[]>([])
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

  function setField(k: keyof typeof EMPTY_ADD, v: string) {
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
    if (!addForm.name || !addForm.phone || !addForm.zip || !addForm.state || !addForm.complaint) return
    setAddSubmitting(true)
    const noteParts: string[] = []
    noteParts.push(`Patient: ${addForm.name}`)
    if (addForm.dob) noteParts.push(`DOB: ${addForm.dob}`)
    if (addForm.email) noteParts.push(`Email: ${addForm.email}`)
    if (addForm.phone) noteParts.push(`Phone: ${addForm.phone}`)
    if (addForm.address) noteParts.push(`Address: ${addForm.address}`)
    if (addForm.allergies) noteParts.push(`Allergies: ${addForm.allergies}`)
    if (addForm.medications) noteParts.push(`Medications: ${addForm.medications}`)
    if (addForm.pmh) noteParts.push(`PMH: ${addForm.pmh}`)
    if (addForm.pcp) noteParts.push(`PCP: ${addForm.pcp}`)
    if (addForm.pharmacy) noteParts.push(`Pharmacy: ${addForm.pharmacy}`)
    if (addForm.insurance) noteParts.push(`Insurance: ${addForm.insurance}`)
    if (addForm.memberId) noteParts.push(`Member ID: ${addForm.memberId}`)
    if (addForm.groupNum) noteParts.push(`Group #: ${addForm.groupNum}`)
    if (addForm.complaint) noteParts.push(`Complaint: ${addForm.complaint}`)
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
        notes: noteParts.join(' | '),
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

  function slotToMinutes(slot: string): number {
    const [t, ampm] = slot.split(' ')
    let [h, m] = t.split(':').map(Number)
    if (ampm === 'PM' && h !== 12) h += 12
    if (ampm === 'AM' && h === 12) h = 0
    return h * 60 + m
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

  async function updateStatus(id: string, status: string) {
    await updateWaitlistEntry(id, { status })
    fetchEntries()
  }

  async function acceptEntry() {
    if (!accepting || !provider || !date || !time) return
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
      'Member ID': 'MEMBERID', 'Group #': 'GROUPNUM',
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
    const DUAL_VISIT_TYPES = ['CMA + telemedicine', 'In-home IV fluids']
    const isDual = DUAL_VISIT_TYPES.includes(finalVisitType)

    try {
      const apptResult = await createAppointment({
        provider_id: provider.id,
        visit_type: finalVisitType,
        zone: accepting.zip,
        scheduled_time: time24,
        scheduled_date: date,
        status: 'upcoming',
        notes: apptNoteParts.join('|') || `From waitlist · Zip: ${accepting.zip}`,
        ...(isDual ? { state: accepting.state || null } : {}),
      })

      await updateWaitlistEntry(accepting.id, { status: 'converted', converted_provider_id: provider.id })

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
          const isIvFluids = finalVisitType === 'In-home IV fluids'
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

        {entries.map(entry => (
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
                  {entry.family_phone && (
                    <a href={`tel:${entry.family_phone}`} className="flex items-center gap-1 hover:text-[#1A1A2E]">
                      <Phone size={11} /> {entry.family_phone}
                    </a>
                  )}
                  {entry.family_email && (
                    <a href={`mailto:${entry.family_email}`} className="flex items-center gap-1 hover:text-[#1A1A2E]">
                      {entry.family_email}
                    </a>
                  )}
                  {entry.preferred_time_window && <span className="flex items-center gap-1"><Clock size={11} /> {entry.preferred_time_window}</span>}
                  <span>Waiting since {safeFormat(entry.created_at, 'MMM d, yyyy')}</span>
                </div>

                {(() => {
                  const noteMap = parseNotes(entry.notes)
                  const complaint = entry.complaint || noteMap.Complaint || ''
                  const noteEntries = Object.entries(noteMap).filter(([k]) => k !== 'Complaint' && k !== 'Patient')
                  return (
                    <div className="mt-1 space-y-1">
                      {complaint && (
                        <div className="text-[12px]">
                          <span className="text-[#999]">Chief complaint: </span>
                          <span className="text-[#1A1A2E] font-medium">{complaint}</span>
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
        ))}
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
                  <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-1">Date of birth</label>
                  <input type="date" value={addForm.dob} onChange={e => setField('dob', e.target.value)}
                    className="w-full px-3 py-2.5 border border-[#E8E8E4] rounded-lg text-[14px] font-sans outline-none focus:border-[#7F77DD]" />
                </div>
                <Input label="Email" type="email" placeholder="parent@email.com" value={addForm.email} onChange={e => setField('email', e.target.value)} />
              </div>
              <Input label="Phone *" placeholder="(704) 555-0000" value={addForm.phone} onChange={e => setField('phone', e.target.value)} />
              <Input label="Visit address" placeholder="123 Main St, City, State" value={addForm.address} onChange={e => setField('address', e.target.value)} />

              <div className="grid grid-cols-2 gap-3">
                <Input label="Zip *" placeholder="28205" value={addForm.zip} onChange={e => setField('zip', e.target.value)} />
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
                  <Input label="Allergies" placeholder="e.g. Penicillin — or NKDA" value={addForm.allergies} onChange={e => setField('allergies', e.target.value)} />
                  <Input label="Current medications" placeholder="None, or list medications" value={addForm.medications} onChange={e => setField('medications', e.target.value)} />
                  <Input label="PMH" placeholder="Significant past medical history" value={addForm.pmh} onChange={e => setField('pmh', e.target.value)} />
                  <Input label="PCP" placeholder="Primary care provider" value={addForm.pcp} onChange={e => setField('pcp', e.target.value)} />
                  <Input label="Pharmacy" placeholder="Preferred pharmacy" value={addForm.pharmacy} onChange={e => setField('pharmacy', e.target.value)} />

                  <div className="text-[10px] font-semibold text-[#999] uppercase tracking-widest pt-1">Insurance</div>
                  <Input label="Insurance" placeholder="e.g. BCBS" value={addForm.insurance} onChange={e => setField('insurance', e.target.value)} />
                  <div className="grid grid-cols-2 gap-3">
                    <Input label="Member ID" value={addForm.memberId} onChange={e => setField('memberId', e.target.value)} />
                    <Input label="Group #" value={addForm.groupNum} onChange={e => setField('groupNum', e.target.value)} />
                  </div>
                </>
              )}
            </div>

            <div className="flex gap-2 mt-5">
              <Button variant="secondary" className="flex-1" onClick={closeAddModal}>Cancel</Button>
              <Button variant="teal" className="flex-1" loading={addSubmitting}
                disabled={!addForm.name || !addForm.phone || !addForm.zip || !addForm.state || !addForm.complaint}
                onClick={submitAdd}>
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
          <div className="relative bg-white rounded-2xl shadow-xl w-full max-w-sm p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-display text-lg font-medium text-[#1A1A2E]">Accept waitlist patient</h2>
              <button onClick={() => setAccepting(null)} className="p-1.5 rounded-lg hover:bg-[#F1EFE8] text-[#999]">
                <X size={16} />
              </button>
            </div>

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

            <p className="text-[13px] text-[#555] mb-4">
              Choose a visit type, date, and time. The family will be notified and the appointment will be added to your schedule.
            </p>

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

            {acceptError && (
              <div className="text-[12px] text-[#DC2626] bg-[#FEE2E2] border border-[#FECACA] rounded-lg px-3 py-2 mb-3">{acceptError}</div>
            )}
            <div className="flex gap-2">
              <Button variant="secondary" className="flex-1" onClick={() => setAccepting(null)}>Cancel</Button>
              <Button variant="teal" className="flex-1" disabled={!acceptVisitType || !date || !time} loading={submitting} onClick={acceptEntry}>
                <CheckCircle2 size={14} /> Confirm
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
