import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { ChevronLeft, ChevronDown, Phone, MapPin, Stethoscope, Pill, Shield, Pencil, CheckCircle2, X, UserPlus, CalendarPlus, FlaskConical } from 'lucide-react'
import { format, parseISO, differenceInYears } from 'date-fns'
import { getEncounterNotes, getVitalsList, getChildrenByIds, getBookingRequests, getAppointments, apiFetch, providerCreateChild, archiveChildInsurance, getDoseSpotSSO, logAudit, getLabOrders, createLabOrder, getDoseSpotNotifications, getPcps, addPcp } from '../lib/api'
import { Badge } from '../components/ui/Badge'
import { BookAppointmentModal } from '../components/BookAppointmentModal'

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
  pcp_faxed_at: string | null
  pcp_fax_name: string | null
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
    const s = String(dob).split('T')[0]
    const [y, m, day] = s.split('-').map(Number)
    return format(new Date(y, m - 1, day), 'MMM d, yyyy')
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

const COMMON_TESTS = [
  { code: '005009', name: 'CBC with Differential' },
  { code: '322000', name: 'Comprehensive Metabolic Panel' },
  { code: '320000', name: 'Basic Metabolic Panel' },
  { code: '303756', name: 'Lipid Panel' },
  { code: '004259', name: 'TSH' },
  { code: '001974', name: 'Free T4' },
  { code: '001453', name: 'Hemoglobin A1c' },
  { code: '081950', name: 'Vitamin D, 25-OH' },
  { code: '004598', name: 'Ferritin' },
  { code: '001040', name: 'Lead, Blood' },
  { code: '003772', name: 'Urinalysis with Microscopy' },
  { code: '008417', name: 'Strep Culture, Group A' },
  { code: '006577', name: 'Mononucleosis Screen' },
  { code: '183788', name: 'Influenza A & B' },
  { code: '188581', name: 'RSV' },
  { code: '008540', name: 'Blood Culture' },
  { code: '007898', name: 'C-Reactive Protein (CRP)' },
  { code: '005215', name: 'Erythrocyte Sedimentation Rate (ESR)' },
  { code: '001503', name: 'Prothrombin Time (PT/INR)' },
  { code: '002003', name: 'Urine Culture' },
]

function LabStatusBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; cls: string }> = {
    pending:   { label: 'Pending',   cls: 'bg-[#F1EFE8] text-[#777]' },
    submitted: { label: 'Submitted', cls: 'bg-[#EEF6FB] text-[#2D7BA6]' },
    received:  { label: 'Received',  cls: 'bg-[#EEF6FB] text-[#2D7BA6]' },
    partial:   { label: 'Partial',   cls: 'bg-[#FEF3C7] text-[#92400E]' },
    resulted:  { label: 'Resulted',  cls: 'bg-[#E6F6F2] text-[#1A7D5A]' },
    cancelled: { label: 'Cancelled', cls: 'bg-[#FDEDED] text-[#991B1B]' },
  }
  const { label, cls } = map[status] ?? { label: status, cls: 'bg-[#F1EFE8] text-[#777]' }
  return <span className={`px-2 py-0.5 rounded-full text-[11px] font-medium ${cls}`}>{label}</span>
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

  const [activeTab, setActiveTab] = useState<'overview' | 'appointments' | 'encounters' | 'prescribe' | 'labs'>('overview')

  // DoseSpot e-prescribing
  const [dsLoading, setDsLoading] = useState(false)
  const [dsUrl, setDsUrl]         = useState<string | null>(null)
  const [dsError, setDsError]     = useState<string | null>(null)
  const [dsNotifCount, setDsNotifCount] = useState(0)
  const [dsNotifBreakdown, setDsNotifBreakdown] = useState<{ renewals: number; rxChanges: number; errors: number }>({ renewals: 0, rxChanges: 0, errors: 0 })
  const [child, setChild] = useState<any | null>(null)
  const [notes, setNotes] = useState<NoteWithVisit[]>([])
  const [vitalsByAppt, setVitalsByAppt] = useState<Record<string, any>>({})
  const [bookingRequests, setBookingRequests] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [expandedNote, setExpandedNote] = useState<string | null>(null)

  // Edit state
  const [editingSection, setEditingSection] = useState<'contact' | 'medical' | 'insurance' | null>(null)
  const [editSaving, setEditSaving] = useState(false)
  const [editSaved, setEditSaved] = useState(false)
  const [editError, setEditError] = useState<string | null>(null)
  const [contactEdit, setContactEdit] = useState({ parent_name: '', parent_phone: '', parent_email: '', parent_address: '', parent_city: '', parent_state: '', parent_zip: '' })
  const [medEdit, setMedEdit] = useState({ allergies: '', current_medications: '', medical_history: '', pcp: '', preferred_pharmacy: '' })
  const [pcpList, setPcpList] = useState<any[]>([])
  const [pcpSearch, setPcpSearch] = useState('')
  const [pcpDropdownOpen, setPcpDropdownOpen] = useState(false)
  const [selectedPcp, setSelectedPcp] = useState<any>(null)
  const [addingNewPcp, setAddingNewPcp] = useState(false)
  const [newPcpName, setNewPcpName] = useState('')
  const [newPcpFax, setNewPcpFax] = useState('')
  const [insEdit, setInsEdit] = useState({ insurance_provider: '', insurance_member_id: '', insurance_group_number: '', insurance_subscriber_name: '', insurance_subscriber_dob: '', insurance_subscriber_gender: '' })

  const [archivingIns, setArchivingIns] = useState(false)
  const [pastInsOpen, setPastInsOpen] = useState(false)

  // Book appointment
  const [bookOpen, setBookOpen] = useState(false)

  // Labs
  const [labOrders, setLabOrders] = useState<any[]>([])
  const [labsLoading, setLabsLoading] = useState(false)
  const [labsLoaded, setLabsLoaded] = useState(false)
  const [labsError, setLabsError] = useState<string | null>(null)
  const [orderFormOpen, setOrderFormOpen] = useState(false)
  const [orderTests, setOrderTests] = useState<{ code: string; name: string }[]>([])
  const [orderDiagnoses, setOrderDiagnoses] = useState('')
  const [orderPriority, setOrderPriority] = useState<'routine' | 'stat'>('routine')
  const [orderNotes, setOrderNotes] = useState('')
  const [orderSubmitting, setOrderSubmitting] = useState(false)
  const [orderError, setOrderError] = useState<string | null>(null)
  const [testSearch, setTestSearch] = useState('')

  async function loadLabs() {
    if (!childId) return
    setLabsLoading(true)
    setLabsError(null)
    try {
      const data = await getLabOrders(childId)
      setLabOrders(data ?? [])
      setLabsLoaded(true)
    } catch (e: any) {
      setLabsError(e.message || 'Failed to load lab orders')
    } finally {
      setLabsLoading(false)
    }
  }

  async function submitLabOrder() {
    if (!childId || !orderTests.length) return
    setOrderSubmitting(true)
    setOrderError(null)
    try {
      const order = await createLabOrder({
        child_id: childId,
        tests: orderTests,
        diagnoses: orderDiagnoses.split(',').map(s => s.trim()).filter(Boolean),
        priority: orderPriority,
        notes: orderNotes || undefined,
      })
      setLabOrders(prev => [order, ...prev])
      setOrderFormOpen(false)
      setOrderTests([])
      setOrderDiagnoses('')
      setOrderPriority('routine')
      setOrderNotes('')
    } catch (e: any) {
      setOrderError(e.message || 'Failed to place order')
    } finally {
      setOrderSubmitting(false)
    }
  }

  // Add sibling
  const [siblingOpen, setSiblingOpen] = useState(false)
  const [siblingSubmitting, setSiblingSubmitting] = useState(false)
  const [siblingError, setSiblingError] = useState<string | null>(null)
  const [siblingDone, setSiblingDone] = useState(false)
  const [sibling, setSibling] = useState({ first_name: '', last_name: '', date_of_birth: '', gender: '' })

  useEffect(() => {
    if (!childId) return
    const cid = childId
    async function load() {
      setLoading(true)
      const [childrenRes, notesRes, vitalsRes, bookingRes, apptRes] = await Promise.all([
        getChildrenByIds([cid]).catch(() => [] as any[]),
        getEncounterNotes({ child_id: cid }).catch(() => [] as NoteWithVisit[]),
        getVitalsList({ child_id: cid }).catch(() => [] as any[]),
        getBookingRequests({ child_id: cid }).catch(() => [] as any[]),
        getAppointments({ child_id: cid }).catch(() => [] as any[]),
      ])
      const loadedChild = childrenRes?.[0] ?? null
      setChild(loadedChild)
      logAudit('view_patient', 'child', cid)
      // Load PCP directory and pre-select if child has one linked
      getPcps().then(pcps => {
        setPcpList(pcps ?? [])
        if (loadedChild?.pcp_id) {
          const found = (pcps ?? []).find((p: any) => p.id === loadedChild.pcp_id)
          if (found) setSelectedPcp(found)
        }
      }).catch(() => {})
      setNotes(notesRes ?? [])
      const byAppt: Record<string, any> = {}
      ;(vitalsRes ?? []).forEach((v: any) => { byAppt[v.appointment_id] = v })
      setVitalsByAppt(byAppt)
      // Merge booking requests and direct appointments, deduplicate by appointment_id
      const appts = apptRes ?? []
      const apptIds = new Set(appts.map((a: any) => a.id))
      const mergedBookings = [
        ...appts.map((a: any) => ({ ...a, preferred_date: a.scheduled_date, _source: 'appointment' })),
        ...(bookingRes ?? []).filter((br: any) => !apptIds.has(br.appointment_id)),
      ].sort((a, b) => (b.preferred_date ?? b.scheduled_date ?? '').localeCompare(a.preferred_date ?? a.scheduled_date ?? ''))
      setBookingRequests(mergedBookings)
      setLoading(false)
    }
    load()
  }, [childId])

  // Poll DoseSpot notification count every 30 seconds
  useEffect(() => {
    async function fetchNotifCount() {
      try {
        const { count, breakdown } = await getDoseSpotNotifications()
        setDsNotifCount(count)
        setDsNotifBreakdown(breakdown)
      } catch { /* silent — never block the UI */ }
    }
    fetchNotifCount()
    const interval = setInterval(fetchNotifCount, 30_000)
    return () => clearInterval(interval)
  }, [])

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
    { key: 'prescribe' as const, label: 'Prescribe', count: dsNotifCount || null },
    { key: 'labs' as const,     label: 'Labs',      count: labOrders.length || null },
  ]

  async function launchDoseSpot() {
    if (!childId) return
    setDsLoading(true)
    setDsError(null)
    setDsUrl(null)
    try {
      const { ssoUrl } = await getDoseSpotSSO(childId)
      setDsUrl(ssoUrl)
    } catch (e: any) {
      setDsError(e.message ?? 'Could not launch DoseSpot')
    } finally {
      setDsLoading(false)
    }
  }

  function startEdit(section: 'contact' | 'medical' | 'insurance') {
    setEditError(null)
    setEditSaved(false)
    if (section === 'contact') {
      setContactEdit({
        parent_name: child?.parent_name || '',
        parent_phone: child?.parent_phone || '',
        parent_email: child?.parent_email || '',
        parent_address: child?.parent_address || '',
        parent_city: child?.parent_city || '',
        parent_state: child?.parent_state || '',
        parent_zip: child?.parent_zip || '',
      })
    } else if (section === 'medical') {
      setMedEdit({
        allergies: child?.allergies || '',
        current_medications: child?.current_medications || '',
        medical_history: child?.medical_history || '',
        pcp: child?.pcp || '',
        preferred_pharmacy: child?.preferred_pharmacy || '',
      })
      setPcpSearch('')
      setPcpDropdownOpen(false)
      setAddingNewPcp(false)
      setNewPcpName('')
      setNewPcpFax('')
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

  async function saveEdit(section: 'contact' | 'medical' | 'insurance') {
    if (!childId) return
    setEditSaving(true)
    setEditError(null)
    try {
      let body: any = section === 'contact' ? contactEdit : section === 'medical' ? medEdit : insEdit
      if (section === 'medical') {
        body = { ...body, pcp_id: selectedPcp?.id ?? null }
      }
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

  async function archiveInsurance() {
    if (!childId) return
    setArchivingIns(true)
    try {
      const updated = await archiveChildInsurance(childId)
      setChild((prev: any) => ({ ...prev, ...updated }))
      startEdit('insurance')
    } catch (e: any) {
      alert(e.message ?? 'Failed to archive insurance')
    } finally {
      setArchivingIns(false)
    }
  }

  async function submitSibling() {
    if (!sibling.first_name.trim() || !sibling.last_name.trim() || !sibling.date_of_birth || !sibling.gender) return
    setSiblingSubmitting(true)
    setSiblingError(null)
    try {
      await providerCreateChild({
        first_name: sibling.first_name.trim(),
        last_name: sibling.last_name.trim(),
        date_of_birth: sibling.date_of_birth,
        gender: sibling.gender,
        family_id: child?.family_id || null,
        parent_name: child?.parent_name || null,
        parent_phone: child?.family_phone || child?.parent_phone || null,
        parent_email: child?.family_email || child?.parent_email || null,
        parent_address: child?.family_address_line1 || child?.parent_address || null,
        parent_city: child?.family_city || child?.parent_city || null,
        parent_state: child?.family_state || child?.parent_state || null,
        parent_zip: child?.family_zip || child?.parent_zip || null,
        pcp: child?.pcp || null,
        preferred_pharmacy: child?.preferred_pharmacy || null,
        insurance_provider: child?.insurance_provider || null,
        insurance_member_id: child?.insurance_member_id || null,
        insurance_group_number: child?.insurance_group_number || null,
        insurance_subscriber_name: child?.insurance_subscriber_name || null,
        insurance_subscriber_dob: child?.insurance_subscriber_dob ? String(child.insurance_subscriber_dob).split('T')[0] : null,
        insurance_subscriber_gender: child?.insurance_subscriber_gender || null,
      })
      setSiblingDone(true)
      setSibling({ first_name: '', last_name: '', date_of_birth: '', gender: '' })
      setTimeout(() => { setSiblingOpen(false); setSiblingDone(false) }, 1500)
    } catch (e: any) {
      setSiblingError(e.message ?? 'Failed to add sibling')
    } finally {
      setSiblingSubmitting(false)
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
          {child && (
            <div className="flex gap-2 flex-shrink-0">
              <button
                onClick={() => setBookOpen(true)}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-[#1D9E75] text-white text-[12px] font-medium rounded-lg hover:bg-[#178860] transition-colors">
                <CalendarPlus size={13} /> Book appointment
              </button>
              <button
                onClick={() => { setSiblingOpen(true); setSiblingError(null); setSiblingDone(false); setSibling({ first_name: '', last_name: '', date_of_birth: '', gender: '' }) }}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-[#7F77DD] text-white text-[12px] font-medium rounded-lg hover:bg-[#6C64C8] transition-colors">
                <UserPlus size={13} /> Add sibling
              </button>
            </div>
          )}
        </div>
        <div className="flex gap-2 mt-3 max-w-3xl mx-auto">
          {tabs.map(tab => (
            <button
              key={tab.key}
              onClick={() => { setActiveTab(tab.key); if (tab.key === 'labs' && !labsLoaded) loadLabs() }}
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
                  <div className="flex items-center justify-between mb-4">
                    <div className="flex items-center gap-2">
                      <Phone size={14} className="text-[#7F77DD]" />
                      <div className="text-[10px] font-semibold text-[#7F77DD] uppercase tracking-wider">Contact & Family</div>
                    </div>
                    {editingSection !== 'contact' && (
                      <button onClick={() => startEdit('contact')}
                        className="flex items-center gap-1 text-[11px] text-[#7F77DD] font-medium hover:underline">
                        <Pencil size={11} /> Edit
                      </button>
                    )}
                  </div>
                  {editingSection === 'contact' ? (
                    <div className="space-y-3">
                      <div>
                        <label className="text-[11px] text-[#999] block mb-1">Parent / guardian name</label>
                        <input className="w-full px-3 py-2 border border-[#E8E8E4] rounded-lg text-[13px] focus:border-[#7F77DD] outline-none"
                          value={contactEdit.parent_name} onChange={e => setContactEdit(p => ({ ...p, parent_name: e.target.value }))}
                          placeholder="e.g. Jane Smith" />
                      </div>
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <label className="text-[11px] text-[#999] block mb-1">Phone</label>
                          <input type="tel" className="w-full px-3 py-2 border border-[#E8E8E4] rounded-lg text-[13px] focus:border-[#7F77DD] outline-none"
                            value={contactEdit.parent_phone} onChange={e => setContactEdit(p => ({ ...p, parent_phone: e.target.value }))}
                            placeholder="(704) 555-0100" />
                        </div>
                        <div>
                          <label className="text-[11px] text-[#999] block mb-1">Email</label>
                          <input type="email" className="w-full px-3 py-2 border border-[#E8E8E4] rounded-lg text-[13px] focus:border-[#7F77DD] outline-none"
                            value={contactEdit.parent_email} onChange={e => setContactEdit(p => ({ ...p, parent_email: e.target.value }))}
                            placeholder="parent@email.com" />
                        </div>
                      </div>
                      <div>
                        <label className="text-[11px] text-[#999] block mb-1">Street address</label>
                        <input className="w-full px-3 py-2 border border-[#E8E8E4] rounded-lg text-[13px] focus:border-[#7F77DD] outline-none"
                          value={contactEdit.parent_address} onChange={e => setContactEdit(p => ({ ...p, parent_address: e.target.value }))}
                          placeholder="123 Main St" />
                      </div>
                      <div className="grid grid-cols-5 gap-2">
                        <div className="col-span-2">
                          <label className="text-[11px] text-[#999] block mb-1">City</label>
                          <input className="w-full px-3 py-2 border border-[#E8E8E4] rounded-lg text-[13px] focus:border-[#7F77DD] outline-none"
                            value={contactEdit.parent_city} onChange={e => setContactEdit(p => ({ ...p, parent_city: e.target.value }))}
                            placeholder="Charlotte" />
                        </div>
                        <div className="col-span-1">
                          <label className="text-[11px] text-[#999] block mb-1">State</label>
                          <select className="w-full px-3 py-2 border border-[#E8E8E4] rounded-lg text-[13px] bg-white focus:border-[#7F77DD] outline-none"
                            value={contactEdit.parent_state} onChange={e => setContactEdit(p => ({ ...p, parent_state: e.target.value }))}>
                            <option value="">—</option>
                            <option value="NC">NC</option>
                            <option value="SC">SC</option>
                            <option value="VA">VA</option>
                          </select>
                        </div>
                        <div className="col-span-2">
                          <label className="text-[11px] text-[#999] block mb-1">Zip</label>
                          <input maxLength={5} className="w-full px-3 py-2 border border-[#E8E8E4] rounded-lg text-[13px] focus:border-[#7F77DD] outline-none"
                            value={contactEdit.parent_zip} onChange={e => setContactEdit(p => ({ ...p, parent_zip: e.target.value }))}
                            placeholder="28277" />
                        </div>
                      </div>
                      {editError && <div className="text-[12px] text-[#991B1B] bg-[#FDEDED] px-3 py-2 rounded-lg">{editError}</div>}
                      <div className="flex gap-2 pt-1">
                        <button onClick={() => saveEdit('contact')} disabled={editSaving}
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
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <Field label="Family" value={child?.family_display_name || child?.parent_name} />
                      <Field label="Phone" value={child?.family_phone || child?.parent_phone} />
                      <Field label="Email" value={child?.family_email || child?.parent_email} />
                      <div>
                        <div className="text-[11px] text-[#999] flex items-center gap-1">
                          <MapPin size={11} />
                          Address
                        </div>
                        {(child?.family_address_line1 || child?.parent_address) ? (
                          <div className="text-[13px] text-[#1A1A2E] mt-0.5">
                            {child.family_address_line1 || child.parent_address}
                            {((child.family_city || child.parent_city) || (child.family_state || child.parent_state) || (child.family_zip || child.parent_zip)) && (
                              <>, {[child.family_city || child.parent_city, child.family_state || child.parent_state, child.family_zip || child.parent_zip].filter(Boolean).join(' ')}</>
                            )}
                          </div>
                        ) : (
                          <div className="text-[13px] text-[#bbb] mt-0.5">Not on file</div>
                        )}
                      </div>
                    </div>
                  )}
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
                        <label className="text-[11px] text-[#999] block mb-1">Primary care practice</label>
                        {selectedPcp ? (
                          <div className="flex items-center gap-2 px-3 py-2 border border-[#7F77DD] rounded-lg bg-[#EEEDFE]">
                            <div className="flex-1 min-w-0">
                              <div className="text-[13px] font-medium text-[#1A1A2E] truncate">{selectedPcp.name}</div>
                              {selectedPcp.fax_number && <div className="text-[11px] text-[#999]">Fax: {selectedPcp.fax_number}</div>}
                            </div>
                            <button onClick={() => { setSelectedPcp(null); setPcpSearch('') }} className="text-[#999] hover:text-[#555] flex-shrink-0"><X size={14} /></button>
                          </div>
                        ) : addingNewPcp ? (
                          <div className="space-y-2 border border-[#E8E8E4] rounded-lg p-3">
                            <div className="text-[11px] text-[#555] font-medium">Add new practice to directory</div>
                            <input className="w-full px-2.5 py-1.5 border border-[#E8E8E4] rounded-lg text-[13px] focus:border-[#7F77DD] outline-none"
                              placeholder="Practice name" value={newPcpName} onChange={e => setNewPcpName(e.target.value)} autoFocus />
                            <input className="w-full px-2.5 py-1.5 border border-[#E8E8E4] rounded-lg text-[13px] focus:border-[#7F77DD] outline-none"
                              placeholder="Fax number" value={newPcpFax} onChange={e => setNewPcpFax(e.target.value)} />
                            <div className="flex gap-2">
                              <button
                                onClick={async () => {
                                  if (!newPcpName.trim()) return
                                  try {
                                    const created = await addPcp({ name: newPcpName.trim(), fax_number: newPcpFax.trim() || undefined })
                                    setPcpList(prev => [...prev, created].sort((a, b) => a.name.localeCompare(b.name)))
                                    setSelectedPcp(created)
                                    setAddingNewPcp(false)
                                    setNewPcpName('')
                                    setNewPcpFax('')
                                  } catch {}
                                }}
                                className="px-3 py-1.5 bg-[#7F77DD] text-white text-[12px] font-medium rounded-lg hover:bg-[#6C64C8]">
                                Add &amp; select
                              </button>
                              <button onClick={() => { setAddingNewPcp(false); setNewPcpName(''); setNewPcpFax('') }}
                                className="px-3 py-1.5 border border-[#E8E8E4] text-[12px] text-[#555] rounded-lg hover:bg-[#F1EFE8]">
                                Cancel
                              </button>
                            </div>
                          </div>
                        ) : (
                          <div className="relative">
                            <input
                              className="w-full px-3 py-2 border border-[#E8E8E4] rounded-lg text-[13px] focus:border-[#7F77DD] outline-none"
                              placeholder="Search practice name…"
                              value={pcpSearch}
                              onChange={e => { setPcpSearch(e.target.value); setPcpDropdownOpen(true) }}
                              onFocus={() => setPcpDropdownOpen(true)}
                            />
                            {pcpDropdownOpen && (
                              <div className="absolute z-20 top-full left-0 right-0 mt-1 bg-white border border-[#E8E8E4] rounded-xl shadow-lg max-h-52 overflow-y-auto">
                                {pcpList
                                  .filter(p => {
                                    const q = pcpSearch.toLowerCase()
                                    return !q || p.name.toLowerCase().includes(q) || (p.aliases ?? []).some((a: string) => a.toLowerCase().includes(q))
                                  })
                                  .map(p => (
                                    <button key={p.id} onMouseDown={() => { setSelectedPcp(p); setPcpDropdownOpen(false); setPcpSearch('') }}
                                      className="w-full text-left px-3 py-2.5 hover:bg-[#FAFAF8] border-b border-[#F1EFE8] last:border-0">
                                      <div className="text-[13px] text-[#1A1A2E]">{p.name}</div>
                                      {p.fax_number && <div className="text-[11px] text-[#999]">Fax: {p.fax_number}</div>}
                                    </button>
                                  ))
                                }
                                <button onMouseDown={() => { setPcpDropdownOpen(false); setAddingNewPcp(true) }}
                                  className="w-full text-left px-3 py-2.5 text-[12px] text-[#7F77DD] font-medium hover:bg-[#EEEDFE]">
                                  + Add new practice to directory
                                </button>
                              </div>
                            )}
                          </div>
                        )}
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
                        <div>
                          <div className="text-[11px] text-[#999]">Primary care practice</div>
                          {selectedPcp ? (
                            <div className="mt-0.5">
                              <div className="text-[13px] text-[#1A1A2E]">{selectedPcp.name}</div>
                              {selectedPcp.fax_number && <div className="text-[11px] text-[#999]">Fax: {selectedPcp.fax_number}</div>}
                            </div>
                          ) : child?.pcp ? (
                            <div className="text-[13px] text-[#1A1A2E] mt-0.5">{child.pcp}</div>
                          ) : (
                            <div className="text-[13px] text-[#bbb] mt-0.5">Not recorded</div>
                          )}
                        </div>
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
                      <div className="flex items-center gap-2">
                        <button onClick={() => startEdit('insurance')}
                          className="flex items-center gap-1 text-[11px] text-[#7F77DD] font-medium hover:underline">
                          <Pencil size={11} /> Edit
                        </button>
                        {(child?.insurance_provider || child?.insurance_member_id) && (
                          <button
                            onClick={archiveInsurance}
                            disabled={archivingIns}
                            className="text-[11px] text-[#F59E0B] font-medium border border-[#F59E0B] px-2 py-0.5 rounded hover:bg-[#FEF9EC] transition-colors disabled:opacity-50">
                            {archivingIns ? 'Archiving…' : 'Make inactive & add new'}
                          </button>
                        )}
                      </div>
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
                    <>
                      {child?.insurance_provider || child?.insurance_member_id || child?.insurance_group_number ? (
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
                        <div className="text-[13px] text-[#bbb] text-center py-4">No active insurance on file</div>
                      )}

                      {/* Past insurance policies */}
                      {Array.isArray(child?.previous_insurance) && child.previous_insurance.length > 0 && (
                        <div className="mt-4 pt-4 border-t border-[#E8E8E4]">
                          <button
                            onClick={() => setPastInsOpen(o => !o)}
                            className="flex items-center gap-1.5 text-[11px] font-medium text-[#999] hover:text-[#555] transition-colors">
                            <ChevronDown size={12} className={`transition-transform ${pastInsOpen ? 'rotate-180' : ''}`} />
                            {child.previous_insurance.length} previous polic{child.previous_insurance.length === 1 ? 'y' : 'ies'}
                          </button>
                          {pastInsOpen && (
                            <div className="mt-3 space-y-4">
                              {[...child.previous_insurance].reverse().map((p: any, i: number) => (
                                <div key={i} className="bg-[#FAFAF8] border border-[#E8E8E4] rounded-lg p-3 space-y-2">
                                  <div className="text-[10px] font-semibold text-[#999] uppercase tracking-wider">
                                    Inactive since {p.deactivated_at ?? 'unknown date'}
                                  </div>
                                  <div className="grid grid-cols-2 gap-3">
                                    <Field label="Insurance plan" value={p.insurance_provider} />
                                    <Field label="Member ID" value={p.insurance_member_id} />
                                    <Field label="Group number" value={p.insurance_group_number} />
                                    <Field label="Subscriber" value={p.insurance_subscriber_name} />
                                    <Field label="Subscriber DOB" value={p.insurance_subscriber_dob ? formatDob(String(p.insurance_subscriber_dob).split('T')[0]) : null} />
                                    <Field label="Subscriber sex" value={p.insurance_subscriber_gender === 'M' ? 'Male' : p.insurance_subscriber_gender === 'F' ? 'Female' : p.insurance_subscriber_gender} />
                                  </div>
                                  {(p.insurance_card_front_url || p.insurance_card_back_url) && (
                                    <div className="grid grid-cols-2 gap-2 mt-2">
                                      {p.insurance_card_front_url && (
                                        <div>
                                          <div className="text-[10px] text-[#999] mb-1">Card front</div>
                                          <a href={p.insurance_card_front_url} target="_blank" rel="noopener noreferrer">
                                            <img src={p.insurance_card_front_url} alt="Old card front"
                                              className="w-full rounded border border-[#E8E8E4] object-cover" />
                                          </a>
                                        </div>
                                      )}
                                      {p.insurance_card_back_url && (
                                        <div>
                                          <div className="text-[10px] text-[#999] mb-1">Card back</div>
                                          <a href={p.insurance_card_back_url} target="_blank" rel="noopener noreferrer">
                                            <img src={p.insurance_card_back_url} alt="Old card back"
                                              className="w-full rounded border border-[#E8E8E4] object-cover" />
                                          </a>
                                        </div>
                                      )}
                                    </div>
                                  )}
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                    </>
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
                                <div className="text-[11px] text-[#999] pt-2 border-t border-[#F1EFE8] space-y-0.5">
                                  <div>
                                    Signed {format(new Date(note.signed_at), 'MMM d, yyyy h:mm a')}
                                    {note.provider_name && ` by ${note.provider_name}`}
                                  </div>
                                  {note.pcp_faxed_at ? (
                                    <div className="text-[#5a9e6f]">
                                      Faxed to {note.pcp_fax_name || 'PCP'} on {format(new Date(note.pcp_faxed_at), 'MMM d, yyyy h:mm a')}
                                    </div>
                                  ) : note.is_signed && (
                                    <div className="text-[#bbb]">Fax pending or no PCP on file</div>
                                  )}
                                </div>
                              )}

                              <div className="pt-2 border-t border-[#F1EFE8] flex justify-end">
                                <button
                                  onClick={() => { launchDoseSpot(); setActiveTab('prescribe') }}
                                  disabled={dsLoading}
                                  className="flex items-center gap-1.5 px-3 py-1.5 bg-[#EEEDFE] text-[#3C3489] text-[12px] font-medium rounded-lg hover:bg-[#7F77DD] hover:text-white transition-colors disabled:opacity-50"
                                >
                                  <FlaskConical size={12} />
                                  {dsLoading ? 'Launching…' : 'Prescribe'}
                                </button>
                              </div>
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            )}

            {activeTab === 'labs' && (
              <div className="space-y-4">
                {/* Header */}
                <div className="flex items-center justify-between">
                  <div>
                    <div className="font-display text-[15px] font-semibold text-[#1A1A2E]">Lab Orders</div>
                    <div className="text-[12px] text-[#999] mt-0.5">Labcorp integration — orders placed here are tracked in your Labcorp account</div>
                  </div>
                  <button
                    onClick={() => { setOrderFormOpen(true); setOrderError(null) }}
                    className="flex items-center gap-1.5 px-3 py-2 bg-[#7F77DD] text-white text-[12px] font-medium rounded-lg hover:bg-[#6C64C8] transition-colors"
                  >
                    + New Order
                  </button>
                </div>

                {/* Order form */}
                {orderFormOpen && (
                  <div className="bg-white border border-[#E8E8E4] rounded-xl p-5 shadow-sm">
                    <div className="flex items-center justify-between mb-4">
                      <div className="font-medium text-[14px] text-[#1A1A2E]">New Lab Order</div>
                      <button onClick={() => setOrderFormOpen(false)} className="text-[#999] hover:text-[#555]"><X size={16} /></button>
                    </div>

                    {/* Test search */}
                    <div className="mb-4">
                      <div className="text-[11px] font-semibold text-[#999] uppercase tracking-wide mb-2">Select Tests</div>
                      <input
                        value={testSearch}
                        onChange={e => setTestSearch(e.target.value)}
                        placeholder="Search test name or code…"
                        className="w-full px-3 py-2 text-[13px] border border-[#E8E8E4] rounded-lg mb-2 focus:outline-none focus:ring-2 focus:ring-[#7F77DD]/30"
                      />
                      <div className="border border-[#E8E8E4] rounded-lg divide-y divide-[#F1EFE8] max-h-56 overflow-y-auto">
                        {COMMON_TESTS.filter(t =>
                          !testSearch || t.name.toLowerCase().includes(testSearch.toLowerCase()) || t.code.includes(testSearch)
                        ).map(t => {
                          const selected = orderTests.some(x => x.code === t.code)
                          return (
                            <button
                              key={t.code}
                              onClick={() => setOrderTests(prev =>
                                selected ? prev.filter(x => x.code !== t.code) : [...prev, t]
                              )}
                              className={`w-full flex items-center justify-between px-3 py-2 text-left text-[13px] transition-colors ${selected ? 'bg-[#7F77DD]/8 text-[#5B54B5]' : 'hover:bg-[#FAFAF8] text-[#1A1A2E]'}`}
                            >
                              <span>{t.name}</span>
                              <span className="text-[11px] text-[#999] font-mono ml-3 flex-shrink-0">{t.code}{selected && ' ✓'}</span>
                            </button>
                          )
                        })}
                      </div>
                      {orderTests.length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {orderTests.map(t => (
                            <span key={t.code} className="inline-flex items-center gap-1 px-2 py-0.5 bg-[#7F77DD]/10 text-[#5B54B5] text-[11px] rounded-full font-medium">
                              {t.name}
                              <button onClick={() => setOrderTests(prev => prev.filter(x => x.code !== t.code))} className="hover:text-red-500"><X size={10} /></button>
                            </span>
                          ))}
                        </div>
                      )}
                    </div>

                    {/* Diagnoses */}
                    <div className="mb-4">
                      <label className="text-[11px] font-semibold text-[#999] uppercase tracking-wide block mb-1">Diagnosis Codes (ICD-10)</label>
                      <input
                        value={orderDiagnoses}
                        onChange={e => setOrderDiagnoses(e.target.value)}
                        placeholder="e.g. Z00.129, J06.9"
                        className="w-full px-3 py-2 text-[13px] border border-[#E8E8E4] rounded-lg focus:outline-none focus:ring-2 focus:ring-[#7F77DD]/30"
                      />
                      <div className="text-[11px] text-[#999] mt-1">Comma-separated</div>
                    </div>

                    {/* Priority */}
                    <div className="mb-4">
                      <div className="text-[11px] font-semibold text-[#999] uppercase tracking-wide mb-2">Priority</div>
                      <div className="flex gap-2">
                        {(['routine', 'stat'] as const).map(p => (
                          <button
                            key={p}
                            onClick={() => setOrderPriority(p)}
                            className={`px-4 py-1.5 rounded-lg text-[12px] font-medium border transition-all capitalize ${orderPriority === p ? (p === 'stat' ? 'bg-red-500 text-white border-red-500' : 'bg-[#7F77DD] text-white border-[#7F77DD]') : 'border-[#E8E8E4] text-[#666] hover:bg-[#F1EFE8]'}`}
                          >
                            {p === 'stat' ? 'STAT' : 'Routine'}
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* Notes */}
                    <div className="mb-4">
                      <label className="text-[11px] font-semibold text-[#999] uppercase tracking-wide block mb-1">Notes (optional)</label>
                      <textarea
                        value={orderNotes}
                        onChange={e => setOrderNotes(e.target.value)}
                        rows={2}
                        placeholder="Any special instructions for this order…"
                        className="w-full px-3 py-2 text-[13px] border border-[#E8E8E4] rounded-lg resize-none focus:outline-none focus:ring-2 focus:ring-[#7F77DD]/30"
                      />
                    </div>

                    {orderError && (
                      <div className="text-[12px] text-red-600 bg-red-50 px-3 py-2 rounded-lg mb-3">{orderError}</div>
                    )}

                    <div className="flex items-center gap-2 justify-end">
                      <button onClick={() => setOrderFormOpen(false)} className="px-4 py-2 text-[13px] text-[#666] border border-[#E8E8E4] rounded-lg hover:bg-[#F1EFE8] transition-colors">
                        Cancel
                      </button>
                      <button
                        onClick={submitLabOrder}
                        disabled={orderSubmitting || orderTests.length === 0}
                        className="px-4 py-2 text-[13px] bg-[#7F77DD] text-white rounded-lg hover:bg-[#6C64C8] transition-colors disabled:opacity-50 font-medium"
                      >
                        {orderSubmitting ? 'Placing…' : 'Place Order'}
                      </button>
                    </div>
                  </div>
                )}

                {/* Order list */}
                {labsLoading ? (
                  <div className="text-center py-8 text-[13px] text-[#999]">Loading…</div>
                ) : labsError ? (
                  <div className="text-[13px] text-red-500 bg-red-50 px-4 py-3 rounded-xl">{labsError}</div>
                ) : labOrders.length === 0 ? (
                  <div className="bg-white border border-[#E8E8E4] rounded-xl p-8 shadow-sm text-center">
                    <div className="text-[13px] text-[#999]">No lab orders yet for this patient.</div>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {labOrders.map(order => (
                      <div key={order.id} className="bg-white border border-[#E8E8E4] rounded-xl p-4 shadow-sm">
                        <div className="flex items-start justify-between mb-2">
                          <div>
                            <div className="flex items-center gap-2 flex-wrap">
                              {(order.tests ?? []).map((t: any) => (
                                <span key={t.code} className="px-2 py-0.5 bg-[#F1EFE8] text-[#555] text-[11px] rounded-full font-medium">{t.name}</span>
                              ))}
                              {order.priority === 'stat' && (
                                <span className="px-2 py-0.5 bg-red-100 text-red-600 text-[11px] rounded-full font-semibold">STAT</span>
                              )}
                            </div>
                            <div className="text-[11px] text-[#999] mt-1">
                              Ordered by {order.provider_name} · {order.created_at ? format(new Date(order.created_at), 'MMM d, yyyy') : ''}
                            </div>
                            {order.diagnoses?.length > 0 && (
                              <div className="text-[11px] text-[#999] mt-0.5">Dx: {order.diagnoses.join(', ')}</div>
                            )}
                          </div>
                          <LabStatusBadge status={order.status} />
                        </div>

                        {order.labcorp_order_id && (
                          <div className="text-[11px] text-[#999] mt-1">Labcorp ID: <span className="font-mono">{order.labcorp_order_id}</span></div>
                        )}

                        {order.results?.length > 0 && (
                          <div className="mt-3 pt-3 border-t border-[#F1EFE8]">
                            <div className="text-[11px] font-semibold text-[#999] uppercase tracking-wide mb-2">Results</div>
                            {order.results.map((r: any) => (
                              <div key={r.id} className="text-[12px] text-[#1A1A2E] bg-[#FAFAF8] rounded-lg p-3">
                                {r.report_date && <div className="text-[11px] text-[#999] mb-1">Reported {format(new Date(r.report_date), 'MMM d, yyyy')}</div>}
                                <pre className="whitespace-pre-wrap font-sans text-[12px]">{typeof r.result_data === 'string' ? r.result_data : JSON.stringify(r.result_data, null, 2)}</pre>
                              </div>
                            ))}
                          </div>
                        )}

                        {order.notes && (
                          <div className="text-[12px] text-[#777] mt-2 pt-2 border-t border-[#F1EFE8]">{order.notes}</div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {activeTab === 'prescribe' && (
              <div className="space-y-4">
                {/* Notification count banner — visible to certification reviewer */}
                {dsNotifCount > 0 && (
                  <div className="flex items-center gap-3 bg-[#FEF3C7] border border-[#F59E0B]/30 rounded-xl px-4 py-3">
                    <div className="w-7 h-7 rounded-full bg-[#F59E0B] flex items-center justify-center flex-shrink-0">
                      <span className="text-white text-[12px] font-bold">{dsNotifCount}</span>
                    </div>
                    <div className="flex-1">
                      <div className="text-[13px] font-semibold text-[#92400E]">
                        {dsNotifCount} pending DoseSpot {dsNotifCount === 1 ? 'notification' : 'notifications'}
                      </div>
                      <div className="text-[11px] text-[#92400E]/70 mt-0.5 flex gap-3">
                        {dsNotifBreakdown.renewals > 0 && <span>{dsNotifBreakdown.renewals} renewal{dsNotifBreakdown.renewals !== 1 ? 's' : ''}</span>}
                        {dsNotifBreakdown.rxChanges > 0 && <span>{dsNotifBreakdown.rxChanges} RxChange{dsNotifBreakdown.rxChanges !== 1 ? 's' : ''}</span>}
                        {dsNotifBreakdown.errors > 0 && <span>{dsNotifBreakdown.errors} error{dsNotifBreakdown.errors !== 1 ? 's' : ''}</span>}
                      </div>
                    </div>
                    <button
                      onClick={async () => {
                        if (!childId) return
                        setDsLoading(true); setDsError(null); setDsUrl(null)
                        try {
                          // Open to notification summary page via RefillsErrors=1
                          const { ssoUrl } = await getDoseSpotSSO(childId)
                          const notifUrl = ssoUrl.replace(/&PatientId=\d+/, '') + '&RefillsErrors=1'
                          setDsUrl(notifUrl)
                        } catch (e: any) {
                          setDsError(e.message ?? 'Could not launch DoseSpot')
                        } finally { setDsLoading(false) }
                      }}
                      className="text-[11px] font-medium text-[#92400E] underline underline-offset-2 hover:text-[#78350F] flex-shrink-0"
                    >
                      Review in DoseSpot
                    </button>
                  </div>
                )}

                {!dsUrl && (
                  <div className="bg-white border border-[#E8E8E4] rounded-xl p-8 shadow-sm text-center">
                    <div className="w-12 h-12 rounded-full bg-[#EEEDFE] flex items-center justify-center mx-auto mb-4">
                      <FlaskConical size={22} className="text-[#7F77DD]" />
                    </div>
                    <div className="font-display text-[16px] font-medium text-[#1A1A2E] mb-1">e-Prescribing via DoseSpot</div>
                    <div className="text-[13px] text-[#777] mb-6 max-w-xs mx-auto">
                      Opens DoseSpot's prescribing interface for {child ? [child.first_name, child.last_name].filter(Boolean).join(' ') : 'this patient'}.
                      The patient record will be created in DoseSpot on first launch.
                    </div>
                    {dsError && (
                      <div className="text-[12px] text-[#991B1B] bg-[#FDEDED] px-3 py-2 rounded-lg mb-4 text-left">
                        {dsError}
                      </div>
                    )}
                    <button
                      onClick={launchDoseSpot}
                      disabled={dsLoading}
                      className="inline-flex items-center gap-2 px-5 py-2.5 bg-[#7F77DD] text-white text-[13px] font-medium rounded-lg hover:bg-[#6C64C8] transition-colors disabled:opacity-50"
                    >
                      <FlaskConical size={14} />
                      {dsLoading ? 'Launching…' : 'Launch DoseSpot'}
                    </button>
                  </div>
                )}

                {dsUrl && (
                  <div className="bg-white border border-[#E8E8E4] rounded-xl shadow-sm overflow-hidden">
                    <div className="flex items-center justify-between px-4 py-2.5 border-b border-[#E8E8E4]">
                      <div className="flex items-center gap-2 text-[12px] text-[#555]">
                        <FlaskConical size={13} className="text-[#7F77DD]" />
                        <span>DoseSpot — {child ? [child.first_name, child.last_name].filter(Boolean).join(' ') : 'Patient'}</span>
                      </div>
                      <button
                        onClick={() => { setDsUrl(null); setDsError(null) }}
                        className="text-[11px] text-[#999] hover:text-[#555] transition-colors"
                      >
                        Close
                      </button>
                    </div>
                    <iframe
                      src={dsUrl}
                      title="DoseSpot e-Prescribing"
                      className="w-full"
                      style={{ height: 'calc(100vh - 220px)', minHeight: 600, border: 'none' }}
                      allow="clipboard-write"
                    />
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>

      {/* Book appointment modal */}
      {bookOpen && child && (
        <BookAppointmentModal
          child={child}
          onClose={() => setBookOpen(false)}
          onBooked={() => {
            setBookOpen(false)
            // Reload appointments tab
            if (childId) getAppointments({ child_id: childId }).then(data => {
              const appts = data ?? []
              setBookingRequests(appts.map((a: any) => ({ ...a, preferred_date: a.scheduled_date, _source: 'appointment' })))
              setActiveTab('appointments')
            }).catch(() => {})
          }}
        />
      )}

      {/* Add sibling modal */}
      {siblingOpen && child && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" onClick={() => !siblingSubmitting && setSiblingOpen(false)} />
          <div className="relative bg-white rounded-2xl shadow-xl w-full max-w-lg overflow-y-auto max-h-[90vh]">
            <div className="flex items-center justify-between px-6 py-4 border-b border-[#E8E8E4]">
              <div className="flex items-center gap-2">
                <UserPlus size={16} className="text-[#7F77DD]" />
                <h2 className="font-display text-[16px] font-medium text-[#1A1A2E]">Add sibling of {name}</h2>
              </div>
              <button onClick={() => setSiblingOpen(false)} className="p-1.5 rounded-lg hover:bg-[#F1EFE8] text-[#999]"><X size={16} /></button>
            </div>

            <div className="p-6 space-y-5">
              {/* New child fields */}
              <div>
                <div className="text-[10px] font-semibold text-[#7F77DD] uppercase tracking-wider mb-3">New child — required</div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-[11px] text-[#999] block mb-1">First name <span className="text-[#991B1B]">*</span></label>
                    <input autoFocus className="w-full px-3 py-2 border border-[#E8E8E4] rounded-lg text-[13px] focus:border-[#7F77DD] outline-none"
                      value={sibling.first_name} onChange={e => setSibling(s => ({ ...s, first_name: e.target.value }))} />
                  </div>
                  <div>
                    <label className="text-[11px] text-[#999] block mb-1">Last name <span className="text-[#991B1B]">*</span></label>
                    <input className="w-full px-3 py-2 border border-[#E8E8E4] rounded-lg text-[13px] focus:border-[#7F77DD] outline-none"
                      value={sibling.last_name} onChange={e => setSibling(s => ({ ...s, last_name: e.target.value }))} />
                  </div>
                  <div>
                    <label className="text-[11px] text-[#999] block mb-1">Date of birth <span className="text-[#991B1B]">*</span></label>
                    <input type="date" className="w-full px-3 py-2 border border-[#E8E8E4] rounded-lg text-[13px] focus:border-[#7F77DD] outline-none"
                      value={sibling.date_of_birth} onChange={e => setSibling(s => ({ ...s, date_of_birth: e.target.value }))} />
                  </div>
                  <div>
                    <label className="text-[11px] text-[#999] block mb-1">Sex <span className="text-[#991B1B]">*</span></label>
                    <select className="w-full px-3 py-2 border border-[#E8E8E4] rounded-lg text-[13px] bg-white focus:border-[#7F77DD] outline-none"
                      value={sibling.gender} onChange={e => setSibling(s => ({ ...s, gender: e.target.value }))}>
                      <option value="">Select…</option>
                      <option value="M">Male</option>
                      <option value="F">Female</option>
                      <option value="Other">Other</option>
                    </select>
                  </div>
                </div>
              </div>

              {/* Pre-filled shared info (read-only preview) */}
              <div className="bg-[#FAFAF8] border border-[#E8E8E4] rounded-xl p-4 space-y-3">
                <div className="text-[10px] font-semibold text-[#7F77DD] uppercase tracking-wider">Pre-filled from {name.split(' ')[0]}'s chart</div>
                <div className="grid grid-cols-2 gap-3 text-[12px]">
                  {[
                    { label: 'Phone', value: child.family_phone || child.parent_phone },
                    { label: 'Email', value: child.family_email || child.parent_email },
                    { label: 'Address', value: [child.family_address_line1 || child.parent_address, child.family_city || child.parent_city, child.family_state || child.parent_state, child.family_zip || child.parent_zip].filter(Boolean).join(', ') },
                    { label: 'PCP', value: child.pcp },
                    { label: 'Pharmacy', value: child.preferred_pharmacy },
                    { label: 'Insurance', value: child.insurance_provider },
                    { label: 'Member ID', value: child.insurance_member_id },
                    { label: 'Group #', value: child.insurance_group_number },
                    { label: 'Subscriber', value: child.insurance_subscriber_name },
                    { label: 'Sub. DOB', value: child.insurance_subscriber_dob ? formatDob(String(child.insurance_subscriber_dob).split('T')[0]) : null },
                    { label: 'Sub. sex', value: child.insurance_subscriber_gender === 'M' ? 'Male' : child.insurance_subscriber_gender === 'F' ? 'Female' : child.insurance_subscriber_gender },
                  ].map(({ label, value }) => value ? (
                    <div key={label}>
                      <div className="text-[10px] text-[#999]">{label}</div>
                      <div className="text-[#1A1A2E] truncate">{value}</div>
                    </div>
                  ) : null)}
                </div>
                <p className="text-[10px] text-[#999] mt-1">These fields are copied automatically. You can edit them from the new patient's chart after saving.</p>
              </div>

              {siblingError && <div className="text-[12px] text-[#991B1B] bg-[#FDEDED] px-3 py-2 rounded-lg">{siblingError}</div>}
              {siblingDone && (
                <div className="flex items-center gap-2 text-[13px] text-[#085041] bg-[#E1F5EE] px-3 py-2 rounded-lg">
                  <CheckCircle2 size={14} /> Sibling added successfully!
                </div>
              )}
            </div>

            <div className="flex gap-2 px-6 pb-6">
              <button onClick={() => setSiblingOpen(false)} disabled={siblingSubmitting}
                className="flex-1 px-4 py-2.5 border border-[#E8E8E4] rounded-lg text-[13px] text-[#555] hover:bg-[#F1EFE8] transition-colors disabled:opacity-50">
                Cancel
              </button>
              <button
                onClick={submitSibling}
                disabled={siblingSubmitting || !sibling.first_name.trim() || !sibling.last_name.trim() || !sibling.date_of_birth || !sibling.gender}
                className="flex-1 px-4 py-2.5 bg-[#7F77DD] text-white rounded-lg text-[13px] font-medium hover:bg-[#6C64C8] transition-colors disabled:opacity-50">
                {siblingSubmitting ? 'Adding…' : 'Add sibling'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
