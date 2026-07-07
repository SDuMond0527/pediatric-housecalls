import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { ChevronLeft, ChevronDown, Phone, MapPin, Stethoscope, Pill, Shield, Pencil, CheckCircle2, X } from 'lucide-react'
import { format, parseISO, differenceInYears } from 'date-fns'
import { getEncounterNotes, getVitalsList, getChildrenByIds, getBookingRequests, apiFetch } from '../lib/api'
import { Badge } from '../components/ui/Badge'

interface NoteWithVisit {
  id: string
  appointment_id: string
  child_id: string
  chief_complaint: string | null
  subjective: string | null
  objective: string | null
  assessment: string | null
  plan: string | null
  diagnoses: { code: string; name: string }[]
  is_signed: boolean
  signed_at: string | null
  visit_type: string
  scheduled_date: string
  scheduled_time: string
  zone: string
  provider_name: string | null
}

function calcAge(dob: string): string {
  try {
    const years = differenceInYears(new Date(), parseISO(dob))
    return `${years}y`
  } catch {
    return ''
  }
}

function formatDob(dob: string): string {
  try {
    return format(parseISO(dob), 'MMM d, yyyy')
  } catch {
    return dob
  }
}

function vitalChips(v: any): string {
  const parts: string[] = []
  if (v?.temperature_f != null) parts.push(`${v.temperature_f}°F`)
  if (v?.heart_rate != null) parts.push(`HR ${v.heart_rate}`)
  if (v?.oxygen_saturation != null) parts.push(`O2 ${v.oxygen_saturation}%`)
  if (v?.weight_lbs != null) parts.push(`${v.weight_lbs} lbs`)
  return parts.join(' · ')
}

function statusColor(status: string): string {
  const s = (status ?? '').toLowerCase()
  if (s === 'pending') return 'bg-[#F1EFE8] text-[#777]'
  if (s === 'confirmed' || s === 'accepted') return 'bg-[#EEF6FB] text-[#2D7BA6]'
  if (s === 'completed') return 'bg-[#E6F6F2] text-[#1A7D5A]'
  if (s === 'cancelled' || s === 'declined') return 'bg-[#FDEDED] text-[#991B1B]'
  return 'bg-[#F1EFE8] text-[#777]'
}

function Field({ label, value }: { label: string; value?: string | null }) {
  return (
    <div>
      <div className="text-[11px] text-[#999]">{label}</div>
      {value ? (
        <div className="text-[13px] text-[#1A1A2E] mt-0.5">{value}</div>
      ) : (
        <div className="text-[13px] text-[#bbb] mt-0.5">Not on file</div>
      )}
    </div>
  )
}

