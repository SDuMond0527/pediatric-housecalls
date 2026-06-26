import { useEffect, useState, type FormEvent } from 'react'
import { Building2, Plus, CheckCircle2, AlertCircle } from 'lucide-react'
import { useAuth } from '../../contexts/AuthContext'
import { getPractices, createPractice } from '../../lib/api'
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

function slugify(name: string) {
  return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

export function AdminProvision() {
  const { provider } = useAuth()
  const [practices, setPractices] = useState<Practice[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [saving, setSaving] = useState(false)
  const [savedId, setSavedId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

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
            <div key={p.id} className="bg-white border border-[#E8E8E4] rounded-xl px-5 py-4 shadow-sm flex items-center gap-4">
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
              <div className="text-right flex-shrink-0">
                <span className="text-[11px] font-medium bg-[#7F77DD]/10 text-[#7F77DD] px-2.5 py-1 rounded-full">
                  {p.subscription_tier}
                </span>
                <div className="text-[11px] text-[#bbb] mt-1">
                  {new Date(p.created_at).toLocaleDateString()}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
