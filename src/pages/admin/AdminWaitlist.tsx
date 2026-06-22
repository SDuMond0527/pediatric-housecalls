import { useEffect, useState } from 'react'
import { Clock, CheckCircle2, Phone, XCircle } from 'lucide-react'
import { format } from 'date-fns'
import { getWaitlistEntries, updateWaitlistEntry, getFamiliesByIds } from '../../lib/api'
import { Badge } from '../../components/ui/Badge'
import { Button } from '../../components/ui/Button'

interface WaitlistEntry {
  id: string
  family_id: string
  visit_type: string | null
  zip: string
  state: string | null
  preferred_time_window: string | null
  notes: string | null
  status: 'waiting' | 'contacted' | 'converted' | 'removed'
  created_at: string
  family_email?: string
  family_name?: string
  family_phone?: string
  children?: string[]
}

const STATUS_COLORS = {
  waiting:   { variant: 'amber' as const,   label: 'Waiting' },
  contacted: { variant: 'blue' as const,    label: 'Contacted' },
  converted: { variant: 'teal' as const,    label: 'Converted' },
  removed:   { variant: 'gray' as const,  label: 'Removed' },
}

export function AdminWaitlist() {
  const [entries, setEntries] = useState<WaitlistEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<'waiting' | 'all'>('waiting')

  async function fetchEntries() {
    setLoading(true)
    const params: Record<string, string> = {}
    if (filter === 'waiting') params.status = 'waiting'

    const entries = await getWaitlistEntries(params).catch(() => null)
    if (!entries) { setLoading(false); return }

    const familyIds = [...new Set(entries.map(e => e.family_id))]
    const [families, kids] = await Promise.all([
      familyIds.length ? getFamiliesByIds(familyIds).catch(() => []) : Promise.resolve([]),
      familyIds.length
        ? fetch(`/api/children?family_ids=${familyIds.join(',')}`).then(r => r.json()).catch(() => [])
        : Promise.resolve([]),
    ])

    const enriched = entries.map(e => {
      const fam = (families as any[]).find(f => f.id === e.family_id)
      const childNames = (kids as any[]).filter(k => k.family_id === e.family_id).map((k: any) => k.display_label) || []
      return {
        ...e,
        family_email: fam?.email,
        family_name: fam?.display_name || fam?.email || 'Unknown family',
        family_phone: fam?.phone,
        children: childNames,
      }
    })

    setEntries(enriched as WaitlistEntry[])
    setLoading(false)
  }

  useEffect(() => { fetchEntries() }, [filter])

  async function updateStatus(id: string, status: WaitlistEntry['status']) {
    await updateWaitlistEntry(id, { status })
    fetchEntries()
  }

  const waitingCount = entries.filter(e => e.status === 'waiting').length

  return (
    <div>
      <div className="bg-white border-b border-[#E8E8E4] px-6 py-4 flex items-center justify-between sticky top-0 z-10">
        <div>
          <div className="font-display text-[18px] font-medium text-[#1A1A2E]">Waitlist</div>
          <div className="text-[12px] text-[#999] mt-0.5">Families waiting for an available appointment</div>
        </div>
        <div className="flex items-center gap-2">
          {filter === 'waiting' && waitingCount > 0 && <Badge variant="amber">{waitingCount} waiting</Badge>}
          <div className="flex gap-1 bg-[#FAFAF8] border border-[#E8E8E4] rounded-lg p-0.5">
            {(['waiting', 'all'] as const).map(f => (
              <button key={f} onClick={() => setFilter(f)}
                className={`px-3 py-1.5 rounded-md text-[12px] font-medium capitalize transition-colors ${filter === f ? 'bg-white shadow-sm text-[#1A1A2E]' : 'text-[#999] hover:text-[#555]'}`}>
                {f === 'waiting' ? 'Active' : 'All'}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="p-6 space-y-3 max-w-3xl">
        {!loading && entries.length === 0 && (
          <div className="text-center py-16 text-[#999] text-[14px]">No waitlist entries.</div>
        )}

        {entries.map(e => (
          <div key={e.id} className="bg-white border border-[#E8E8E4] rounded-xl p-5 shadow-sm">
            <div className="flex items-start justify-between gap-4">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap mb-1">
                  <span className="font-display text-[15px] font-medium text-[#1A1A2E]">
                    {e.family_name || 'Unknown family'}
                  </span>
                  <Badge variant={STATUS_COLORS[e.status].variant}>{STATUS_COLORS[e.status].label}</Badge>
                  {e.visit_type && <Badge variant="gray">{e.visit_type}</Badge>}
                </div>

                <div className="flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-[#999] mb-2">
                  <span>Zip {e.zip}{e.state && ` · ${e.state}`}</span>
                  {e.family_phone && (
                    <a href={`tel:${e.family_phone}`} className="flex items-center gap-1 hover:text-[#1A1A2E]">
                      <Phone size={11} /> {e.family_phone}
                    </a>
                  )}
                  {e.family_email && (
                    <a href={`mailto:${e.family_email}`} className="flex items-center gap-1 hover:text-[#1A1A2E]">
                      {e.family_email}
                    </a>
                  )}
                  {e.preferred_time_window && <span className="flex items-center gap-1"><Clock size={11} /> {e.preferred_time_window}</span>}
                  <span>{format(new Date(e.created_at), 'MMM d, yyyy')}</span>
                </div>

                {e.children && e.children.length > 0 && (
                  <p className="text-[12px] text-[#555] mb-1">Children: {e.children.join(', ')}</p>
                )}
                {e.notes && (
                  <p className="text-[12px] text-[#555] italic">{e.notes}</p>
                )}
              </div>

              {e.status === 'waiting' && (
                <div className="flex flex-col gap-1.5 flex-shrink-0">
                  <Button variant="secondary" size="xs" onClick={() => updateStatus(e.id, 'contacted')}>
                    <Phone size={11} /> Mark contacted
                  </Button>
                  <Button variant="teal" size="xs" onClick={() => updateStatus(e.id, 'converted')}>
                    <CheckCircle2 size={11} /> Converted
                  </Button>
                  <Button variant="danger" size="xs" onClick={() => updateStatus(e.id, 'removed')}>
                    <XCircle size={11} /> Remove
                  </Button>
                </div>
              )}

              {e.status === 'contacted' && (
                <div className="flex flex-col gap-1.5 flex-shrink-0">
                  <Button variant="teal" size="xs" onClick={() => updateStatus(e.id, 'converted')}>
                    <CheckCircle2 size={11} /> Converted
                  </Button>
                  <Button variant="danger" size="xs" onClick={() => updateStatus(e.id, 'removed')}>
                    <XCircle size={11} /> Remove
                  </Button>
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
