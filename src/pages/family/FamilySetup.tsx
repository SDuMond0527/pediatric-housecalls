import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { Plus, Trash2, CheckCircle2 } from 'lucide-react'
import { updateMyFamily, createChild, lookupChild } from '../../lib/api'
import { useFamilyAuth } from '../../contexts/FamilyAuthContext'
import { Button } from '../../components/ui/Button'
import { Input } from '../../components/ui/Input'
import { PracticeLogo } from '../../lib/practice'
import { format, parseISO } from 'date-fns'

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

type ChildEntry = {
  first_name: string
  last_name: string
  date_of_birth: string
  match: { id: string; first_name: string; last_name: string; date_of_birth: string; parent_phone: string | null; parent_email: string | null; parent_address: string | null } | null
  matchDismissed: boolean
  matchConfirmed: boolean
}

function emptyChild(): ChildEntry {
  return { first_name: '', last_name: '', date_of_birth: '', match: null, matchDismissed: false, matchConfirmed: false }
}

export function FamilySetup() {
  const { user, loading, refreshFamily } = useFamilyAuth()
  const navigate = useNavigate()

  useEffect(() => {
    if (!loading && !user) navigate('/family/login')
  }, [user, loading])

  const [displayName, setDisplayName] = useState('')
  const [state, setState] = useState('')
  const [zip, setZip] = useState('')
  const [children, setChildren] = useState<ChildEntry[]>([emptyChild()])
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  const lookupTimers = useRef<Record<number, ReturnType<typeof setTimeout>>>({})

  function updateChild(i: number, field: keyof ChildEntry, value: string) {
    setChildren(prev => prev.map((c, idx) => idx !== i ? c : { ...c, [field]: value, match: null, matchDismissed: false, matchConfirmed: false }))

    // Trigger lookup when all three fields are filled
    const updated = { ...children[i], [field]: value }
    if (updated.first_name.trim() && updated.last_name.trim() && updated.date_of_birth) {
      clearTimeout(lookupTimers.current[i])
      lookupTimers.current[i] = setTimeout(async () => {
        try {
          const match = await lookupChild(updated.first_name.trim(), updated.last_name.trim(), updated.date_of_birth)
          setChildren(prev => prev.map((c, idx) => idx !== i ? c : { ...c, match: match ?? null }))
        } catch { /* lookup failure is non-fatal */ }
      }, 600)
    }
  }

  function confirmMatch(i: number) {
    setChildren(prev => prev.map((c, idx) => idx !== i ? c : { ...c, matchConfirmed: true, matchDismissed: false }))
  }

  function dismissMatch(i: number) {
    setChildren(prev => prev.map((c, idx) => idx !== i ? c : { ...c, matchDismissed: true, matchConfirmed: false }))
  }

  async function save() {
    if (!state || !zip) { setError('Please select your state and enter your zip code.'); return }
    const valid = children.filter(c => c.first_name.trim())
    if (!valid.length) { setError('Please add at least one child.'); return }
    setSaving(true)
    setError('')

    try {
      await updateMyFamily({
        email:        user!.email ?? null,
        display_name: displayName || null,
        state:        state || null,
        zip:          zip || null,
        practice_id:  import.meta.env.VITE_PRACTICE_ID || null,
      })
    } catch (e: any) {
      setError('Profile save failed: ' + (e?.message || String(e)))
      setSaving(false)
      return
    }

    try {
      for (const child of valid) {
        await createChild({
          first_name:    child.first_name.trim() || null,
          last_name:     child.last_name.trim()  || null,
          date_of_birth: child.date_of_birth     || null,
          display_label: [child.first_name.trim(), child.last_name.trim()].filter(Boolean).join(' ') || null,
        })
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
      <div className="w-full max-w-md">
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
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-1">State</label>
                <select value={state} onChange={e => setState(e.target.value)}
                  className="w-full px-3 py-2.5 border border-[#E8E8E4] rounded-lg text-[14px] font-sans bg-white">
                  <option value="">Select state</option>
                  {US_STATES.map(([code, name]) => <option key={code} value={code}>{name}</option>)}
                </select>
              </div>
              <Input label="Zip code" placeholder="28078" maxLength={5} value={zip} onChange={e => setZip(e.target.value)} />
            </div>
            <p className="text-[11px] text-[#aeaeb2] mt-2">Your state and zip are used to match you with providers in your area.</p>
          </div>

          <div className="border-t border-[#E8E8E4] pt-5">
            <div className="flex items-center justify-between mb-1">
              <h2 className="font-display text-lg font-medium text-[#1A1A2E]">Children</h2>
              <button onClick={() => setChildren(prev => [...prev, emptyChild()])}
                className="flex items-center gap-1.5 text-[12px] text-[#7F77DD] font-medium hover:underline">
                <Plus size={13} /> Add another
              </button>
            </div>
            <p className="text-[12px] text-[#999] mb-4">Enter your child's legal name and date of birth.</p>

            <div className="space-y-4">
              {children.map((child, i) => {
                const showMatch = child.match && !child.matchDismissed
                return (
                  <div key={i} className="space-y-2">
                    <div className="grid grid-cols-2 gap-2">
                      <Input label="First name *" placeholder="Emma"
                        value={child.first_name} onChange={e => updateChild(i, 'first_name', e.target.value)} />
                      <Input label="Last name" placeholder="Smith"
                        value={child.last_name} onChange={e => updateChild(i, 'last_name', e.target.value)} />
                    </div>
                    <div className="flex items-end gap-2">
                      <div className="flex-1">
                        <Input label="Date of birth" type="date"
                          value={child.date_of_birth} onChange={e => updateChild(i, 'date_of_birth', e.target.value)} />
                      </div>
                      {children.length > 1 && (
                        <button onClick={() => setChildren(prev => prev.filter((_, idx) => idx !== i))}
                          className="p-2 mb-0.5 text-[#999] hover:text-[#791F1F]">
                          <Trash2 size={14} />
                        </button>
                      )}
                    </div>

                    {/* Existing profile match */}
                    {showMatch && !child.matchConfirmed && (
                      <div className="rounded-xl border border-[#7F77DD] bg-[#EEEDFE] p-4 space-y-3">
                        <p className="text-[13px] font-semibold text-[#3C3489]">We found an existing patient profile — is this your child?</p>
                        <div className="space-y-1 text-[13px] text-[#1A1A2E]">
                          <div><span className="text-[#555]">Name: </span><strong>{child.match!.first_name} {child.match!.last_name}</strong></div>
                          <div><span className="text-[#555]">Date of birth: </span><strong>{format(parseISO(String(child.match!.date_of_birth).split('T')[0]), 'MMMM d, yyyy')}</strong></div>
                          {child.match!.parent_phone && <div><span className="text-[#555]">Phone: </span><strong>{child.match!.parent_phone}</strong></div>}
                          {child.match!.parent_email && <div><span className="text-[#555]">Email: </span><strong>{child.match!.parent_email}</strong></div>}
                          {child.match!.parent_address && <div><span className="text-[#555]">Address: </span><strong>{child.match!.parent_address}</strong></div>}
                        </div>
                        <div className="flex gap-2 pt-1">
                          <Button variant="primary" size="sm" onClick={() => confirmMatch(i)}>
                            <CheckCircle2 size={13} /> Yes, that's my child
                          </Button>
                          <Button variant="secondary" size="sm" onClick={() => dismissMatch(i)}>
                            No, create new profile
                          </Button>
                        </div>
                      </div>
                    )}

                    {child.matchConfirmed && (
                      <div className="rounded-lg bg-[#E1F5EE] border border-[#5DCAA5] px-3 py-2 flex items-center gap-2 text-[13px] text-[#085041]">
                        <CheckCircle2 size={14} /> Existing profile will be linked to your account.
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>

          {error && <div className="p-3 rounded-lg bg-[#FCEBEB] text-[13px] text-[#791F1F]">{error}</div>}

          <Button className="w-full !py-2.5" loading={saving} onClick={save}>Save and continue</Button>
        </div>
      </div>
    </div>
  )
}
