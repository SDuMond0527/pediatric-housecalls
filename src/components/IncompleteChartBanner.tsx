import { useState } from 'react'
import { AlertTriangle, Send, Pencil, X } from 'lucide-react'
import { updateChild, apiFetch } from '../lib/api'
import { getMissingChildFields, type RequiredField } from '../lib/childCompleteness'
import { Button } from './ui/Button'
import { Input } from './ui/Input'

// Staff-facing banner rendered at the top of every patient chart that is
// missing any required field. Two actions:
//   1. Fill in now — pops a modal so staff can type the missing fields.
//   2. Text the parent — sends SMS + email with a magic link that opens
//      the family portal's CompleteChildProfileGate on the parent's phone.
// Every patient interaction (chart open, appointment booking, etc.) hits
// this — never let a sparse chart quietly sit on the list.

interface Props {
  child: any
  onUpdated: (updated: any) => void
}

const VAX_OPTIONS = [
  { value: 'fully_vaccinated', label: 'Fully vaccinated on schedule' },
  { value: 'delayed',          label: 'Delayed / alternative schedule' },
  { value: 'unvaccinated',     label: 'Not vaccinated' },
]
const GENDER_OPTIONS = [
  { value: 'Male',   label: 'Male' },
  { value: 'Female', label: 'Female' },
]

