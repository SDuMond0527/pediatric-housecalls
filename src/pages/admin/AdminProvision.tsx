import { useEffect, useState, type FormEvent } from 'react'
import { Building2, Plus, CheckCircle2, AlertCircle, UserPlus, ChevronDown, ChevronUp, Map, Trash2, ListChecks } from 'lucide-react'
import { useAuth } from '../../contexts/AuthContext'
import { getPractices, createPractice, createProviderForPractice, getPracticeZones, upsertPracticeZone, updatePracticeZone, deletePracticeZone, getPracticeVisitTypes, upsertPracticeVisitType, deletePracticeVisitType } from '../../lib/api'
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

function ZonePanel({ practiceId, practiceName }: { practiceId: string; practiceName: string }) {
  const [zones, setZones] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [form, setForm] = useState({ zone_name: '', state: '', zips: '', is_waitlist_only: false })
  const [editingId, setEditingId] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    getPracticeZones(practiceId)
      .then(setZones)
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [practiceId])

  function startEdit(zone: any) {
    setEditingId(zone.id)
    setForm({
      zone_name: zone.zone_name,
      state: zone.state || '',
      zips: (zone.zips || []).join(', '),
      is_waitlist_only: zone.is_waitlist_only || false,
    })
    setError(null)
  }

  function cancelEdit() {
    setEditingId(null)
    setForm({ zone_name: '', state: '', zips: '', is_waitlist_only: false })
    setError(null)
  }

  async function handleSave(e: FormEvent) {
    e.preventDefault()
    if (!form.zone_name) return
    setSaving(true)
    setError(null)
    try {
      const zips = form.zips.split(/[\s,]+/).map(z => z.trim()).filter(Boolean)
      let zone: any
      if (editingId) {
        zone = await updatePracticeZone(editingId, {
          zone_name: form.zone_name,
          state: form.state || null,
          zips,
          is_waitlist_only: form.is_waitlist_only,
        })
        setZones(prev => prev.map(z => z.id === editingId ? zone : z))
        setEditingId(null)
      } else {
        zone = await upsertPracticeZone({
          zone_name: form.zone_name,
          state: form.state || null,
          zips,
          is_waitlist_only: form.is_waitlist_only,
          practice_id: practiceId,
        })
        setZones(prev => {
          const idx = prev.findIndex(z => z.id === zone.id)
          return idx >= 0 ? prev.map((z, i) => i === idx ? zone : z) : [...prev, zone]
        })
      }
      setForm({ zone_name: '', state: '', zips: '', is_waitlist_only: false })
    } catch (err: any) {
      setError(err.message ?? 'Failed to save zone')
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete(id: string) {
    await deletePracticeZone(id).catch(() => {})
    setZones(prev => prev.filter(z => z.id !== id))
  }

  return (
    <div className="mt-3 pt-3 border-t border-[#E8E8E4]">
      <div className="text-[11px] font-semibold text-[#7F77DD] uppercase tracking-wider mb-2">
        Service zones — {practiceName}
      </div>
      {loading ? (
        <div className="text-[12px] text-[#999]">Loading zones…</div>
      ) : zones.length === 0 ? (
        <div className="text-[12px] text-[#999] mb-3">No zones defined yet.</div>
      ) : (
        <div className="space-y-1.5 mb-3">
          {zones.map(z => (
            <div key={z.id} className={`flex items-center gap-2 text-[13px] text-[#555] border rounded-lg px-3 py-2 ${editingId === z.id ? 'bg-[#F7F6FF] border-[#7F77DD]' : 'bg-[#FAFAF8] border-[#E8E8E4]'}`}>
              <div className="flex-1 min-w-0">
                <span className="font-medium text-[#1A1A2E]">{z.zone_name}</span>
                {z.state && <span className="text-[#999] ml-1.5">· {z.state}</span>}
                <span className="text-[#bbb] ml-1.5">· {(z.zips || []).length} ZIP{(z.zips || []).length !== 1 ? 's' : ''}</span>
                {z.is_waitlist_only && (
                  <span className="ml-1.5 text-[10px] font-medium bg-[#FAEEDA] text-[#633806] px-1.5 py-0.5 rounded-full">waitlist</span>
                )}
              </div>
              <button onClick={() => editingId === z.id ? cancelEdit() : startEdit(z)}
                className="p-1 text-[#999] hover:text-[#7F77DD] hover:bg-[#F0EFFE] rounded transition-colors flex-shrink-0 text-[11px] font-medium px-2">
                {editingId === z.id ? 'Cancel' : 'Edit'}
              </button>
              <button onClick={() => handleDelete(z.id)}
                className="p-1 text-[#999] hover:text-[#791F1F] hover:bg-[#FCEBEB] rounded transition-colors flex-shrink-0">
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </div>
      )}

      <form onSubmit={handleSave} className="bg-[#F7F6FF] border border-[#AFA9EC] rounded-lg p-3 space-y-2">
        <div className="text-[11px] font-semibold text-[#555] uppercase tracking-wider">{editingId ? 'Edit zone' : 'Add zone'}</div>
        <div className="grid grid-cols-2 gap-2">
          <Input label="Zone name" value={form.zone_name}
            onChange={e => setForm(f => ({ ...f, zone_name: e.target.value }))}
            placeholder="e.g. SouthPark" required />
          <Input label="State (2-char)" value={form.state} maxLength={2}
            onChange={e => setForm(f => ({ ...f, state: e.target.value.toUpperCase() }))}
            placeholder="NC" />
        </div>
        <div>
          <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-1">ZIP codes</label>
          <textarea value={form.zips}
            onChange={e => setForm(f => ({ ...f, zips: e.target.value }))}
            placeholder="28078, 28036, 28031"
            rows={2}
            className="w-full px-3 py-2 border border-[#E8E8E4] rounded-lg text-[13px] font-sans resize-none outline-none focus:border-[#7F77DD] bg-white" />
        </div>
        <label className="flex items-center gap-2 text-[13px] text-[#555] cursor-pointer">
          <input type="checkbox" checked={form.is_waitlist_only}
            onChange={e => setForm(f => ({ ...f, is_waitlist_only: e.target.checked }))}
            className="w-4 h-4 accent-[#7F77DD]" />
          Waitlist only
        </label>
        {error && (
          <div className="flex items-center gap-2 text-[#791F1F] text-[12px] bg-[#FCEBEB] border border-[#F09595] rounded-lg px-3 py-2">
            <AlertCircle size={13} />
            {error}
          </div>
        )}
        <div className="flex justify-end gap-2">
          {editingId && (
            <Button type="button" size="sm" variant="secondary" onClick={cancelEdit}>Cancel</Button>
          )}
          <Button type="submit" size="sm" loading={saving}>{editingId ? 'Update zone' : 'Save zone'}</Button>
        </div>
      </form>
    </div>
  )
}

function VisitTypePanel({ practiceId, practiceName }: { practiceId: string; practiceName: string }) {
  const [visitTypes, setVisitTypes] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [form, setForm] = useState({
    visit_type: '', badge_label: '', badge_color: '#EEEDFE', badge_text_color: '#3C3489',
    base_price: '', duration_minutes: '60', lead_minutes: '60',
    has_convenience_fee: true, per_child_extra_minutes: '0',
    is_in_home: true, is_cpr: false, sort_order: '0',
  })

  useEffect(() => {
    getPracticeVisitTypes(practiceId).then(setVisitTypes).catch(() => {}).finally(() => setLoading(false))
  }, [practiceId])

  async function handleSave(e: FormEvent) {
    e.preventDefault()
    if (!form.visit_type) return
    setSaving(true); setError(null)
    try {
      const row = await upsertPracticeVisitType({
        practice_id: practiceId,
        visit_type: form.visit_type,
        badge_label: form.badge_label || null,
        badge_color: form.badge_color,
        badge_text_color: form.badge_text_color,
        base_price: form.base_price ? parseFloat(form.base_price) : null,
        duration_minutes: parseInt(form.duration_minutes) || 60,
        lead_minutes: parseInt(form.lead_minutes) || 60,
        has_convenience_fee: form.has_convenience_fee,
        per_child_extra_minutes: parseInt(form.per_child_extra_minutes) || 0,
        is_in_home: form.is_in_home,
        is_cpr: form.is_cpr,
        sort_order: parseInt(form.sort_order) || 0,
      })
      setVisitTypes(prev => {
        const idx = prev.findIndex(v => v.id === row.id)
        return idx >= 0 ? prev.map((v, i) => i === idx ? row : v) : [...prev, row]
      })
      setForm({ visit_type: '', badge_label: '', badge_color: '#EEEDFE', badge_text_color: '#3C3489',
        base_price: '', duration_minutes: '60', lead_minutes: '60',
        has_convenience_fee: true, per_child_extra_minutes: '0', is_in_home: true, is_cpr: false, sort_order: '0' })
    } catch (err: any) {
      setError(err.message ?? 'Failed to save visit type')
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete(id: string) {
    await deletePracticeVisitType(id).catch(() => {})
    setVisitTypes(prev => prev.filter(v => v.id !== id))
  }

  return (
    <div className="mt-3 pt-3 border-t border-[#E8E8E4]">
      <div className="text-[11px] font-semibold text-[#7F77DD] uppercase tracking-wider mb-2">
        Visit types — {practiceName}
      </div>
      {loading ? (
        <div className="text-[12px] text-[#999]">Loading…</div>
      ) : visitTypes.length === 0 ? (
        <div className="text-[12px] text-[#999] mb-3">No visit types defined yet.</div>
      ) : (
        <div className="space-y-1.5 mb-3">
          {visitTypes.map(v => (
            <div key={v.id} className="flex items-center gap-2 text-[13px] text-[#555] bg-[#FAFAF8] border border-[#E8E8E4] rounded-lg px-3 py-2">
              <div className="flex-1 min-w-0">
                <span
                  className="text-[11px] font-medium px-2 py-0.5 rounded-full mr-2"
                  style={{ background: v.badge_color, color: v.badge_text_color }}
                >
                  {v.badge_label || v.visit_type}
                </span>
                <span className="font-medium text-[#1A1A2E]">{v.visit_type}</span>
                {v.base_price && <span className="text-[#999] ml-1.5">· ${v.base_price}</span>}
                <span className="text-[#bbb] ml-1.5">· {v.duration_minutes}min</span>
                {!v.is_active && <span className="ml-1.5 text-[10px] font-medium bg-[#F5F5F3] text-[#999] px-1.5 py-0.5 rounded-full">inactive</span>}
              </div>
              <button onClick={() => handleDelete(v.id)}
                className="p-1 text-[#999] hover:text-[#791F1F] hover:bg-[#FCEBEB] rounded transition-colors flex-shrink-0">
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </div>
      )}

      <form onSubmit={handleSave} className="bg-[#F7F6FF] border border-[#AFA9EC] rounded-lg p-3 space-y-2">
        <div className="text-[11px] font-semibold text-[#555] uppercase tracking-wider">Add / update visit type</div>
        <div className="grid grid-cols-2 gap-2">
          <Input label="Visit type name" value={form.visit_type}
            onChange={e => setForm(f => ({ ...f, visit_type: e.target.value }))}
            placeholder="e.g. In-home sick visit" required />
          <Input label="Badge label (short)" value={form.badge_label}
            onChange={e => setForm(f => ({ ...f, badge_label: e.target.value }))}
            placeholder="e.g. Sick visit" />
        </div>
        <div className="grid grid-cols-3 gap-2">
          <Input label="Base price ($)" value={form.base_price} type="number"
            onChange={e => setForm(f => ({ ...f, base_price: e.target.value }))}
            placeholder="150" />
          <Input label="Duration (min)" value={form.duration_minutes} type="number"
            onChange={e => setForm(f => ({ ...f, duration_minutes: e.target.value }))}
            placeholder="60" />
          <Input label="Lead time (min)" value={form.lead_minutes} type="number"
            onChange={e => setForm(f => ({ ...f, lead_minutes: e.target.value }))}
            placeholder="60" />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-1">Badge color</label>
            <input type="color" value={form.badge_color}
              onChange={e => setForm(f => ({ ...f, badge_color: e.target.value }))}
              className="h-8 w-full rounded border border-[#E8E8E4] cursor-pointer" />
          </div>
          <div>
            <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-1">Badge text color</label>
            <input type="color" value={form.badge_text_color}
              onChange={e => setForm(f => ({ ...f, badge_text_color: e.target.value }))}
              className="h-8 w-full rounded border border-[#E8E8E4] cursor-pointer" />
          </div>
        </div>
        <div className="flex flex-wrap gap-3">
          <label className="flex items-center gap-2 text-[13px] text-[#555] cursor-pointer">
            <input type="checkbox" checked={form.has_convenience_fee}
              onChange={e => setForm(f => ({ ...f, has_convenience_fee: e.target.checked }))}
              className="w-4 h-4 accent-[#7F77DD]" />
            Convenience fee
          </label>
          <label className="flex items-center gap-2 text-[13px] text-[#555] cursor-pointer">
            <input type="checkbox" checked={form.is_in_home}
              onChange={e => setForm(f => ({ ...f, is_in_home: e.target.checked }))}
              className="w-4 h-4 accent-[#7F77DD]" />
            In-home visit
          </label>
          <label className="flex items-center gap-2 text-[13px] text-[#555] cursor-pointer">
            <input type="checkbox" checked={form.is_cpr}
              onChange={e => setForm(f => ({ ...f, is_cpr: e.target.checked }))}
              className="w-4 h-4 accent-[#7F77DD]" />
            CPR class
          </label>
        </div>
        {error && (
          <div className="flex items-center gap-2 text-[#791F1F] text-[12px] bg-[#FCEBEB] border border-[#F09595] rounded-lg px-3 py-2">
            <AlertCircle size={13} />{error}
          </div>
        )}
        <div className="flex justify-end">
          <Button type="submit" size="sm" loading={saving}>Save visit type</Button>
        </div>
      </form>
    </div>
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
  const [expandedZonePanel, setExpandedZonePanel] = useState<string | null>(null)
  const [expandedVisitTypePanel, setExpandedVisitTypePanel] = useState<string | null>(null)
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
                    onClick={() => setExpandedZonePanel(prev => prev === p.id ? null : p.id)}
                    className="flex items-center gap-1.5 text-[12px] text-[#1D9E75] font-medium border border-[#1D9E75]/30 rounded-lg px-3 py-1.5 hover:bg-[#1D9E75]/8 transition-all"
                  >
                    <Map size={13} />
                    Manage zones
                    {expandedZonePanel === p.id ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                  </button>
                  <button
                    onClick={() => setExpandedVisitTypePanel(prev => prev === p.id ? null : p.id)}
                    className="flex items-center gap-1.5 text-[12px] text-[#555] font-medium border border-[#E8E8E4] rounded-lg px-3 py-1.5 hover:bg-[#F7F6FF] transition-all"
                  >
                    <ListChecks size={13} />
                    Visit types
                    {expandedVisitTypePanel === p.id ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                  </button>
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

              {expandedZonePanel === p.id && (
                <ZonePanel practiceId={p.id} practiceName={p.name} />
              )}
              {expandedVisitTypePanel === p.id && (
                <VisitTypePanel practiceId={p.id} practiceName={p.name} />
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
