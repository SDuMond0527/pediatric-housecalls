import { useState } from 'react'
import { X, Droplet, Send } from 'lucide-react'
import { createBroadcast, invokeNotifications } from '../lib/api'
import { Button } from './ui/Button'
import { Input } from './ui/Input'
import { TIME_SLOTS } from '../lib/zipData'

// Patient context — anything we already know from where the modal is opened.
export interface RnIvOrderContext {
  patientFirstName: string
  patientLastName: string
  patientDob?: string | null
  patientAddress?: string | null
  familyPhone?: string | null
  familyEmail?: string | null
  state?: string | null
  zone?: string | null
  relatedAppointmentId?: string | null
}

interface Props {
  ctx: RnIvOrderContext
  providerId: string
  providerRole: string
  providerName: string
  onClose: () => void
  onSent: () => void
}

const VOLUMES = [500, 1000] as const

export function RnIvOrderModal({ ctx, providerId, providerRole, providerName, onClose, onSent }: Props) {
  const [weightLbs, setWeightLbs] = useState('')
  const [volumeMl, setVolumeMl] = useState<number | null>(null)
  const today = new Date().toISOString().split('T')[0]
  const [date, setDate] = useState(today)
  const [time, setTime] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const weightNum = parseFloat(weightLbs)
  const weightValid = !Number.isNaN(weightNum) && weightNum > 0
  const canSend = weightValid && volumeMl !== null && !!date && !!time && !submitting

  async function send() {
    if (!canSend) return
    setError(null)
    setSubmitting(true)
    try {
      const [t, ampm] = time.split(' ')
      let [h, m] = t.split(':').map(Number)
      if (ampm === 'PM' && h !== 12) h += 12
      if (ampm === 'AM' && h === 12) h = 0
      const time24 = `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`

      // Structured, machine-parseable orders string. Rendered as a distinct
      // "RN orders" block on the broadcast card and the RN's appointment card.
      const complaint = `IV: NS ${volumeMl} mL | wt ${weightNum} lbs`

      const bc = await createBroadcast({
        patient_first_name: ctx.patientFirstName,
        patient_last_name:  ctx.patientLastName,
        patient_dob:        ctx.patientDob ?? null,
        patient_address:    ctx.patientAddress ?? null,
        family_phone:       ctx.familyPhone ?? null,
        family_email:       ctx.familyEmail ?? null,
        state:              ctx.state ?? null,
        zone:               ctx.zone ?? ctx.patientAddress ?? null,
        visit_type:         'In-home IV fluids – RN only',
        request_type:       'In-home RN — IV fluids',
        complaint,
        is_urgent:          false,
        created_by:         providerId,
        created_by_name:    `${providerRole} ${providerName}`,
        related_appointment_id: ctx.relatedAppointmentId ?? null,
        // Gate the claim button so only RNs see it (reuses the pairing_role_needed
        // filter), but leave pairing_initiator_id null so the claim path knows
        // this is a solo visit, not a pair.
        pairing_role_needed: 'RN',
        scheduled_date: date,
        scheduled_time: time24,
      }).catch(() => null)

      if (!bc?.id) {
        setError('Broadcast failed to send. Please try again.')
        setSubmitting(false)
        return
      }

      invokeNotifications({ type: 'broadcast', broadcastId: bc.id }).catch(() => {})
      onSent()
    } catch (e: any) {
      setError(e?.message || 'Broadcast failed to send.')
      setSubmitting(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-white rounded-2xl shadow-xl w-full max-w-md max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between px-6 pt-6 pb-4">
          <div className="flex items-center gap-2">
            <Droplet size={16} className="text-[#7F77DD]" />
            <h2 className="font-display text-lg font-medium text-[#1A1A2E]">Send RN for in-home IV fluids</h2>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-[#F1EFE8] text-[#999]"><X size={16} /></button>
        </div>

        <div className="px-6 flex-1 overflow-y-auto">
          <div className="p-3 bg-[#FAFAF8] border border-[#E8E8E4] rounded-lg text-[13px] text-[#555] mb-4">
            <div className="font-medium text-[#1A1A2E]">{ctx.patientFirstName} {ctx.patientLastName}</div>
            {ctx.patientAddress && <div className="text-[#999] mt-0.5">{ctx.patientAddress}</div>}
          </div>

          <div className="space-y-4">
            <Input
              label="Patient weight (lbs) *"
              type="number"
              min="0"
              step="0.1"
              placeholder="e.g. 32"
              value={weightLbs}
              onChange={e => setWeightLbs(e.target.value)}
            />

            <div>
              <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-1">Fluid type</label>
              <div className="px-3 py-2.5 border border-[#E8E8E4] rounded-lg text-[14px] bg-[#FAFAF8] text-[#555]">NS (Normal Saline)</div>
            </div>

            <div>
              <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-1">Total volume (mL) *</label>
              <div className="grid grid-cols-2 gap-2">
                {VOLUMES.map(v => (
                  <button
                    key={v}
                    type="button"
                    onClick={() => setVolumeMl(v)}
                    className={`py-3 text-center text-[14px] rounded-lg border-2 transition-all font-medium ${
                      volumeMl === v
                        ? 'bg-[#7F77DD] border-[#7F77DD] text-white'
                        : 'border-[#E8E8E4] bg-white hover:border-[#AFA9EC] text-[#1A1A2E]'
                    }`}>
                    {v} mL
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-1">Date *</label>
              <input type="date" value={date} min={today}
                onChange={e => setDate(e.target.value)}
                className="w-full px-3 py-2.5 border border-[#E8E8E4] rounded-lg text-[14px] font-sans outline-none focus:border-[#7F77DD]" />
            </div>

            <div>
              <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-1">Time *</label>
              <div className="grid grid-cols-4 gap-1.5 max-h-40 overflow-y-auto">
                {TIME_SLOTS.map(slot => (
                  <button key={slot} type="button" onClick={() => setTime(slot)}
                    className={`py-1.5 text-center text-[12px] rounded-lg border-2 transition-all font-sans ${
                      time === slot ? 'bg-[#7F77DD] border-[#7F77DD] text-white'
                      : 'border-[#E8E8E4] bg-white hover:border-[#AFA9EC] text-[#1A1A2E]'
                    }`}>
                    {slot}
                  </button>
                ))}
              </div>
            </div>

            <div className="p-3 bg-[#FEF3E8] border border-[#F5943A]/30 rounded-lg text-[12px] text-[#633806]">
              This will page every active RN in the state. First to claim adds it to their schedule. No paired telemedicine visit is created.
            </div>
          </div>
        </div>

        <div className="px-6 py-4 border-t border-[#E8E8E4]">
          {error && (
            <div className="text-[12px] text-[#DC2626] bg-[#FEE2E2] border border-[#FECACA] rounded-lg px-3 py-2 mb-3">{error}</div>
          )}
          <div className="flex gap-2">
            <Button variant="secondary" className="flex-1" onClick={onClose}>Cancel</Button>
            <Button variant="teal" className="flex-1" disabled={!canSend} loading={submitting} onClick={send}>
              <Send size={13} /> Send broadcast
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
