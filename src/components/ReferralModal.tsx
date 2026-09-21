import { useEffect, useState } from 'react'
import { X, Send, AlertCircle, CheckCircle2, Clock, Plus, Paperclip } from 'lucide-react'
import { Button } from './ui/Button'
import {
  getSpecialists, createSpecialist, sendReferral, getReferralsForChild, getEncounterNotes,
  type Specialist, type Referral,
} from '../lib/api'

// Shape of the encounter notes we need for the attachment checklist.
// We only render + send the fields we need; API returns more.
interface AttachableNote {
  id: string
  scheduled_date: string | null
  visit_type: string | null
  is_signed: boolean
}

// "New referral" flow from a patient chart. Sara 2026-09-21.
// Loads the specialist directory, lets the biller pick one (or add
// a new one inline if the directory is missing them), fills in the
// reason + clinical summary + urgency, and fires the fax.
//
// Also shows a history strip of past referrals for this patient so
// the biller doesn't accidentally double-send the same referral.

export function ReferralModal({
  childId, childName, onClose,
}: {
  childId: string
  childName: string
  onClose: () => void
}) {
  const [specialists, setSpecialists] = useState<Specialist[]>([])
  const [history, setHistory]         = useState<Referral[]>([])
  const [notes, setNotes]             = useState<AttachableNote[]>([])
  const [loading, setLoading]         = useState(true)
  const [error, setError]             = useState<string | null>(null)

  const [specialistId, setSpecialistId]         = useState('')
  const [reason, setReason]                     = useState('')
  const [clinicalSummary, setClinicalSummary]   = useState('')
  const [urgency, setUrgency]                   = useState<'routine' | 'urgent' | 'stat'>('routine')
  const [sending, setSending]                   = useState(false)
  const [justSent, setJustSent]                 = useState<Referral | null>(null)

  // Attachment selections. Demographics + insurance default ON since
  // most referrals want them; individual note checkboxes default OFF.
  const [includeDemographics, setIncludeDemographics] = useState(true)
  const [includeInsurance, setIncludeInsurance]       = useState(true)
  const [selectedNoteIds, setSelectedNoteIds]         = useState<Set<string>>(new Set())

  // Inline "add specialist" — for the case where the biller realizes
  // mid-referral that this specialist isn't in the directory yet.
  const [addingSpecialist, setAddingSpecialist] = useState(false)
  const [newSpec, setNewSpec] = useState({ name: '', specialty: '', fax_number: '', phone: '', address: '' })
  const [addingSaving, setAddingSaving]         = useState(false)

  useEffect(() => {
    let cancelled = false
    Promise.all([
      getSpecialists(),
      getReferralsForChild(childId),
      getEncounterNotes({ child_id: childId }),
    ])
      .then(([s, h, n]) => {
        if (cancelled) return
        setSpecialists(s ?? [])
        setHistory(h ?? [])
        setNotes((n ?? []).map((row: any) => ({
          id: row.id,
          scheduled_date: row.scheduled_date ? String(row.scheduled_date).split('T')[0] : null,
          visit_type: row.visit_type,
          is_signed: !!row.is_signed,
        })))
        setLoading(false)
      })
      .catch(e => { if (!cancelled) { setError(e?.message ?? 'Failed to load'); setLoading(false) } })
    return () => { cancelled = true }
  }, [childId])

  function toggleNote(id: string) {
    setSelectedNoteIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  const activeSpecialists = specialists.filter(s => s.is_active)
  const selectedSpec = activeSpecialists.find(s => s.id === specialistId)
  const specHasNoFax = selectedSpec && !selectedSpec.fax_number

  async function handleAddSpecialist() {
    if (!newSpec.name.trim()) return
    setAddingSaving(true); setError(null)
    try {
      const created = await createSpecialist({
        name: newSpec.name.trim(),
        specialty: newSpec.specialty.trim() || null,
        phone: newSpec.phone.trim() || null,
        fax_number: newSpec.fax_number.trim() || null,
        address: newSpec.address.trim() || null,
      })
      setSpecialists(prev => [...prev, created])
      setSpecialistId(created.id)
      setAddingSpecialist(false)
      setNewSpec({ name: '', specialty: '', fax_number: '', phone: '', address: '' })
    } catch (e: any) { setError(e?.message ?? 'Failed to add specialist') }
    finally { setAddingSaving(false) }
  }

  async function handleSend() {
    if (!specialistId || !reason.trim()) return
    setSending(true); setError(null)
    try {
      const created = await sendReferral({
        child_id: childId,
        specialist_id: specialistId,
        reason: reason.trim(),
        clinical_summary: clinicalSummary.trim(),
        urgency,
        attachments: {
          include_demographics: includeDemographics,
          include_insurance: includeInsurance,
          encounter_note_ids: Array.from(selectedNoteIds),
        },
      })
      setJustSent(created)
      setHistory(prev => [created, ...prev])
    } catch (e: any) { setError(e?.message ?? 'Failed to send') }
    finally { setSending(false) }
  }

  const inputCls = 'w-full px-3 py-2 border border-[#E8E8E4] rounded-lg text-[14px] outline-none focus:border-[#7F77DD] bg-white'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-xl max-w-2xl w-full max-h-[90vh] flex flex-col" onClick={e => e.stopPropagation()}>

        <div className="flex items-start justify-between px-5 py-4 border-b border-[#E8E8E4]">
          <div>
            <div className="text-[11px] uppercase tracking-wide text-[#1A1A2E]/60">New referral</div>
            <h2 className="font-display text-[17px] font-semibold text-[#1A1A2E] mt-0.5">{childName}</h2>
          </div>
          <button onClick={onClose} className="text-[#1A1A2E]/60 hover:text-[#1A1A2E] p-1 -mr-1"><X size={18} /></button>
        </div>

        <div className="overflow-auto flex-1 p-5 space-y-4">
          {loading && <div className="py-8 text-center text-[13px] text-[#1A1A2E]/60">Loading…</div>}

          {error && (
            <div className="flex items-start gap-2 text-[13px] text-[#991B1B] bg-[#FCEBEB] border border-[#F5C6C6] px-3 py-2 rounded-lg">
              <AlertCircle size={14} className="mt-0.5 flex-shrink-0" /> <span>{error}</span>
            </div>
          )}

          {justSent && (
            <div className={`flex items-start gap-2 text-[13px] px-3 py-2.5 rounded-lg border ${
              justSent.fax_status === 'sent'
                ? 'text-[#085041] bg-[#E1F5EE] border-[#8FD8BE]'
                : 'text-[#991B1B] bg-[#FCEBEB] border-[#F5C6C6]'
            }`}>
              {justSent.fax_status === 'sent'
                ? <><CheckCircle2 size={14} className="mt-0.5 flex-shrink-0" /> <span>Referral faxed to <strong>{justSent.specialist_name_snapshot}</strong>. You can close this dialog or send another.</span></>
                : <><AlertCircle size={14} className="mt-0.5 flex-shrink-0" /> <span>Referral saved but fax failed: <strong>{justSent.fax_error}</strong>. The record is in this patient's history so you can retry manually.</span></>
              }
            </div>
          )}

          {!loading && !justSent && (
            <>
              {history.length > 0 && (
                <div className="p-3 bg-[#FAFAF8] border border-[#E8E8E4] rounded-lg">
                  <div className="text-[11px] font-semibold text-[#555] uppercase tracking-wider mb-2">Past referrals for this patient</div>
                  <div className="space-y-1.5 text-[12px]">
                    {history.slice(0, 4).map(r => (
                      <div key={r.id} className="flex items-center gap-2">
                        {r.fax_status === 'sent'   && <CheckCircle2 size={12} className="text-[#1D9E75] flex-shrink-0" />}
                        {r.fax_status === 'failed' && <AlertCircle  size={12} className="text-[#991B1B] flex-shrink-0" />}
                        {r.fax_status === 'pending' && <Clock       size={12} className="text-[#8A4B00] flex-shrink-0" />}
                        <span className="text-[#1A1A2E]"><strong>{r.specialist_name_snapshot}</strong>{r.specialist_specialty ? ` (${r.specialist_specialty})` : ''} — {r.reason}</span>
                        <span className="text-[#1A1A2E]/60 ml-auto">{new Date(r.created_at).toLocaleDateString()}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div>
                <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-1">
                  Specialist <span className="text-[#ff3b30]">*</span>
                </label>
                {addingSpecialist ? (
                  <div className="p-3 border-2 border-[#7F77DD] rounded-lg bg-white space-y-2">
                    <input value={newSpec.name} onChange={e => setNewSpec(s => ({ ...s, name: e.target.value }))} placeholder="Name *" className={inputCls} autoFocus />
                    <div className="grid grid-cols-2 gap-2">
                      <input value={newSpec.specialty} onChange={e => setNewSpec(s => ({ ...s, specialty: e.target.value }))} placeholder="Specialty" className={inputCls} />
                      <input value={newSpec.fax_number} onChange={e => setNewSpec(s => ({ ...s, fax_number: e.target.value }))} placeholder="Fax *" className={inputCls} />
                      <input value={newSpec.phone} onChange={e => setNewSpec(s => ({ ...s, phone: e.target.value }))} placeholder="Phone" className={inputCls} />
                      <input value={newSpec.address} onChange={e => setNewSpec(s => ({ ...s, address: e.target.value }))} placeholder="Address" className={inputCls} />
                    </div>
                    <div className="flex gap-2">
                      <Button size="sm" variant="teal" loading={addingSaving} disabled={!newSpec.name.trim()} onClick={handleAddSpecialist}>
                        Add to directory
                      </Button>
                      <Button size="sm" variant="secondary" onClick={() => setAddingSpecialist(false)}>Cancel</Button>
                    </div>
                  </div>
                ) : (
                  <div className="flex gap-2">
                    <select value={specialistId} onChange={e => setSpecialistId(e.target.value)} className={inputCls}>
                      <option value="">— Pick a specialist —</option>
                      {activeSpecialists.length === 0 && <option value="" disabled>No specialists in directory yet</option>}
                      {activeSpecialists.map(s => (
                        <option key={s.id} value={s.id}>
                          {s.name}{s.specialty ? ` (${s.specialty})` : ''}{!s.fax_number ? ' — NO FAX' : ''}
                        </option>
                      ))}
                    </select>
                    <Button size="sm" variant="secondary" onClick={() => setAddingSpecialist(true)}>
                      <Plus size={12} /> New
                    </Button>
                  </div>
                )}
                {specHasNoFax && (
                  <p className="text-[11px] text-[#991B1B] mt-1">⚠ This specialist has no fax number on file. The referral will save but not fax.</p>
                )}
              </div>

              <div>
                <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-1">
                  Reason for referral <span className="text-[#ff3b30]">*</span>
                </label>
                <input value={reason} onChange={e => setReason(e.target.value)}
                  placeholder="e.g. Eczema not responding to topical steroids"
                  className={inputCls} />
              </div>

              <div>
                <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-1">
                  Clinical summary
                </label>
                <textarea value={clinicalSummary} onChange={e => setClinicalSummary(e.target.value)}
                  rows={5} className={`${inputCls} resize-y`}
                  placeholder="Onset, duration, prior treatments tried, current exam findings, relevant labs…" />
              </div>

              <div>
                <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-2 flex items-center gap-1">
                  <Paperclip size={11} /> Attachments to include with the fax
                </label>
                <div className="border border-[#E8E8E4] rounded-lg p-3 bg-[#FAFAF8] space-y-2">
                  <label className="flex items-start gap-2 text-[13px] cursor-pointer">
                    <input type="checkbox" checked={includeDemographics}
                      onChange={e => setIncludeDemographics(e.target.checked)}
                      className="mt-0.5" />
                    <span><strong>Demographics</strong> <span className="text-[#1A1A2E]/60">— address, parent phone, parent email</span></span>
                  </label>
                  <label className="flex items-start gap-2 text-[13px] cursor-pointer">
                    <input type="checkbox" checked={includeInsurance}
                      onChange={e => setIncludeInsurance(e.target.checked)}
                      className="mt-0.5" />
                    <span><strong>Insurance information</strong> <span className="text-[#1A1A2E]/60">— provider, member/group, subscriber</span></span>
                  </label>
                  <div className="pt-2 mt-1 border-t border-[#E8E8E4]">
                    <div className="text-[11px] text-[#555] font-medium mb-1.5">Encounter notes</div>
                    {notes.length === 0 ? (
                      <p className="text-[12px] text-[#1A1A2E]/60 italic">No encounter notes on this chart yet.</p>
                    ) : (
                      <div className="space-y-1 max-h-40 overflow-auto">
                        {notes.map(n => (
                          <label key={n.id} className="flex items-start gap-2 text-[13px] cursor-pointer">
                            <input type="checkbox" checked={selectedNoteIds.has(n.id)}
                              onChange={() => toggleNote(n.id)}
                              className="mt-0.5" />
                            <span>
                              {n.scheduled_date
                                ? new Date(n.scheduled_date + 'T12:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
                                : '(no date)'}
                              {n.visit_type ? ` — ${n.visit_type}` : ''}
                              {!n.is_signed && <span className="text-[11px] text-[#8A4B00] ml-1">(draft)</span>}
                            </span>
                          </label>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>

              <div>
                <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-2">Urgency</label>
                <div className="flex gap-2">
                  {([
                    { v: 'routine', label: 'Routine',       cls: 'border-[#CBD5E1]' },
                    { v: 'urgent',  label: 'Urgent (1 wk)', cls: 'border-[#F5D5A6]' },
                    { v: 'stat',    label: 'STAT / same day', cls: 'border-[#F5C6C6]' },
                  ] as const).map(o => (
                    <button key={o.v} type="button" onClick={() => setUrgency(o.v)}
                      className={`px-4 py-2 rounded-lg border-2 text-[13px] font-medium transition-all ${
                        urgency === o.v
                          ? (o.v === 'stat' ? 'bg-[#991B1B] border-[#991B1B] text-white'
                             : o.v === 'urgent' ? 'bg-[#8A4B00] border-[#8A4B00] text-white'
                             : 'bg-[#31447A] border-[#31447A] text-white')
                          : `${o.cls} bg-white text-[#1A1A2E] hover:opacity-80`
                      }`}>
                      {o.label}
                    </button>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>

        {!justSent && !loading && (
          <div className="px-5 py-3 border-t border-[#E8E8E4] bg-[#FAFAF8] flex items-center justify-between">
            <span className="text-[11px] text-[#1A1A2E]/60">Fax sent from your practice number. Patient identity + allergies + meds + PMH always on the cover page.</span>
            <Button variant="teal" size="sm" loading={sending}
              disabled={!specialistId || !reason.trim()} onClick={handleSend}>
              <Send size={12} /> Send referral
            </Button>
          </div>
        )}

        {justSent && (
          <div className="px-5 py-3 border-t border-[#E8E8E4] bg-[#FAFAF8] flex items-center justify-end gap-2">
            <Button variant="secondary" size="sm" onClick={() => {
              setJustSent(null); setReason(''); setClinicalSummary(''); setSpecialistId(''); setUrgency('routine')
            }}>Send another</Button>
            <Button variant="teal" size="sm" onClick={onClose}>Done</Button>
          </div>
        )}

      </div>
    </div>
  )
}
