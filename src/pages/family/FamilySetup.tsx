import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { Plus, Trash2, CheckCircle2, Upload } from 'lucide-react'
import { updateMyFamily, createChild, lookupChild, familyUploadInsuranceCard } from '../../lib/api'
import { useFamilyAuth } from '../../contexts/FamilyAuthContext'
import { Button } from '../../components/ui/Button'
import { Input } from '../../components/ui/Input'
import { PracticeLogo } from '../../lib/practice'
import { format, parseISO } from 'date-fns'

const US_STATES: [string, string][] = [
  ['AL','Alabama'],['AK','Alaska'],['AZ','Arizona'],['AR','Arkansas'],['CA','California'],
  ['CO','Colorado'],['CT','Connecticut'],['DE','Delaware'],['FL','Florida'],['GA','Georgia'],
  ['HI','Hawaii'],['ID','Idaho'],['IL','Illinois'],['IN','Indiana'],['IA','Iowa'],
  ['KS','Kansas'],['KY','Kentucky'],['LA','Louisiana'],['ME','Maine'],['MD','Maryland'],
  ['MA','Massachusetts'],['MI','Michigan'],['MN','Minnesota'],['MS','Mississippi'],['MO','Missouri'],
  ['MT','Montana'],['NE','Nebraska'],['NV','Nevada'],['NH','New Hampshire'],['NJ','New Jersey'],
  ['NM','New Mexico'],['NY','New York'],['NC','North Carolina'],['ND','North Dakota'],['OH','Ohio'],
  ['OK','Oklahoma'],['OR','Oregon'],['PA','Pennsylvania'],['RI','Rhode Island'],['SC','South Carolina'],
  ['SD','South Dakota'],['TN','Tennessee'],['TX','Texas'],['UT','Utah'],['VT','Vermont'],
  ['VA','Virginia'],['WA','Washington'],['WV','West Virginia'],['WI','Wisconsin'],['WY','Wyoming'],
]

const VAX_OPTIONS = [
  { value: 'fully_vaccinated', label: 'Fully vaccinated on schedule' },
  { value: 'delayed',          label: 'Delayed / alternative schedule' },
  { value: 'unvaccinated',     label: 'Not vaccinated' },
]

type ChildEntry = {
  first_name: string
  last_name: string
  date_of_birth: string
  gender: string
  allergies: string
  current_medications: string
  medical_history: string
  preferred_pharmacy: string
  pcp: string
  vaccination_status: string
  self_pay: boolean
  insurance_provider: string
  insurance_member_id: string
  insurance_group_number: string
  insurance_subscriber_name: string
  insurance_subscriber_dob: string
  insurance_subscriber_gender: string
  insurance_subscriber_relationship: string
  insurance_card_front_url: string
  insurance_card_back_url: string
  match: { id: string; first_name: string; last_name: string; date_of_birth: string; parent_phone: string | null; parent_email: string | null; parent_address: string | null } | null
  matchDismissed: boolean
  matchConfirmed: boolean
}

function emptyChild(): ChildEntry {
  return {
    first_name: '', last_name: '', date_of_birth: '',
    gender: '', allergies: '', current_medications: '', medical_history: '',
    preferred_pharmacy: '', pcp: '', vaccination_status: '',
    self_pay: false,
    insurance_provider: '', insurance_member_id: '', insurance_group_number: '',
    insurance_subscriber_name: '', insurance_subscriber_dob: '',
    insurance_subscriber_gender: '', insurance_subscriber_relationship: 'child',
    insurance_card_front_url: '', insurance_card_back_url: '',
    match: null, matchDismissed: false, matchConfirmed: false,
  }
}

