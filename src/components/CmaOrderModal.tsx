import { useState } from 'react'
import { X, TestTube, Send, Check } from 'lucide-react'
import { createBroadcast, invokeNotifications } from '../lib/api'
import { Button } from './ui/Button'

// Patient context — anything we already know from where the modal is opened.
export interface CmaOrderContext {
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
  ctx: CmaOrderContext
  providerId: string
  providerRole: string
  providerName: string
  onClose: () => void
  onSent: () => void
}

const TEST_OPTIONS = [
  { key: 'urine_culture',  label: 'Urine culture' },
  { key: 'urinalysis',     label: 'Urinalysis (dipstick)' },
  { key: 'strep',          label: 'Strep test' },
  { key: 'flu_covid',      label: 'Flu/COVID rapid' },
  { key: 'flu_covid_rsv',  label: 'Flu/COVID/RSV rapid' },
  { key: 'ear_exam',       label: 'Ear exam (digital)' },
] as const

export function CmaOrderModal({ ctx, providerId, providerRole, providerName, onClose, onSent }: Props) {
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [otherTest, setOtherTest] = useState('')
  const [notes, setNotes] = useState('')
  const today = new Date().toISOString().split('T')[0]
  const [date, setDate] = useState(today)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function toggle(k: string) {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(k)) next.delete(k); else next.add(k)
      return next
    })
  }

  const selectedLabels = TEST_OPTIONS
    .filter(t => selected.has(t.key))
    .map(t => t.label)
  const otherLabel = otherTest.trim()
  const allLabels = otherLabel ? [...selectedLabels, otherLabel] : selectedLabels
  const canSend = allLabels.length > 0 && !!date && !submitting

  async function send() {
    if (!canSend) return
    setError(null)
    setSubmitting(true)
    try {
      const trimmedNotes = notes.trim()
      const testStr = allLabels.join(', ')
      const complaint = trimmedNotes
        ? `Tests: ${testStr} | notes: ${trimmedNotes}`
        : `Tests: ${testStr}`

      const bc = await createBroadcast({
        patient_first_name: ctx.patientFirstName,
        patient_last_name:  ctx.patientLastName,
        patient_dob:        ctx.patientDob ?? null,
        patient_address:    ctx.patientAddress ?? null,
        family_phone:       ctx.familyPhone ?? null,
        family_email:       ctx.familyEmail ?? null,
        state:              ctx.state ?? null,
        zone:               ctx.zone ?? ctx.patientAddress ?? null,
        visit_type:         'In-home diagnostics – CMA only',
        request_type:       'In-home CMA — test collection',
        complaint,
        is_urgent:          false,
        created_by:         providerId,
        created_by_name:    `${providerRole} ${providerName}`,
        related_appointment_id: ctx.relatedAppointmentId ?? null,
        // Gate the claim button so only CMAs see it. Not a paired visit —
        // no pairing_initiator_id, so downstream we treat it as solo and
        // don't spawn a phantom MD/NP twin.
        pairing_role_needed: 'CMA',
        scheduled_date: date,
        scheduled_time: null,
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
            <TestTube size={16} className="text-[#7F77DD]" />
            <h2 className="font-display text-lg font-medium text-[#1A1A2E]">Send CMA for in-home diagnostics</h2>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-[#F1EFE8] text-[#999]"><X size={16} /></button>
        </div>

        <div className="px-6 flex-1 overflow-y-auto">
          <div className="p-3 bg-[#FAFAF8] border border-[#E8E8E4] rounded-lg text-[13px] text-[#555] mb-4">
            <div className="font-medium text-[#1A1A2E]">{ctx.patientFirstName} {ctx.patientLastName}</div>
            {ctx.patientAddress && <div className="text-[#999] mt-0.5">{ctx.patientAddress}</div>}
          </div>

          <div className="space-y-4">
            <div>
              <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-2">Tests to perform *</label>
              <div className="space-y-1.5">
                {TEST_OPTIONS.map(t => {
                  const on = selected.has(t.key)
                  return (
                    <button
                      key={t.key}
                      type="button"
                      onClick={() => toggle(t.key)}
                      className={`w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg border-2 transition-all text-left ${
                        on ? 'border-[#7F77DD] bg-[#F5F4FE]' : 'border-[#E8E8E4] bg-white hover:border-[#AFA9EC]'
                      }`}
                    >
                      <div className={`w-5 h-5 rounded border-2 flex-shrink-0 flex items-center justify-center transition-all ${
                        on ? 'bg-[#7F77DD] border-[#7F77DD]' : 'border-[#D0D0CC]'
                      }`}>
                        {on && <Check size={11} className="text-white" strokeWidth={3} />}
                      </div>
                      <span className={`text-[14px] ${on ? 'text-[#1A1A2E] font-medium' : 'text-[#333]'}`}>{t.label}</span>
                    </button>
                  )
                })}
              </div>
            </div>

            <div>
              <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-1">Other test</label>
              <input
                type="text"
                value={otherTest}
                onChange={e => setOtherTest(e.target.value)}
                placeholder="e.g. COVID PCR send-out"
                className="w-full px-3 py-2.5 border border-[#E8E8E4] rounded-lg text-[14px] font-sans outline-none focus:border-[#7F77DD]"
              />
              <p className="text-[11px] text-[#999] mt-1">Optional — anything not in the list above.</p>
            </div>

            <div>
              <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-1">Additional notes for the CMA</label>
              <textarea
                value={notes}
                onChange={e => setNotes(e.target.value)}
                rows={3}
                placeholder="e.g. Clean catch preferred. Bring specimen back to office same day."
                className="w-full px-3 py-2.5 border border-[#E8E8E4] rounded-lg text-[14px] font-sans outline-none focus:border-[#7F77DD] resize-none"
              />
              <p className="text-[11px] text-[#999] mt-1">Optional — anything else the CMA should know.</p>
            </div>

            <div>
              <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-1">Target date *</label>
              <input type="date" value={date} min={today}
                onChange={e => setDate(e.target.value)}
                className="w-full px-3 py-2.5 border border-[#E8E8E4] rounded-lg text-[14px] font-sans outline-none focus:border-[#7F77DD]" />
              <p className="text-[11px] text-[#999] mt-1">The claiming CMA picks the exact arrival time when she accepts.</p>
            </div>

            <div className="p-3 bg-[#FEF3E8] border border-[#F5943A]/30 rounded-lg text-[12px] text-[#633806]">
              This will page every active CMA in the state. The first CMA to claim picks her arrival time and adds it to her schedule. No paired telemedicine visit is created.
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
