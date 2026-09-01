import { useEffect, useRef, useState } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { Search, ChevronRight, Plus, Upload, X } from 'lucide-react'
import { format, parseISO, differenceInYears } from 'date-fns'
import { searchChildren, providerCreateChild, providerUpdateChild, providerUploadInsuranceCard } from '../lib/api'
import { Button } from '../components/ui/Button'
import { Modal } from '../components/ui/Modal'

const EMPTY_FORM = {
  first_name: '', last_name: '', date_of_birth: '', gender: '', nickname: '',
  parent_name: '', parent_phone: '', parent_email: '',
  parent_address: '', parent_city: '', parent_state: '', parent_zip: '',
  insurance_provider: '', insurance_member_id: '', insurance_group_number: '',
  insurance_subscriber_name: '', insurance_subscriber_dob: '', insurance_subscriber_gender: '',
}

function Input({ label, required, ...props }: { label: string; required?: boolean } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div>
      <label className="block text-[11px] font-medium text-[#555] uppercase tracking-wide mb-1">
        {label}{required && <span className="text-[#C0392B] ml-0.5">*</span>}
      </label>
      <input
        className="w-full px-3 py-2 border border-[#E8E8E4] rounded-lg text-[13px] font-sans outline-none focus:border-[#7F77DD] bg-white"
        {...props}
      />
    </div>
  )
}

function Select({ label, required, children, ...props }: { label: string; required?: boolean } & React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <div>
      <label className="block text-[11px] font-medium text-[#555] uppercase tracking-wide mb-1">
        {label}{required && <span className="text-[#C0392B] ml-0.5">*</span>}
      </label>
      <select
        className="w-full px-3 py-2 border border-[#E8E8E4] rounded-lg text-[13px] font-sans outline-none focus:border-[#7F77DD] bg-white"
        {...props}
      >{children}</select>
    </div>
  )
}

function CardUpload({ label, file, onChange }: { label: string; file: File | null; onChange: (f: File | null) => void }) {
  const inputRef = useRef<HTMLInputElement>(null)
  const preview = file ? URL.createObjectURL(file) : null

  return (
    <div>
      <label className="block text-[11px] font-medium text-[#555] uppercase tracking-wide mb-1">
        {label}<span className="text-[#C0392B] ml-0.5">*</span>
      </label>
      <div
        onClick={() => inputRef.current?.click()}
        className="relative w-full h-28 border-2 border-dashed border-[#E8E8E4] rounded-lg overflow-hidden cursor-pointer hover:border-[#7F77DD] transition-colors bg-[#FAFAF8] flex items-center justify-center"
      >
        {preview ? (
          <>
            <img src={preview} alt={label} className="w-full h-full object-cover" />
            <button
              type="button"
              onClick={e => { e.stopPropagation(); onChange(null) }}
              className="absolute top-1 right-1 w-5 h-5 bg-white rounded-full shadow flex items-center justify-center hover:bg-red-50"
            >
              <X size={11} className="text-[#999]" />
            </button>
          </>
        ) : (
          <div className="flex flex-col items-center gap-1 text-[#bbb]">
            <Upload size={18} />
            <span className="text-[11px]">Click to upload</span>
          </div>
        )}
      </div>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className="sr-only"
        onChange={e => onChange(e.target.files?.[0] ?? null)}
      />
    </div>
  )
}

function calcAge(dob: string): string {
  try {
    const years = differenceInYears(new Date(), parseISO(dob))
    return `${years} yo`
  } catch {
    return ''
  }
}

function formatDob(raw: string): string {
  try {
    const s = String(raw).split('T')[0]
    return format(parseISO(s), 'MMM d, yyyy')
  } catch {
    return raw
  }
}

