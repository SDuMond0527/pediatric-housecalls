import { useEffect, useState } from 'react'
import { MapPin, Clock, AlertCircle, Plus, X, AlertTriangle } from 'lucide-react'
import {
  getBroadcasts, createBroadcast, updateBroadcast,
  createAppointment, invokeNotifications,
} from '../lib/api'
import { useAuth } from '../contexts/AuthContext'
import { Badge } from '../components/ui/Badge'
import { Button } from '../components/ui/Button'
import { Input } from '../components/ui/Input'
import { format } from 'date-fns'
import type { Broadcast } from '../types'

const REQUEST_TYPES = [
  'In-person house call',
  'Virtual visit — IV fluids screening',
  'Virtual visit — CMA visit',
]

function defaultAcceptTime() {
  const now = new Date()
  const m = Math.ceil(now.getMinutes() / 15) * 15
  if (m === 60) { now.setHours(now.getHours() + 1, 0, 0, 0) } else { now.setMinutes(m, 0, 0) }
  return `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`
}

export function Broadcasts() {
  const { provider } = useAuth()
  const [broadcasts, setBroadcasts] = useState<Broadcast[]>([])
  const [loading, setLoading] = useState(true)
  const [acting, setActing] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [form, setForm] = useState({
    patient_first_name: '',
    patient_last_name: '',
    patient_dob: '',
    patient_address: '',
    family_phone: '',
    family_email: '',
    request_type: '',
    complaint: '',
    is_urgent: false,
  })

  // Accept modal state
  const [acceptingBc, setAcceptingBc] = useState<Broadcast | null>(null)
  const [acceptDate, setAcceptDate] = useState(format(new Date(), 'yyyy-MM-dd'))
  const [acceptTime, setAcceptTime] = useState(defaultAcceptTime)

  async function fetchBroadcasts() {
    const data = await getBroadcasts({ open_only: 'true' })
    setBroadcasts((data ?? []) as Broadcast[])
    setLoading(false)
  }

  useEffect(() => { fetchBroadcasts() }, [])

  async function submitBroadcast() {
    if (!provider || !form.patient_first_name || !form.patient_last_name || !form.request_type || !form.complaint) return
    setSubmitting(true)

    const bc = await createBroadcast({
      patient_first_name: form.patient_first_name,
      patient_last_name: form.patient_last_name,
      patient_dob: form.patient_dob || null,
      patient_address: form.patient_address || null,
      family_phone: form.family_phone || null,
      family_email: form.family_email || null,
      state: provider.states?.[0] || null,
      request_type: form.request_type,
      complaint: form.complaint,
      is_urgent: form.is_urgent,
      is_open: true,
      created_by: provider.id,
      created_by_name: provider.name,
    })

    if (bc) {
      invokeNotifications({ type: 'broadcast', broadcastId: bc.id }).catch(() => {})
    }

    setSubmitting(false)
    setCreating(false)
    setForm({ patient_first_name: '', patient_last_name: '', patient_dob: '', patient_address: '', family_phone: '', family_email: '', request_type: '', complaint: '', is_urgent: false })
    fetchBroadcasts()
  }

  function openAcceptModal(bc: Broadcast) {
    setAcceptingBc(bc)
    setAcceptDate(format(new Date(), 'yyyy-MM-dd'))
    setAcceptTime(defaultAcceptTime())
  }

  async function confirmAccept() {
    if (!provider || !acceptingBc) return
    const bc = acceptingBc
    setActing(bc.id)
    setAcceptingBc(null)

    const noteParts = [`Broadcast: ${bc.patient_first_name} ${bc.patient_last_name}`]
    if (bc.patient_dob) noteParts.push(`DOB:${bc.patient_dob}`)
    if (bc.patient_address) noteParts.push(`ADDR:${bc.patient_address}`)
    if (bc.complaint) noteParts.push(`CC:${bc.complaint}`)
    noteParts.push(`Request: ${bc.request_type}`)

    await createAppointment({
      provider_id: provider.id,
      visit_type: bc.request_type === 'In-person house call' ? 'In-home sick visit' : 'Video telemedicine',
      zone: bc.patient_address || (bc as any).zone || 'Broadcast',
      scheduled_time: acceptTime,
      scheduled_date: acceptDate,
      status: 'upcoming',
      notes: noteParts.join('|'),
    })

    await updateBroadcast(bc.id, { is_open: false })

    invokeNotifications({
      type: 'broadcast_accepted',
      broadcastId: bc.id,
      acceptedByName: provider.name,
      acceptedById: provider.id,
      acceptedDate: acceptDate,
      acceptedTime: acceptTime,
    }).catch(() => {})

    setBroadcasts(prev => prev.filter(b => b.id !== bc.id))
    setActing(null)
  }

  async function pass(id: string) {
    setActing(id)
    await updateBroadcast(id, { is_open: false })
    setBroadcasts(prev => prev.filter(b => b.id !== id))
    setActing(null)
  }

  const formValid = form.patient_first_name && form.patient_last_name && form.request_type && form.complaint

  return (
    <div>
      <div className="bg-white border-b border-[#E8E8E4] px-6 py-4 flex items-center justify-between sticky top-0 z-10">
        <div className="font-display text-[18px] font-medium text-[#1A1A2E]">Broadcasts</div>
        <div className="flex items-center gap-2">
          <Badge variant="amber">{broadcasts.length} open request{broadcasts.length !== 1 ? 's' : ''}</Badge>
          <Button variant="teal" size="sm" onClick={() => setCreating(true)}>
            <Plus size={13} /> New broadcast
          </Button>
        </div>
      </div>

      <div className="p-6 max-w-2xl">
        <p className="text-[13px] text-[#555] mb-5 leading-relaxed">
          Broadcast a patient request to all providers in your state. Anyone can accept and it will be added to their schedule automatically.
        </p>

        {loading ? (
          <div className="text-[#999] text-sm">Loading...</div>
        ) : broadcasts.length === 0 ? (
          <div className="text-center py-16">
            <div className="w-12 h-12 rounded-xl bg-[#F1EFE8] flex items-center justify-center mx-auto mb-3">
              <AlertCircle size={20} className="text-[#999]" />
            </div>
            <p className="text-[14px] text-[#999]">No open broadcast requests right now.</p>
          </div>
        ) : (
          <div className="space-y-3">
            {broadcasts.map(bc => (
              <div key={bc.id}
                className={`border rounded-xl p-4 ${bc.is_urgent ? 'border-[#FAC775] bg-[#FAEEDA]' : 'border-[#E8E8E4] bg-white'}`}>
                <div className="mb-3">
                  <div className="flex items-center gap-2 flex-wrap mb-2">
                    <span className="font-display text-[15px] font-medium text-[#1A1A2E]">
                      {bc.patient_first_name} {bc.patient_last_name}
                    </span>
                    {bc.is_urgent && <Badge variant="red">Urgent</Badge>}
                    <Badge variant="purple">{bc.request_type}</Badge>
                  </div>
                  <div className="space-y-1 text-[13px] text-[#555]">
                    {bc.patient_dob && (
                      <p><span className="text-[#999] text-[11px] uppercase tracking-wider">DOB </span>{bc.patient_dob}</p>
                    )}
                    {bc.patient_address && (
                      <p className="flex items-start gap-1">
                        <MapPin size={11} className="text-[#999] flex-shrink-0 mt-0.5" />
                        {bc.patient_address}
                      </p>
                    )}
                    {bc.complaint && (
                      <p><span className="text-[#999] text-[11px] uppercase tracking-wider">Complaint </span>{bc.complaint}</p>
                    )}
                    {bc.created_by_name && (
                      <p className="flex items-center gap-1 text-[12px] text-[#999] mt-2">
                        <Clock size={11} />
                        Sent by {bc.created_by_name} · {format(new Date(bc.created_at), 'MMM d, h:mm a')}
                      </p>
                    )}
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button variant="teal" size="sm" loading={acting === bc.id} onClick={() => openAcceptModal(bc)}>
                    Accept — add to my schedule
                  </Button>
                  <Button variant="secondary" size="sm" disabled={acting === bc.id} onClick={() => pass(bc.id)}>
                    Pass
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Accept modal — date/time picker */}
      {acceptingBc && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" onClick={() => setAcceptingBc(null)} />
          <div className="relative bg-white rounded-2xl shadow-xl w-full max-w-sm p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-display text-lg font-medium text-[#1A1A2E]">Confirm acceptance</h2>
              <button onClick={() => setAcceptingBc(null)} className="p-1.5 rounded-lg hover:bg-[#F1EFE8] text-[#999]">
                <X size={16} />
              </button>
            </div>
            <p className="text-[13px] text-[#555] mb-4">
              <strong>{acceptingBc.patient_first_name} {acceptingBc.patient_last_name}</strong> · {acceptingBc.request_type}
            </p>
            <div className="space-y-3 mb-5">
              <Input label="Date" type="date" value={acceptDate}
                onChange={e => setAcceptDate(e.target.value)} />
              <Input label="Time" type="time" value={acceptTime}
                onChange={e => setAcceptTime(e.target.value)} />
            </div>
            <div className="flex gap-2">
              <Button variant="secondary" className="flex-1" onClick={() => setAcceptingBc(null)}>Cancel</Button>
              <Button variant="teal" className="flex-1" onClick={confirmAccept} disabled={!acceptDate || !acceptTime}>
                Confirm accept
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* New broadcast modal */}
      {creating && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" onClick={() => setCreating(false)} />
          <div className="relative bg-white rounded-2xl shadow-xl w-full max-w-sm p-6 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-display text-lg font-medium text-[#1A1A2E]">New broadcast</h2>
              <button onClick={() => setCreating(false)} className="p-1.5 rounded-lg hover:bg-[#F1EFE8] text-[#999]">
                <X size={16} />
              </button>
            </div>

            <div className="space-y-3 mb-5">
              <div className="grid grid-cols-2 gap-3">
                <Input label="First name *" placeholder="Emma" value={form.patient_first_name}
                  onChange={e => setForm(f => ({ ...f, patient_first_name: e.target.value }))} />
                <Input label="Last name *" placeholder="Smith" value={form.patient_last_name}
                  onChange={e => setForm(f => ({ ...f, patient_last_name: e.target.value }))} />
              </div>
              <Input label="Date of birth" type="date" value={form.patient_dob}
                onChange={e => setForm(f => ({ ...f, patient_dob: e.target.value }))} />
              <Input label="Full address" placeholder="123 Main St, Charlotte, NC 28078" value={form.patient_address}
                onChange={e => setForm(f => ({ ...f, patient_address: e.target.value }))} />
              <div className="border-t border-[#E8E8E4] pt-3">
                <p className="text-[11px] font-medium text-[#555] uppercase tracking-wider mb-2">Parent contact — for acceptance notification</p>
                <div className="space-y-2">
                  <Input label="Parent phone" type="tel" placeholder="+17045550100" value={form.family_phone}
                    onChange={e => setForm(f => ({ ...f, family_phone: e.target.value }))} />
                  <Input label="Parent email" type="email" placeholder="parent@email.com" value={form.family_email}
                    onChange={e => setForm(f => ({ ...f, family_email: e.target.value }))} />
                </div>
              </div>
              <div>
                <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-1">
                  Request type <span className="text-[#ff3b30]">*</span>
                </label>
                <select value={form.request_type} onChange={e => setForm(f => ({ ...f, request_type: e.target.value }))}
                  className="w-full px-3 py-2.5 border border-[#E8E8E4] rounded-lg text-[14px] font-sans bg-white outline-none focus:border-[#7F77DD]">
                  <option value="">Select...</option>
                  {REQUEST_TYPES.map(rt => <option key={rt} value={rt}>{rt}</option>)}
                </select>
              </div>
              <div>
                <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-1">
                  Chief complaint <span className="text-[#ff3b30]">*</span>
                </label>
                <textarea value={form.complaint} onChange={e => setForm(f => ({ ...f, complaint: e.target.value }))}
                  placeholder="Describe the patient's symptoms..."
                  rows={3}
                  className="w-full px-3 py-2.5 border border-[#E8E8E4] rounded-lg text-[14px] font-sans resize-none outline-none focus:border-[#7F77DD] bg-white" />
              </div>
              <button onClick={() => setForm(f => ({ ...f, is_urgent: !f.is_urgent }))}
                className={`w-full flex items-center gap-3 p-3 rounded-xl border-2 transition-all text-left ${form.is_urgent ? 'border-[#F09595] bg-[#FCEBEB]' : 'border-[#E8E8E4] bg-white hover:border-[#AFA9EC]'}`}>
                <div className={`w-5 h-5 rounded border-2 flex items-center justify-center transition-all flex-shrink-0 ${form.is_urgent ? 'bg-[#791F1F] border-[#791F1F]' : 'border-[#D0D0CC]'}`}>
                  {form.is_urgent && <AlertTriangle size={11} className="text-white" />}
                </div>
                <span className={`text-[13px] font-medium ${form.is_urgent ? 'text-[#791F1F]' : 'text-[#555]'}`}>Mark as urgent</span>
              </button>
            </div>

            <div className="flex gap-2">
              <Button variant="secondary" className="flex-1" onClick={() => setCreating(false)}>Cancel</Button>
              <Button variant="teal" className="flex-1" disabled={!formValid} loading={submitting} onClick={submitBroadcast}>
                Send broadcast
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
