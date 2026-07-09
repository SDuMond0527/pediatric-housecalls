import { useEffect, useState } from 'react'
import { X, CalendarPlus } from 'lucide-react'
import { Button } from './ui/Button'
import { createAppointment, invokeNotifications, getProviders, getPracticeZones } from '../lib/api'
import { TIME_SLOTS, ZIP_TO_ZONE } from '../lib/zipData'
import { usePracticeVisitTypes } from '../hooks/usePracticeVisitTypes'

interface Props {
  child: any
  onClose: () => void
  onBooked: () => void
}

export function BookAppointmentModal({ child, onClose, onBooked }: Props) {
  const { visitTypes, loading: vtLoading } = usePracticeVisitTypes()
  const [providers, setProviders] = useState<any[]>([])
  const [zones, setZones] = useState<string[]>([])

  const childZip = child?.family_zip || child?.parent_zip || ''
  const autoZone = ZIP_TO_ZONE[childZip] ?? ''

  const today = new Date().toISOString().slice(0, 10)
  const [form, setForm] = useState({
    provider_id: '',
    visit_type: '',
    scheduled_date: today,
    scheduled_time: '9:00 AM',
    zone: autoZone,
  })
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    getProviders().then(data => setProviders((data ?? []).filter((p: any) => p.is_active && p.role !== 'admin'))).catch(() => {})
    getPracticeZones().then(data => setZones((data ?? []).map((z: any) => z.zone_name))).catch(() => {})
  }, [])

  function set(field: string, value: string) {
    setForm(f => ({ ...f, [field]: value }))
  }

  // Convert "9:00 AM" → "09:00"
  function to24h(t: string): string {
    const [time, ampm] = t.split(' ')
    const [h, m] = time.split(':').map(Number)
    const hour = ampm === 'PM' && h !== 12 ? h + 12 : ampm === 'AM' && h === 12 ? 0 : h
    return `${String(hour).padStart(2, '0')}:${String(m).padStart(2, '0')}`
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!form.provider_id || !form.visit_type || !form.scheduled_date || !form.scheduled_time || !form.zone) {
      setError('Please fill in all fields.')
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      const appt = await createAppointment({
        provider_id: form.provider_id,
        visit_type: form.visit_type,
        zone: form.zone,
        scheduled_date: form.scheduled_date,
        scheduled_time: to24h(form.scheduled_time),
        child_id: child.id,
        status: 'upcoming',
      })
      await invokeNotifications({ type: 'admin_booked', appointmentId: appt.id })
      onBooked()
    } catch (e: any) {
      setError(e.message ?? 'Failed to book appointment')
    } finally {
      setSubmitting(false)
    }
  }

  const childName = [child?.first_name, child?.last_name].filter(Boolean).join(' ')

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-[#E8E8E4]">
          <div className="flex items-center gap-2.5">
            <CalendarPlus size={18} className="text-[#7F77DD]" />
            <div>
              <h2 className="font-display text-[16px] font-medium text-[#1A1A2E]">Book Appointment</h2>
              <p className="text-[12px] text-[#999]">{childName}</p>
            </div>
          </div>
          <button onClick={onClose} className="text-[#999] hover:text-[#333] transition-colors">
            <X size={18} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="px-6 py-5 space-y-4">
          {/* Provider */}
          <div>
            <label className="text-[11px] font-semibold text-[#555] uppercase tracking-wider block mb-1.5">Provider</label>
            <select value={form.provider_id} onChange={e => set('provider_id', e.target.value)} required
              className="w-full px-3 py-2 border border-[#E8E8E4] rounded-lg text-[14px] bg-white outline-none focus:border-[#7F77DD]">
              <option value="">— select —</option>
              {providers.map(p => (
                <option key={p.id} value={p.id}>{p.name} ({p.role})</option>
              ))}
            </select>
          </div>

          {/* Visit type */}
          <div>
            <label className="text-[11px] font-semibold text-[#555] uppercase tracking-wider block mb-1.5">Visit Type</label>
            <select value={form.visit_type} onChange={e => set('visit_type', e.target.value)} required
              className="w-full px-3 py-2 border border-[#E8E8E4] rounded-lg text-[14px] bg-white outline-none focus:border-[#7F77DD]">
              <option value="">— select —</option>
              {vtLoading
                ? <option disabled>Loading…</option>
                : visitTypes.map(vt => <option key={vt.visit_type} value={vt.visit_type}>{vt.visit_type}</option>)
              }
            </select>
          </div>

          {/* Date + Time */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-[11px] font-semibold text-[#555] uppercase tracking-wider block mb-1.5">Date</label>
              <input type="date" min={today} value={form.scheduled_date}
                onChange={e => set('scheduled_date', e.target.value)} required
                className="w-full px-3 py-2 border border-[#E8E8E4] rounded-lg text-[14px] outline-none focus:border-[#7F77DD]" />
            </div>
            <div>
              <label className="text-[11px] font-semibold text-[#555] uppercase tracking-wider block mb-1.5">Time</label>
              <select value={form.scheduled_time} onChange={e => set('scheduled_time', e.target.value)} required
                className="w-full px-3 py-2 border border-[#E8E8E4] rounded-lg text-[14px] bg-white outline-none focus:border-[#7F77DD]">
                {TIME_SLOTS.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
          </div>

          {/* Zone */}
          <div>
            <label className="text-[11px] font-semibold text-[#555] uppercase tracking-wider block mb-1.5">
              Zone {autoZone && <span className="text-[#1D9E75] normal-case font-normal">(auto-filled from ZIP)</span>}
            </label>
            <select value={form.zone} onChange={e => set('zone', e.target.value)} required
              className="w-full px-3 py-2 border border-[#E8E8E4] rounded-lg text-[14px] bg-white outline-none focus:border-[#7F77DD]">
              <option value="">— select —</option>
              {zones.map(z => <option key={z} value={z}>{z}</option>)}
              {autoZone && !zones.includes(autoZone) && <option value={autoZone}>{autoZone}</option>}
            </select>
          </div>

          {error && (
            <div className="text-[12px] text-[#DC2626] bg-[#FEE2E2] border border-[#FECACA] rounded-lg px-3 py-2">{error}</div>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="secondary" size="sm" onClick={onClose}>Cancel</Button>
            <Button type="submit" size="sm" loading={submitting}>
              <CalendarPlus size={13} className="mr-1.5" /> Book &amp; send confirmation
            </Button>
          </div>
        </form>
      </div>
    </div>
  )
}