export function Patients() {
  const navigate = useNavigate()
  const location = useLocation()
  const isAdmin = location.pathname.startsWith('/admin')
  const [tab, setTab] = useState<'active' | 'archived'>('active')
  const [allChildren, setAllChildren] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')
  const [searchResults, setSearchResults] = useState<any[]>([])
  const [searchLoading, setSearchLoading] = useState(false)
  const [searchError, setSearchError] = useState('')
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const [newPatientOpen, setNewPatientOpen] = useState(false)
  const [form, setForm] = useState(EMPTY_FORM)
  const [cardFront, setCardFront] = useState<File | null>(null)
  const [cardBack, setCardBack] = useState<File | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')

  function field(key: keyof typeof EMPTY_FORM) {
    return {
      value: form[key],
      onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
        setForm(f => ({ ...f, [key]: e.target.value })),
    }
  }

  async function createPatient() {
    const checks: [string, string][] = [
      [form.first_name.trim(), 'Given name is required'],
      [form.last_name.trim(), 'Last name is required'],
      [form.date_of_birth, 'Date of birth is required'],
      [form.parent_phone.trim(), 'Phone number is required'],
      [form.parent_email.trim(), 'Email is required'],
      [form.parent_address.trim(), 'Street address is required'],
      [form.parent_city.trim(), 'City is required'],
      [form.parent_state.trim(), 'State is required'],
      [form.parent_zip.trim(), 'Zip code is required'],
      [form.insurance_provider.trim(), 'Insurance company is required'],
      [form.insurance_member_id.trim(), 'Member ID is required'],
      [form.insurance_group_number.trim(), 'Group number is required'],
      [form.insurance_subscriber_name.trim(), 'Subscriber name is required'],
      [form.insurance_subscriber_dob, 'Subscriber date of birth is required'],
      [cardFront ? 'ok' : '', 'Front of insurance card is required'],
      [cardBack ? 'ok' : '', 'Back of insurance card is required'],
    ]
    for (const [val, msg] of checks) {
      if (!val) { setSaveError(msg); return }
    }

    setSaving(true)
    setSaveError('')
    try {
      const row = await providerCreateChild({
        first_name: form.first_name.trim(),
        last_name: form.last_name.trim(),
        nickname: form.nickname.trim() || null,
        date_of_birth: form.date_of_birth,
        gender: form.gender || null,
        parent_name: form.parent_name || null,
        parent_phone: form.parent_phone.trim(),
        parent_email: form.parent_email.trim(),
        parent_address: form.parent_address.trim(),
        parent_city: form.parent_city.trim(),
        parent_state: form.parent_state.trim(),
        parent_zip: form.parent_zip.trim(),
        insurance_provider: form.insurance_provider.trim(),
        insurance_member_id: form.insurance_member_id.trim(),
        insurance_group_number: form.insurance_group_number.trim(),
        insurance_subscriber_name: form.insurance_subscriber_name.trim(),
        insurance_subscriber_dob: form.insurance_subscriber_dob,
        insurance_subscriber_gender: form.insurance_subscriber_gender || null,
      })

      const [frontUrl, backUrl] = await Promise.all([
        providerUploadInsuranceCard(row.id, cardFront!, 'front'),
        providerUploadInsuranceCard(row.id, cardBack!, 'back'),
      ])
      await providerUpdateChild(row.id, {
        insurance_card_front_url: frontUrl,
        insurance_card_back_url: backUrl,
      })

      setNewPatientOpen(false)
      setForm(EMPTY_FORM)
      setCardFront(null)
      setCardBack(null)
      navigate(isAdmin ? `/admin/chart/${row.id}` : `/chart/${row.id}`)
    } catch (e: any) {
      setSaveError(e?.message || 'Failed to create patient.')
    } finally {
      setSaving(false)
    }
  }

  useEffect(() => {
    async function loadAll() {
      setLoading(true)
      setQuery('')
      setSearchResults([])
      try {
        const rows = await searchChildren('', tab === 'archived').catch(() => [] as any[])
        setAllChildren(rows ?? [])
      } finally {
        setLoading(false)
      }
    }
    loadAll()
  }, [tab])

  function onQueryChange(q: string) {
    setQuery(q)
    setSearchError('')
    if (searchTimer.current) clearTimeout(searchTimer.current)
    if (!q.trim()) {
      setSearchResults([])
      return
    }
    searchTimer.current = setTimeout(async () => {
      setSearchLoading(true)
      try {
        const rows = await searchChildren(q.trim(), tab === 'archived')
        setSearchResults(rows ?? [])
      } catch (e: any) {
        setSearchResults([])
        setSearchError(e?.message || 'Search failed')
      }
      setSearchLoading(false)
    }, 300)
  }

  const isSearching = query.trim().length > 0
  const displayed = isSearching ? searchResults : allChildren

  function childName(c: any): string {
    const first = c.first_name || ''
    const nick = c.nickname ? ` (${c.nickname})` : ''
    const last = c.last_name || ''
    return [first + nick, last].filter(Boolean).join(' ') || c.display_label || 'Unknown'
  }

  function familyLabel(c: any): string {
    return c.family_display_name || c.family_email || ''
  }

  function dobStr(c: any): string {
    if (!c.date_of_birth) return ''
    return String(c.date_of_birth instanceof Date ? c.date_of_birth.toISOString() : c.date_of_birth).split('T')[0]
  }

  function initials(c: any): string {
    return childName(c).split(' ').map((p: string) => p[0]).filter(Boolean).slice(0, 2).join('')
  }

  return (
    <div className="min-h-screen bg-[#FAFAF8]">
      {/* Header */}
      <div className="bg-white border-b border-[#E8E8E4] px-6 py-4 flex items-center justify-between sticky top-0 z-10">
        <div className="flex items-center gap-4">
          <div className="font-display text-[18px] font-medium text-[#1A1A2E]">Patients</div>
          <div className="flex gap-1">
            <button onClick={() => setTab('active')}
              className={`px-3 py-1 rounded-full text-[12px] font-medium transition-colors ${tab === 'active' ? 'bg-[#7F77DD] text-white' : 'text-[#999] hover:text-[#555]'}`}>
              Active
            </button>
            <button onClick={() => setTab('archived')}
              className={`px-3 py-1 rounded-full text-[12px] font-medium transition-colors ${tab === 'archived' ? 'bg-[#7F77DD] text-white' : 'text-[#999] hover:text-[#555]'}`}>
              Archived
            </button>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div className="relative w-56">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#999]" />
            <input
              type="text"
              placeholder="Search by name…"
              value={query}
              onChange={e => onQueryChange(e.target.value)}
              className="w-full pl-8 pr-3 py-2 border border-[#E8E8E4] rounded-lg text-[14px] outline-none focus:border-[#7F77DD] font-sans"
            />
          </div>
          {tab === 'active' && (
            <Button variant="primary" size="sm" onClick={() => { setForm(EMPTY_FORM); setCardFront(null); setCardBack(null); setSaveError(''); setNewPatientOpen(true) }}>
              <Plus size={13} /> New patient
            </Button>
          )}
        </div>
      </div>

      <div className="p-6 max-w-3xl mx-auto">
        {loading ? (
          <div className="text-center py-16 text-[#999] text-[14px]">Loading patients…</div>
        ) : searchLoading ? (
          <div className="text-center py-16 text-[#999] text-[14px]">Searching…</div>
        ) : searchError ? (
          <div className="text-center py-16">
            <div className="text-[#791F1F] text-[14px]">Search error: {searchError}</div>
          </div>
        ) : displayed.length === 0 ? (
          <div className="text-center py-16">
            <div className="text-[#999] text-[14px]">
              {isSearching ? 'No patients found matching your search.' : tab === 'archived' ? 'No archived patients.' : 'No patients on file.'}
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            {displayed.map((child: any) => {
              const dob = dobStr(child)
              const age = dob ? calcAge(dob) : ''
              const fam = familyLabel(child)

              return (
                <button
                  key={child.id}
                  onClick={() => navigate(isAdmin ? `/admin/chart/${child.id}` : `/chart/${child.id}`)}
                  className="w-full text-left flex items-center gap-4 px-5 py-4 bg-white border border-[#E8E8E4] rounded-xl hover:border-[#AFA9EC] hover:bg-[#FAFAF8] transition-all group">
                  <div className="w-9 h-9 rounded-full bg-[#EEEDFE] flex items-center justify-center flex-shrink-0">
                    <span className="text-[12px] font-semibold text-[#7F77DD]">{initials(child)}</span>
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="font-display text-[15px] font-medium text-[#1A1A2E] flex items-center gap-2">
                      {childName(child)}
                      {child.is_archived && <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-[#F1EFE8] text-[#999]">Archived</span>}
                    </div>
                    <div className="text-[12px] text-[#999] mt-0.5 flex items-center gap-2 flex-wrap">
                      {dob && <span>{formatDob(dob)}{age ? ` · ${age}` : ''}</span>}
                      {fam && <span className="text-[#555]">{fam}</span>}
                    </div>
                  </div>
                  <ChevronRight size={14} className="text-[#ccc] group-hover:text-[#7F77DD] transition-colors flex-shrink-0" />
                </button>
              )
            })}
          </div>
        )}
      </div>

      <Modal open={newPatientOpen} onClose={() => setNewPatientOpen(false)} title="New patient" size="lg">
        <div className="space-y-6">

          {/* Patient */}
          <div>
            <div className="text-[11px] font-semibold text-[#999] uppercase tracking-wider mb-3">Patient</div>
            <div className="grid grid-cols-2 gap-3">
              <Input label="Given first name" required placeholder="Jane" {...field('first_name')} />
              <Input label="Last name" required placeholder="Smith" {...field('last_name')} />
              <Input label="Nickname" placeholder="Optional" {...field('nickname')} />
              <Input label="Date of birth" required type="date" {...field('date_of_birth')} />
              <Select label="Gender" {...field('gender')}>
                <option value="">— select —</option>
                <option value="Male">Male</option>
                <option value="Female">Female</option>
                <option value="Other">Other</option>
              </Select>
            </div>
          </div>

          {/* Contact */}
          <div>
            <div className="text-[11px] font-semibold text-[#999] uppercase tracking-wider mb-3">Contact</div>
            <div className="grid grid-cols-2 gap-3">
              <Input label="Parent / guardian name" placeholder="John Smith" {...field('parent_name')} />
              <Input label="Phone" required type="tel" placeholder="(704) 555-0100" {...field('parent_phone')} />
              <div className="col-span-2">
                <Input label="Email" required type="email" placeholder="parent@email.com" {...field('parent_email')} />
              </div>
              <div className="col-span-2">
                <Input label="Street address" required placeholder="123 Main St" {...field('parent_address')} />
              </div>
              <Input label="City" required placeholder="Charlotte" {...field('parent_city')} />
              <div className="grid grid-cols-2 gap-3">
                <Input label="State" required placeholder="NC" maxLength={2} {...field('parent_state')} />
                <Input label="Zip" required placeholder="28201" maxLength={10} {...field('parent_zip')} />
              </div>
            </div>
          </div>

          {/* Insurance */}
          <div>
            <div className="text-[11px] font-semibold text-[#999] uppercase tracking-wider mb-3">Insurance</div>
            <div className="grid grid-cols-2 gap-3">
              <div className="col-span-2">
                <Input label="Insurance company" required placeholder="BlueCross BlueShield" {...field('insurance_provider')} />
              </div>
              <Input label="Member ID" required {...field('insurance_member_id')} />
              <Input label="Group number" required {...field('insurance_group_number')} />
              <Input label="Subscriber name" required {...field('insurance_subscriber_name')} />
              <Input label="Subscriber DOB" required type="date" {...field('insurance_subscriber_dob')} />
              <Select label="Subscriber gender" {...field('insurance_subscriber_gender')}>
                <option value="">— select —</option>
                <option value="Male">Male</option>
                <option value="Female">Female</option>
                <option value="Other">Other</option>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-3 mt-3">
              <CardUpload label="Front of card" file={cardFront} onChange={setCardFront} />
              <CardUpload label="Back of card" file={cardBack} onChange={setCardBack} />
            </div>
          </div>

          {saveError && (
            <div className="px-3 py-2 bg-[#FCEBEB] text-[#791F1F] text-[13px] rounded-lg">{saveError}</div>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <Button variant="secondary" size="sm" onClick={() => setNewPatientOpen(false)}>Cancel</Button>
            <Button variant="primary" size="sm" loading={saving} onClick={createPatient}>Create patient</Button>
          </div>
        </div>
      </Modal>
    </div>
  )
}
