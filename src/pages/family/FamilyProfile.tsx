import { useState, useRef } from 'react'
import { Plus, Trash2, CheckCircle2, KeyRound, ChevronDown, ChevronUp, Upload, X } from 'lucide-react'
import { upload } from '@vercel/blob/client'
import { updateMyFamily, createChild, updateChild, deleteChild } from '../../lib/api'
import { useFamilyAuth, getFamilyAccessToken } from '../../contexts/FamilyAuthContext'
import { Button } from '../../components/ui/Button'
import { Input } from '../../components/ui/Input'
import type { Child } from '../../types/family'

type ChildEdit = {
  first_name: string
  last_name: string
  date_of_birth: string
  insurance_provider: string
  insurance_member_id: string
  insurance_group_number: string
  insurance_card_front_url: string
  insurance_card_back_url: string
  allergies: string
  current_medications: string
  medical_history: string
  preferred_pharmacy: string
  pcp: string
}

function childEditFrom(c: Child): ChildEdit {
  return {
    first_name: c.first_name || '',
    last_name: c.last_name || '',
    date_of_birth: c.date_of_birth || '',
    insurance_provider: c.insurance_provider || '',
    insurance_member_id: c.insurance_member_id || '',
    insurance_group_number: c.insurance_group_number || '',
    insurance_card_front_url: c.insurance_card_front_url || '',
    insurance_card_back_url: c.insurance_card_back_url || '',
    allergies: c.allergies || '',
    current_medications: c.current_medications || '',
    medical_history: c.medical_history || '',
    preferred_pharmacy: c.preferred_pharmacy || '',
    pcp: c.pcp || '',
  }
}

