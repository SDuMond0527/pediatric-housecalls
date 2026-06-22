import { useEffect, useState } from 'react'
import { Phone, Mail, AlertCircle } from 'lucide-react'
import { getProviders } from '../../lib/api'
import { Badge } from '../../components/ui/Badge'
import type { Provider } from '../../types'

type ProviderWithContact = Provider & { phone?: string | null; email?: string | null }

const ROLE_COLORS: Record<string, 'purple' | 'teal' | 'amber' | 'blue' | 'gray'> = {
  MD: 'purple', PNP: 'teal', CMA: 'amber', RN: 'blue', admin: 'gray',
}

const ROLE_LABELS: Record<string, string> = {
  MD: 'Physicians', PNP: 'Nurse Practitioners', CMA: 'CMAs', RN: 'RNs', admin: 'Admin',
}

export function AdminProviders() {
  const [providers, setProviders] = useState<ProviderWithContact[]>([])

  useEffect(() => {
    async function load() {
      const data = await getProviders().catch(() => null)
      if (!data) return
      setProviders(data as ProviderWithContact[])
    }
    load()
  }, [])

  const byRole = ['MD', 'PNP', 'CMA', 'RN', 'admin'].map(role => ({
    role,
    providers: providers.filter(p => p.role === role),
  })).filter(g => g.providers.length > 0)

  const missingContact = providers.filter(p => !p.phone || !p.email)

  return (
    <div>
      <div className="bg-white border-b border-[#E8E8E4] px-6 py-4 sticky top-0 z-10">
        <div className="font-display text-[18px] font-medium text-[#1A1A2E]">Providers</div>
        <div className="text-[12px] text-[#999] mt-0.5">
          Broadcast alerts go to all active providers and all admins via text + email.
        </div>
      </div>

      <div className="p-6 space-y-6 max-w-3xl">
        {missingContact.length > 0 && (
          <div className="flex items-start gap-2 bg-[#FAEEDA] border border-[#FAC775] rounded-lg px-4 py-3 text-[13px] text-[#633806]">
            <AlertCircle size={14} className="flex-shrink-0 mt-0.5" />
            <span>
              <strong>{missingContact.length} {missingContact.length === 1 ? 'person is' : 'people are'} missing a phone or email</strong> and won't receive broadcast alerts until updated:{' '}
              {missingContact.map(p => p.name).join(', ')}
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
              {providers.map(p => (
                <div key={p.id} className="bg-white border border-[#E8E8E4] rounded-lg px-4 py-3 flex items-start gap-3">
                  <div className="w-8 h-8 rounded-full flex items-center justify-center text-[11px] font-medium flex-shrink-0 mt-0.5"
                    style={{ background: p.avatar_color, color: p.avatar_text_color }}>
                    {p.initials}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-[14px] font-medium text-[#1A1A2E]">{p.name}</span>
                      {p.states.map(s => <Badge key={s} variant="gray">{s}</Badge>)}
                      <div className={`w-2 h-2 rounded-full flex-shrink-0 ${p.is_active ? 'bg-[#1D9E75]' : 'bg-[#D0D0CC]'}`}
                        title={p.is_active ? 'Active' : 'Inactive'} />
                    </div>
                    <div className="mt-1.5 space-y-0.5">
                      <div className="flex items-center gap-1.5 text-[12px]">
                        <Phone size={10} className={p.phone ? 'text-[#1D9E75]' : 'text-[#D0D0CC]'} />
                        <span className={p.phone ? 'text-[#555]' : 'text-[#D0D0CC]'}>
                          {p.phone || 'No phone — won\'t receive texts'}
                        </span>
                      </div>
                      <div className="flex items-center gap-1.5 text-[12px]">
                        <Mail size={10} className={p.email ? 'text-[#7F77DD]' : 'text-[#D0D0CC]'} />
                        <span className={p.email ? 'text-[#555]' : 'text-[#D0D0CC]'}>
                          {p.email || 'No email — won\'t receive emails'}
                        </span>
                      </div>
                    </div>
                    {p.zones.length > 0 && (
                      <div className="text-[11px] text-[#999] mt-1 truncate">{p.zones.join(' · ')}</div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
