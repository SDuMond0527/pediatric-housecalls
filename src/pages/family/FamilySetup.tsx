import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { Plus } from 'lucide-react'
import { updateMyFamily, createChild, lookupChild, familyUploadInsuranceCard } from '../../lib/api'
import { useFamilyAuth } from '../../contexts/FamilyAuthContext'
import { Button } from '../../components/ui/Button'
import { Input } from '../../components/ui/Input'
import { PracticeLogo } from '../../lib/practice'
import {
  ChildIntakeForm,
  emptyChild,
  childIsComplete,
  buildChildCreatePayload,
  type ChildEntry,
} from '../../components/ChildIntakeForm'

const US_STATES: [string, string][] = [
  ['AL','Alabama'],['AK','Alaska'],['AZ','Arizona'],['AR','Arkansas'],['CA','California'],
  ['CO','Colorado'],['CT','Connecticut'],['DE','Delaware'],['FL','Florida'],['GA','Georgia'],
  ['HI','Hawaii'],['ID','Idaho'],['IL','Illinois'],['IN','Indiana'],['IA','Iowa'],
  ['KS','Kansas'],['KY','Kentucky'],['LA','Louisiana'],['ME','Maine'],['MD','Maryland'],
  ['MA','Massachusetts'],['MI','Michigan'],['MN','Minnesota'],['MS','Mississippi'],['MO','Missouri'],
  ['MT','Montana'],['NE','Nebraska'],['NV','Nevada'],['NH','New Hampshire'],['NJ','New Jersey'],
  ['NM','New Mexico'],['NY','New York'],['NC','North Carolina'],['ND','North Dakota'],['OH','Ohio'],
  ['OK','Oklahoma'],['OR','Oregon'],['PA','Pennsylvania'],['RI','Rhode Island'],['SC','South Carolina'],
  ['SD','South Dakota'],['TN','Tennessee'],['TX','Texas'],['UT','Utah'],['VT','Vermont'],
  ['VA','Virginia'],['WA','Washington'],['WV','West Virginia'],['WI','Wisconsin'],['WY','Wyoming'],
]

