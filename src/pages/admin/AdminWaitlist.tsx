import { useEffect, useRef, useState } from 'react'
import { Clock, CheckCircle2, Phone, XCircle, Plus, X, Pencil } from 'lucide-react'
import { format } from 'date-fns'
import { getWaitlistEntries, updateWaitlistEntry, getFamiliesByIds, getChildrenByFamilyIds, invokeNotifications, createWaitlistEntry, apiFetch } from '../../lib/api'
import { Badge } from '../../components/ui/Badge'
import { Button } from '../../components/ui/Button'
import { Input } from '../../components/ui/Input'
import { usePracticeVisitTypes } from '../../hooks/usePracticeVisitTypes'

interface WaitlistEntry {
  id: string
  family_id: string
  visit_type: string | null
  zip: string
  state: string | null
  preferred_time_window: string | null
  complaint: string | null
  notes: string | null
  status: 'waiting' | 'contacted' | 'converted' | 'removed'
  created_at: string
  family_email?: string
  family_name?: string
  family_phone?: string
  children?: string[]
}

const STATUS_COLORS = {
  waiting:   { variant: 'amber' as const,   label: 'Waiting' },
  contacted: { variant: 'blue' as const,    label: 'Contacted' },
  converted: { variant: 'teal' as const,    label: 'Converted' },
  removed:   { variant: 'gray' as const,    label: 'Removed' },
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

export function AdminWaitlist() {
  const { visitTypes } = usePracticeVisitTypes()
  const [entries, setEntries] = useState<WaitlistEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [filter] = useState<'waiting' | 'all'>('all')

  // Add patient modal
  const [addOpen, setAddOpen] = useState(false)
  const [addForm, setAddForm] = useState(EMPTY_ADD)
  const [addSubmitting, setAddSubmitting] = useState(false)
  const [addError, setAddError] = useState<string | null>(null)
  const [selectedChild, setSelectedChild] = useState<any | null>(null)
  const [nameQuery, setNameQuery] = useState('')
  const [searchResults, setSearchResults] = useState<any[]>([])
  const [searchOpen, setSearchOpen] = useState(false)
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
    setSelectedChild(child)
    setSearchOpen(false)
    setAddForm(f => ({
      ...f,
      name: childName,
      dob,
      email: child.parent_email || child.family_email || '',
      phone: child.parent_phone || child.family_phone || '',
      address: [child.parent_address || child.family_address_line1, child.parent_city || child.family_city].filter(Boolean).join(', '),
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

  function closeAddModal() {
    setAddOpen(false)
    setAddForm(EMPTY_ADD)
    setNameQuery('')
    setSelectedChild(null)
    setSearchResults([])
    setSearchOpen(false)
    setAddError(null)
  }

  async function submitAdd() {
    if (!addForm.name || !addForm.zip || !addForm.state || !addForm.complaint) return
    setAddSubmitting(true)
    setAddError(null)
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

    const preferredWindow = [
      addForm.preferredDate ? new Date(addForm.preferredDate + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '',
      addForm.preferredTime,
    ].filter(Boolean).join(' — ') || null

    try {
      await createWaitlistEntry({
        visit_type: addForm.visitType || null,
        zip: addForm.zip,
        state: addForm.state,
        complaint: addForm.complaint,
        preferred_time_window: preferredWindow,
        notes: noteParts.join(' | '),
      })
      closeAddModal()
      fetchEntries()
    } catch (err: any) {
      setAddError(err?.message || 'Failed to add patient to waitlist')
    } finally {
      setAddSubmitting(false)
    }
  }

  async function fetchEntries() {
    setLoading(true)
    const params: Record<string, string> = {}
    if (filter === 'waiting') params.status = 'waiting'

    const entries = await getWaitlistEntries(params).catch(() => null)
    if (!entries) { setLoading(false); return }

    const familyIds = [...new Set(entries.map(e => e.family_id).filter(Boolean))]
    const [families, kids] = await Promise.all([
      familyIds.length ? getFamiliesByIds(familyIds).catch(() => []) : Promise.resolve([]),
      familyIds.length ? getChildrenByFamilyIds(familyIds).catch(() => []) : Promise.resolve([]),
    ])

    const enriched = entries.map(e => {
      const fam = (families as any[]).find(f => f.id === e.family_id)
      const childNames = (kids as any[]).filter(k => k.family_id === e.family_id).map((k: any) => k.display_label) || []
      const notesPatient  = e.notes?.match(/Patient:\s*([^|]+)/)?.[1]?.trim() ?? null
      const notesFamily   = e.notes?.match(/Family:\s*([^|]+)/)?.[1]?.trim() ?? null
      const notesEmail    = e.notes?.match(/Email:\s*([^|]+)/)?.[1]?.trim() ?? null
      const notesPhone    = e.notes?.match(/Phone:\s*([^|]+)/)?.[1]?.trim() ?? null
      return {
        ...e,
        family_email: fam?.email ?? notesEmail ?? undefined,
        family_name: fam?.display_name || notesFamily || notesPatient || fam?.email || notesEmail || 'Unknown family',
        family_phone: fam?.phone ?? notesPhone ?? undefined,
        children: childNames,
      }
    })

    setEntries((enriched as WaitlistEntry[]).filter(e => e.status !== 'removed' && e.status !== 'converted'))
    setLoading(false)
  }

  useEffect(() => { fetchEntries() }, [filter])

  async function updateStatus(id: string, status: WaitlistEntry['status']) {
    await updateWaitlistEntry(id, { status })
    fetchEntries()
    if (status === 'converted') {
      invokeNotifications({ type: 'waitlist_converted', waitlistEntryId: id }).catch(() => {})
    }
  }

  const waitingCount = entries.filter(e => e.status === 'waiting').length

  const NOTE_LABELS: Record<string, string> = {
    Patient: 'Patient name', DOB: 'Date of birth', Email: 'Email', Phone: 'Phone',
    Address: 'Address', Allergies: 'Allergies', Medications: 'Medications',
    PMH: 'Medical history', PCP: 'PCP', Pharmacy: 'Preferred pharmacy',
    Insurance: 'Insurance', 'Member ID': 'Member ID', 'Group #': 'Group #',
    Complaint: 'Chief complaint',
  }

  return (
    <div>
      <div className="bg-white border-b border-[#E8E8E4] px-6 py-4 flex items-center justify-between sticky top-0 z-10">
        <div>
          <div className="font-display text-[18px] font-medium text-[#1A1A2E]">Waitlist</div>
          <div className="text-[12px] text-[#999] mt-0.5">Families waiting for an available appointment</div>
        </div>
        <div className="flex items-center gap-2">
          {waitingCount > 0 && <Badge variant="amber">{waitingCount} waiting</Badge>}
          <Button size="sm" onClick={() => { setAddOpen(true); setAddForm(EMPTY_ADD); setNameQuery(''); setSelectedChild(null); setSearchResults([]); setSearchOpen(false); setAddError(null) }}>
            <Plus size={13} /> Add patient to waitlist
          </Button>
        </div>
      </div>

      <div className="p-6 space-y-3 max-w-3xl">
        {!loading && entries.length === 0 && (
          <div className="text-center py-16 text-[#999] text-[14px]">No waitlist entries.</div>
        )}

        {entries.map(e => (
          <div key={e.id} className="bg-white border border-[#E8E8E4] rounded-xl p-5 shadow-sm">
            <div className="flex items-start justify-between gap-4">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap mb-1">
                  <span className="font-display text-[15px] font-medium text-[#1A1A2E]">
                    {e.family_name || 'Unknown family'}
                  </span>
                  <Badge variant={STATUS_COLORS[e.status].variant}>{STATUS_COLORS[e.status].label}</Badge>
                  {e.visit_type && <Badge variant="gray">{e.visit_type}</Badge>}
                </div>

                <div className="flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-[#999] mb-2">
                  <span>Zip {e.zip}{e.state && ` · ${e.state}`}</span>
                  {e.family_phone && (
                    <a href={`tel:${e.family_phone}`} className="flex items-center gap-1 hover:text-[#1A1A2E]">
                      <Phone size={11} /> {e.family_phone}
                    </a>
                  )}
                  {e.family_email && (
                    <a href={`mailto:${e.family_email}`} className="flex items-center gap-1 hover:text-[#1A1A2E]">
                      {e.family_email}
                    </a>
                  )}
                  {e.preferred_time_window && <span className="flex items-center gap-1"><Clock size={11} /> {e.preferred_time_window}</span>}
                  <span>{format(new Date(e.created_at), 'MMM d, yyyy')}</span>
                </div>

                {e.children && e.children.length > 0 && (
                  <p className="text-[12px] text-[#555] mb-1">Children: {e.children.join(', ')}</p>
                )}
                {(() => {
                  const noteMap: Record<string, string> = {}
                  ;(e.notes || '').split(' | ').forEach(part => {
                    const colon = part.indexOf(': ')
                    if (colon > 0) {
                      const k = part.slice(0, colon).trim()
                      const v = part.slice(colon + 2).trim()
                      if (v) noteMap[k] = v
                    }
                  })
                  const complaint = e.complaint || noteMap.Complaint || ''
                  const noteEntries = Object.entries(noteMap).filter(([k]) => k !== 'Complaint' && k !== 'Patient')
                  return (
                    <div className="mt-2 space-y-1">
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
                          <span className="text-[#999]">{NOTE_LABELS[k] || k}: </span>
                          <span className="text-[#555]">{v}</span>
                        </div>
                      ))}
                    </div>
                  )
                })()}
              </div>

              {e.status !== 'removed' && (
                <div className="flex flex-col gap-1.5 flex-shrink-0">
                  <Button variant="ghost" size="xs" onClick={() => openEdit(e)}>
                    <Pencil size={11} /> Edit contact
                  </Button>
                  {e.status !== 'converted' && (
                    <Button variant="teal" size="xs" onClick={() => updateStatus(e.id, 'converted')}>
                      <CheckCircle2 size={11} /> Converted
                    </Button>
                  )}
                  <Button variant="danger" size="xs" onClick={() => updateStatus(e.id, 'removed')}>
                    <XCircle size={11} /> Remove
                  </Button>
                </div>
              )}
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

      {/* Add patient to waitlist modal */}
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

              {/* Patient name search */}
              <div className="relative">
                <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-1">Patient name *</label>
                {selectedChild ? (
                  <div className="flex items-center gap-2 px-3 py-2.5 border border-[#AFA9EC] rounded-lg bg-[#F5F4FE]">
                    <span className="flex-1 text-[14px] font-medium text-[#1A1A2E]">{addForm.name}</span>
                    <button type="button" onClick={() => { setSelectedChild(null); setNameQuery(''); setAddForm(EMPTY_ADD) }} className="text-[#999] hover:text-[#555]"><X size={14} /></button>
                  </div>
                ) : (
                  <>
                    <input autoComplete="off" placeholder="Search by name..."
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
              <Input label="Phone" placeholder="(704) 555-0000" value={addForm.phone} onChange={e => setField('phone', e.target.value)} />
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
            </div>

            {addError && (
              <div className="mt-3 text-[12px] text-[#DC2626] bg-[#FEE2E2] border border-[#FECACA] rounded-lg px-3 py-2">{addError}</div>
            )}

            <div className="flex gap-2 mt-5">
              <Button variant="secondary" className="flex-1" onClick={closeAddModal}>Cancel</Button>
              <Button variant="teal" className="flex-1" loading={addSubmitting}
                disabled={!addForm.name || !addForm.zip || !addForm.state || !addForm.complaint}
                onClick={submitAdd}>
                Add to waitlist
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