function childIsComplete(c: ChildEntry): string | null {
  if (!c.first_name.trim()) return 'First name'
  if (!c.last_name.trim()) return 'Last name'
  if (!c.date_of_birth) return 'Date of birth'
  if (!c.gender) return 'Sex'
  if (!c.allergies.trim()) return 'Allergies (type "NKDA" if none)'
  if (!c.current_medications.trim()) return 'Current medications (type "None" if none)'
  if (!c.medical_history.trim()) return 'Medical history (type "None" if none)'
  if (!c.preferred_pharmacy.trim()) return 'Preferred pharmacy'
  if (!c.pcp.trim()) return 'Primary care provider'
  if (!c.vaccination_status) return 'Vaccination status'
  if (!c.self_pay) {
    if (!c.insurance_provider.trim()) return 'Insurance provider'
    if (!c.insurance_member_id.trim()) return 'Member ID'
    if (!c.insurance_group_number.trim()) return 'Group #'
    if (!c.insurance_subscriber_name.trim()) return 'Subscriber name'
    if (!c.insurance_subscriber_dob) return 'Subscriber DOB'
    if (!c.insurance_subscriber_gender) return 'Subscriber sex'
    if (!c.insurance_card_front_url) return 'Insurance card — front photo'
    if (!c.insurance_card_back_url) return 'Insurance card — back photo'
  }
  return null
}

