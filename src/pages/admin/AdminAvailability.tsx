import { useEffect, useState } from 'react'
import { format, parseISO } from 'date-fns'
import { getProviders, getAvailability } from '../../lib/api'

function fmt24to12(t: string) {
  const [h, m] = t.split(':').map(Number)
  const ampm = h >= 12 ? 'PM' : 'AM'
  return `${h % 12 || 12}:${m.toString().padStart(2, '0')} ${ampm}`
}

interface Provider { id: string; name: string; role: string; initials: string; avatar_color: string; avatar_text_color: string }

interface ProviderAvail {
  provider: Provider
  overrides: { date: string; is_available: boolean; start_time: string | null; end_time: string | null; note: string | null }[]
}

export function AdminAvailability() {
  const [rows, setRows] = useState<ProviderAvail[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    async function load() {
      try {
        const providers: Provider[] = await getProviders({ exclude_admin: 'true' }) as any
        const results = await Promise.all(
          providers.map(async p => {
            const avail = await getAvailability(p.id).catch(() => ({ overrides: [] }))
            const n = new Date()
            const today = `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`
            const upcoming = ((avail.overrides ?? []) as any[])
              .map((o: any) => ({ ...o, date: (o.date as string).split('T')[0] }))
              .filter((o: any) => o.date >= today)
              .sort((a: any, b: any) => a.date.localeCompare(b.date))
              .slice(0, 10)
            return { provider: p, overrides: upcoming }
          })
        )
        setRows(results)
      } catch (e: any) {
        setError(e?.message ?? 'Failed to load')
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [])

  if (loading) return <div className="p-8 text-[#999] text-[13px]">Loading…</div>
  if (error) return <div className="p-8 text-[#791F1F] text-[13px]">{error}</div>

  return (
    <div>
      <div className="bg-white border-b border-[#E8E8E4] px-6 py-4 sticky top-0 z-10">
        <div className="font-display text-[18px] font-medium text-[#1A1A2E]">Provider availability</div>
        <div className="text-[12px] text-[#999] mt-0.5">Upcoming date-specific availability for all providers</div>
      </div>

      <div className="p-6 space-y-4 max-w-5xl">
        {rows.length === 0 && <p className="text-[13px] text-[#999]">No providers found.</p>}
        {rows.map(({ provider: p, overrides }) => {
          const upcoming = overrides.slice(0, 10)
          return (
            <div key={p.id} className="bg-white border border-[#E8E8E4] rounded-xl p-5 shadow-sm">
              <div className="flex items-center gap-3 mb-4">
                <div className="w-9 h-9 rounded-full flex items-center justify-center text-[12px] font-semibold flex-shrink-0"
                  style={{ background: p.avatar_color || '#EEEDFE', color: p.avatar_text_color || '#3C3489' }}>
                  {p.initials}
                </div>
                <div>
                  <div className="font-medium text-[15px] text-[#1A1A2E]">{p.name}</div>
                  <div className="text-[11px] text-[#999] uppercase tracking-wider">{p.role}</div>
                </div>
              </div>

              {upcoming.length > 0 && (
                <div className="border-t border-[#E8E8E4] pt-3">
                  <p className="text-[11px] font-semibold text-[#555] uppercase tracking-wider mb-2">Upcoming schedule changes</p>
                  <div className="space-y-1.5">
                    {upcoming.map((o, i) => (
                      <div key={i} className={`flex items-center gap-3 px-3 py-2 rounded-lg text-[12px] ${o.is_available ? 'bg-[#E1F5EE] text-[#085041]' : 'bg-[#FCEBEB] text-[#791F1F]'}`}>
                        <span className="font-semibold whitespace-nowrap">{format(parseISO(o.date), 'EEE, MMM d')}</span>
                        <span>
                          {o.is_available
                            ? (o.start_time && o.end_time ? `${fmt24to12(o.start_time)} – ${fmt24to12(o.end_time)}` : 'Available')
                            : 'Unavailable'}
                        </span>
                        {o.note && <span className="text-[11px] opacity-70 italic">{o.note}</span>}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
