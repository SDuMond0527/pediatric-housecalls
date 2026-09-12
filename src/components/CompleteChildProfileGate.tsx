import { useEffect, useState } from 'react'
import { AlertTriangle } from 'lucide-react'
import { updateChild, updateMyFamily, uploadNotePhoto } from '../lib/api'
import { Button } from './ui/Button'
import { Input } from './ui/Input'
import { getMissingChildFields, type RequiredField } from '../lib/childCompleteness'

// Blocking modal that fires whenever ANY child in the family is missing a
// required field. Cannot be dismissed until every gap is filled. Parents
// cannot navigate to booking, waitlist, dashboard, etc. until they have
// completed every field for every child. See memory:
// feedback_all_patient_info_required_and_displayed.md

interface Props {
  children: any[]
  family: any
  onAllComplete: () => void
}

const VAX_OPTIONS = [
  { value: 'fully_vaccinated',       label: 'Fully vaccinated on schedule' },
  { value: 'delayed',                label: 'Delayed / alternative schedule' },
  { value: 'unvaccinated',           label: 'Not vaccinated' },
]
const GENDER_OPTIONS = [
  { value: 'Male',   label: 'Male' },
  { value: 'Female', label: 'Female' },
]
const SUBSCRIBER_GENDER_OPTIONS = GENDER_OPTIONS

export function CompleteChildProfileGate({ children, family, onAllComplete }: Props) {
  const incomplete = children.map(c => ({ child: c, missing: getMissingChildFields(c, family) })).filter(x => x.missing.length > 0)
  const [activeIdx, setActiveIdx] = useState(0)
  const [values, setValues] = useState<Record<string, Record<string, string>>>(() => {
    const seed: Record<string, Record<string, string>> = {}
    for (const { child } of incomplete) {
      seed[child.id] = {}
    }
    return seed
  })
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (incomplete.length === 0) onAllComplete()
  }, [incomplete.length, onAllComplete])

  if (incomplete.length === 0) return null

  const current = incomplete[activeIdx] ?? incomplete[0]
  const currentValues = values[current.child.id] || {}
  function setV(k: string, v: string) {
    setValues(prev => ({ ...prev, [current.child.id]: { ...(prev[current.child.id] || {}), [k]: v } }))
  }

  async function saveCurrent() {
    setError(null)
    setSubmitting(true)
    try {
      // Split payload — parent contact fields also update family_profiles.
      const childPatch: Record<string, any> = {}
      const familyPatch: Record<string, any> = {}
      for (const f of current.missing) {
        const raw = currentValues[f.key]
        if (raw == null || String(raw).trim() === '') {
          setError(`Please fill in "${f.label}" — every field is required.`)
          setSubmitting(false)
          return
        }
        childPatch[f.key] = raw
        if (f.key === 'parent_phone')   familyPatch.phone         = raw
        if (f.key === 'parent_email')   familyPatch.email         = raw
        if (f.key === 'parent_address') familyPatch.address_line1 = raw
      }
      // Both writes must succeed. Previously updateMyFamily was silent-
      // failed which left family_profiles stale — new siblings then
      // couldn't inherit the parent's phone/email/address via the
      // MAX() lookup on POST /api/children. See memory:
      // feedback_extract_shared_code_first_try.md.
      if (Object.keys(familyPatch).length > 0) {
        await updateMyFamily(familyPatch)
      }
      await updateChild(current.child.id, childPatch)

      if (activeIdx + 1 < incomplete.length) {
        setActiveIdx(i => i + 1)
      } else {
        onAllComplete()
      }
    } catch (e: any) {
      setError(e?.message || 'Save failed. Please try again.')
    } finally {
      setSubmitting(false)
    }
  }

  const childName = current.child.display_label
    || [current.child.first_name, current.child.last_name].filter(Boolean).join(' ')
    || 'This child'

  return (
    <div className="fixed inset-0 z-[1000] bg-black/50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg max-h-[95vh] flex flex-col">
        <div className="px-6 pt-6 pb-3 border-b border-[#E8E8E4]">
          <div className="flex items-center gap-2 mb-1">
            <AlertTriangle size={18} className="text-[#EF9F27]" />
            <h2 className="font-display text-lg font-medium text-[#1A1A2E]">Complete your child's profile</h2>
          </div>
          <p className="text-[13px] text-[#555]">
            We need every field filled in so we can file insurance claims, send prescriptions, order labs, and provide care. Once you save this, we'll never ask again.
          </p>
          {incomplete.length > 1 && (
            <p className="text-[12px] text-[#7F77DD] font-medium mt-2">
              Child {activeIdx + 1} of {incomplete.length} — {childName}
            </p>
          )}
        </div>

        <div className="px-6 py-4 flex-1 overflow-y-auto">
          <p className="text-[12px] text-[#999] uppercase tracking-wider mb-2 font-semibold">Missing information for {childName}</p>
          <div className="space-y-3">
            {current.missing.map(f => (
              <ProfileFieldInput key={f.key} field={f} value={currentValues[f.key] ?? ''} onChange={v => setV(f.key, v)} />
            ))}
          </div>
        </div>

        <div className="px-6 py-4 border-t border-[#E8E8E4]">
          {error && (
            <div className="text-[12px] text-[#DC2626] bg-[#FEE2E2] border border-[#FECACA] rounded-lg px-3 py-2 mb-3">{error}</div>
          )}
          <Button variant="teal" className="w-full" loading={submitting} onClick={saveCurrent}>
            {activeIdx + 1 < incomplete.length ? 'Save and continue to next child' : 'Save and continue'}
          </Button>
        </div>
      </div>
    </div>
  )
}