export function FamilySetup() {
  const { user, loading, refreshFamily } = useFamilyAuth()
  const navigate = useNavigate()

  useEffect(() => {
    if (!loading && !user) navigate('/family/login')
  }, [user, loading])

  const [displayName, setDisplayName] = useState('')
  const [addressLine1, setAddressLine1] = useState('')
  const [city, setCity] = useState('')
  const [state, setState] = useState('')
  const [zip, setZip] = useState('')
  const [children, setChildren] = useState<ChildEntry[]>([emptyChild()])
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  const lookupTimers = useRef<Record<number, ReturnType<typeof setTimeout>>>({})

  function updateChildField(i: number, field: keyof ChildEntry, value: string | boolean) {
    setChildren(prev => prev.map((c, idx) => idx !== i ? c : { ...c, [field]: value } as ChildEntry))

    if (field === 'first_name' || field === 'last_name' || field === 'date_of_birth') {
      const updated = { ...children[i], [field]: value } as ChildEntry
      if (updated.first_name.trim() && updated.last_name.trim() && updated.date_of_birth) {
        clearTimeout(lookupTimers.current[i])
        lookupTimers.current[i] = setTimeout(async () => {
          try {
            const match = await lookupChild(updated.first_name.trim(), updated.last_name.trim(), updated.date_of_birth)
            setChildren(prev => prev.map((c, idx) => idx !== i ? c : { ...c, match: match ?? null, matchDismissed: false, matchConfirmed: false }))
          } catch { /* non-fatal */ }
        }, 600)
      }
    }
  }

  function confirmMatch(i: number) {
    setChildren(prev => prev.map((c, idx) => idx !== i ? c : { ...c, matchConfirmed: true, matchDismissed: false }))
  }
  function dismissMatch(i: number) {
    setChildren(prev => prev.map((c, idx) => idx !== i ? c : { ...c, matchDismissed: true, matchConfirmed: false }))
  }

  async function save() {
    setError('')

    if (!addressLine1.trim() || !city.trim() || !state || !zip) {
      setError('Please enter your full home address (street, city, state, zip).')
      return
    }
    if (zip.length < 5) { setError('Please enter a 5-digit zip code.'); return }

    if (children.length === 0) { setError('Please add at least one child.'); return }
    for (let i = 0; i < children.length; i++) {
      const missing = childIsComplete(children[i])
      if (missing) {
        setError(`Child ${i + 1}: ${missing} is required. Every field must be filled in before we can create your account.`)
        return
      }
    }

    setSaving(true)

    // Phone is required. Collected at signup and stashed in sessionStorage.
    let signupPhone = ''
    try { signupPhone = sessionStorage.getItem('phc_signup_phone') || '' } catch {}
    const digits = signupPhone.replace(/\D/g, '')
    if (digits.length < 10) {
      setError('A 10-digit phone number is required. Please go back to sign up and provide one.')
      setSaving(false)
      return
    }

    try {
      await updateMyFamily({
        email:         user!.email ?? null,
        display_name:  displayName || null,
        phone:         digits,
        address_line1: addressLine1.trim(),
        city:          city.trim(),
        state:         state,
        zip:           zip,
        practice_id:   import.meta.env.VITE_PRACTICE_ID || null,
      })
      try { sessionStorage.removeItem('phc_signup_phone') } catch {}
    } catch (e: any) {
      setError('Profile save failed: ' + (e?.message || String(e)))
      setSaving(false)
      return
    }

    try {
      const parent = { phone: digits, email: user!.email ?? null, address: addressLine1.trim(), city: city.trim(), state, zip }
      for (const child of children) {
        await createChild(buildChildCreatePayload(child, parent))
      }
    } catch (e: any) {
      setError('Child save failed: ' + (e?.message || String(e)))
      setSaving(false)
      return
    }

    try {
      await refreshFamily()
      navigate('/family/dashboard')
    } catch (e: any) {
      setError('Refresh failed: ' + (e?.message || String(e)))
      setSaving(false)
    }
  }

  return (
    <div className="min-h-screen bg-[#FAFAF8] flex items-start justify-center p-4 pt-12">
      <div className="w-full max-w-2xl">
        <div className="text-center mb-8">
          <div className="font-display text-2xl font-medium text-[#1A1A2E] mb-1">
            <PracticeLogo />
          </div>
          <p className="text-[13px] text-[#999] mt-1">Let's set up your family profile</p>
        </div>

        <div className="bg-white border border-[#E8E8E4] rounded-xl shadow-sm p-7 space-y-5">
          <div>
            <h2 className="font-display text-lg font-medium text-[#1A1A2E] mb-3">Your family</h2>
            <div className="mb-3">
              <Input label="Family display name (optional)"
                placeholder="e.g. The Smith Family, or just your first name"
                value={displayName} onChange={e => setDisplayName(e.target.value)} />
              <p className="text-[11px] text-[#aeaeb2] mt-1">This is just how we'll greet you in the portal.</p>
            </div>
            <div className="space-y-3">
              <Input label="Home street address *" placeholder="123 Main St"
                value={addressLine1} onChange={e => setAddressLine1(e.target.value)} />
              <div className="grid grid-cols-3 gap-3">
                <Input label="City *" placeholder="Charlotte"
                  value={city} onChange={e => setCity(e.target.value)} />
                <div>
                  <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-1">State *</label>
                  <select value={state} onChange={e => setState(e.target.value)}
                    className="w-full px-3 py-2.5 border border-[#E8E8E4] rounded-lg text-[14px] font-sans bg-white">
                    <option value="">Select</option>
                    {US_STATES.map(([code, name]) => <option key={code} value={code}>{name}</option>)}
                  </select>
                </div>
                <Input label="Zip *" placeholder="28078" maxLength={5} value={zip} onChange={e => setZip(e.target.value)} />
              </div>
            </div>
          </div>

          <div className="border-t border-[#E8E8E4] pt-5">
            <div className="flex items-center justify-between mb-1">
              <h2 className="font-display text-lg font-medium text-[#1A1A2E]">Children</h2>
              <button onClick={() => setChildren(prev => [...prev, emptyChild()])}
                className="flex items-center gap-1.5 text-[12px] text-[#7F77DD] font-medium hover:underline">
                <Plus size={13} /> Add another
              </button>
            </div>
            <p className="text-[12px] text-[#999] mb-4">
              We need a complete profile for each child — allergies, medications, insurance, and everything on the intake form.
              This lets us prescribe medications, order labs, and file insurance claims from your very first visit.
            </p>

            <div className="space-y-6">
              {children.map((child, i) => (
                <ChildIntakeForm
                  key={i}
                  index={i}
                  child={child}
                  removable={children.length > 1}
                  uploadCard={(f, s) => familyUploadInsuranceCard(user?.id || user?.email || 'unknown', f, s)}
                  onField={(k, v) => updateChildField(i, k, v)}
                  onRemove={() => setChildren(prev => prev.filter((_, idx) => idx !== i))}
                  onConfirmMatch={() => confirmMatch(i)}
                  onDismissMatch={() => dismissMatch(i)}
                />
              ))}
            </div>
          </div>

          {error && <div className="p-3 rounded-lg bg-[#FCEBEB] text-[13px] text-[#791F1F]">{error}</div>}

          <Button className="w-full !py-2.5" loading={saving} onClick={save}>Save and continue</Button>
          <p className="text-[11px] text-[#999] text-center">
            Nothing is saved until every field is complete. If any field is missing we'll tell you which one — we never create a half-empty chart.
          </p>
        </div>
      </div>
    </div>
  )
}
