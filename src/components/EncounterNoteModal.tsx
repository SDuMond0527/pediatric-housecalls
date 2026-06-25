import { useEffect, useRef, useState } from 'react'
import { X, Search, UserRound } from 'lucide-react'
import { format, parseISO } from 'date-fns'
import { Button } from './ui/Button'
import { getEncounterNote, createEncounterNote, updateEncounterNote, getVitals, saveVitals, searchChildren } from '../lib/api'
import type { Appointment } from '../types'

interface Diagnosis {
  code: string
  name: string
}

interface Props {
  appointment: Appointment
  childId: string | null
  providerId: string
  onClose: () => void
}

interface VitalsForm {
  temperature_f: string
  heart_rate: string
  respiratory_rate: string
  oxygen_saturation: string
  weight_lbs: string
  height_in: string
  systolic_bp: string
  diastolic_bp: string
}

const emptyVitals = (): VitalsForm => ({
  temperature_f: '',
  heart_rate: '',
  respiratory_rate: '',
  oxygen_saturation: '',
  weight_lbs: '',
  height_in: '',
  systolic_bp: '',
  diastolic_bp: '',
})

export function EncounterNoteModal({ appointment, childId, providerId, onClose }: Props) {
  const [noteId, setNoteId] = useState<string | null>(null)
  const [isSigned, setIsSigned] = useState(false)
  const [saving, setSaving] = useState(false)
  const [signing, setSigning] = useState(false)
  const [loading, setLoading] = useState(true)

  // Linked patient (may be null for manually-added appointments)
  const [linkedChildId, setLinkedChildId] = useState<string | null>(childId)
  const [linkedChildName, setLinkedChildName] = useState<string | null>(null)
  const [patientQuery, setPatientQuery] = useState('')
  const [patientResults, setPatientResults] = useState<any[]>([])
  const [patientSearching, setPatientSearching] = useState(false)
  const patientTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Note fields
  const [chiefComplaint, setChiefComplaint] = useState('')
  const [subjective, setSubjective] = useState('')
  const [objective, setObjective] = useState('')
  const [assessment, setAssessment] = useState('')
  const [plan, setPlan] = useState('')
  const [diagnoses, setDiagnoses] = useState<Diagnosis[]>([])

  // Vitals
  const [vitals, setVitals] = useState<VitalsForm>(emptyVitals())

  // ICD-10 search
  const [icdQuery, setIcdQuery] = useState('')
  const [icdResults, setIcdResults] = useState<Diagnosis[]>([])
  const [icdSearching, setIcdSearching] = useState(false)
  const icdTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  function onPatientQueryChange(q: string) {
    setPatientQuery(q)
    if (patientTimer.current) clearTimeout(patientTimer.current)
    if (!q.trim()) { setPatientResults([]); return }
    patientTimer.current = setTimeout(async () => {
      setPatientSearching(true)
      const results = await searchChildren(q).catch(() => [])
      setPatientResults(results)
      setPatientSearching(false)
    }, 300)
  }

  function selectPatient(child: any) {
    const name = [child.first_name, child.last_name].filter(Boolean).join(' ') || child.display_label
    setLinkedChildId(child.id)
    setLinkedChildName(name)
    setPatientQuery('')
    setPatientResults([])
  }

  useEffect(() => {
    async function load() {
      setLoading(true)
      const [note, vitalsData] = await Promise.all([
        getEncounterNote({ appointment_id: appointment.id }).catch(() => null),
        getVitals({ appointment_id: appointment.id }).catch(() => null),
      ])
      if (note) {
        setNoteId(note.id)
        setIsSigned(note.is_signed)
        setChiefComplaint(note.chief_complaint ?? '')
        setSubjective(note.subjective ?? '')
        setObjective(note.objective ?? '')
        setAssessment(note.assessment ?? '')
        setPlan(note.plan ?? '')
        setDiagnoses(Array.isArray(note.diagnoses) ? note.diagnoses : [])
        if (note.child_id && !childId) {
          setLinkedChildId(note.child_id)
          if (note.child_first_name || note.child_last_name) {
            setLinkedChildName([note.child_first_name, note.child_last_name].filter(Boolean).join(' '))
          }
        }
      }
      if (vitalsData) {
        setVitals({
          temperature_f:    vitalsData.temperature_f    != null ? String(vitalsData.temperature_f)    : '',
          heart_rate:       vitalsData.heart_rate       != null ? String(vitalsData.heart_rate)       : '',
          respiratory_rate: vitalsData.respiratory_rate != null ? String(vitalsData.respiratory_rate) : '',
          oxygen_saturation:vitalsData.oxygen_saturation!= null ? String(vitalsData.oxygen_saturation): '',
          weight_lbs:       vitalsData.weight_lbs       != null ? String(vitalsData.weight_lbs)       : '',
          height_in:        vitalsData.height_in        != null ? String(vitalsData.height_in)        : '',
          systolic_bp:      vitalsData.systolic_bp      != null ? String(vitalsData.systolic_bp)      : '',
          diastolic_bp:     vitalsData.diastolic_bp     != null ? String(vitalsData.diastolic_bp)     : '',
        })
      }
      setLoading(false)
    }
    load()
  }, [appointment.id])

  function onIcdQueryChange(q: string) {
    setIcdQuery(q)
    if (icdTimer.current) clearTimeout(icdTimer.current)
    if (!q.trim()) { setIcdResults([]); return }
    icdTimer.current = setTimeout(async () => {
      setIcdSearching(true)
      try {
        const url = `https://clinicaltables.nlm.nih.gov/api/icd10cm/v3/search?sf=code,name&terms=${encodeURIComponent(q)}&maxList=8`
        const resp = await fetch(url)
        const data = await resp.json()
        const items: [string, string][] = data[3] ?? []
        setIcdResults(items.map(([code, name]) => ({ code, name })))
      } catch {
        setIcdResults([])
      }
      setIcdSearching(false)
    }, 300)
  }

  function addDiagnosis(dx: Diagnosis) {
    if (!diagnoses.find(d => d.code === dx.code)) {
      setDiagnoses(prev => [...prev, dx])
    }
    setIcdQuery('')
    setIcdResults([])
  }

  function removeDiagnosis(code: string) {
    setDiagnoses(prev => prev.filter(d => d.code !== code))
  }

  function buildNoteBody() {
    return {
      appointment_id: appointment.id,
      child_id: linkedChildId,
      provider_id: providerId,
      chief_complaint: chiefComplaint || null,
      subjective: subjective || null,
      objective: objective || null,
      assessment: assessment || null,
      plan: plan || null,
      diagnoses,
    }
  }

  function buildVitalsBody() {
    const toNum = (s: string) => s.trim() !== '' ? parseFloat(s) : null
    const toInt = (s: string) => s.trim() !== '' ? parseInt(s, 10) : null
    return {
      appointment_id: appointment.id,
      child_id: linkedChildId,
      temperature_f: toNum(vitals.temperature_f),
      heart_rate: toInt(vitals.heart_rate),
      respiratory_rate: toInt(vitals.respiratory_rate),
      oxygen_saturation: toInt(vitals.oxygen_saturation),
      weight_lbs: toNum(vitals.weight_lbs),
      height_in: toNum(vitals.height_in),
      systolic_bp: toInt(vitals.systolic_bp),
      diastolic_bp: toInt(vitals.diastolic_bp),
    }
  }

  async function saveDraft() {
    setSaving(true)
    try {
      const [note] = await Promise.all([
        noteId
          ? updateEncounterNote(noteId, buildNoteBody())
          : createEncounterNote(buildNoteBody()),
        saveVitals(buildVitalsBody()),
      ])
      if (!noteId) setNoteId(note.id)
    } finally {
      setSaving(false)
    }
  }

  async function signNote() {
    setSigning(true)
    try {
      const vitalsPromise = saveVitals(buildVitalsBody())
      let note: any
      if (noteId) {
        note = await updateEncounterNote(noteId, { ...buildNoteBody(), is_signed: true })
      } else {
        const draft = await createEncounterNote(buildNoteBody())
        note = await updateEncounterNote(draft.id, { is_signed: true })
        setNoteId(draft.id)
      }
      await vitalsPromise
      setIsSigned(true)
      if (!noteId) setNoteId(note.id)
    } finally {
      setSigning(false)
    }
  }

  const readOnly = isSigned

  const inputCls = `w-full px-3 py-2 border border-[#E8E8E4] rounded-lg text-[14px] outline-none focus:border-[#7F77DD] font-sans bg-white disabled:bg-[#F8F8F6] disabled:text-[#999] disabled:cursor-not-allowed`
  const textareaCls = `w-full px-3 py-2 border border-[#E8E8E4] rounded-lg text-[14px] outline-none focus:border-[#7F77DD] font-sans resize-none bg-white disabled:bg-[#F8F8F6] disabled:text-[#999] disabled:cursor-not-allowed`
  const sectionHeader = `text-[10px] font-semibold text-[#7F77DD] uppercase tracking-wider mb-3`

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={() => !saving && !signing && onClose()} />
      <div className="relative bg-[#FAFAF8] rounded-2xl shadow-2xl w-full max-w-2xl max-h-[92vh] flex flex-col overflow-hidden">

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-[#E8E8E4] bg-white flex-shrink-0">
          <div>
            <div className="font-display text-[16px] font-medium text-[#1A1A2E]">Encounter Note</div>
            <div className="text-[12px] text-[#999] mt-0.5">
              {appointment.visit_type} · {format(parseISO(appointment.scheduled_date), 'MMM d, yyyy')}
            </div>
          </div>
          <div className="flex items-center gap-2">
            {isSigned && (
              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold bg-[#E1F5EE] text-[#085041]">
                Signed
              </span>
            )}
            {!readOnly && (
              <>
                <Button variant="secondary" size="sm" onClick={saveDraft} loading={saving} disabled={signing}>
                  Save draft
                </Button>
                <Button variant="teal" size="sm" onClick={signNote} loading={signing} disabled={saving}>
                  Sign note
                </Button>
              </>
            )}
            <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-[#F1EFE8] text-[#999] ml-1">
              <X size={16} />
            </button>
          </div>
        </div>

        {/* Body */}
        {loading ? (
          <div className="flex-1 flex items-center justify-center text-[#999] text-[13px]">Loading…</div>
        ) : (
          <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6">

            {/* Patient link — shown for manually-added appointments */}
            {!childId && (
              <section>
                <div className={sectionHeader}>Patient</div>
                {linkedChildId && linkedChildName ? (
                  <div className="flex items-center justify-between px-3 py-2.5 border border-[#1D9E75] rounded-lg bg-[#F0FAF6]">
                    <div className="flex items-center gap-2">
                      <UserRound size={15} className="text-[#1D9E75] flex-shrink-0" />
                      <span className="text-[14px] font-medium text-[#1A1A2E]">{linkedChildName}</span>
                      <span className="text-[11px] text-[#999]">— note will appear in their chart</span>
                    </div>
                    {!readOnly && (
                      <button onClick={() => { setLinkedChildId(null); setLinkedChildName(null) }}
                        className="text-[11px] text-[#999] hover:text-[#1A1A2E] ml-3 flex-shrink-0">
                        × Unlink
                      </button>
                    )}
                  </div>
                ) : (
                  <div className="relative">
                    <div className="relative">
                      <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#999]" />
                      <input type="text" placeholder="Search patient name to link to chart (optional)…"
                        value={patientQuery}
                        onChange={e => onPatientQueryChange(e.target.value)}
                        disabled={readOnly}
                        className="w-full pl-8 pr-3 py-2 border border-[#E8E8E4] rounded-lg text-[14px] outline-none focus:border-[#7F77DD] font-sans disabled:bg-[#F8F8F6] disabled:text-[#999]" />
                    </div>
                    {(patientSearching || patientResults.length > 0) && (
                      <div className="absolute z-10 w-full mt-1 border border-[#E8E8E4] rounded-xl bg-white shadow-lg overflow-hidden">
                        {patientSearching && (
                          <div className="px-3 py-2 text-[12px] text-[#999]">Searching…</div>
                        )}
                        {!patientSearching && patientResults.map((child: any) => {
                          const name = [child.first_name, child.last_name].filter(Boolean).join(' ') || child.display_label
                          return (
                            <button key={child.id} onClick={() => selectPatient(child)}
                              className="w-full text-left px-3 py-2 hover:bg-[#FAFAF8] border-b border-[#F1EFE8] last:border-0 transition-colors">
                              <div className="text-[13px] font-medium text-[#1A1A2E]">{name}</div>
                              {child.family_display_name && (
                                <div className="text-[11px] text-[#999]">{child.family_display_name}</div>
                              )}
                            </button>
                          )
                        })}
                      </div>
                    )}
                    {!readOnly && !patientQuery && (
                      <p className="text-[11px] text-[#999] mt-1">Leave blank to save without linking to a patient chart.</p>
                    )}
                  </div>
                )}
              </section>
            )}

            {/* Vitals */}
            <section>
              <div className={sectionHeader}>Vitals</div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <div>
                  <label className="text-[11px] font-medium text-[#555] block mb-1">Temp (°F)</label>
                  <input type="number" step="0.1" placeholder="98.6" value={vitals.temperature_f}
                    disabled={readOnly}
                    onChange={e => setVitals(v => ({ ...v, temperature_f: e.target.value }))}
                    className={inputCls} />
                </div>
                <div>
                  <label className="text-[11px] font-medium text-[#555] block mb-1">HR (bpm)</label>
                  <input type="number" placeholder="80" value={vitals.heart_rate}
                    disabled={readOnly}
                    onChange={e => setVitals(v => ({ ...v, heart_rate: e.target.value }))}
                    className={inputCls} />
                </div>
                <div>
                  <label className="text-[11px] font-medium text-[#555] block mb-1">RR (br/min)</label>
                  <input type="number" placeholder="16" value={vitals.respiratory_rate}
                    disabled={readOnly}
                    onChange={e => setVitals(v => ({ ...v, respiratory_rate: e.target.value }))}
                    className={inputCls} />
                </div>
                <div>
                  <label className="text-[11px] font-medium text-[#555] block mb-1">O2 sat (%)</label>
                  <input type="number" placeholder="99" value={vitals.oxygen_saturation}
                    disabled={readOnly}
                    onChange={e => setVitals(v => ({ ...v, oxygen_saturation: e.target.value }))}
                    className={inputCls} />
                </div>
                <div>
                  <label className="text-[11px] font-medium text-[#555] block mb-1">Weight (lbs)</label>
                  <input type="number" step="0.1" placeholder="45.0" value={vitals.weight_lbs}
                    disabled={readOnly}
                    onChange={e => setVitals(v => ({ ...v, weight_lbs: e.target.value }))}
                    className={inputCls} />
                </div>
                <div>
                  <label className="text-[11px] font-medium text-[#555] block mb-1">Height (in)</label>
                  <input type="number" step="0.1" placeholder="42.0" value={vitals.height_in}
                    disabled={readOnly}
                    onChange={e => setVitals(v => ({ ...v, height_in: e.target.value }))}
                    className={inputCls} />
                </div>
                <div>
                  <label className="text-[11px] font-medium text-[#555] block mb-1">Systolic BP</label>
                  <input type="number" placeholder="120" value={vitals.systolic_bp}
                    disabled={readOnly}
                    onChange={e => setVitals(v => ({ ...v, systolic_bp: e.target.value }))}
                    className={inputCls} />
                </div>
                <div>
                  <label className="text-[11px] font-medium text-[#555] block mb-1">Diastolic BP</label>
                  <input type="number" placeholder="80" value={vitals.diastolic_bp}
                    disabled={readOnly}
                    onChange={e => setVitals(v => ({ ...v, diastolic_bp: e.target.value }))}
                    className={inputCls} />
                </div>
              </div>
            </section>

            {/* Chief Complaint */}
            <section>
              <div className={sectionHeader}>Chief Complaint</div>
              <input type="text" placeholder="e.g. Fever for 2 days" value={chiefComplaint}
                disabled={readOnly}
                onChange={e => setChiefComplaint(e.target.value)}
                className={inputCls} />
            </section>

            {/* Subjective */}
            <section>
              <div className={sectionHeader}>Subjective</div>
              <p className="text-[11px] text-[#999] mb-1.5">History of present illness, symptoms reported by parent</p>
              <textarea rows={4} placeholder="Parent reports…" value={subjective}
                disabled={readOnly}
                onChange={e => setSubjective(e.target.value)}
                className={textareaCls} />
            </section>

            {/* Objective */}
            <section>
              <div className={sectionHeader}>Objective</div>
              <p className="text-[11px] text-[#999] mb-1.5">Physical exam findings, clinical observations</p>
              <textarea rows={4} placeholder="General: Alert and in no acute distress…" value={objective}
                disabled={readOnly}
                onChange={e => setObjective(e.target.value)}
                className={textareaCls} />
            </section>

            {/* Assessment / Diagnoses */}
            <section>
              <div className={sectionHeader}>Assessment / Diagnoses</div>

              {!readOnly && (
                <div className="relative mb-3">
                  <div className="relative">
                    <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#999]" />
                    <input type="text" placeholder="Search ICD-10 code or diagnosis name…" value={icdQuery}
                      onChange={e => onIcdQueryChange(e.target.value)}
                      className="w-full pl-8 pr-3 py-2 border border-[#E8E8E4] rounded-lg text-[14px] outline-none focus:border-[#7F77DD] font-sans" />
                  </div>
                  {(icdSearching || icdResults.length > 0) && (
                    <div className="absolute z-10 w-full mt-1 border border-[#E8E8E4] rounded-xl bg-white shadow-lg overflow-hidden">
                      {icdSearching && (
                        <div className="px-3 py-2 text-[12px] text-[#999]">Searching…</div>
                      )}
                      {!icdSearching && icdResults.map(dx => (
                        <button key={dx.code} onClick={() => addDiagnosis(dx)}
                          className="w-full text-left px-3 py-2 hover:bg-[#FAFAF8] border-b border-[#F1EFE8] last:border-0 transition-colors">
                          <span className="text-[12px] font-semibold text-[#7F77DD]">{dx.code}</span>
                          <span className="text-[12px] text-[#1A1A2E] ml-2">{dx.name}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {diagnoses.length > 0 && (
                <div className="flex flex-wrap gap-2 mb-3">
                  {diagnoses.map(dx => (
                    <span key={dx.code} className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-[#EEEDFE] text-[#3C3489] rounded-full text-[12px] font-medium">
                      {dx.code} – {dx.name}
                      {!readOnly && (
                        <button onClick={() => removeDiagnosis(dx.code)}
                          className="hover:text-[#791F1F] transition-colors ml-0.5">
                          <X size={11} />
                        </button>
                      )}
                    </span>
                  ))}
                </div>
              )}

              <textarea rows={3} placeholder="Clinical reasoning and assessment notes…" value={assessment}
                disabled={readOnly}
                onChange={e => setAssessment(e.target.value)}
                className={textareaCls} />
            </section>

            {/* Plan */}
            <section>
              <div className={sectionHeader}>Plan</div>
              <p className="text-[11px] text-[#999] mb-1.5">Treatment, medications, follow-up instructions</p>
              <textarea rows={4} placeholder="1. Rest and increased fluids…" value={plan}
                disabled={readOnly}
                onChange={e => setPlan(e.target.value)}
                className={textareaCls} />
            </section>

          </div>
        )}

        {/* Footer */}
        {!loading && !readOnly && (
          <div className="flex items-center justify-end gap-2 px-6 py-4 border-t border-[#E8E8E4] bg-white flex-shrink-0">
            <Button variant="secondary" onClick={saveDraft} loading={saving} disabled={signing}>
              Save draft
            </Button>
            <Button variant="teal" onClick={signNote} loading={signing} disabled={saving}>
              Sign &amp; lock note
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}
