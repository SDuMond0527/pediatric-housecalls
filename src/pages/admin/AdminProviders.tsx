import { useEffect, useState } from 'react'
import { Phone, Mail, AlertCircle, MapPin, ChevronDown, ChevronUp, CheckCircle2 } from 'lucide-react'
import { getProviders, updateProvider } from '../../lib/api'
import { Badge } from '../../components/ui/Badge'
import { Button } from '../../components/ui/Button'
import { Input } from '../../components/ui/Input'
import type { Provider } from '../../types'

type ProviderWithContact = Provider & { phone?: string | null; email?: string | null; home_address?: string | null }

type ProviderEdit = { phone: string; email: string; home_address: string }

const ROLE_COLORS: Record<string, 'purple' | 'teal' | 'amber' | 'blue' | 'gray'> = {
  MD: 'purple', PNP: 'teal', CMA: 'amber', RN: 'blue', admin: 'gray',
}

const ROLE_LABELS: Record<string, string> = {
  MD: 'Physicians', PNP: 'Nurse Practitioners', CMA: 'CMAs', RN: 'RNs', admin: 'Admin',
}

export function AdminProviders() {
  const [providers, setProviders] = useState<ProviderWithContact[]>([])
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [edits, setEdits] = useState<Record<string, ProviderEdit>>({})
  const [savingId, setSavingId] = useState<string | null>(null)
  const [savedId, setSavedId] = useState<string | null>(null)

  useEffect(() => {
    getProviders().then(data => setProviders((data ?? []) as ProviderWithContact[])).catch(() => {})
  }, [])

  function getEdit(p: ProviderWithContact): ProviderEdit {
    return edits[p.id] ?? { phone: p.phone || '', email: p.email || '', home_address: (p as any).home_address || '' }
  }

  function setField(id: string, field: keyof ProviderEdit, value: string) {
    setEdits(prev => ({ ...prev, [id]: { ...getEdit(providers.find(p => p.id === id)!), ...prev[id], [field]: value } }))
  }

  async function save(p: ProviderWithContact) {
    const edit = getEdit(p)
    setSavingId(p.id)
    await updateProvider(p.id, {
      phone: edit.phone || null,
      email: edit.email || null,
      home_address: edit.home_address || null,
    }).catch(() => {})
    const data = await getProviders().catch(() => null)
    if (data) setProviders(data as ProviderWithContact[])
    setSavingId(null)
    setSavedId(p.id)
    setTimeout(() => setSavedId(null), 2500)
  }

  const byRole = ['MD', 'PNP', 'CMA', 'RN', 'admin'].map(role => ({
    role,
    providers: providers.filter(p => p.role === role),
  })).filter(g => g.providers.length > 0)

  const missingAddress = providers.filter(p => !(p as any).home_address)

  return (
    <div>
      <div className="bg-white border-b border-[#E8E8E4] px-6 py-4 sticky top-0 z-10">
        <div className="font-display text-[18px] font-medium text-[#1A1A2E]">Providers</div>
        <div className="text-[12px] text-[#999] mt-0.5">
          Set home addresses so convenience fees calculate correctly for the first appointment of the day.
        </div>
      </div>

      <div className="p-6 space-y-6 max-w-3xl">
        {missingAddress.length > 0 && (
          <div className="flex items-start gap-2 bg-[#FAEEDA] border border-[#FAC775] rounded-lg px-4 py-3 text-[13px] text-[#633806]">
            <AlertCircle size={14} className="flex-shrink-0 mt-0.5" />
            <span>
              <strong>{missingAddress.length} {missingAddress.length === 1 ? 'provider is' : 'providers are'} missing a home address</strong> — convenience fees won't calculate for their first appointment of the day:{' '}
              {missingAddress.map(p => p.name).join(', ')}
            </span>
          </div>
        )}

        {byRole.map(({ role, providers }) => (
          <div key={role}>
            <div className="flex items-center gap-2 mb-3">
              <Badge variant={ROLE_COLORS[role]}>{role}</Badge>
              <span className="text-[12px] text-[#999]">{ROLE_LABELS[role] || role} · {providers.length}</span>
            </div>
            <div className="space-y-2">
              {providers.map(p => {
                const isExpanded = expandedId === p.id
                const edit = getEdit(p)
                const isSaving = savingId === p.id
                const isSaved = savedId === p.id
                const ha = (p as any).home_address

                return (
                  <div key={p.id} className={`bg-white border rounded-lg overflow-hidden transition-all ${isExpanded ? 'border-[#7F77DD]' : 'border-[#E8E8E4]'}`}>
                    <button className="w-full px-4 py-3 flex items-start gap-3 text-left hover:bg-[#FAFAF8] transition-colors"
                      onClick={() => setExpandedId(isExpanded ? null : p.id)}>
                      <div className="w-8 h-8 rounded-full flex items-center justify-center text-[11px] font-medium flex-shrink-0 mt-0.5"
                        style={{ background: p.avatar_color, color: p.avatar_text_color }}>
                        {p.initials}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-[14px] font-medium text-[#1A1A2E]">{p.name}</span>
                          {(p.states ?? []).map(s => <Badge key={s} variant="gray">{s}</Badge>)}
                          <div className={`w-2 h-2 rounded-full flex-shrink-0 ${p.is_active ? 'bg-[#1D9E75]' : 'bg-[#D0D0CC]'}`} title={p.is_active ? 'Active' : 'Inactive'} />
                        </div>
                        <div className="mt-1 space-y-0.5">
                          <div className="flex items-center gap-1.5 text-[12px]">
                            <Phone size={10} className={p.phone ? 'text-[#1D9E75]' : 'text-[#D0D0CC]'} />
                            <span className={p.phone ? 'text-[#555]' : 'text-[#D0D0CC]'}>{p.phone || 'No phone'}</span>
                          </div>
                          <div className="flex items-center gap-1.5 text-[12px]">
                            <Mail size={10} className={p.email ? 'text-[#7F77DD]' : 'text-[#D0D0CC]'} />
                            <span className={p.email ? 'text-[#555]' : 'text-[#D0D0CC]'}>{p.email || 'No email'}</span>
                          </div>
                          <div className="flex items-center gap-1.5 text-[12px]">
                            <MapPin size={10} className={ha ? 'text-[#F5943A]' : 'text-[#D0D0CC]'} />
                            <span className={ha ? 'text-[#555]' : 'text-[#D0D0CC]'}>{ha || 'No home address — convenience fees may not calculate'}</span>
                          </div>
                        </div>
                        {(p.zones ?? []).length > 0 && (
                          <div className="text-[11px] text-[#999] mt-1 truncate">{(p.zones ?? []).join(' · ')}</div>
                        )}
                      </div>
                      {isExpanded ? <ChevronUp size={14} className="text-[#999] flex-shrink-0 mt-1" /> : <ChevronDown size={14} className="text-[#999] flex-shrink-0 mt-1" />}
                    </button>

                    {isExpanded && (
                      <div className="px-4 pb-4 border-t border-[#E8E8E4] pt-3 space-y-3">
                        <Input label="Phone number" placeholder="+1 (555) 000-0000"
                          value={edit.phone} onChange={e => setField(p.id, 'phone', e.target.value)} />
                        <Input label="Email address" placeholder="provider@example.com"
                          value={edit.email} onChange={e => setField(p.id, 'email', e.target.value)} />
                        <Input label="Home address (for convenience fee calculation)"
                          placeholder="e.g. 123 Main St, Charlotte, NC 28205"
                          value={edit.home_address} onChange={e => setField(p.id, 'home_address', e.target.value)} />
                        <div className="flex items-center gap-3">
                          <Button size="sm" loading={isSaving} onClick={() => save(p)}>Save</Button>
                          {isSaved && (
                            <span className="flex items-center gap-1 text-[13px] text-[#085041]">
                              <CheckCircle2 size={13} /> Saved
                            </span>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