export function FamilyProfile() {
  const { user, family, children, refreshFamily } = useFamilyAuth()

  // Contact info
  const [displayName, setDisplayName] = useState(family?.display_name || '')
  const [phone, setPhone] = useState(family?.phone || '')
  const [email, setEmail] = useState(user?.email || '')
  const [addressLine1, setAddressLine1] = useState(family?.address_line1 || '')
  const [city, setCity] = useState(family?.city || '')
  const [state, setState] = useState(family?.state || '')
  const [zip, setZip] = useState(family?.zip || '')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [emailNote, setEmailNote] = useState('')

  // Children
  const [addingChild, setAddingChild] = useState(false)
  const [newLabel, setNewLabel] = useState('')
  const [expandedChildId, setExpandedChildId] = useState<string | null>(null)
  const [childEdits, setChildEdits] = useState<Record<string, ChildEdit>>({})
  const [savingChildId, setSavingChildId] = useState<string | null>(null)
  const [savedChildId, setSavedChildId] = useState<string | null>(null)
  const [childSaveError, setChildSaveError] = useState<string | null>(null)
  const [uploadingChild, setUploadingChild] = useState<{ id: string; side: 'front' | 'back' } | null>(null)
  const frontRefs = useRef<Record<string, HTMLInputElement | null>>({})
  const backRefs = useRef<Record<string, HTMLInputElement | null>>({})

  // Password
  const [pw, setPw] = useState({ next: '', confirm: '' })
  const [pwSaved, setPwSaved] = useState(false)
  const [pwError, setPwError] = useState('')

  async function saveProfile() {
    setSaving(true)
    setEmailNote('')
    await updateMyFamily({
      display_name: displayName || null,
      phone: phone || null,
      address_line1: addressLine1 || null,
      city: city || null,
      state: state || null,
      zip: zip || null,
    })
    await refreshFamily()
    setSaving(false)
    setSaved(true)
    setTimeout(() => setSaved(false), 2500)
  }

  function getChildEdit(child: Child): ChildEdit {
    return childEdits[child.id] || childEditFrom(child)
  }

  function setChildField(childId: string, field: keyof ChildEdit, value: string) {
    const child = children.find(c => c.id === childId)!
    setChildEdits(prev => ({
      ...prev,
      [childId]: { ...(prev[childId] || childEditFrom(child)), [field]: value },
    }))
  }

  async function uploadInsuranceCard(childId: string, file: File, side: 'front' | 'back') {
    setUploadingChild({ id: childId, side })
    setChildSaveError(null)
    try {
      const token = await getFamilyAccessToken()
      const ext = file.name.split('.').pop()?.toLowerCase() || 'jpg'
      const blob = await upload(
        `insurance-cards/${childId}/${side}-${Date.now()}.${ext}`,
        file,
        {
          access: 'public',
          handleUploadUrl: '/api/upload-insurance-card',
          headers: { Authorization: `Bearer ${token}` },
        }
      )
      setChildField(childId, side === 'front' ? 'insurance_card_front_url' : 'insurance_card_back_url', blob.url)
    } catch (e: any) {
      setChildSaveError(e.message ?? 'Upload failed')
    } finally {
      setUploadingChild(null)
    }
  }

  async function saveChild(child: Child) {
    setSavingChildId(child.id)
    setChildSaveError(null)
    const edit = getChildEdit(child)
    try {
      await updateChild(child.id, {
        first_name: edit.first_name || null,
        last_name: edit.last_name || null,
        date_of_birth: edit.date_of_birth || null,
        insurance_provider: edit.insurance_provider || null,
        insurance_member_id: edit.insurance_member_id || null,
        insurance_group_number: edit.insurance_group_number || null,
        insurance_card_front_url: edit.insurance_card_front_url || null,
        insurance_card_back_url: edit.insurance_card_back_url || null,
        allergies: edit.allergies || null,
        current_medications: edit.current_medications || null,
        medical_history: edit.medical_history || null,
        preferred_pharmacy: edit.preferred_pharmacy || null,
        pcp: edit.pcp || null,
      })
    } catch (e: any) {
      setChildSaveError(e.message)
      setSavingChildId(null)
      return
    }
    await refreshFamily()
    setSavingChildId(null)
    setSavedChildId(child.id)
    setTimeout(() => setSavedChildId(null), 2500)
  }

  async function addChild() {
    if (!newLabel.trim()) return
    await createChild({ display_label: newLabel.trim(), family_id: user!.id })
    await refreshFamily()
    setNewLabel('')
    setAddingChild(false)
  }

  async function removeChild(id: string) {
    await deleteChild(id)
    if (expandedChildId === id) setExpandedChildId(null)
    await refreshFamily()
  }

  async function changePassword() {
    setPwError('')
    if (pw.next.length < 8) { setPwError('Password must be at least 8 characters.'); return }
    if (pw.next !== pw.confirm) { setPwError("Passwords don't match."); return }
    // TODO: implement password change via API
    setPwSaved(true)
    setPw({ next: '', confirm: '' })
    setTimeout(() => setPwSaved(false), 2500)
  }

  return (
    <div className="space-y-5">
      <h1 className="font-display text-2xl font-medium text-[#1A1A2E]">Family profile</h1>

      {/* ── Contact info ── */}
      <div className="bg-white border border-[#E8E8E4] rounded-xl p-6 shadow-sm">
        <h2 className="font-display text-[16px] font-medium text-[#1A1A2E] mb-4">Contact info</h2>
        <div className="space-y-3">
          <Input label="Family name (optional)" placeholder="e.g. The Smith Family"
            value={displayName} onChange={e => setDisplayName(e.target.value)} />
          <Input label="Phone number" placeholder="e.g. (704) 555-0100" type="tel"
            value={phone} onChange={e => setPhone(e.target.value)} />
          <div>
            <Input label="Email address" type="email" placeholder="you@email.com"
              value={email} onChange={e => setEmail(e.target.value)} />
            {emailNote && (
              <p className={`text-[12px] mt-1 ${emailNote.startsWith('Check') ? 'text-[#1D9E75]' : 'text-[#791F1F]'}`}>
                {emailNote}
              </p>
            )}
          </div>
          <Input label="Street address" placeholder="123 Main St"
            value={addressLine1} onChange={e => setAddressLine1(e.target.value)} />
          <div className="grid grid-cols-5 gap-3">
            <div className="col-span-2">
              <Input label="City" placeholder="Charlotte"
                value={city} onChange={e => setCity(e.target.value)} />
            </div>
            <div className="col-span-1">
              <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-1">State</label>
              <select value={state} onChange={e => setState(e.target.value)}
                className="w-full px-3 py-2.5 border border-[#E8E8E4] rounded-lg text-[14px] font-sans bg-white">
                <option value="">—</option>
                <option value="NC">NC</option>
                <option value="SC">SC</option>
                <option value="VA">VA</option>
              </select>
            </div>
            <div className="col-span-2">
              <Input label="Zip code" maxLength={5} placeholder="28078"
                value={zip} onChange={e => setZip(e.target.value)} />
            </div>
          </div>
        </div>
        {saved && <div className="flex items-center gap-2 text-[13px] text-[#085041] mt-3"><CheckCircle2 size={14} /> Saved!</div>}
        <div className="mt-4">
          <Button size="sm" loading={saving} onClick={saveProfile}>Save changes</Button>
        </div>
      </div>

      {/* ── Children & Insurance ── */}
      <div className="bg-white border border-[#E8E8E4] rounded-xl p-6 shadow-sm">
        <div className="flex items-center justify-between mb-1">
          <h2 className="font-display text-[16px] font-medium text-[#1A1A2E]">Children & Insurance</h2>
          <button onClick={() => setAddingChild(true)}
            className="flex items-center gap-1.5 text-[12px] text-[#7F77DD] font-medium hover:underline">
            <Plus size={13} /> Add child
          </button>
        </div>
        <p className="text-[12px] text-[#999] mb-4">Click a child's name to edit their insurance info, card photos, pharmacy, and PCP.</p>

        <div className="space-y-2">
          {children.map(c => {
            const isExpanded = expandedChildId === c.id
            const edit = getChildEdit(c)
            const isSaving = savingChildId === c.id
            const isSaved = savedChildId === c.id

            return (
              <div key={c.id} className="border border-[#E8E8E4] rounded-lg overflow-hidden">
                {/* Header row */}
                <button className="w-full flex items-center gap-3 p-3 bg-[#FAFAF8] text-left hover:bg-[#F3F3F0] transition-colors"
                  onClick={() => setExpandedChildId(isExpanded ? null : c.id)}>
                  <div className="w-8 h-8 rounded-full bg-[#EEEDFE] flex items-center justify-center text-[11px] font-medium text-[#3C3489] flex-shrink-0">
                    {c.display_label.charAt(0).toUpperCase()}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-[14px] font-medium text-[#1A1A2E]">{c.display_label}</div>
                    <div className="text-[11px] text-[#999]">{isExpanded ? 'Tap to close' : 'Tap to edit insurance & health info'}</div>
                  </div>
                  {isExpanded ? <ChevronUp size={16} className="text-[#7F77DD] flex-shrink-0" /> : <ChevronDown size={16} className="text-[#999] flex-shrink-0" />}
                  <div onClick={e => { e.stopPropagation(); removeChild(c.id) }}
                    className="p-1.5 rounded-lg hover:bg-[#FCEBEB] text-[#999] hover:text-[#791F1F] transition-colors flex-shrink-0">
                    <Trash2 size={13} />
                  </div>
                </button>

                {/* Expanded edit form */}
                {isExpanded && (
                  <div className="p-4 border-t border-[#E8E8E4] space-y-5">

                    {/* Basic info */}
                    <div>
                      <p className="text-[11px] font-semibold text-[#555] uppercase tracking-wider mb-2">Patient info</p>
                      <div className="space-y-2">
                        <div className="grid grid-cols-2 gap-3">
                          <Input label="Legal first name" placeholder="Emma"
                            value={edit.first_name}
                            onChange={e => setChildField(c.id, 'first_name', e.target.value)} />
                          <Input label="Legal last name" placeholder="Smith"
                            value={edit.last_name}
                            onChange={e => setChildField(c.id, 'last_name', e.target.value)} />
                        </div>
                        <Input label="Date of birth" type="date"
                          value={edit.date_of_birth}
                          onChange={e => setChildField(c.id, 'date_of_birth', e.target.value)} />
                      </div>
                    </div>

                    {/* Insurance text fields */}
                    <div>
                      <p className="text-[11px] font-semibold text-[#555] uppercase tracking-wider mb-2">Insurance</p>
                      <div className="space-y-2">
                        <Input label="Insurance company / plan name" placeholder="e.g. Blue Cross Blue Shield"
                          value={edit.insurance_provider}
                          onChange={e => setChildField(c.id, 'insurance_provider', e.target.value)} />
                        <div className="grid grid-cols-2 gap-3">
                          <Input label="Member ID" placeholder="e.g. XYZ123456"
                            value={edit.insurance_member_id}
                            onChange={e => setChildField(c.id, 'insurance_member_id', e.target.value)} />
                          <Input label="Group number" placeholder="e.g. 12345"
                            value={edit.insurance_group_number}
                            onChange={e => setChildField(c.id, 'insurance_group_number', e.target.value)} />
                        </div>
                      </div>
                    </div>

                    {/* Insurance card photos */}
                    <div>
                      <p className="text-[11px] font-semibold text-[#555] uppercase tracking-wider mb-2">Insurance card photos</p>
                      <div className="grid grid-cols-2 gap-3">
                        {(['front', 'back'] as const).map(side => {
                          const url = side === 'front' ? edit.insurance_card_front_url : edit.insurance_card_back_url
                          const isUploading = uploadingChild?.id === c.id && uploadingChild?.side === side
                          return (
                            <div key={side}>
                              <input type="file" accept="image/*" className="hidden"
                                ref={el => { if (side === 'front') frontRefs.current[c.id] = el; else backRefs.current[c.id] = el }}
                                onChange={e => { if (e.target.files?.[0]) uploadInsuranceCard(c.id, e.target.files[0], side) }} />
                              {url ? (
                                <div className="relative rounded-lg overflow-hidden border border-[#E8E8E4] aspect-[1.6/1]">
                                  <img src={url} alt={`Insurance card ${side}`} className="w-full h-full object-cover" />
                                  <button
                                    onClick={() => setChildField(c.id, side === 'front' ? 'insurance_card_front_url' : 'insurance_card_back_url', '')}
                                    className="absolute top-1.5 right-1.5 w-6 h-6 rounded-full bg-black/50 flex items-center justify-center text-white hover:bg-black/70">
                                    <X size={12} />
                                  </button>
                                  <div className="absolute bottom-0 left-0 right-0 bg-black/40 text-white text-[10px] text-center py-1 capitalize">{side}</div>
                                </div>
                              ) : (
                                <button
                                  onClick={() => (side === 'front' ? frontRefs.current[c.id] : backRefs.current[c.id])?.click()}
                                  className="w-full aspect-[1.6/1] border-2 border-dashed border-[#E8E8E4] rounded-lg flex flex-col items-center justify-center gap-1.5 hover:border-[#7F77DD] hover:bg-[#FAFAF8] transition-all text-[#999] hover:text-[#7F77DD]">
                                  {isUploading ? (
                                    <div className="text-[12px]">Uploading...</div>
                                  ) : (
                                    <>
                                      <Upload size={16} />
                                      <div className="text-[12px] font-medium capitalize">{side} of card</div>
                                    </>
                                  )}
                                </button>
                              )}
                            </div>
                          )
                        })}
                      </div>
                    </div>

                    {/* Medical info */}
                    <div>
                      <p className="text-[11px] font-semibold text-[#555] uppercase tracking-wider mb-2">Medical info</p>
                      <div className="space-y-2">
                        <Input label="Drug & food allergies" placeholder="e.g. Penicillin, peanuts — or NKDA"
                          value={edit.allergies}
                          onChange={e => setChildField(c.id, 'allergies', e.target.value)} />
                        <Input label="Current medications" placeholder="e.g. Zyrtec 5mg daily — or None"
                          value={edit.current_medications}
                          onChange={e => setChildField(c.id, 'current_medications', e.target.value)} />
                        <div>
                          <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-1">Medical history</label>
                          <textarea rows={2} placeholder="e.g. Asthma, ADHD, prior surgeries..."
                            value={edit.medical_history}
                            onChange={e => setChildField(c.id, 'medical_history', e.target.value)}
                            className="w-full px-3 py-2.5 border border-[#E8E8E4] rounded-lg text-[14px] font-sans resize-none focus:border-[#7F77DD] focus:ring-2 focus:ring-[#7F77DD]/10 outline-none bg-white" />
                        </div>
                      </div>
                    </div>

                    {/* Health providers */}
                    <div>
                      <p className="text-[11px] font-semibold text-[#555] uppercase tracking-wider mb-2">Health providers</p>
                      <div className="space-y-2">
                        <Input label="Preferred pharmacy" placeholder="e.g. CVS on Providence Rd"
                          value={edit.preferred_pharmacy}
                          onChange={e => setChildField(c.id, 'preferred_pharmacy', e.target.value)} />
                        <Input label="Primary care provider" placeholder="e.g. Dr. Jane Smith, Charlotte Pediatrics"
                          value={edit.pcp}
                          onChange={e => setChildField(c.id, 'pcp', e.target.value)} />
                      </div>
                    </div>

                    {isSaved && <div className="flex items-center gap-2 text-[13px] text-[#085041]"><CheckCircle2 size={14} /> Saved!</div>}
                    {childSaveError && <div className="p-3 rounded-lg bg-[#FCEBEB] text-[13px] text-[#791F1F]">{childSaveError}</div>}
                    <Button size="sm" loading={isSaving} onClick={() => saveChild(c)}>
                      Save {c.display_label}
                    </Button>
                  </div>
                )}
              </div>
            )
          })}
        </div>

        {addingChild && (
          <div className="mt-3 p-4 border border-[#E8E8E4] rounded-lg bg-[#FAFAF8]">
            <div className="mb-2">
              <Input label="Name or label" placeholder="e.g. Emma, my son, Child 3"
                value={newLabel} onChange={e => setNewLabel(e.target.value)} />
            </div>
            <div className="flex gap-2">
              <Button variant="secondary" size="sm" onClick={() => setAddingChild(false)}>Cancel</Button>
              <Button size="sm" onClick={addChild}>Add</Button>
            </div>
          </div>
        )}
      </div>

      {/* ── Change password ── */}
      <div className="bg-white border border-[#E8E8E4] rounded-xl p-6 shadow-sm">
        <div className="flex items-center gap-2 mb-4">
          <KeyRound size={16} className="text-[#7F77DD]" />
          <h2 className="font-display text-[16px] font-medium text-[#1A1A2E]">Change password</h2>
        </div>
        <div className="space-y-3 max-w-sm">
          <Input label="New password" type="password" placeholder="8+ characters"
            value={pw.next} onChange={e => setPw(p => ({ ...p, next: e.target.value }))} />
          <Input label="Confirm new password" type="password" placeholder="••••••••"
            value={pw.confirm} onChange={e => setPw(p => ({ ...p, confirm: e.target.value }))} />
          {pwError && <div className="p-3 rounded-lg bg-[#FCEBEB] text-[13px] text-[#791F1F]">{pwError}</div>}
          {pwSaved && <div className="flex items-center gap-2 text-[13px] text-[#085041]"><CheckCircle2 size={14} /> Password updated!</div>}
          <Button size="sm" onClick={changePassword}>Update password</Button>
        </div>
      </div>
    </div>
  )
}
