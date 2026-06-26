import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { Plus, Trash2 } from 'lucide-react'
import { updateMyFamily, createChild } from '../../lib/api'
import { useFamilyAuth } from '../../contexts/FamilyAuthContext'
import { Button } from '../../components/ui/Button'
import { Input } from '../../components/ui/Input'

export function FamilySetup() {
  const { user, loading, refreshFamily } = useFamilyAuth()
  const navigate = useNavigate()

  useEffect(() => {
    if (!loading && !user) navigate('/family/login')
  }, [user, loading])
  const [displayName, setDisplayName] = useState('')
  const [state, setState] = useState('')
  const [zip, setZip] = useState('')
  const [labels, setLabels] = useState([''])
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  function setLabel(i: number, v: string) {
    setLabels(prev => prev.map((l, idx) => idx === i ? v : l))
  }

  async function save() {
    if (!state || !zip) { setError('Please select your state and enter your zip code.'); return }
    const validLabels = labels.filter(l => l.trim())
    if (!validLabels.length) { setError('Please add at least one child.'); return }
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
      for (const label of validLabels) {
        await createChild({ display_label: label.trim() })
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
            Pediatric<span style={{ color: '#7F77DD' }}>Housecalls</span>
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
                  <option value="NC">North Carolina</option>
                  <option value="SC">South Carolina</option>
                  <option value="VA">Virginia</option>
                </select>
              </div>
              <Input label="Zip code" placeholder="28078" maxLength={5} value={zip} onChange={e => setZip(e.target.value)} />
            </div>
            <p className="text-[11px] text-[#aeaeb2] mt-2">Your state and zip are used to match you with providers in your area.</p>
          </div>

          <div className="border-t border-[#E8E8E4] pt-5">
            <div className="flex items-center justify-between mb-3">
              <h2 className="font-display text-lg font-medium text-[#1A1A2E]">Children</h2>
              <button onClick={() => setLabels(prev => [...prev, ''])}
                className="flex items-center gap-1.5 text-[12px] text-[#7F77DD] font-medium hover:underline">
                <Plus size={13} /> Add another
              </button>
            </div>
            <p className="text-[12px] text-[#999] mb-3">Add a name or label for each child so you can identify them when booking.</p>
            <div className="space-y-2">
              {labels.map((label, i) => (
                <div key={i} className="flex items-center gap-2">
                  <div className="flex-1">
                    <Input placeholder={`e.g. Emma, my son, Child ${i + 1}`}
                      value={label} onChange={e => setLabel(i, e.target.value)} />
                  </div>
                  {labels.length > 1 && (
                    <button onClick={() => setLabels(prev => prev.filter((_, idx) => idx !== i))}
                      className="p-2 text-[#999] hover:text-[#791F1F] flex-shrink-0">
                      <Trash2 size={14} />
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>

          {error && <div className="p-3 rounded-lg bg-[#FCEBEB] text-[13px] text-[#791F1F]">{error}</div>}

          <Button className="w-full !py-2.5" loading={saving} onClick={save}>Save and continue</Button>
        </div>
      </div>
    </div>
  )
}