export function IncompleteChartBanner({ child, onUpdated }: Props) {
  const missing = getMissingChildFields(child, {
    phone:         child?.family_phone,
    email:         child?.family_email,
    address_line1: child?.family_address_line1,
  })
  const [fillOpen, setFillOpen] = useState(false)
  const [textSending, setTextSending] = useState(false)
  const [textSent, setTextSent] = useState(false)
  const [textError, setTextError] = useState<string | null>(null)

  if (missing.length === 0) return null

  async function textParent() {
    setTextError(null)
    setTextSending(true)
    try {
      const res = await apiFetch<any>(`/api/children/${child.id}/request-completion`, { method: 'POST' })
      if (res?.ok) setTextSent(true)
      else setTextError(res?.error || 'Could not send. Check parent phone/email on file.')
    } catch (e: any) {
      setTextError(e?.message || 'Send failed.')
    } finally {
      setTextSending(false)
    }
  }

  return (
    <>
      <div className="mb-4 border border-[#F5943A] bg-[#FEF3E8] rounded-xl p-4">
        <div className="flex items-start gap-3">
          <AlertTriangle size={18} className="text-[#EF9F27] flex-shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <div className="text-[13px] font-semibold text-[#633806] mb-0.5">This chart is missing required information</div>
            <div className="text-[12px] text-[#633806]/80 mb-2">
              Missing: {missing.map(f => f.label).join(' · ')}
            </div>
            {textSent ? (
              <div className="text-[12px] text-[#1D9E75] font-medium">✓ Sent request to parent. They'll get a text + email with a link to complete.</div>
            ) : (
              <div className="flex flex-wrap gap-2">
                <button onClick={() => setFillOpen(true)}
                        className="flex items-center gap-1.5 px-3 py-1.5 bg-white border border-[#F5943A] text-[#633806] text-[12px] font-medium rounded-lg hover:bg-[#F5943A] hover:text-white transition-colors">
                  <Pencil size={12} /> Fill in now
                </button>
                <button onClick={textParent} disabled={textSending}
                        className="flex items-center gap-1.5 px-3 py-1.5 bg-[#EF9F27] text-white text-[12px] font-medium rounded-lg hover:bg-[#BA7517] transition-colors disabled:opacity-50">
                  <Send size={12} /> {textSending ? 'Sending…' : 'Text the parent'}
                </button>
              </div>
            )}
            {textError && <div className="text-[11px] text-[#DC2626] mt-2">{textError}</div>}
          </div>
        </div>
      </div>

      {fillOpen && <FillInModal child={child} missing={missing} onClose={() => setFillOpen(false)} onSaved={(patched) => { onUpdated(patched); setFillOpen(false) }} />}
    </>
  )
}

function FillInModal({ child, missing, onClose, onSaved }: { child: any; missing: RequiredField[]; onClose: () => void; onSaved: (updated: any) => void }) {
  const [values, setValues] = useState<Record<string, string>>({})
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function save() {
    setError(null)
    setSubmitting(true)
    try {
      // Staff-side fill-in supports partial saves. Only fields the user
      // actually typed values into get written to the DB. Any field left
      // empty stays empty — the banner will re-render on the next page load
      // showing whatever is still missing. This is different from the
      // parent-facing CompleteChildProfileGate, which does require every
      // field in one shot (parents are filling their own child's profile,
      // not chasing missing info piecemeal like staff).
      const patch: Record<string, any> = {}
      for (const f of missing) {
        const raw = values[f.key]
        if (raw != null && String(raw).trim() !== '') {
          patch[f.key] = raw
        }
      }
      if (Object.keys(patch).length === 0) {
        setError('Nothing to save — fill in at least one field before saving.')
        setSubmitting(false)
        return
      }
      const updated = await updateChild(child.id, patch)
      onSaved({ ...child, ...updated })
    } catch (e: any) {
      setError(e?.message || 'Save failed.')
      setSubmitting(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative bg-white rounded-2xl shadow-xl w-full max-w-lg max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between px-6 pt-6 pb-3 border-b border-[#E8E8E4]">
          <h2 className="font-display text-lg font-medium text-[#1A1A2E]">Complete this chart</h2>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-[#F1EFE8] text-[#999]"><X size={16} /></button>
        </div>
        <div className="px-6 py-4 flex-1 overflow-y-auto space-y-3">
          {missing.map(f => (
            <FieldInput key={f.key} field={f} value={values[f.key] ?? ''} onChange={v => setValues(prev => ({ ...prev, [f.key]: v }))} />
          ))}
        </div>
        <div className="px-6 py-4 border-t border-[#E8E8E4]">
          {error && <div className="text-[12px] text-[#DC2626] bg-[#FEE2E2] border border-[#FECACA] rounded-lg px-3 py-2 mb-3">{error}</div>}
          <div className="flex gap-2">
            <Button variant="secondary" className="flex-1" onClick={onClose}>Cancel</Button>
            <Button variant="teal" className="flex-1" loading={submitting} onClick={save}>Save</Button>
          </div>
        </div>
      </div>
    </div>
  )
}

function FieldInput({ field, value, onChange }: { field: RequiredField; value: string; onChange: (v: string) => void }) {
  if (field.key === 'insurance_card_front_url' || field.key === 'insurance_card_back_url') {
    return <Input label={`${field.label} (paste URL) *`} value={value} onChange={e => onChange(e.target.value)} placeholder="https://..." />
  }
  if (field.key === 'date_of_birth' || field.key === 'insurance_subscriber_dob') {
    return (
      <div>
        <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-1">{field.label} *</label>
        <input type="date" value={value} onChange={e => onChange(e.target.value)}
               className="w-full px-3 py-2.5 border border-[#E8E8E4] rounded-lg text-[14px] outline-none focus:border-[#7F77DD]" />
      </div>
    )
  }
  if (field.key === 'gender' || field.key === 'insurance_subscriber_gender') {
    return (
      <div>
        <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-1">{field.label} *</label>
        <select value={value} onChange={e => onChange(e.target.value)}
                className="w-full px-3 py-2.5 border border-[#E8E8E4] rounded-lg text-[14px] outline-none focus:border-[#7F77DD] bg-white">
          <option value="">Select</option>
          {GENDER_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </div>
    )
  }
  if (field.key === 'vaccination_status') {
    return (
      <div>
        <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-1">{field.label} *</label>
        <select value={value} onChange={e => onChange(e.target.value)}
                className="w-full px-3 py-2.5 border border-[#E8E8E4] rounded-lg text-[14px] outline-none focus:border-[#7F77DD] bg-white">
          <option value="">Select</option>
          {VAX_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </div>
    )
  }
  const isLong = field.key === 'medical_history' || field.key === 'current_medications' || field.key === 'allergies'
  if (isLong) {
    return (
      <div>
        <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-1">{field.label} *</label>
        <textarea value={value} onChange={e => onChange(e.target.value)} rows={2}
                  className="w-full px-3 py-2.5 border border-[#E8E8E4] rounded-lg text-[14px] outline-none focus:border-[#7F77DD] resize-none" />
      </div>
    )
  }
  const type = field.key === 'parent_phone' ? 'tel' : field.key === 'parent_email' ? 'email' : 'text'
  return <Input label={`${field.label} *`} type={type} value={value} onChange={e => onChange(e.target.value)} />
}