export function FamilySetup() {
  const { user, loading, refreshFamily } = useFamilyAuth()
  const navigate = useNavigate()

  useEffect(() => {
    if (!loading && !user) navigate('/family/login')
  }, [user, loading])

  const [displayName, setDisplayName] = useState('')
  const [addressLine1, setAddressLine1] = useState('')
  const [city, setCity] = useState('')
  const [state, setState] = useState('')
  const [zip, setZip] = useState('')
  const [children, setChildren] = useState<ChildEntry[]>([emptyChild()])
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  const lookupTimers = useRef<Record<number, ReturnType<typeof setTimeout>>>({})

  function updateChildField<K extends keyof ChildEntry>(i: number, field: K, value: ChildEntry[K]) {
    setChildren(prev => prev.map((c, idx) => idx !== i ? c : { ...c, [field]: value }))

    if (field === 'first_name' || field === 'last_name' || field === 'date_of_birth') {
      const updated = { ...children[i], [field]: value } as ChildEntry
      if (updated.first_name.trim() && updated.last_name.trim() && updated.date_of_birth) {
        clearTimeout(lookupTimers.current[i])
        lookupTimers.current[i] = setTimeout(async () => {
          try {
            const match = await lookupChild(updated.first_name.trim(), updated.last_name.trim(), updated.date_of_birth)
            setChildren(prev => prev.map((c, idx) => idx !== i ? c : { ...c, match: match ?? null, matchDismissed: false, matchConfirmed: false }))
          } catch { /* lookup failure is non-fatal */ }
        }, 600)
      }
    }
  }

  function confirmMatch(i: number) {
    setChildren(prev => prev.map((c, idx) => idx !== i ? c : { ...c, matchConfirmed: true, matchDismissed: false }))
  }
  function dismissMatch(i: number) {
    setChildren(prev => prev.map((c, idx) => idx !== i ? c : { ...c, matchDismissed: true, matchConfirmed: false }))
  }

  async function save() {
    setError('')

    if (!addressLine1.trim() || !city.trim() || !state || !zip) {
      setError('Please enter your full home address (street, city, state, zip).')
      return
    }
    if (zip.length < 5) { setError('Please enter a 5-digit zip code.'); return }

    if (children.length === 0) { setError('Please add at least one child.'); return }
    for (let i = 0; i < children.length; i++) {
      const missing = childIsComplete(children[i])
      if (missing) {
        setError(`Child ${i + 1}: ${missing} is required. Every field must be filled in before we can create your account.`)
        return
      }
    }

    setSaving(true)

    // Phone is required. Collected at signup and stashed in sessionStorage.
    // See memory: feedback_phone_required_everywhere.md.
    let signupPhone = ''
    try { signupPhone = sessionStorage.getItem('phc_signup_phone') || '' } catch {}
    const digits = signupPhone.replace(/\D/g, '')
    if (digits.length < 10) {
      setError('A 10-digit phone number is required. Please go back to sign up and provide one.')
      setSaving(false)
      return
    }

    try {
      await updateMyFamily({
        email:         user!.email ?? null,
        display_name:  displayName || null,
        phone:         digits,
        address_line1: addressLine1.trim(),
        city:          city.trim(),
        state:         state,
        zip:           zip,
        practice_id:   import.meta.env.VITE_PRACTICE_ID || null,
      })
      try { sessionStorage.removeItem('phc_signup_phone') } catch {}
    } catch (e: any) {
      setError('Profile save failed: ' + (e?.message || String(e)))
      setSaving(false)
      return
    }

    // Only after every child's intake is validated do we create rows.
    // See memory: feedback_all_patient_info_required_and_displayed.md
    try {
      for (const child of children) {
        await createChild({
          first_name:      child.first_name.trim(),
          last_name:       child.last_name.trim(),
          date_of_birth:   child.date_of_birth,
          display_label:   [child.first_name.trim(), child.last_name.trim()].filter(Boolean).join(' '),
          gender:          child.gender,
          parent_phone:    digits,
          parent_email:    user!.email ?? null,
          parent_address:  addressLine1.trim(),
          parent_city:     city.trim(),
          parent_state:    state,
          parent_zip:      zip,
          allergies:                          child.allergies.trim(),
          current_medications:                child.current_medications.trim(),
          medical_history:                    child.medical_history.trim(),
          preferred_pharmacy:                 child.preferred_pharmacy.trim(),
          pcp:                                child.pcp.trim(),
          vaccination_status:                 child.vaccination_status,
          insurance_provider:                 child.self_pay ? 'Self-pay' : child.insurance_provider.trim(),
          insurance_member_id:                child.self_pay ? null : child.insurance_member_id.trim(),
          insurance_group_number:             child.self_pay ? null : child.insurance_group_number.trim(),
          insurance_subscriber_name:          child.self_pay ? null : child.insurance_subscriber_name.trim(),
          insurance_subscriber_dob:           child.self_pay ? null : child.insurance_subscriber_dob,
          insurance_subscriber_gender:        child.self_pay ? null : child.insurance_subscriber_gender,
          insurance_subscriber_relationship:  child.self_pay ? null : child.insurance_subscriber_relationship,
          insurance_card_front_url:           child.self_pay ? null : child.insurance_card_front_url,
          insurance_card_back_url:            child.self_pay ? null : child.insurance_card_back_url,
        })
      }
    } catch (e: any) {
      setError('Child save failed: ' + (e?.message || String(e)))
      setSaving(false)
      return
    }

    try {
      await refreshFamily()
      navigate('/family/dashboard')
    } catch (e: any) {
      setError('Refresh failed: ' + (e?.message || String(e)))
      setSaving(false)
    }
  }

  return (
    <div className="min-h-screen bg-[#FAFAF8] flex items-start justify-center p-4 pt-12">
      <div className="w-full max-w-2xl">
        <div className="text-center mb-8">
          <div className="font-display text-2xl font-medium text-[#1A1A2E] mb-1">
            <PracticeLogo />
          </div>
          <p className="text-[13px] text-[#999] mt-1">Let's set up your family profile</p>
        </div>

        <div className="bg-white border border-[#E8E8E4] rounded-xl shadow-sm p-7 space-y-5">
          <div>
            <h2 className="font-display text-lg font-medium text-[#1A1A2E] mb-3">Your family</h2>
            <div className="mb-3">
              <Input label="Family display name (optional)"
                placeholder="e.g. The Smith Family, or just your first name"
                value={displayName} onChange={e => setDisplayName(e.target.value)} />
              <p className="text-[11px] text-[#aeaeb2] mt-1">This is just how we'll greet you in the portal.</p>
            </div>
            <div className="space-y-3">
              <Input label="Home street address *" placeholder="123 Main St"
                value={addressLine1} onChange={e => setAddressLine1(e.target.value)} />
              <div className="grid grid-cols-3 gap-3">
                <Input label="City *" placeholder="Charlotte"
                  value={city} onChange={e => setCity(e.target.value)} />
                <div>
                  <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-1">State *</label>
                  <select value={state} onChange={e => setState(e.target.value)}
                    className="w-full px-3 py-2.5 border border-[#E8E8E4] rounded-lg text-[14px] font-sans bg-white">
                    <option value="">Select</option>
                    {US_STATES.map(([code, name]) => <option key={code} value={code}>{name}</option>)}
                  </select>
                </div>
                <Input label="Zip *" placeholder="28078" maxLength={5} value={zip} onChange={e => setZip(e.target.value)} />
              </div>
            </div>
          </div>

          <div className="border-t border-[#E8E8E4] pt-5">
            <div className="flex items-center justify-between mb-1">
              <h2 className="font-display text-lg font-medium text-[#1A1A2E]">Children</h2>
              <button onClick={() => setChildren(prev => [...prev, emptyChild()])}
                className="flex items-center gap-1.5 text-[12px] text-[#7F77DD] font-medium hover:underline">
                <Plus size={13} /> Add another
              </button>
            </div>
            <p className="text-[12px] text-[#999] mb-4">
              We need a complete profile for each child — allergies, medications, insurance, and everything on the intake form.
              This lets us prescribe medications, order labs, and file insurance claims from your very first visit.
            </p>

            <div className="space-y-6">
              {children.map((child, i) => (
                <ChildIntake
                  key={i}
                  index={i}
                  child={child}
                  removable={children.length > 1}
                  familySub={user?.id || user?.email || 'unknown'}
                  onField={(k, v) => updateChildField(i, k, v as any)}
                  onRemove={() => setChildren(prev => prev.filter((_, idx) => idx !== i))}
                  onConfirmMatch={() => confirmMatch(i)}
                  onDismissMatch={() => dismissMatch(i)}
                />
              ))}
            </div>
          </div>

          {error && <div className="p-3 rounded-lg bg-[#FCEBEB] text-[13px] text-[#791F1F]">{error}</div>}

          <Button className="w-full !py-2.5" loading={saving} onClick={save}>Save and continue</Button>
          <p className="text-[11px] text-[#999] text-center">
            Nothing is saved until every field is complete. If any field is missing we'll tell you which one — we never create a half-empty chart.
          </p>
        </div>
      </div>
    </div>
  )
}

