import { useEffect, useState } from 'react'
import { MapPin, Trash2 } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import { Badge } from '../../components/ui/Badge'
import { Button } from '../../components/ui/Button'
import { format } from 'date-fns'
import type { Broadcast } from '../../types'


export function AdminBroadcasts() {
  const [broadcasts, setBroadcasts] = useState<Broadcast[]>([])
  const [loading, setLoading] = useState(true)

  async function fetchBroadcasts() {
    const { data } = await supabase.from('broadcasts').select('*').order('is_urgent', { ascending: false }).order('created_at')
    setBroadcasts((data ?? []) as Broadcast[])
    setLoading(false)
  }

  useEffect(() => { fetchBroadcasts() }, [])

  async function remove(id: string) {
    await supabase.from('broadcasts').delete().eq('id', id)
    setBroadcasts(prev => prev.filter(b => b.id !== id))
  }

  async function toggleOpen(b: Broadcast) {
    await supabase.from('broadcasts').update({ is_open: !b.is_open }).eq('id', b.id)
    setBroadcasts(prev => prev.map(bc => bc.id === b.id ? { ...bc, is_open: !bc.is_open } : bc))
  }

  const open = broadcasts.filter(b => b.is_open)
  const closed = broadcasts.filter(b => !b.is_open)

  return (
    <div>
      <div className="bg-white border-b border-[#E8E8E4] px-6 py-4 flex items-center justify-between sticky top-0 z-10">
        <div>
          <div className="font-display text-[18px] font-medium text-[#1A1A2E]">Broadcasts</div>
          <div className="text-[12px] text-[#999] mt-0.5">Providers create broadcasts from their portal</div>
        </div>
        <Badge variant="amber">{open.length} open</Badge>
      </div>

      <div className="p-6 max-w-2xl space-y-6">
        <div>
          <div className="text-[11px] font-medium text-[#999] uppercase tracking-wider mb-3">Open requests</div>
          {!loading && open.length === 0 && (
            <div className="text-[13px] text-[#999] py-4">No open broadcasts.</div>
          )}
          <div className="space-y-3">
            {open.map(bc => (
              <div key={bc.id} className={`border rounded-xl p-4 ${bc.is_urgent ? 'border-[#FAC775] bg-[#FAEEDA]' : 'border-[#E8E8E4] bg-white'}`}>
                <div className="flex items-start justify-between gap-2 mb-2">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap mb-1">
                      <span className="font-display text-[14px] font-medium text-[#1A1A2E]">
                        {bc.patient_first_name} {bc.patient_last_name}
                      </span>
                      {bc.is_urgent && <Badge variant="red">Urgent</Badge>}
                      <Badge variant="purple">{bc.request_type}</Badge>
                    </div>
                    <div className="space-y-0.5 text-[12px] text-[#555]">
                      {bc.patient_dob && <p>DOB: {bc.patient_dob}</p>}
                      {bc.patient_address && (
                        <p className="flex items-center gap-1"><MapPin size={11} />{bc.patient_address}</p>
                      )}
                      {bc.complaint && <p><strong>Complaint:</strong> {bc.complaint}</p>}
                      {bc.created_by_name && (
                        <p className="text-[#999]">Sent by {bc.created_by_name} · {format(new Date(bc.created_at), 'MMM d, h:mm a')}</p>
                      )}
                    </div>
                  </div>
                  <div className="flex gap-1.5 flex-shrink-0">
                    <Button variant="secondary" size="xs" onClick={() => toggleOpen(bc)}>Close</Button>
                    <button onClick={() => remove(bc.id)} className="p-1.5 rounded-lg hover:bg-[#FCEBEB] text-[#999] hover:text-[#791F1F] transition-colors">
                      <Trash2 size={13} />
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {closed.length > 0 && (
          <div>
            <div className="text-[11px] font-medium text-[#999] uppercase tracking-wider mb-3">Closed / accepted</div>
            <div className="space-y-2">
              {closed.map(bc => (
                <div key={bc.id} className="border border-[#E8E8E4] rounded-lg px-4 py-2.5 flex items-center gap-3 bg-white opacity-60">
                  <span className="text-[13px] font-medium text-[#1A1A2E] flex-1">
                    {bc.patient_first_name} {bc.patient_last_name} · {bc.request_type}
                  </span>
                  <Badge variant="gray">Closed</Badge>
                  <Button variant="secondary" size="xs" onClick={() => toggleOpen(bc)}>Reopen</Button>
                  <button onClick={() => remove(bc.id)} className="p-1 rounded hover:bg-[#FCEBEB] text-[#999] hover:text-[#791F1F]">
                    <Trash2 size={12} />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
