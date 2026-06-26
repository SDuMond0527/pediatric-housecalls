import { useEffect, useState, type FormEvent } from 'react'
import { Building2, Plus, CheckCircle2, AlertCircle, UserPlus, ChevronDown, ChevronUp } from 'lucide-react'
import { useAuth } from '../../contexts/AuthContext'
import { getPractices, createPractice, createProviderForPractice } from '../../lib/api'
import { Button } from '../../components/ui/Button'
import { Input } from '../../components/ui/Input'

interface Practice {
  id: string
  name: string
  slug: string
  city: string | null
  state: string | null
  phone: string | null
  email: string | null
  subscription_tier: string
  is_active: boolean
  created_at: string
}

const TIERS = ['starter', 'growth', 'pro', 'owner']
const ROLES = ['MD', 'PNP', 'CMA', 'RN', 'admin']

function slugify(name: string) {
  return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

function autoInitials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return ''
}

interface ProviderFormState {
  name: string
  email: string
  role: string
  initials: string
}

function ProviderForm({ practiceId, onDone }: { practiceId: string; onDone: (provider: any) => void }) {
  const [form, setForm] = useState<ProviderFormState>({ name: '', email: '', role: 'MD', initials: '' })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function setField(field: keyof ProviderFormState, value: string) {
    setForm(prev => {
      const next = { ...prev, [field]: value }
      if (field === 'name') next.initials = autoInitials(value)
      return next
    })
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (!form.name || !form.email || !form.role || !form.initials) return
    setSaving(true)
    setError(null)
    try {
      const provider = await createProviderForPractice({ ...form, practice_id: practiceId })
      onDone(provider)
    } catch (err: any) {
      setError(err.message ?? 'Failed to create provider')
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="mt-3 pt-3 border-t border-[#E8E8E4]">
      <div className="grid grid-cols-2 gap-3">
        <div className="col-span-2">
          <Input label="Full name" value={form.name} onChange={e => setField('name', e.target.value)}
            placeholder="Dr. Jane Smith" required />
        </div>
        <div className="col-span-2">
          <Input label="Email" type="email" value={form.email} onChange={e => setField('email', e.target.value)}
            placeholder="jane@example.com" required />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider">Role</label>
          <select value={form.role} onChange={e => setField('role', e.target.value)}
            className="w-full px-3 py-2.5 rounded-lg border border-[#E8E8E4] bg-white text-sm text-[#1A1A2E] outline-none focus:border-[#7F77DD] focus:ring-2 focus:ring-[#7F77DD]/10 transition-all">
            {ROLES.map(r => <option key={r} value={r}>{r}</option>)}
          </select>
        </div>
        <Input label="Initials" value={form.initials} onChange={e => setField('initials', e.target.value)}
          placeholder="JS" maxLength={3} required />
      </div>
      {error && (
        <div className="mt-3 flex items-center gap-2 text-[#791F1F] text-sm bg-[#FCEBEB] border border-[#F09595] rounded-lg px-3 py-2">
          <AlertCircle size={14} />
          {error}
        </div>
      )}
      <div className="mt-3 flex justify-end gap-2">
        <Button type="submit" size="sm" loading={saving}>Create provider</Button>
      </div>
    </form>
  )
}

export function AdminProvision() {
  const { provider } = useAuth()
  const [practices, setPractices] = useState<Practice[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [saving, setSaving] = useState(false)
  const [savedId, setSavedId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [expandedProviderForm, setExpandedProviderForm] = useState<string | null>(null)
  const [savedProviders, setSavedProviders] = useState<Record<string, any[]>>({})

  const [form, setForm] = useState({
    name: '', slug: '', city: '', state: '', phone: '', email: '', subscription_tier: 'starter',
  })

  useEffect(() => {
    if (!provider?.is_super_admin) return
    getPractices().then(setPractices).catch(() => {}).finally(() => setLoading(false))
  }, [provider])

  function setField(field: string, value: string) {
    setForm(prev => {
      const next = { ...prev, [field]: value }
      if (field === 'name' && !prev.slug) next.slug = slugify(value)
      return next
    })
  }

  async function handleCreate(e: FormEvent) {
    e.preventDefault()
    if (!form.name || !form.slug) return
    setSaving(true)
    setError(null)
    try {
      const practice = await createPractice({
        name: form.name,
        slug: form.slug,
        city: form.city || null,
        state: form.state || null,
        phone: form.phone || null,
        email: form.email || null,
        subscription_tier: form.subscription_tier,
      })
      setPractices(prev => [practice, ...prev])
      setSavedId(practice.id)
      setShowForm(false)
      setForm({ name: '', slug: '', city: '', state: '', phone: '', email: '', subscription_tier: 'starter' })
      setTimeout(() => setSavedId(null), 3000)
    } catch (err: any) {
      setError(err.message ?? 'Failed to create practice')
    } finally {
      setSaving(false)
    }
  }

  function handleProviderCreated(practiceId: string, newProvider: any) {
    setSavedProviders(prev => ({ ...prev, [practiceId]: [...(prev[practiceId] ?? []), newProvider] }))
    setExpandedProviderForm(null)
  }

  if (!provider?.is_super_admin) {
    return (
      <div className="p-10 flex items-center gap-3 text-[#791F1F] text-sm">
        <AlertCircle size={16} />
        Super admin access required
      </div>
    )
  }

  return (
    <div className="p-8 max-w-4xl">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="font-display text-2xl font-semibold text-[#1A1A2E]">Practices</h1>
          <p className="text-[13px] text-[#999] mt-0.5">Manage all practices on this platform</p>
        </div>
        <Button onClick={() => { setShowForm(v => !v); setError(null) }} size="sm">
          <Plus size={14} /> {showForm ? 'Cancel' : 'New practice'}
        </Button>
      </div>

      {showForm && (
        <form onSubmit={handleCreate} className="bg-white border border-[#E8E8E4] rounded-xl p-6 mb-6 shadow-sm">
          <h2 className="text-[14px] font-semibold text-[#1A1A2E] mb-4">New practice</h2>
          <div className="grid grid-cols-2 gap-4">
            <Input
              label="Practice name"
              value={form.name}
              onChange={e => setField('name', e.target.value)}
              placeholder="Pediatric House Calls"
              required
            />
            <Input
              label="Slug (unique URL key)"
              value={form.slug}
              onChange={e => setField('slug', e.target.value)}
              placeholder="pediatric-house-calls"
              required
            />
            <Input
              label="City"
              value={form.city}
              onChange={e => setField('city', e.target.value)}
              placeholder="Charlotte"
            />
            <Input
              label="State"
              value={form.state}
              onChange={e => setField('state', e.target.value)}
              placeholder="NC"
              maxLength={2}
            />
            <Input
              label="Phone"
              value={form.phone}
              onChange={e => setField('phone', e.target.value)}
              placeholder="7045550000"
            />
            <Input
              label="Email"
              type="email"
              value={form.email}
              onChange={e => setField('email', e.target.value)}
              placeholder="admin@example.com"
            />
            <div className="flex flex-col gap-1">
              <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider">Subscription tier</label>
              <select
                value={form.subscription_tier}
                onChange={e => setField('subscription_tier', e.target.value)}
                className="w-full px-3 py-2.5 rounded-lg border border-[#E8E8E4] bg-white text-sm text-[#1A1A2E] outline-none focus:border-[#7F77DD] focus:ring-2 focus:ring-[#7F77DD]/10 transition-all"
              >
                {TIERS.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
          </div>
          {error && (
            <div className="mt-4 flex items-center gap-2 text-[#791F1F] text-sm bg-[#FCEBEB] border border-[#F09595] rounded-lg px-3 py-2">
              <AlertCircle size={14} />
              {error}
            </div>
          )}
          <div className="mt-5 flex justify-end gap-3">
            <Button type="button" variant="secondary" size="sm" onClick={() => { setShowForm(false); setError(null) }}>
              Cancel
            </Button>
            <Button type="submit" size="sm" loading={saving}>
              Create practice
            </Button>
          </div>
        </form>
      )}

      {loading ? (
        <div className="text-[13px] text-[#999]">Loading practices…</div>
      ) : practices.length === 0 ? (
        <div className="text-[13px] text-[#999]">No practices yet.</div>
      ) : (
        <div className="space-y-3">
          {practices.map(p => (
            <div key={p.id} className="bg-white border border-[#E8E8E4] rounded-xl px-5 py-4 shadow-sm">
              <div className="flex items-center gap-4">
                <div className="w-9 h-9 rounded-lg bg-[#7F77DD]/10 flex items-center justify-center flex-shrink-0">
                  <Building2 size={18} className="text-[#7F77DD]" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-[14px] font-semibold text-[#1A1A2E]">{p.name}</span>
                    {savedId === p.id && <CheckCircle2 size={14} className="text-[#1D9E75]" />}
                    {!p.is_active && (
                      <span className="text-[11px] font-medium bg-[#F1EFE8] text-[#888] px-2 py-0.5 rounded-full">inactive</span>
                    )}
                  </div>
                  <div className="text-[12px] text-[#999] mt-0.5">
                    slug: <span className="font-mono">{p.slug}</span>
                    {(p.city || p.state) && ` · ${[p.city, p.state].filter(Boolean).join(', ')}`}
                    {p.email && ` · ${p.email}`}
                  </div>
                </div>
                <div className="flex items-center gap-3 flex-shrink-0">
                  <div className="text-right">
                    <span className="text-[11px] font-medium bg-[#7F77DD]/10 text-[#7F77DD] px-2.5 py-1 rounded-full">
                      {p.subscription_tier}
                    </span>
                    <div className="text-[11px] text-[#bbb] mt-1">
                      {new Date(p.created_at).toLocaleDateString()}
                    </div>
                  </div>
                  <button
                    onClick={() => setExpandedProviderForm(prev => prev === p.id ? null : p.id)}
                    className="flex items-center gap-1.5 text-[12px] text-[#7F77DD] font-medium border border-[#7F77DD]/30 rounded-lg px-3 py-1.5 hover:bg-[#7F77DD]/8 transition-all"
                  >
                    <UserPlus size={13} />
                    Add provider
                    {expandedProviderForm === p.id ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                  </button>
                </div>
              </div>

              {savedProviders[p.id]?.length > 0 && (
                <div className="mt-3 pt-3 border-t border-[#E8E8E4] space-y-1">
                  {savedProviders[p.id].map((prov: any) => (
                    <div key={prov.id} className="flex items-center gap-2 text-[13px] text-[#555]">
                      <CheckCircle2 size={13} className="text-[#1D9E75] flex-shrink-0" />
                      <span className="font-medium">{prov.name}</span>
                      <span className="text-[#bbb]">·</span>
                      <span className="text-[#999]">{prov.role}</span>
                      <span className="text-[#bbb]">·</span>
                      <span className="text-[#999]">invite sent</span>
                    </div>
                  ))}
                </div>
              )}

              {expandedProviderForm === p.id && (
                <ProviderForm
                  practiceId={p.id}
                  onDone={newProvider => handleProviderCreated(p.id, newProvider)}
                />
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
