import { useEffect, useState } from 'react'
import { Plus, Building2, CheckCircle, AlertCircle, ChevronDown, ChevronUp } from 'lucide-react'
import { Button } from '../../components/ui/Button'
import { Input } from '../../components/ui/Input'
import { getPractices, createPractice } from '../../lib/api'

interface Practice {
  id: string
  name: string
  slug: string
  city: string | null
  state: string | null
  subscription_tier: string
  is_active: boolean
  created_at: string
}

function slugify(name: string) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

export function AdminProvision() {
  const [practices, setPractices] = useState<Practice[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null)
  const [expandedId, setExpandedId] = useState<string | null>(null)

  const [form, setForm] = useState({
    name: '',
    slug: '',
    city: '',
    state: '',
    subscription_tier: 'starter',
    admin_name: '',
    admin_email: '',
  })

  async function load() {
    setLoading(true)
    try {
      const data = await getPractices()
      setPractices(data)
    } catch {}
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  function setField(key: keyof typeof form, value: string) {
    setForm(prev => {
      const next = { ...prev, [key]: value }
      if (key === 'name') next.slug = slugify(value)
      return next
    })
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSubmitting(true)
    setResult(null)
    try {
      await createPractice(form)
      setResult({ ok: true, message: `Practice "${form.name}" created. An invite email has been sent to ${form.admin_email} with their temporary login credentials.` })
      setForm({ name: '', slug: '', city: '', state: '', subscription_tier: 'starter', admin_name: '', admin_email: '' })
      setShowForm(false)
      await load()
    } catch (e: any) {
      setResult({ ok: false, message: e.message || 'Failed to create practice.' })
    } finally {
      setSubmitting(false)
    }
  }

  const TIERS = ['starter', 'launch', 'growth', 'owner']
  const TIER_LABEL: Record<string, string> = {
    starter: 'Starter — $199/mo',
    launch: 'Launch — $349/mo',
    growth: 'Growth — $499/mo',
    owner: 'Owner (Pediatric House Calls)',
  }

  return (
    <div className="p-8 max-w-3xl">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="font-display text-[22px] font-medium text-[#1A1A2E]">Practice Provisioning</h1>
          <p className="text-[13px] text-[#999] mt-0.5">Create and manage Roam client practices</p>
        </div>
        <Button variant="teal" size="sm" onClick={() => { setShowForm(s => !s); setResult(null) }}>
          <Plus size={14} className="mr-1.5" /> New practice
        </Button>
      </div>

      {/* Result banner */}
      {result && (
        <div className={`mb-5 p-4 rounded-xl flex items-start gap-3 text-[13px] ${result.ok ? 'bg-[#E1F5EE] text-[#085041]' : 'bg-[#FEE2E2] text-[#7F1D1D]'}`}>
          {result.ok ? <CheckCircle size={16} className="flex-shrink-0 mt-0.5" /> : <AlertCircle size={16} className="flex-shrink-0 mt-0.5" />}
          {result.message}
        </div>
      )}

      {/* Create form */}
      {showForm && (
        <form onSubmit={handleSubmit} className="bg-white border border-[#E8E8E4] rounded-xl p-6 mb-6 space-y-5">
          <div className="text-[13px] font-semibold text-[#1A1A2E] mb-1">Practice details</div>
          <div className="grid grid-cols-2 gap-4">
            <div className="col-span-2">
              <label className="text-[11px] text-[#555] block mb-1">Practice name</label>
              <Input value={form.name} onChange={e => setField('name', e.target.value)} placeholder="Denver Pediatric House Calls" required />
            </div>
            <div>
              <label className="text-[11px] text-[#555] block mb-1">URL slug</label>
              <div className="flex items-center gap-1">
                <span className="text-[12px] text-[#999]">roam.health/</span>
                <Input value={form.slug} onChange={e => setField('slug', e.target.value)} placeholder="denver-pediatrics" required className="flex-1" />
              </div>
            </div>
            <div>
              <label className="text-[11px] text-[#555] block mb-1">Subscription tier</label>
              <select value={form.subscription_tier} onChange={e => setField('subscription_tier', e.target.value)}
                className="w-full px-3 py-2 border border-[#E8E8E4] rounded-lg text-[13px] bg-white outline-none focus:border-[#7F77DD]">
                {TIERS.map(t => <option key={t} value={t}>{TIER_LABEL[t]}</option>)}
              </select>
            </div>
            <div>
              <label className="text-[11px] text-[#555] block mb-1">City</label>
              <Input value={form.city} onChange={e => setField('city', e.target.value)} placeholder="Denver" />
            </div>
            <div>
              <label className="text-[11px] text-[#555] block mb-1">State</label>
              <Input value={form.state} onChange={e => setField('state', e.target.value)} placeholder="CO" maxLength={2} />
            </div>
          </div>

          <div className="border-t border-[#F1EFE8] pt-4">
            <div className="text-[13px] font-semibold text-[#1A1A2E] mb-3">First admin account</div>
            <p className="text-[12px] text-[#999] mb-3">This person will receive an email with temporary login credentials and be the admin for this practice.</p>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="text-[11px] text-[#555] block mb-1">Full name</label>
                <Input value={form.admin_name} onChange={e => setField('admin_name', e.target.value)} placeholder="Dr. Jane Smith" required />
              </div>
              <div>
                <label className="text-[11px] text-[#555] block mb-1">Email address</label>
                <Input type="email" value={form.admin_email} onChange={e => setField('admin_email', e.target.value)} placeholder="jane@denverpediatrics.com" required />
              </div>
            </div>
          </div>

          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="secondary" onClick={() => setShowForm(false)}>Cancel</Button>
            <Button type="submit" variant="teal" loading={submitting}>Create practice &amp; send invite</Button>
          </div>
        </form>
      )}

      {/* Practices list */}
      {loading ? (
        <div className="text-[#999] text-[13px] py-12 text-center">Loading…</div>
      ) : practices.length === 0 ? (
        <div className="text-center py-12 text-[#999] text-[13px]">No practices yet.</div>
      ) : (
        <div className="space-y-2">
          {practices.map(p => (
            <div key={p.id} className="bg-white border border-[#E8E8E4] rounded-xl overflow-hidden">
              <button className="w-full flex items-center justify-between px-5 py-4 text-left hover:bg-[#FAFAF8] transition-colors"
                onClick={() => setExpandedId(expandedId === p.id ? null : p.id)}>
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-lg bg-[#EEEDFE] flex items-center justify-center flex-shrink-0">
                    <Building2 size={15} className="text-[#7F77DD]" />
                  </div>
                  <div>
                    <div className="text-[14px] font-medium text-[#1A1A2E]">{p.name}</div>
                    <div className="text-[12px] text-[#999] mt-0.5">
                      roam.health/{p.slug}
                      {p.city && ` · ${p.city}${p.state ? `, ${p.state}` : ''}`}
                      {` · ${TIER_LABEL[p.subscription_tier] ?? p.subscription_tier}`}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <span className={`text-[11px] px-2 py-0.5 rounded-full font-medium ${p.is_active ? 'bg-[#E1F5EE] text-[#085041]' : 'bg-[#F1EFE8] text-[#999]'}`}>
                    {p.is_active ? 'Active' : 'Inactive'}
                  </span>
                  {expandedId === p.id ? <ChevronUp size={14} className="text-[#999]" /> : <ChevronDown size={14} className="text-[#999]" />}
                </div>
              </button>
              {expandedId === p.id && (
                <div className="px-5 pb-4 border-t border-[#F1EFE8] pt-4 grid grid-cols-2 gap-x-6 gap-y-1.5 text-[13px]">
                  <div><span className="text-[#999]">Practice ID: </span><span className="font-mono text-[11px] text-[#555]">{p.id}</span></div>
                  <div><span className="text-[#999]">Created: </span>{new Date(p.created_at).toLocaleDateString()}</div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