// ── Per-child intake block ────────────────────────────────────────

function ChildIntake({
  index, child, removable, familySub,
  onField, onRemove, onConfirmMatch, onDismissMatch,
}: {
  index: number
  child: ChildEntry
  removable: boolean
  familySub: string
  onField: (k: keyof ChildEntry, v: string | boolean) => void
  onRemove: () => void
  onConfirmMatch: () => void
  onDismissMatch: () => void
}) {
  const showMatch = child.match && !child.matchDismissed
  const [uploadingFront, setUploadingFront] = useState(false)
  const [uploadingBack, setUploadingBack] = useState(false)
  const [uploadErr, setUploadErr] = useState('')

  async function uploadCard(file: File, side: 'front' | 'back') {
    setUploadErr('')
    if (side === 'front') setUploadingFront(true); else setUploadingBack(true)
    try {
      const url = await familyUploadInsuranceCard(familySub, file, side)
      onField(side === 'front' ? 'insurance_card_front_url' : 'insurance_card_back_url', url)
    } catch (e: any) {
      setUploadErr(e?.message || 'Upload failed')
    } finally {
      if (side === 'front') setUploadingFront(false); else setUploadingBack(false)
    }
  }

  return (
    <div className="border border-[#E8E8E4] rounded-xl p-4 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="font-display text-[15px] font-medium text-[#1A1A2E]">Child {index + 1}</h3>
        {removable && (
          <button onClick={onRemove} className="text-[#999] hover:text-[#791F1F]" title="Remove">
            <Trash2 size={14} />
          </button>
        )}
      </div>

      {/* Identity */}
      <div className="grid grid-cols-2 gap-2">
        <Input label="First name *" placeholder="Emma"
          value={child.first_name} onChange={e => onField('first_name', e.target.value)} />
        <Input label="Last name *" placeholder="Smith"
          value={child.last_name} onChange={e => onField('last_name', e.target.value)} />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Input label="Date of birth *" type="date"
          value={child.date_of_birth} onChange={e => onField('date_of_birth', e.target.value)} />
        <div>
          <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-1">Sex *</label>
          <select value={child.gender} onChange={e => onField('gender', e.target.value)}
            className="w-full px-3 py-2.5 border border-[#E8E8E4] rounded-lg text-[14px] bg-white">
            <option value="">Select</option>
            <option value="Male">Male</option>
            <option value="Female">Female</option>
          </select>
        </div>
      </div>

      {showMatch && !child.matchConfirmed && (
        <div className="rounded-xl border border-[#7F77DD] bg-[#EEEDFE] p-4 space-y-3">
          <p className="text-[13px] font-semibold text-[#3C3489]">We found an existing patient profile — is this your child?</p>
          <div className="space-y-1 text-[13px] text-[#1A1A2E]">
            <div><span className="text-[#555]">Name: </span><strong>{child.match!.first_name} {child.match!.last_name}</strong></div>
            <div><span className="text-[#555]">DOB: </span><strong>{format(parseISO(String(child.match!.date_of_birth).split('T')[0]), 'MMMM d, yyyy')}</strong></div>
            {child.match!.parent_phone && <div><span className="text-[#555]">Phone: </span><strong>{child.match!.parent_phone}</strong></div>}
            {child.match!.parent_email && <div><span className="text-[#555]">Email: </span><strong>{child.match!.parent_email}</strong></div>}
          </div>
          <div className="flex gap-2 pt-1">
            <Button variant="primary" size="sm" onClick={onConfirmMatch}>
              <CheckCircle2 size={13} /> Yes, that's my child
            </Button>
            <Button variant="secondary" size="sm" onClick={onDismissMatch}>
              No, create new profile
            </Button>
          </div>
        </div>
      )}

      {/* Clinical */}
      <div className="border-t border-[#F1EFE8] pt-3 space-y-3">
        <p className="text-[11px] font-semibold text-[#7F77DD] uppercase tracking-wider">Medical</p>
        <div>
          <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-1">Drug &amp; food allergies *</label>
          <textarea rows={2} placeholder='Type "NKDA" if none'
            value={child.allergies} onChange={e => onField('allergies', e.target.value)}
            className="w-full px-3 py-2.5 border border-[#E8E8E4] rounded-lg text-[14px] resize-none" />
        </div>
        <div>
          <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-1">Current medications *</label>
          <textarea rows={2} placeholder='Type "None" if none'
            value={child.current_medications} onChange={e => onField('current_medications', e.target.value)}
            className="w-full px-3 py-2.5 border border-[#E8E8E4] rounded-lg text-[14px] resize-none" />
        </div>
        <div>
          <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-1">Significant medical history *</label>
          <textarea rows={2} placeholder='Type "None" if no significant history'
            value={child.medical_history} onChange={e => onField('medical_history', e.target.value)}
            className="w-full px-3 py-2.5 border border-[#E8E8E4] rounded-lg text-[14px] resize-none" />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Input label="Preferred pharmacy *" placeholder="CVS on Main St"
            value={child.preferred_pharmacy} onChange={e => onField('preferred_pharmacy', e.target.value)} />
          <Input label="Primary care provider *" placeholder="Dr. Jane Smith"
            value={child.pcp} onChange={e => onField('pcp', e.target.value)} />
        </div>
        <div>
          <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-1">Vaccination status *</label>
          <select value={child.vaccination_status} onChange={e => onField('vaccination_status', e.target.value)}
            className="w-full px-3 py-2.5 border border-[#E8E8E4] rounded-lg text-[14px] bg-white">
            <option value="">Select</option>
            {VAX_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
      </div>

      {/* Insurance */}
      <div className="border-t border-[#F1EFE8] pt-3 space-y-3">
        <div className="flex items-center justify-between">
          <p className="text-[11px] font-semibold text-[#7F77DD] uppercase tracking-wider">Insurance</p>
          <label className="flex items-center gap-1.5 text-[12px] text-[#555]">
            <input type="checkbox" checked={child.self_pay}
              onChange={e => onField('self_pay', e.target.checked)} />
            Self-pay (no insurance)
          </label>
        </div>

        {!child.self_pay && (
          <>
            <div className="grid grid-cols-2 gap-2">
              <Input label="Insurance provider *" placeholder="Blue Cross"
                value={child.insurance_provider} onChange={e => onField('insurance_provider', e.target.value)} />
              <Input label="Member ID *" placeholder="ABC123456"
                value={child.insurance_member_id} onChange={e => onField('insurance_member_id', e.target.value)} />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Input label="Group # *" placeholder="G00000001"
                value={child.insurance_group_number} onChange={e => onField('insurance_group_number', e.target.value)} />
              <Input label="Subscriber name *" placeholder="Full name"
                value={child.insurance_subscriber_name} onChange={e => onField('insurance_subscriber_name', e.target.value)} />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Input label="Subscriber DOB *" type="date"
                value={child.insurance_subscriber_dob} onChange={e => onField('insurance_subscriber_dob', e.target.value)} />
              <div>
                <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-1">Subscriber sex *</label>
                <select value={child.insurance_subscriber_gender} onChange={e => onField('insurance_subscriber_gender', e.target.value)}
                  className="w-full px-3 py-2.5 border border-[#E8E8E4] rounded-lg text-[14px] bg-white">
                  <option value="">Select</option>
                  <option value="Male">Male</option>
                  <option value="Female">Female</option>
                </select>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <CardUpload label="Insurance card — front *"
                url={child.insurance_card_front_url}
                uploading={uploadingFront}
                onFile={f => uploadCard(f, 'front')}
                onClear={() => onField('insurance_card_front_url', '')} />
              <CardUpload label="Insurance card — back *"
                url={child.insurance_card_back_url}
                uploading={uploadingBack}
                onFile={f => uploadCard(f, 'back')}
                onClear={() => onField('insurance_card_back_url', '')} />
            </div>
            {uploadErr && <div className="text-[12px] text-[#DC2626]">{uploadErr}</div>}
          </>
        )}
      </div>
    </div>
  )
}

function CardUpload({ label, url, uploading, onFile, onClear }: {
  label: string; url: string; uploading: boolean
  onFile: (f: File) => void; onClear: () => void
}) {
  return (
    <div>
      <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-1">{label}</label>
      {url ? (
        <div className="flex items-center gap-2">
          <img src={url} className="h-16 rounded border border-[#E8E8E4] object-contain" />
          <button onClick={onClear} className="text-[11px] text-[#DC2626]">Remove</button>
        </div>
      ) : (
        <label className="flex items-center gap-1.5 px-3 py-2 border border-dashed border-[#E8E8E4] rounded-lg text-[12px] text-[#555] cursor-pointer hover:bg-[#F1EFE8]">
          <Upload size={12} />
          {uploading ? 'Uploading…' : 'Choose photo'}
          <input type="file" accept="image/*" className="hidden"
            onChange={e => e.target.files?.[0] && onFile(e.target.files[0])} />
        </label>
      )}
    </div>
  )
}