function ProfileFieldInput({ field, value, onChange }: { field: RequiredField; value: string; onChange: (v: string) => void }) {
  const [uploading, setUploading] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function handleFile(file: File) {
    setErr(null)
    setUploading(true)
    try {
      const url = await uploadNotePhoto(file)
      onChange(url)
    } catch (e: any) {
      setErr(e?.message || 'Upload failed')
    } finally {
      setUploading(false)
    }
  }

  if (field.key === 'insurance_card_front_url' || field.key === 'insurance_card_back_url') {
    return (
      <div>
        <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-1">{field.label} *</label>
        {value ? (
          <div className="flex items-center gap-2">
            <img src={value} className="h-16 rounded border border-[#E8E8E4] object-contain" />
            <button onClick={() => onChange('')} className="text-[11px] text-[#DC2626]">Remove</button>
          </div>
        ) : (
          <div>
            <input type="file" accept="image/*" onChange={e => e.target.files?.[0] && handleFile(e.target.files[0])} className="text-[12px]" />
            {uploading && <div className="text-[11px] text-[#999] mt-1">Uploading…</div>}
            {err && <div className="text-[11px] text-[#DC2626] mt-1">{err}</div>}
          </div>
        )}
      </div>
    )
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
    const opts = field.key === 'gender' ? GENDER_OPTIONS : SUBSCRIBER_GENDER_OPTIONS
    return (
      <div>
        <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-1">{field.label} *</label>
        <select value={value} onChange={e => onChange(e.target.value)}
                className="w-full px-3 py-2.5 border border-[#E8E8E4] rounded-lg text-[14px] outline-none focus:border-[#7F77DD] bg-white">
          <option value="">Select</option>
          {opts.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
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

  const isLongText = field.key === 'medical_history' || field.key === 'current_medications' || field.key === 'allergies'
  if (isLongText) {
    return (
      <div>
        <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-1">{field.label} *</label>
        <textarea value={value} onChange={e => onChange(e.target.value)} rows={2}
                  placeholder={field.key === 'allergies' ? 'Drug and food allergies (or "NKDA" if none)' : field.key === 'current_medications' ? 'Current daily medications (or "None")' : 'Significant past medical history (or "None")'}
                  className="w-full px-3 py-2.5 border border-[#E8E8E4] rounded-lg text-[14px] outline-none focus:border-[#7F77DD] resize-none" />
      </div>
    )
  }

  const type = field.key === 'parent_phone' ? 'tel' : field.key === 'parent_email' ? 'email' : 'text'
  return <Input label={`${field.label} *`} type={type} value={value} onChange={e => onChange(e.target.value)} />
}