export function PatientChart() {
  const { childId } = useParams<{ childId: string }>()
  const navigate = useNavigate()

  const [activeTab, setActiveTab] = useState<'overview' | 'appointments' | 'encounters'>('overview')
  const [child, setChild] = useState<any | null>(null)
  const [notes, setNotes] = useState<NoteWithVisit[]>([])
  const [vitalsByAppt, setVitalsByAppt] = useState<Record<string, any>>({})
  const [bookingRequests, setBookingRequests] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [expandedNote, setExpandedNote] = useState<string | null>(null)

  // Edit state
  const [editingSection, setEditingSection] = useState<'medical' | 'insurance' | null>(null)
  const [editSaving, setEditSaving] = useState(false)
  const [editSaved, setEditSaved] = useState(false)
  const [editError, setEditError] = useState<string | null>(null)
  const [medEdit, setMedEdit] = useState({ allergies: '', current_medications: '', medical_history: '', pcp: '', preferred_pharmacy: '' })
  const [insEdit, setInsEdit] = useState({ insurance_provider: '', insurance_member_id: '', insurance_group_number: '', insurance_subscriber_name: '', insurance_subscriber_dob: '', insurance_subscriber_gender: '' })

  useEffect(() => {
    if (!childId) return
    const cid = childId
    async function load() {
      setLoading(true)
      const [childrenRes, notesRes, vitalsRes, bookingRes] = await Promise.all([
        getChildrenByIds([cid]).catch(() => [] as any[]),
        getEncounterNotes({ child_id: cid }).catch(() => [] as NoteWithVisit[]),
        getVitalsList({ child_id: cid }).catch(() => [] as any[]),
        getBookingRequests({ child_id: cid }).catch(() => [] as any[]),
      ])
      setChild(childrenRes?.[0] ?? null)
      setNotes(notesRes ?? [])
      const byAppt: Record<string, any> = {}
      ;(vitalsRes ?? []).forEach((v: any) => { byAppt[v.appointment_id] = v })
      setVitalsByAppt(byAppt)
      setBookingRequests(bookingRes ?? [])
      setLoading(false)
    }
    load()
  }, [childId])

  const today = new Date().toISOString().slice(0, 10)
  const upcomingRequests = bookingRequests.filter(br => {
    const s = (br.status ?? '').toLowerCase()
    return br.preferred_date >= today && s !== 'cancelled' && s !== 'declined'
  })
  const pastRequests = bookingRequests.filter(br => {
    const s = (br.status ?? '').toLowerCase()
    return br.preferred_date < today || s === 'cancelled' || s === 'declined'
  })

  const name = child
    ? ([child.first_name, child.last_name].filter(Boolean).join(' ') || child.display_label || 'Unknown patient')
    : 'Loading…'

  const dob = child?.date_of_birth ? String(child.date_of_birth).split('T')[0] : null

  const tabs = [
    { key: 'overview' as const, label: 'Overview', count: null },
    { key: 'appointments' as const, label: 'Appointments', count: bookingRequests.length },
    { key: 'encounters' as const, label: 'Encounters', count: notes.length },
  ]

  function startEdit(section: 'medical' | 'insurance') {
    setEditError(null)
    setEditSaved(false)
    if (section === 'medical') {
      setMedEdit({
        allergies: child?.allergies || '',
        current_medications: child?.current_medications || '',
        medical_history: child?.medical_history || '',
        pcp: child?.pcp || '',
        preferred_pharmacy: child?.preferred_pharmacy || '',
      })
    } else {
      setInsEdit({
        insurance_provider: child?.insurance_provider || '',
        insurance_member_id: child?.insurance_member_id || '',
        insurance_group_number: child?.insurance_group_number || '',
        insurance_subscriber_name: child?.insurance_subscriber_name || '',
        insurance_subscriber_dob: child?.insurance_subscriber_dob ? String(child.insurance_subscriber_dob).split('T')[0] : '',
        insurance_subscriber_gender: child?.insurance_subscriber_gender || '',
      })
    }
    setEditingSection(section)
  }

  async function saveEdit(section: 'medical' | 'insurance') {
    if (!childId) return
    setEditSaving(true)
    setEditError(null)
    try {
      const body = section === 'medical' ? medEdit : insEdit
      const updated = await apiFetch<any>(`/api/children/${childId}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      })
      setChild((prev: any) => ({ ...prev, ...updated }))
      setEditingSection(null)
      setEditSaved(true)
      setTimeout(() => setEditSaved(false), 2500)
    } catch (e: any) {
      setEditError(e.message ?? 'Save failed')
    } finally {
      setEditSaving(false)
    }
  }

  return (
    <div className="min-h-screen bg-[#FAFAF8]">
      <div className="bg-white border-b border-[#E8E8E4] px-6 py-4 sticky top-0 z-10">
        <div className="flex items-center gap-3 max-w-3xl mx-auto">
          <button
            onClick={() => navigate(-1)}
            className="p-1.5 rounded-lg hover:bg-[#F1EFE8] text-[#555] transition-colors flex-shrink-0"
          >
            <ChevronLeft size={18} />
          </button>
          <div className="flex-1 min-w-0">
            <div className="font-display text-[18px] font-medium text-[#1A1A2E]">{name}</div>
            {child && (
              <div className="text-[12px] text-[#999] mt-0.5 flex items-center gap-2 flex-wrap">
                {dob && <span>DOB {formatDob(dob)} ({calcAge(dob)})</span>}
                {child.allergies && (
                  <span className="text-[#991B1B] font-medium bg-[#FDEDED] px-1.5 py-0.5 rounded">
                    ⚠ Allergies
                  </span>
                )}
              </div>
            )}
          </div>
        </div>
        <div className="flex gap-2 mt-3 max-w-3xl mx-auto">
          {tabs.map(tab => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[12px] font-medium transition-colors ${
                activeTab === tab.key
                  ? 'bg-[#7F77DD] text-white'
                  : 'bg-white text-[#555] border border-[#E8E8E4] hover:border-[#AFA9EC]'
              }`}
            >
              {tab.label}
              {tab.count !== null && (
                <span className={`text-[11px] px-1.5 py-0.5 rounded-full ${
                  activeTab === tab.key ? 'bg-white/20 text-white' : 'bg-[#F1EFE8] text-[#777]'
                }`}>
                  {tab.count}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>

      <div className="p-6 max-w-3xl mx-auto">
        {loading ? (
          <div className="text-center py-16 text-[#999] text-[14px]">Loading chart…</div>
        ) : (
          <>
            {activeTab === 'overview' && (
              <div className="space-y-4">
                <div className="bg-white border border-[#E8E8E4] rounded-xl p-5 shadow-sm">
                  <div className="flex items-center gap-2 mb-4">
                    <Phone size={14} className="text-[#7F77DD]" />
                    <div className="text-[10px] font-semibold text-[#7F77DD] uppercase tracking-wider">Contact & Family</div>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <Field label="Family" value={child?.family_display_name} />
                    <Field label="Phone" value={child?.family_phone} />
                    <Field label="Email" value={child?.family_email} />
                    <div>
                      <div className="text-[11px] text-[#999] flex items-center gap-1">
                        <MapPin size={11} />
                        Address
                      </div>
                      {child?.family_address_line1 ? (
                        <div className="text-[13px] text-[#1A1A2E] mt-0.5">
                          {child.family_address_line1}
                          {(child.family_city || child.family_state || child.family_zip) && (
                            <>, {[child.family_city, child.family_state, child.family_zip].filter(Boolean).join(' ')}</>
                          )}
                        </div>
                      ) : (
                        <div className="text-[13px] text-[#bbb] mt-0.5">Not on file</div>
                      )}
                    </div>
                  </div>
                </div>

                <div className="bg-white border border-[#E8E8E4] rounded-xl p-5 shadow-sm">
                  <div className="flex items-center justify-between mb-4">
                    <div className="flex items-center gap-2">
                      <Stethoscope size={14} className="text-[#7F77DD]" />
                      <div className="text-[10px] font-semibold text-[#7F77DD] uppercase tracking-wider">Medical Information</div>
                    </div>
                    {editingSection !== 'medical' && (
                      <button onClick={() => startEdit('medical')}
                        className="flex items-center gap-1 text-[11px] text-[#7F77DD] font-medium hover:underline">
                        <Pencil size={11} /> Edit
                      </button>
                    )}
                  </div>
                  {editingSection === 'medical' ? (
                    <div className="space-y-3">
                      <div>
                        <label className="text-[11px] text-[#999] flex items-center gap-1 mb-1"><Pill size={11} /> Drug &amp; food allergies</label>
                        <input className="w-full px-3 py-2 border border-[#E8E8E4] rounded-lg text-[13px] focus:border-[#7F77DD] outline-none"
                          value={medEdit.allergies} onChange={e => setMedEdit(p => ({ ...p, allergies: e.target.value }))}
                          placeholder="e.g. Penicillin, peanuts — or NKDA" />
                      </div>
                      <div>
                        <label className="text-[11px] text-[#999] block mb-1">Current medications</label>
                        <input className="w-full px-3 py-2 border border-[#E8E8E4] rounded-lg text-[13px] focus:border-[#7F77DD] outline-none"
                          value={medEdit.current_medications} onChange={e => setMedEdit(p => ({ ...p, current_medications: e.target.value }))}
                          placeholder="e.g. Zyrtec 5mg daily — or None" />
                      </div>
                      <div>
                        <label className="text-[11px] text-[#999] block mb-1">Medical history</label>
                        <textarea rows={2} className="w-full px-3 py-2 border border-[#E8E8E4] rounded-lg text-[13px] focus:border-[#7F77DD] outline-none resize-none"
                          value={medEdit.medical_history} onChange={e => setMedEdit(p => ({ ...p, medical_history: e.target.value }))}
                          placeholder="e.g. Asthma, ADHD, prior surgeries..." />
                      </div>
                      <div>
                        <label className="text-[11px] text-[#999] block mb-1">Primary care provider</label>
                        <input className="w-full px-3 py-2 border border-[#E8E8E4] rounded-lg text-[13px] focus:border-[#7F77DD] outline-none"
                          value={medEdit.pcp} onChange={e => setMedEdit(p => ({ ...p, pcp: e.target.value }))}
                          placeholder="e.g. Dr. Jane Smith, Charlotte Pediatrics" />
                      </div>
                      <div>
                        <label className="text-[11px] text-[#999] block mb-1">Preferred pharmacy</label>
                        <input className="w-full px-3 py-2 border border-[#E8E8E4] rounded-lg text-[13px] focus:border-[#7F77DD] outline-none"
                          value={medEdit.preferred_pharmacy} onChange={e => setMedEdit(p => ({ ...p, preferred_pharmacy: e.target.value }))}
                          placeholder="e.g. CVS on Providence Rd" />
                      </div>
                      {editError && <div className="text-[12px] text-[#991B1B] bg-[#FDEDED] px-3 py-2 rounded-lg">{editError}</div>}
                      <div className="flex gap-2 pt-1">
                        <button onClick={() => saveEdit('medical')} disabled={editSaving}
                          className="flex items-center gap-1.5 px-3 py-1.5 bg-[#7F77DD] text-white text-[12px] font-medium rounded-lg hover:bg-[#6C64C8] disabled:opacity-50">
                          {editSaving ? 'Saving…' : 'Save'}
                        </button>
                        <button onClick={() => setEditingSection(null)}
                          className="flex items-center gap-1 px-3 py-1.5 border border-[#E8E8E4] text-[12px] text-[#555] rounded-lg hover:bg-[#F1EFE8]">
                          <X size={12} /> Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="space-y-4">
                      <div>
                        <div className="text-[11px] text-[#999] flex items-center gap-1">
                          <Pill size={11} />
                          Drug &amp; food allergies
                        </div>
                        {child?.allergies ? (
                          <div className="text-[13px] text-[#991B1B] bg-[#FDEDED] mt-0.5 px-2.5 py-1.5 rounded-lg">
                            {child.allergies}
                          </div>
                        ) : (
                          <div className="text-[13px] text-[#bbb] mt-0.5">Not recorded</div>
                        )}
                      </div>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        {[
                          { label: 'Current medications', value: child?.current_medications },
                          { label: 'Medical history', value: child?.medical_history },
                          { label: 'Primary care provider', value: child?.pcp },
                          { label: 'Preferred pharmacy', value: child?.preferred_pharmacy },
                        ].map(({ label, value }) => (
                          <div key={label}>
                            <div className="text-[11px] text-[#999]">{label}</div>
                            {value ? (
                              <div className="text-[13px] text-[#1A1A2E] mt-0.5">{value}</div>
                            ) : (
                              <div className="text-[13px] text-[#bbb] mt-0.5">Not recorded</div>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>

                <div className="bg-white border border-[#E8E8E4] rounded-xl p-5 shadow-sm">
                  <div className="flex items-center justify-between mb-4">
                    <div className="flex items-center gap-2">
                      <Shield size={14} className="text-[#7F77DD]" />
                      <div className="text-[10px] font-semibold text-[#7F77DD] uppercase tracking-wider">Insurance</div>
                    </div>
                    {editingSection !== 'insurance' && (
                      <button onClick={() => startEdit('insurance')}
                        className="flex items-center gap-1 text-[11px] text-[#7F77DD] font-medium hover:underline">
                        <Pencil size={11} /> Edit
                      </button>
                    )}
                  </div>
                  {editingSection === 'insurance' ? (
                    <div className="space-y-3">
                      <div>
                        <label className="text-[11px] text-[#999] block mb-1">Insurance company / plan name</label>
                        <input className="w-full px-3 py-2 border border-[#E8E8E4] rounded-lg text-[13px] focus:border-[#7F77DD] outline-none"
                          value={insEdit.insurance_provider} onChange={e => setInsEdit(p => ({ ...p, insurance_provider: e.target.value }))}
                          placeholder="e.g. Blue Cross Blue Shield" />
                      </div>
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <label className="text-[11px] text-[#999] block mb-1">Member ID</label>
                          <input className="w-full px-3 py-2 border border-[#E8E8E4] rounded-lg text-[13px] focus:border-[#7F77DD] outline-none"
                            value={insEdit.insurance_member_id} onChange={e => setInsEdit(p => ({ ...p, insurance_member_id: e.target.value }))}
                            placeholder="e.g. XYZ123456" />
                        </div>
                        <div>
                          <label className="text-[11px] text-[#999] block mb-1">Group number</label>
                          <input className="w-full px-3 py-2 border border-[#E8E8E4] rounded-lg text-[13px] focus:border-[#7F77DD] outline-none"
                            value={insEdit.insurance_group_number} onChange={e => setInsEdit(p => ({ ...p, insurance_group_number: e.target.value }))}
                            placeholder="e.g. 12345" />
                        </div>
                      </div>
                      <div>
                        <label className="text-[11px] text-[#999] block mb-1">Subscriber name</label>
                        <input className="w-full px-3 py-2 border border-[#E8E8E4] rounded-lg text-[13px] focus:border-[#7F77DD] outline-none"
                          value={insEdit.insurance_subscriber_name} onChange={e => setInsEdit(p => ({ ...p, insurance_subscriber_name: e.target.value }))}
                          placeholder="e.g. John Smith" />
                      </div>
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <label className="text-[11px] text-[#999] block mb-1">Subscriber DOB</label>
                          <input type="date" className="w-full px-3 py-2 border border-[#E8E8E4] rounded-lg text-[13px] focus:border-[#7F77DD] outline-none"
                            value={insEdit.insurance_subscriber_dob} onChange={e => setInsEdit(p => ({ ...p, insurance_subscriber_dob: e.target.value }))} />
                        </div>
                        <div>
                          <label className="text-[11px] text-[#999] block mb-1">Subscriber sex</label>
                          <select className="w-full px-3 py-2 border border-[#E8E8E4] rounded-lg text-[13px] bg-white focus:border-[#7F77DD] outline-none"
                            value={insEdit.insurance_subscriber_gender} onChange={e => setInsEdit(p => ({ ...p, insurance_subscriber_gender: e.target.value }))}>
                            <option value="">—</option>
                            <option value="M">Male</option>
                            <option value="F">Female</option>
                          </select>
                        </div>
                      </div>
                      {editError && <div className="text-[12px] text-[#991B1B] bg-[#FDEDED] px-3 py-2 rounded-lg">{editError}</div>}
                      <div className="flex gap-2 pt-1">
                        <button onClick={() => saveEdit('insurance')} disabled={editSaving}
                          className="flex items-center gap-1.5 px-3 py-1.5 bg-[#7F77DD] text-white text-[12px] font-medium rounded-lg hover:bg-[#6C64C8] disabled:opacity-50">
                          {editSaving ? 'Saving…' : 'Save'}
                        </button>
                        <button onClick={() => setEditingSection(null)}
                          className="flex items-center gap-1 px-3 py-1.5 border border-[#E8E8E4] text-[12px] text-[#555] rounded-lg hover:bg-[#F1EFE8]">
                          <X size={12} /> Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    child?.insurance_provider || child?.insurance_member_id || child?.insurance_group_number ? (
                      <div className="space-y-4">
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                          <Field label="Insurance plan" value={child?.insurance_provider} />
                          <Field label="Member ID" value={child?.insurance_member_id} />
                          <Field label="Group number" value={child?.insurance_group_number} />
                          <Field label="Subscriber" value={child?.insurance_subscriber_name || child?.family_display_name} />
                          <Field label="Subscriber DOB" value={child?.insurance_subscriber_dob ? formatDob(String(child.insurance_subscriber_dob).split('T')[0]) : null} />
                          <Field label="Subscriber sex" value={child?.insurance_subscriber_gender === 'M' ? 'Male' : child?.insurance_subscriber_gender === 'F' ? 'Female' : child?.insurance_subscriber_gender} />
                        </div>
                        {(child?.insurance_card_front_url || child?.insurance_card_back_url) && (
                          <div>
                            <div className="text-[11px] text-[#999] mb-2">Insurance card</div>
                            <div className="grid grid-cols-2 gap-3">
                              {child?.insurance_card_front_url && (
                                <div>
                                  <div className="text-[11px] text-[#999] mb-1">Front</div>
                                  <img src={child.insurance_card_front_url} alt="Insurance card front"
                                    className="w-full rounded-lg border border-[#E8E8E4] object-cover" />
                                </div>
                              )}
                              {child?.insurance_card_back_url && (
                                <div>
                                  <div className="text-[11px] text-[#999] mb-1">Back</div>
                                  <img src={child.insurance_card_back_url} alt="Insurance card back"
                                    className="w-full rounded-lg border border-[#E8E8E4] object-cover" />
                                </div>
                              )}
                            </div>
                          </div>
                        )}
                      </div>
                    ) : (
                      <div className="text-[13px] text-[#bbb] text-center py-4">No insurance information on file</div>
                    )
                  )}
                </div>
                {editSaved && (
                  <div className="flex items-center gap-2 text-[13px] text-[#085041]">
                    <CheckCircle2 size={14} /> Saved!
                  </div>
                )}
              </div>
            )}

            {activeTab === 'appointments' && (
              <div className="space-y-6">
                <div>
                  <div className="text-[10px] font-semibold text-[#7F77DD] uppercase tracking-wider mb-3">Upcoming</div>
                  {upcomingRequests.length === 0 ? (
                    <div className="text-[13px] text-[#bbb] text-center py-6 bg-white border border-[#E8E8E4] rounded-xl">
                      No upcoming appointments
                    </div>
                  ) : (
                    <div className="space-y-3">
                      {upcomingRequests.map(br => (
                        <div key={br.id} className="bg-white border border-[#E8E8E4] rounded-xl p-4 shadow-sm">
                          <div className="flex items-start justify-between gap-3">
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2 flex-wrap mb-1.5">
                                <span className="font-display text-[15px] font-medium text-[#1A1A2E]">
                                  {br.preferred_date ? format(parseISO(br.preferred_date), 'MMM d, yyyy') : 'Date TBD'}
                                </span>
                                {br.visit_type && <Badge variant="purple">{br.visit_type}</Badge>}
                              </div>
                              <div className="text-[12px] text-[#999] mb-1">
                                {br.zone && <span>{br.zone}</span>}
                                {br.provider_name && <span> · {br.provider_name}</span>}
                              </div>
                              {br.notes && (
                                <div className="text-[12px] text-[#555] mt-1">
                                  {br.notes.length > 100 ? br.notes.slice(0, 100) + '…' : br.notes}
                                </div>
                              )}
                            </div>
                            <span className={`text-[11px] font-medium px-2.5 py-1 rounded-full flex-shrink-0 capitalize ${statusColor(br.status)}`}>
                              {br.status ?? 'pending'}
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div>
                  <div className="text-[10px] font-semibold text-[#7F77DD] uppercase tracking-wider mb-3">Past</div>
                  {pastRequests.length === 0 ? (
                    <div className="text-[13px] text-[#bbb] text-center py-6 bg-white border border-[#E8E8E4] rounded-xl">
                      No past appointments
                    </div>
                  ) : (
                    <div className="space-y-3">
                      {pastRequests.map(br => (
                        <div key={br.id} className="bg-white border border-[#E8E8E4] rounded-xl p-4 shadow-sm opacity-80">
                          <div className="flex items-start justify-between gap-3">
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2 flex-wrap mb-1.5">
                                <span className="font-display text-[15px] font-medium text-[#1A1A2E]">
                                  {br.preferred_date ? format(parseISO(br.preferred_date), 'MMM d, yyyy') : 'Date TBD'}
                                </span>
                                {br.visit_type && <Badge variant="purple">{br.visit_type}</Badge>}
                              </div>
                              <div className="text-[12px] text-[#999] mb-1">
                                {br.zone && <span>{br.zone}</span>}
                                {br.provider_name && <span> · {br.provider_name}</span>}
                              </div>
                              {br.notes && (
                                <div className="text-[12px] text-[#555] mt-1">
                                  {br.notes.length > 100 ? br.notes.slice(0, 100) + '…' : br.notes}
                                </div>
                              )}
                            </div>
                            <span className={`text-[11px] font-medium px-2.5 py-1 rounded-full flex-shrink-0 capitalize ${statusColor(br.status)}`}>
                              {br.status ?? 'unknown'}
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}

            {activeTab === 'encounters' && (
              <div>
                {notes.length === 0 ? (
                  <div className="text-center py-16">
                    <div className="text-[#999] text-[14px]">No encounter notes on file for this patient.</div>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {notes.map(note => {
                      const vitals = vitalsByAppt[note.appointment_id]
                      const chips = vitals ? vitalChips(vitals) : ''
                      const isOpen = expandedNote === note.id

                      return (
                        <div
                          key={note.id}
                          className={`border rounded-xl bg-white overflow-hidden transition-all ${
                            isOpen ? 'border-[#7F77DD]' : 'border-[#E8E8E4] hover:border-[#AFA9EC]'
                          }`}
                        >
                          <button
                            className="w-full text-left px-5 py-4 flex items-start gap-3"
                            onClick={() => setExpandedNote(isOpen ? null : note.id)}
                          >
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2 flex-wrap mb-1">
                                <span className="font-display text-[15px] font-medium text-[#1A1A2E]">
                                  {format(parseISO(note.scheduled_date), 'MMM d, yyyy')}
                                </span>
                                <Badge variant="purple">{note.visit_type}</Badge>
                                {note.is_signed && <Badge variant="teal">Signed</Badge>}
                              </div>
                              <div className="text-[12px] text-[#999] mb-1.5">
                                {note.provider_name && <span>{note.provider_name} · </span>}
                                {note.zone}
                              </div>
                              {chips && (
                                <div className="text-[11px] font-medium text-[#555] bg-[#F1EFE8] px-2.5 py-1 rounded-full inline-block mb-2">
                                  {chips}
                                </div>
                              )}
                              {note.chief_complaint && (
                                <div className="text-[13px] text-[#1A1A2E]">
                                  <span className="text-[#999] text-[11px]">CC: </span>{note.chief_complaint}
                                </div>
                              )}
                              {note.diagnoses?.length > 0 && (
                                <div className="flex flex-wrap gap-1.5 mt-2">
                                  {note.diagnoses.map(dx => (
                                    <span key={dx.code} className="text-[11px] font-medium bg-[#EEEDFE] text-[#3C3489] px-2 py-0.5 rounded-full">
                                      {dx.code} – {dx.name}
                                    </span>
                                  ))}
                                </div>
                              )}
                              {note.plan && (
                                <div className="text-[12px] text-[#555] mt-1.5 line-clamp-2">
                                  <span className="text-[#999]">Plan: </span>
                                  {note.plan.length > 120 ? note.plan.slice(0, 120) + '…' : note.plan}
                                </div>
                              )}
                              {!note.chief_complaint && !note.plan && note.diagnoses?.length === 0 && (
                                <div className="text-[12px] text-[#bbb] italic mt-1">No encounter note content</div>
                              )}
                            </div>
                            <ChevronDown
                              size={14}
                              className={`text-[#999] flex-shrink-0 mt-1 transition-transform ${isOpen ? 'rotate-180' : ''}`}
                            />
                          </button>

                          {isOpen && (
                            <div className="px-5 pb-5 border-t border-[#E8E8E4] pt-4 space-y-4">
                              {vitals && (
                                <div>
                                  <div className="text-[10px] font-semibold text-[#7F77DD] uppercase tracking-wider mb-2">Vitals</div>
                                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                                    {[
                                      { label: 'Temp', value: vitals.temperature_f != null ? `${vitals.temperature_f}°F` : null },
                                      { label: 'HR', value: vitals.heart_rate != null ? `${vitals.heart_rate} bpm` : null },
                                      { label: 'RR', value: vitals.respiratory_rate != null ? `${vitals.respiratory_rate} br/min` : null },
                                      { label: 'O2 sat', value: vitals.oxygen_saturation != null ? `${vitals.oxygen_saturation}%` : null },
                                      { label: 'Weight', value: vitals.weight_lbs != null ? `${vitals.weight_lbs} lbs` : null },
                                      { label: 'Height', value: vitals.height_in != null ? `${vitals.height_in} in` : null },
                                      { label: 'BP', value: vitals.systolic_bp != null && vitals.diastolic_bp != null ? `${vitals.systolic_bp}/${vitals.diastolic_bp}` : null },
                                    ].filter(d => d.value).map(d => (
                                      <div key={d.label} className="bg-[#FAFAF8] border border-[#E8E8E4] rounded-lg px-3 py-2">
                                        <div className="text-[10px] text-[#999] font-medium uppercase tracking-wider">{d.label}</div>
                                        <div className="text-[13px] font-medium text-[#1A1A2E] mt-0.5">{d.value}</div>
                                      </div>
                                    ))}
                                  </div>
                                </div>
                              )}

                              {[
                                { label: 'Chief Complaint', value: note.chief_complaint },
                                { label: 'Subjective', value: note.subjective },
                                { label: 'Objective', value: note.objective },
                                { label: 'Assessment', value: note.assessment },
                                { label: 'Plan', value: note.plan },
                              ].map(({ label, value }) => value ? (
                                <div key={label}>
                                  <div className="text-[10px] font-semibold text-[#7F77DD] uppercase tracking-wider mb-1">{label}</div>
                                  <div className="text-[13px] text-[#1A1A2E] whitespace-pre-line">{value}</div>
                                </div>
                              ) : null)}

                              {note.diagnoses?.length > 0 && (
                                <div>
                                  <div className="text-[10px] font-semibold text-[#7F77DD] uppercase tracking-wider mb-2">Diagnoses</div>
                                  <div className="flex flex-wrap gap-2">
                                    {note.diagnoses.map(dx => (
                                      <span key={dx.code} className="text-[12px] font-medium bg-[#EEEDFE] text-[#3C3489] px-2.5 py-1 rounded-full">
                                        {dx.code} – {dx.name}
                                      </span>
                                    ))}
                                  </div>
                                </div>
                              )}

                              {note.is_signed && note.signed_at && (
                                <div className="text-[11px] text-[#999] pt-2 border-t border-[#F1EFE8]">
                                  Signed {format(new Date(note.signed_at), 'MMM d, yyyy h:mm a')}
                                  {note.provider_name && ` by ${note.provider_name}`}
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
