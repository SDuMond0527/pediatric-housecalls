import { useEffect, useRef, useState } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { Search, ChevronRight, Plus } from 'lucide-react'
import { format, parseISO, differenceInYears } from 'date-fns'
import { searchChildren, providerCreateChild } from '../lib/api'
import { Button } from '../components/ui/Button'
import { Modal } from '../components/ui/Modal'

const EMPTY_FORM = {
  first_name: '', last_name: '', date_of_birth: '', gender: '',
  parent_name: '', parent_phone: '', parent_email: '',
  parent_address: '', parent_city: '', parent_state: '', parent_zip: '',
  insurance_provider: '', insurance_member_id: '', insurance_group_number: '',
  insurance_subscriber_name: '', insurance_subscriber_dob: '', insurance_subscriber_gender: '',
}

function Input({ label, ...props }: { label: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div>
      <label className="block text-[11px] font-medium text-[#555] uppercase tracking-wide mb-1">{label}</label>
      <input
        className="w-full px-3 py-2 border border-[#E8E8E4] rounded-lg text-[13px] font-sans outline-none focus:border-[#7F77DD] bg-white"
        {...props}
      />
    </div>
  )
}

function Select({ label, children, ...props }: { label: string } & React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <div>
      <label className="block text-[11px] font-medium text-[#555] uppercase tracking-wide mb-1">{label}</label>
      <select
        className="w-full px-3 py-2 border border-[#E8E8E4] rounded-lg text-[13px] font-sans outline-none focus:border-[#7F77DD] bg-white"
        {...props}
      >{children}</select>
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
  const [allChildren, setAllChildren] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')
  const [searchResults, setSearchResults] = useState<any[]>([])
  const [searchLoading, setSearchLoading] = useState(false)
  const [searchError, setSearchError] = useState('')
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const [newPatientOpen, setNewPatientOpen] = useState(false)
  const [form, setForm] = useState(EMPTY_FORM)
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
    if (!form.first_name.trim() && !form.last_name.trim()) {
      setSaveError('First or last name is required.')
      return
    }
    setSaving(true)
    setSaveError('')
    try {
      const row = await providerCreateChild({
        first_name: form.first_name.trim() || null,
        last_name: form.last_name.trim() || null,
        date_of_birth: form.date_of_birth || null,
        gender: form.gender || null,
        parent_name: form.parent_name || null,
        parent_phone: form.parent_phone || null,
        parent_email: form.parent_email || null,
        parent_address: form.parent_address || null,
        parent_city: form.parent_city || null,
        parent_state: form.parent_state || null,
        parent_zip: form.parent_zip || null,
        insurance_provider: form.insurance_provider || null,
        insurance_member_id: form.insurance_member_id || null,
        insurance_group_number: form.insurance_group_number || null,
        insurance_subscriber_name: form.insurance_subscriber_name || null,
        insurance_subscriber_dob: form.insurance_subscriber_dob || null,
        insurance_subscriber_gender: form.insurance_subscriber_gender || null,
      })
      setNewPatientOpen(false)
      setForm(EMPTY_FORM)
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
      try {
        // Load a broad initial set using the search endpoint
        const rows = await searchChildren('').catch(() => [] as any[])
        setAllChildren(rows ?? [])
      } finally {
        setLoading(false)
      }
    }
    loadAll()
  }, [])

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
        const rows = await searchChildren(q.trim())
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
    return [c.first_name, c.last_name].filter(Boolean).join(' ') || c.display_label || 'Unknown'
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
        <div className="font-display text-[18px] font-medium text-[#1A1A2E]">Patients</div>
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
          <Button variant="primary" size="sm" onClick={() => { setForm(EMPTY_FORM); setSaveError(''); setNewPatientOpen(true) }}>
            <Plus size={13} /> New patient
          </Button>
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
              {isSearching ? 'No patients found matching your search.' : 'No patients on file.'}
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
                    <div className="font-display text-[15px] font-medium text-[#1A1A2E]">{childName(child)}</div>
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
        <div className="space-y-5">
          <div>
            <div className="text-[11px] font-semibold text-[#999] uppercase tracking-wider mb-3">Patient</div>
            <div className="grid grid-cols-2 gap-3">
              <Input label="First name *" placeholder="Jane" {...field('first_name')} />
              <Input label="Last name *" placeholder="Smith" {...field('last_name')} />
              <Input label="Date of birth" type="date" {...field('date_of_birth')} />
              <Select label="Gender" {...field('gender')}>
                <option value="">— select —</option>
                <option value="Male">Male</option>
                <option value="Female">Female</option>
                <option value="Other">Other</option>
              </Select>
            </div>
          </div>

          <div>
            <div className="text-[11px] font-semibold text-[#999] uppercase tracking-wider mb-3">Parent / guardian</div>
            <div className="grid grid-cols-2 gap-3">
              <Input label="Name" placeholder="John Smith" {...field('parent_name')} />
              <Input label="Phone" type="tel" placeholder="(704) 555-0100" {...field('parent_phone')} />
              <div className="col-span-2">
                <Input label="Email" type="email" placeholder="parent@email.com" {...field('parent_email')} />
              </div>
              <div className="col-span-2">
                <Input label="Address" placeholder="123 Main St" {...field('parent_address')} />
              </div>
              <Input label="City" placeholder="Charlotte" {...field('parent_city')} />
              <div className="grid grid-cols-2 gap-3">
                <Input label="State" placeholder="NC" maxLength={2} {...field('parent_state')} />
                <Input label="Zip" placeholder="28201" maxLength={10} {...field('parent_zip')} />
              </div>
            </div>
          </div>

          <div>
            <div className="text-[11px] font-semibold text-[#999] uppercase tracking-wider mb-3">Insurance <span className="text-[#bbb] normal-case font-normal">(optional)</span></div>
            <div className="grid grid-cols-2 gap-3">
              <div className="col-span-2">
                <Input label="Payer / insurance company" placeholder="BlueCross BlueShield" {...field('insurance_provider')} />
              </div>
              <Input label="Member ID" {...field('insurance_member_id')} />
              <Input label="Group number" {...field('insurance_group_number')} />
              <Input label="Subscriber name" {...field('insurance_subscriber_name')} />
              <Input label="Subscriber DOB" type="date" {...field('insurance_subscriber_dob')} />
              <Select label="Subscriber gender" {...field('insurance_subscriber_gender')}>
                <option value="">— select —</option>
                <option value="Male">Male</option>
                <option value="Female">Female</option>
                <option value="Other">Other</option>
              </Select>
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
