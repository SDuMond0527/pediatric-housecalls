import { useEffect, useRef, useState, type ReactNode } from 'react'
import { X, Search, UserRound, Camera, Trash2, BookmarkPlus, ChevronDown } from 'lucide-react'
import { format, parseISO } from 'date-fns'
import { Button } from './ui/Button'
import { getEncounterNote, createEncounterNote, updateEncounterNote, getVitals, saveVitals, searchChildren, getFeeSchedule, uploadNotePhoto, getChildrenByIds, getNoteTemplates, createNoteTemplate, updateNoteTemplate, deleteNoteTemplate } from '../lib/api'
import type { Appointment } from '../types'

const NOTE_TYPES = [
  'In-home sick visit',
  'Telemedicine video visit',
  'Text visit',
  'Sports physical',
  'RN IV fluids',
] as const
type NoteType = typeof NOTE_TYPES[number]

const NOTE_TEMPLATES: Record<NoteType, { subjective: string; objective: string; plan: string }> = {
  'In-home sick visit': {
    subjective: 'Parent reports ',
    objective: `General: Alert, in no acute distress, well-nourished, well-hydrated child.
HEENT: Normocephalic, atraumatic. PERRL. Conjunctivae clear. TMs: [clear bilaterally / erythematous / effusion]. Nose: [patent / congested]. Oropharynx: [clear / erythematous / tonsillar exudate noted].
Neck: Supple. No lymphadenopathy.
Respiratory: [Clear to auscultation bilaterally / wheezing / rhonchi]. No retractions. RR age-appropriate.
Cardiovascular: Regular rate and rhythm. No murmurs. Cap refill < 2 sec.
Abdomen: Soft, non-tender, non-distended. Normal bowel sounds. No hepatosplenomegaly.
Skin: Warm, dry. [No rash / rash noted — describe].
Neurological: Alert, age-appropriate.`,
    plan: '',
  },
  'Telemedicine video visit': {
    subjective: 'Parent reports ',
    objective: `Patient seen via secure HIPAA-compliant video telemedicine visit. Physical exam limited to visual assessment.
General: [Alert, interactive, in no apparent distress / appears ill] as observed via video.
Respiratory: [No visible work of breathing / increased work of breathing noted].
Skin: [No visible rash / rash visible — described as...].
Note: Unable to assess ears, throat, or auscultate lungs/heart remotely.`,
    plan: '',
  },
  'Text visit': {
    subjective: 'Parent reports via secure text: ',
    objective: `Patient/parent communication conducted via secure HIPAA-compliant text. No visual or physical examination performed.
Assessment based on history and information provided via text communication.`,
    plan: '',
  },
  'Sports physical': {
    subjective: 'Patient presenting for pre-participation sports physical. No current complaints.',
    objective: `General: Alert, in no acute distress, well-appearing athlete.
Vital Signs: See above.
Eyes: Normal.
Ears, Nose, and Throat: Normal.
Mouth and Teeth: Normal.
Neck: Normal.
Cardiovascular: Normal.
Chest and Lungs: Normal.
Abdomen: Normal.
Skin: Normal.
Genitals-Hernia: Normal.
Musculoskeletal: Normal.
Neurological: Normal.`,
    plan: `1. Cleared for full athletic participation without restrictions.
2. Return precautions reviewed with patient and parent.
3. Follow up with PCP for routine care.`,
  },
  'RN IV fluids': {
    subjective: 'Parent/patient reports ',
    objective: `IV access: [20g / 22g / 24g] peripheral IV established in [right / left] [hand / antecubital / forearm] on [first / second] attempt.
IV site: No swelling, redness, or signs of infiltration.
[Normal saline / Lactated Ringer's] infusing at [___] mL/hr.
Patient tolerating infusion without complaint.
Post-infusion: Patient tolerated fluids well. Improved hydration status.`,
    plan: `1. IV fluid infusion administered as ordered.
2. Patient monitored throughout infusion — no adverse reactions.
3. Encourage PO fluids as tolerated.
4. Return precautions discussed with family.
5. Follow up with PCP or return to ED if symptoms worsen.`,
  },
}

function visitTypeToNoteType(visitType: string): NoteType {
  const v = visitType.toLowerCase()
  if (v.includes('video') || v.includes('telemedicine')) return 'Telemedicine video visit'
  if (v.includes('text')) return 'Text visit'
  if (v.includes('sports') || v.includes('physical')) return 'Sports physical'
  if (v.includes('iv') || v.includes('fluid')) return 'RN IV fluids'
  return 'In-home sick visit'
}

interface SportsPxHx {
  shortOfBreath: 'yes' | 'no' | 'other' | ''
  shortOfBreathOther: string
  doctorRestricted: 'yes' | 'no' | 'other' | ''
  doctorRestrictedOther: string
  medConditions: string[]
  medConditionsOther: string
  headInjury: 'yes' | 'no' | 'other' | ''
  headInjuryOther: string
  familySuddenDeath: string[]
  familySuddenDeathOther: string
  familyHeartProblem: string[]
  familyHeartProblemOther: string
  familyFainting: string[]
  familyFaintingOther: string
  supplements: 'yes' | 'no' | 'other' | ''
  supplementsOther: string
  weightConcern: 'yes' | 'no' | 'other' | ''
  weightConcernOther: string
}

const emptySportsHx = (): SportsPxHx => ({
  shortOfBreath: '', shortOfBreathOther: '',
  doctorRestricted: '', doctorRestrictedOther: '',
  medConditions: [], medConditionsOther: '',
  headInjury: '', headInjuryOther: '',
  familySuddenDeath: [], familySuddenDeathOther: '',
  familyHeartProblem: [], familyHeartProblemOther: '',
  familyFainting: [], familyFaintingOther: '',
  supplements: '', supplementsOther: '',
  weightConcern: '', weightConcernOther: '',
})

interface ExamFinding {
  val: 'normal' | 'abnormal' | 'other' | ''
  correctedLenses: boolean
  notes: string
}
type ExamFindings = Record<string, ExamFinding>

const EXAM_SYSTEMS: { key: string; label: string; hasCorrectLenses?: boolean }[] = [
  { key: 'Eyes', label: 'Eyes', hasCorrectLenses: true },
  { key: 'Ears, Nose, and Throat', label: 'Ears, Nose, and Throat' },
  { key: 'Mouth and Teeth', label: 'Mouth and Teeth' },
  { key: 'Neck', label: 'Neck' },
  { key: 'Cardiovascular', label: 'Cardiovascular' },
  { key: 'Chest and Lungs', label: 'Chest and Lungs' },
  { key: 'Abdomen', label: 'Abdomen' },
  { key: 'Skin', label: 'Skin' },
  { key: 'Genitals-Hernia', label: 'Genitals-Hernia' },
  { key: 'Musculoskeletal', label: 'Musculoskeletal: ROM, Strength' },
  { key: 'Neurological', label: 'Neurological' },
]

const emptyExamFindings = (): ExamFindings =>
  Object.fromEntries(EXAM_SYSTEMS.map(s => [s.key, { val: '', correctedLenses: false, notes: '' }]))

function compileSportsHx(hx: SportsPxHx): string {
  const yno = (val: string, other: string) =>
    val === 'yes' ? 'Yes' : val === 'no' ? 'No' : val === 'other' ? (other || 'Other') : '—'
  const multi = (vals: string[], other: string) => {
    if (!vals.length) return '—'
    const parts = vals.filter(v => v !== 'Other')
    if (vals.includes('Other')) parts.push(other || 'Other')
    return parts.join(', ')
  }
  return [
    'PERSONAL HEALTH HISTORY:',
    `• Exercise intolerance/dyspnea faster than peers: ${yno(hx.shortOfBreath, hx.shortOfBreathOther)}`,
    `• Prior physician restriction from sports: ${yno(hx.doctorRestricted, hx.doctorRestrictedOther)}`,
    `• Ongoing medical conditions: ${multi(hx.medConditions, hx.medConditionsOther)}`,
    `• History of head injury or concussion: ${yno(hx.headInjury, hx.headInjuryOther)}`,
    '',
    'FAMILY HISTORY:',
    `• Cardiac death or sudden death <50yo (incl. drowning, unexplained MVA, SIDS): ${multi(hx.familySuddenDeath, hx.familySuddenDeathOther)}`,
    `• Heart disease, pacemaker, or ICD: ${multi(hx.familyHeartProblem, hx.familyHeartProblemOther)}`,
    `• Unexplained syncope, seizures, or near drowning: ${multi(hx.familyFainting, hx.familyFaintingOther)}`,
    '',
    'SOCIAL HISTORY:',
    `• Performance-enhancing supplements: ${yno(hx.supplements, hx.supplementsOther)}`,
    `• Weight concerns: ${yno(hx.weightConcern, hx.weightConcernOther)}`,
  ].join('\n')
}

interface Diagnosis {
  code: string
  name: string
}

interface CptCode {
  code: string
  description: string
  category: string
  charge_amount: number
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
  const [signError, setSignError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  // Linked patient (may be null for manually-added appointments)
  const [linkedChildId, setLinkedChildId] = useState<string | null>(childId)
  const [linkedChildName, setLinkedChildName] = useState<string | null>(null)
  const [linkedChildDob, setLinkedChildDob] = useState<string | null>(null)
  const [patientQuery, setPatientQuery] = useState('')
  const [patientResults, setPatientResults] = useState<any[]>([])
  const [patientSearching, setPatientSearching] = useState(false)
  const patientTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Note type + template
  const [noteType, setNoteType] = useState<NoteType>(visitTypeToNoteType(appointment.visit_type))
  const [showTemplatePrompt, setShowTemplatePrompt] = useState(false)

  // Custom templates
  const [customTemplates, setCustomTemplates] = useState<any[]>([])
  const [showCustomTemplateMenu, setShowCustomTemplateMenu] = useState(false)
  const [showSaveForm, setShowSaveForm] = useState(false)
  const [saveFormName, setSaveFormName] = useState('')
  const [saveFormShare, setSaveFormShare] = useState(false)
  const [savingTemplate, setSavingTemplate] = useState(false)
  const [editingTemplateId, setEditingTemplateId] = useState<string | null>(null)

  // Sports physical questionnaire
  const [sportsHx, setSportsHx] = useState<SportsPxHx>(emptySportsHx())
  const [examFindings, setExamFindings] = useState<ExamFindings>(emptyExamFindings())

  function updateSportsHx(update: Partial<SportsPxHx>) {
    setSportsHx(prev => {
      const next = { ...prev, ...update }
      setSubjective(compileSportsHx(next))
      return next
    })
  }

  function updateExamFinding(key: string, update: Partial<ExamFinding>) {
    setExamFindings(prev => {
      const finding = { ...prev[key], ...update }
      const next = { ...prev, [key]: finding }
      if (finding.val) {
        const suffix =
          finding.val === 'normal'
            ? finding.correctedLenses ? 'Normal (corrected lenses).' : 'Normal.'
            : finding.val === 'abnormal'
            ? `Abnormal${finding.notes ? ' — ' + finding.notes : ''}.`
            : `${finding.notes || 'see notes'}.`
        const newLine = `${key}: ${suffix}`
        const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        setObjective(prev => {
          const replaced = prev.replace(new RegExp(`^${escaped}:.*$`, 'm'), newLine)
          return replaced !== prev ? replaced : `${prev}\n${newLine}`
        })
      }
      return next
    })
  }

  function applyCustomTemplate(t: any) {
    setSubjective(t.subjective || '')
    setObjective(t.objective || '')
    setPlan(t.plan || '')
    setShowCustomTemplateMenu(false)
  }

  async function saveAsTemplate() {
    if (!saveFormName.trim()) return
    setSavingTemplate(true)
    try {
      if (editingTemplateId) {
        const updated = await updateNoteTemplate(editingTemplateId, {
          name: saveFormName,
          subjective,
          objective,
          plan,
          is_shared: saveFormShare,
        })
        setCustomTemplates(prev => prev.map(t => t.id === editingTemplateId ? updated : t))
      } else {
        const created = await createNoteTemplate({
          name: saveFormName,
          subjective,
          objective,
          plan,
          is_shared: saveFormShare,
        })
        setCustomTemplates(prev => [...prev, created])
      }
      setShowSaveForm(false)
      setSaveFormName('')
      setSaveFormShare(false)
      setEditingTemplateId(null)
    } catch { /* ignore */ } finally {
      setSavingTemplate(false)
    }
  }

  async function deleteCustomTemplate(id: string) {
    await deleteNoteTemplate(id).catch(() => {})
    setCustomTemplates(prev => prev.filter(t => t.id !== id))
  }

  function openSaveForm(template?: any) {
    if (template) {
      setEditingTemplateId(template.id)
      setSaveFormName(template.name)
      setSaveFormShare(template.is_shared)
    } else {
      setEditingTemplateId(null)
      setSaveFormName('')
      setSaveFormShare(false)
    }
    setShowSaveForm(true)
    setShowCustomTemplateMenu(false)
  }

  function applyTemplate(type: NoteType) {
    const t = NOTE_TEMPLATES[type]
    setSubjective(t.subjective)
    setObjective(t.objective)
    if (t.plan) setPlan(t.plan)
    if (type !== 'Sports physical') { setSportsHx(emptySportsHx()); setExamFindings(emptyExamFindings()) }
    setShowTemplatePrompt(false)
  }

  function onNoteTypeChange(type: NoteType) {
    setNoteType(type)
    const hasContent = subjective.trim() || objective.trim() || plan.trim()
    if (hasContent) {
      setShowTemplatePrompt(true)
    } else {
      applyTemplate(type)
    }
  }

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

  // CPT codes
  const [cptCodes, setCptCodes] = useState<CptCode[]>([])
  const [feeSchedule, setFeeSchedule] = useState<CptCode[]>([])
  const [cptTab, setCptTab] = useState<'Procedure' | 'Non-Covered Services'>('Procedure')
  const [cptSearch, setCptSearch] = useState('')
  const [cptOpen, setCptOpen] = useState(false)

  // Photos
  const [photos, setPhotos] = useState<{ url: string; caption: string }[]>([])
  const [photoUploading, setPhotoUploading] = useState(false)
  const photoInputRef = useRef<HTMLInputElement>(null)

  async function handlePhotoFile(file: File) {
    setPhotoUploading(true)
    try {
      const url = await uploadNotePhoto(file)
      setPhotos(prev => [...prev, { url, caption: '' }])
    } finally {
      setPhotoUploading(false)
    }
  }

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
    if (child.date_of_birth) setLinkedChildDob(child.date_of_birth)
    setPatientQuery('')
    setPatientResults([])
  }

  useEffect(() => {
    async function load() {
      setLoading(true)
      const [note, vitalsData, schedule, templates] = await Promise.all([
        getEncounterNote({ appointment_id: appointment.id }).catch(() => null),
        getVitals({ appointment_id: appointment.id }).catch(() => null),
        getFeeSchedule().catch(() => []),
        getNoteTemplates().catch(() => []),
      ])
      setCustomTemplates(templates)
      setFeeSchedule(schedule)
      let resolvedChildId = childId
      if (note) {
        setNoteId(note.id)
        setIsSigned(note.is_signed)
        setChiefComplaint(note.chief_complaint ?? '')
        setSubjective(note.subjective ?? '')
        setObjective(note.objective ?? '')
        setAssessment(note.assessment ?? '')
        setPlan(note.plan ?? '')
        setDiagnoses(Array.isArray(note.diagnoses) ? note.diagnoses : [])
        setCptCodes(Array.isArray(note.cpt_codes) ? note.cpt_codes.map((c: any) => ({ ...c, charge_amount: parseFloat(c.charge_amount) })) : [])
        setPhotos(Array.isArray(note.photos) ? note.photos : [])
        if (note.note_type && NOTE_TYPES.includes(note.note_type)) setNoteType(note.note_type as NoteType)
        if (note.child_id && !childId) {
          resolvedChildId = note.child_id
          setLinkedChildId(note.child_id)
          if (note.child_first_name || note.child_last_name) {
            setLinkedChildName([note.child_first_name, note.child_last_name].filter(Boolean).join(' '))
          }
        }
      } else {
        // New note — auto-apply template
        const type = visitTypeToNoteType(appointment.visit_type)
        const t = NOTE_TEMPLATES[type]
        setSubjective(t.subjective)
        setObjective(t.objective)
        if (t.plan) setPlan(t.plan)
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
      if (resolvedChildId) {
        const children = await getChildrenByIds([resolvedChildId]).catch(() => [])
        const child = children?.[0]
        if (child) {
          if (!linkedChildName && (child.first_name || child.last_name)) {
            setLinkedChildName([child.first_name, child.last_name].filter(Boolean).join(' '))
          }
          if (child.date_of_birth) setLinkedChildDob(child.date_of_birth)
        }
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
      note_type: noteType,
      chief_complaint: chiefComplaint || null,
      subjective: subjective || null,
      objective: objective || null,
      assessment: assessment || null,
      plan: plan || null,
      diagnoses,
      cpt_codes: cptCodes,
      photos,
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

  async function unlockNote() {
    if (!noteId) return
    setSaving(true)
    try {
      await updateEncounterNote(noteId, { is_signed: false })
      setIsSigned(false)
    } finally {
      setSaving(false)
    }
  }

  async function signNote() {
    setSigning(true)
    setSignError(null)
    try {
      const vitalsPromise = saveVitals(buildVitalsBody()).catch(() => {})
      let note: any
      if (noteId) {
        note = await updateEncounterNote(noteId, { ...buildNoteBody(), is_signed: true })
      } else {
        const draft = await createEncounterNote(buildNoteBody())
        note = await updateEncounterNote(draft.id, { is_signed: true })
        setNoteId(draft.id)
      }
      setIsSigned(true)
      setCptOpen(false)
      if (!noteId) setNoteId(note.id)
      await vitalsPromise
    } catch (e: any) {
      setSignError(e.message ?? 'Failed to sign note')
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
            {(linkedChildName || linkedChildDob) && (
              <div className="mt-1.5 flex items-center gap-2">
                {linkedChildName && (
                  <span className="text-[14px] font-semibold text-[#1A1A2E]">{linkedChildName}</span>
                )}
                {linkedChildDob && (
                  <span className="text-[12px] text-[#666]">
                    DOB {format(parseISO(linkedChildDob), 'MM/dd/yyyy')}
                  </span>
                )}
              </div>
            )}
          </div>
          <div className="flex items-center gap-2">
            {isSigned && (
              <>
                <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold bg-[#E1F5EE] text-[#085041]">
                  Signed
                </span>
                <Button variant="secondary" size="sm" onClick={unlockNote} loading={saving}>
                  Unlock note
                </Button>
              </>
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

            {/* Note type */}
            <section>
              <div className={sectionHeader}>Note type</div>
              <select
                value={noteType}
                onChange={e => !readOnly && onNoteTypeChange(e.target.value as NoteType)}
                disabled={readOnly}
                className={`w-full px-3 py-2 border border-[#E8E8E4] rounded-lg text-[14px] font-sans outline-none focus:border-[#7F77DD] bg-white disabled:bg-[#F8F8F6] disabled:text-[#999] disabled:cursor-not-allowed`}>
                {NOTE_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
              {showTemplatePrompt && (
                <div className="mt-2 flex items-center justify-between gap-3 px-3 py-2.5 bg-[#FEF3E8] border border-[#FAC775] rounded-lg">
                  <span className="text-[12px] text-[#633806]">Apply the <strong>{noteType}</strong> template? This will replace your current note content.</span>
                  <div className="flex gap-2 flex-shrink-0">
                    <button onClick={() => setShowTemplatePrompt(false)}
                      className="text-[11px] text-[#633806] hover:underline">Keep current</button>
                    <button onClick={() => applyTemplate(noteType)}
                      className="text-[11px] font-semibold text-white bg-[#EF9F27] px-2.5 py-1 rounded-lg hover:bg-[#d98e20] transition-colors">Apply</button>
                  </div>
                </div>
              )}

              {/* Custom templates */}
              {!readOnly && (
                <div className="mt-2 relative">
                  <div className="flex items-center gap-2">
                    <div className="relative flex-1">
                      <button
                        onClick={() => { setShowCustomTemplateMenu(v => !v); setShowSaveForm(false) }}
                        className="flex items-center gap-1.5 text-[12px] text-[#7F77DD] font-medium border border-[#7F77DD]/30 rounded-lg px-3 py-1.5 hover:bg-[#7F77DD]/8 transition-all w-full justify-between">
                        <span>My Templates {customTemplates.length > 0 ? `(${customTemplates.length})` : ''}</span>
                        <ChevronDown size={12} />
                      </button>
                      {showCustomTemplateMenu && (
                        <div className="absolute top-full left-0 mt-1 w-72 bg-white border border-[#E8E8E4] rounded-xl shadow-lg z-50 overflow-hidden">
                          {customTemplates.length === 0 ? (
                            <div className="px-4 py-3 text-[12px] text-[#999]">No saved templates yet.</div>
                          ) : (
                            <>
                              {customTemplates.filter((t: any) => !t.is_shared).length > 0 && (
                                <div className="px-3 pt-2 pb-1 text-[10px] font-semibold text-[#999] uppercase tracking-wider">My Templates</div>
                              )}
                              {customTemplates.filter((t: any) => !t.is_shared).map((t: any) => (
                                <div key={t.id} className="flex items-center gap-1 px-3 py-1.5 hover:bg-[#FAFAF8] group">
                                  <button onClick={() => applyCustomTemplate(t)} className="flex-1 text-left text-[13px] text-[#1A1A2E]">{t.name}</button>
                                  <button onClick={() => openSaveForm(t)} className="text-[#999] hover:text-[#7F77DD] p-1 opacity-0 group-hover:opacity-100 text-[11px]">Edit</button>
                                  <button onClick={() => deleteCustomTemplate(t.id)} className="text-[#999] hover:text-[#791F1F] p-1 opacity-0 group-hover:opacity-100"><Trash2 size={11} /></button>
                                </div>
                              ))}
                              {customTemplates.filter((t: any) => t.is_shared).length > 0 && (
                                <div className="px-3 pt-2 pb-1 text-[10px] font-semibold text-[#999] uppercase tracking-wider border-t border-[#E8E8E4] mt-1">Practice Templates</div>
                              )}
                              {customTemplates.filter((t: any) => t.is_shared).map((t: any) => (
                                <div key={t.id} className="flex items-center gap-1 px-3 py-1.5 hover:bg-[#FAFAF8] group">
                                  <button onClick={() => applyCustomTemplate(t)} className="flex-1 text-left text-[13px] text-[#1A1A2E]">{t.name}</button>
                                  <button onClick={() => openSaveForm(t)} className="text-[#999] hover:text-[#7F77DD] p-1 opacity-0 group-hover:opacity-100 text-[11px]">Edit</button>
                                  <button onClick={() => deleteCustomTemplate(t.id)} className="text-[#999] hover:text-[#791F1F] p-1 opacity-0 group-hover:opacity-100"><Trash2 size={11} /></button>
                                </div>
                              ))}
                            </>
                          )}
                          <div className="border-t border-[#E8E8E4] px-3 py-2">
                            <button onClick={() => openSaveForm()} className="flex items-center gap-1.5 text-[12px] text-[#7F77DD] font-medium w-full">
                              <BookmarkPlus size={13} /> Save current note as template
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                    <button onClick={() => { openSaveForm(); setShowCustomTemplateMenu(false) }}
                      className="flex items-center gap-1 text-[12px] text-[#7F77DD] font-medium border border-[#7F77DD]/30 rounded-lg px-3 py-1.5 hover:bg-[#7F77DD]/8 transition-all flex-shrink-0">
                      <BookmarkPlus size={13} /> Save as template
                    </button>
                  </div>

                  {showSaveForm && (
                    <div className="mt-2 border border-[#7F77DD]/30 rounded-xl p-3 bg-[#F7F6FF]">
                      <div className="text-[11px] font-semibold text-[#555] uppercase tracking-wider mb-2">
                        {editingTemplateId ? 'Edit template' : 'Save as template'}
                      </div>
                      <input
                        type="text"
                        placeholder="Template name…"
                        value={saveFormName}
                        onChange={e => setSaveFormName(e.target.value)}
                        className="w-full px-3 py-2 border border-[#E8E8E4] rounded-lg text-[13px] font-sans outline-none focus:border-[#7F77DD] bg-white mb-2"
                        autoFocus
                      />
                      <label className="flex items-center gap-2 text-[13px] text-[#555] cursor-pointer mb-3">
                        <input type="checkbox" checked={saveFormShare} onChange={e => setSaveFormShare(e.target.checked)}
                          className="w-4 h-4 accent-[#7F77DD]" />
                        Share with entire practice
                      </label>
                      <div className="flex gap-2">
                        <Button size="sm" loading={savingTemplate} onClick={saveAsTemplate}
                          disabled={!saveFormName.trim()}>
                          {editingTemplateId ? 'Update' : 'Save'}
                        </Button>
                        <Button size="sm" variant="secondary"
                          onClick={() => { setShowSaveForm(false); setEditingTemplateId(null) }}>
                          Cancel
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </section>

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

            {/* Sports Physical Pre-Participation History */}
            {noteType === 'Sports physical' && !readOnly && (() => {
              const pillCls = (active: boolean) =>
                `px-3 py-1 rounded-lg text-[12px] font-medium border transition-colors ${active ? 'bg-[#7F77DD] text-white border-[#7F77DD]' : 'bg-white text-[#555] border-[#E8E8E4] hover:border-[#7F77DD]'}`
              const toggleMulti = (field: keyof SportsPxHx, opt: string) => {
                const arr = sportsHx[field] as string[]
                updateSportsHx({ [field]: arr.includes(opt) ? arr.filter(v => v !== opt) : [...arr, opt] })
              }
              const YNO = ({ field, otherField }: { field: keyof SportsPxHx; otherField: keyof SportsPxHx }) => (
                <div>
                  <div className="flex gap-2 mt-1.5">
                    {(['yes', 'no', 'other'] as const).map(opt => (
                      <button key={opt} type="button"
                        onClick={() => updateSportsHx({ [field]: sportsHx[field] === opt ? '' : opt })}
                        className={pillCls(sportsHx[field] === opt)}>
                        {opt === 'yes' ? 'Yes' : opt === 'no' ? 'No' : 'Other'}
                      </button>
                    ))}
                  </div>
                  {sportsHx[field] === 'other' && (
                    <input type="text" placeholder="Describe…" value={sportsHx[otherField] as string}
                      onChange={e => updateSportsHx({ [otherField]: e.target.value })}
                      className={`mt-1.5 ${inputCls}`} />
                  )}
                </div>
              )
              const MULTI = ({ field, otherField, opts }: { field: keyof SportsPxHx; otherField: keyof SportsPxHx; opts: string[] }) => (
                <div>
                  <div className="flex gap-1.5 flex-wrap mt-1.5">
                    {opts.map(opt => (
                      <button key={opt} type="button"
                        onClick={() => toggleMulti(field, opt)}
                        className={pillCls((sportsHx[field] as string[]).includes(opt))}>
                        {opt}
                      </button>
                    ))}
                  </div>
                  {(sportsHx[field] as string[]).includes('Other') && (
                    <input type="text" placeholder="Describe…" value={sportsHx[otherField] as string}
                      onChange={e => updateSportsHx({ [otherField]: e.target.value })}
                      className={`mt-1.5 ${inputCls}`} />
                  )}
                </div>
              )
              const Q = ({ label, children }: { label: string; children: ReactNode }) => (
                <div>
                  <p className="text-[13px] text-[#1A1A2E] leading-snug">{label}</p>
                  {children}
                </div>
              )
              const subHead = 'text-[10px] font-semibold text-[#999] uppercase tracking-wider mb-2 mt-1'
              return (
                <section>
                  <div className={sectionHeader}>Pre-Participation History</div>
                  <div className="bg-white border border-[#E8E8E4] rounded-xl p-4 space-y-4">
                    <div className={subHead}>Personal Health</div>
                    <Q label="Do you get more tired or short of breath more quickly than your friends during exercise?">
                      <YNO field="shortOfBreath" otherField="shortOfBreathOther" />
                    </Q>
                    <Q label="Has a doctor ever restricted or denied your participation in sports for any reason?">
                      <YNO field="doctorRestricted" otherField="doctorRestrictedOther" />
                    </Q>
                    <Q label="Do you have any ongoing medical conditions?">
                      <MULTI field="medConditions" otherField="medConditionsOther"
                        opts={['Asthma', 'Anemia', 'Diabetes', 'Infections', 'Other', 'None of the above']} />
                    </Q>
                    <Q label="Have you ever had a head injury or concussion?">
                      <YNO field="headInjury" otherField="headInjuryOther" />
                    </Q>

                    <div className={subHead}>Family History</div>
                    <Q label="Has any family member or relative died of heart problems or had an unexpected or unexplained sudden death before age 50 (including drowning, unexplained car accident, or sudden infant death syndrome)?">
                      <MULTI field="familySuddenDeath" otherField="familySuddenDeathOther"
                        opts={['Maternal', 'Paternal', 'Sibling - brother', 'Sibling - sister', 'None of the above', 'Other']} />
                    </Q>
                    <Q label="Does anyone in your family have a heart problem, pacemaker or implanted defibrillator?">
                      <MULTI field="familyHeartProblem" otherField="familyHeartProblemOther"
                        opts={['Maternal', 'Paternal', 'Sibling - brother', 'Sibling - sister', 'None of the above', 'Other']} />
                    </Q>
                    <Q label="Has anyone in your family had unexplained fainting, unexplained seizures, or near drowning?">
                      <MULTI field="familyFainting" otherField="familyFaintingOther"
                        opts={['Maternal', 'Paternal', 'Sibling - brother', 'Sibling - sister', 'None of the above', 'Other']} />
                    </Q>

                    <div className={subHead}>Social History</div>
                    <Q label="Do you take any performance enhancing supplements?">
                      <YNO field="supplements" otherField="supplementsOther" />
                    </Q>
                    <Q label="Do you worry about your weight?">
                      <YNO field="weightConcern" otherField="weightConcernOther" />
                    </Q>
                  </div>
                  <p className="text-[11px] text-[#999] mt-1.5">Responses auto-populate the Subjective field below.</p>
                </section>
              )
            })()}

            {/* Subjective */}
            <section>
              <div className={sectionHeader}>Subjective</div>
              <p className="text-[11px] text-[#999] mb-1.5">
                {noteType === 'Sports physical' && !readOnly
                  ? 'Auto-filled from history above — edit freely'
                  : 'History of present illness, symptoms reported by parent'}
              </p>
              <textarea rows={noteType === 'Sports physical' && !readOnly ? 6 : 4} placeholder="Parent reports…" value={subjective}
                disabled={readOnly}
                onChange={e => setSubjective(e.target.value)}
                className={textareaCls} />
            </section>

            {/* Objective */}
            <section>
              <div className={sectionHeader}>Objective</div>
              <p className="text-[11px] text-[#999] mb-1.5">Physical exam findings, clinical observations</p>
              {noteType === 'Sports physical' && !readOnly && (
                <div className="mb-3 bg-white border border-[#E8E8E4] rounded-xl overflow-hidden">
                  <div className="px-3 py-2 border-b border-[#F1EFE8] bg-[#FAFAF8]">
                    <span className="text-[10px] font-semibold text-[#999] uppercase tracking-wider">Physical Exam — click to document, updates text below</span>
                  </div>
                  <div className="divide-y divide-[#F1EFE8]">
                    {EXAM_SYSTEMS.map(sys => {
                      const f = examFindings[sys.key]
                      const pillCls = (active: boolean) =>
                        `px-2.5 py-1 rounded-lg text-[12px] font-medium border transition-colors ${active ? 'bg-[#7F77DD] text-white border-[#7F77DD]' : 'bg-white text-[#555] border-[#E8E8E4] hover:border-[#7F77DD]'}`
                      return (
                        <div key={sys.key} className="px-3 py-2.5">
                          <div className="flex items-center gap-3 flex-wrap">
                            <span className="text-[13px] text-[#1A1A2E] w-44 flex-shrink-0">{sys.label}</span>
                            <div className="flex gap-1.5 flex-wrap">
                              {(['normal', 'abnormal', 'other'] as const).map(opt => (
                                <button key={opt} type="button"
                                  onClick={() => updateExamFinding(sys.key, { val: f.val === opt ? '' : opt, notes: '' })}
                                  className={pillCls(f.val === opt)}>
                                  {opt === 'normal' ? 'Normal' : opt === 'abnormal' ? 'Abnormal' : 'Other'}
                                </button>
                              ))}
                              {sys.hasCorrectLenses && f.val === 'normal' && (
                                <button type="button"
                                  onClick={() => updateExamFinding(sys.key, { correctedLenses: !f.correctedLenses })}
                                  className={pillCls(f.correctedLenses)}>
                                  Corrected lenses
                                </button>
                              )}
                            </div>
                          </div>
                          {(f.val === 'abnormal' || f.val === 'other') && (
                            <div className="mt-1.5 pl-[11.5rem]">
                              <input type="text" placeholder="Describe findings…" value={f.notes}
                                onChange={e => updateExamFinding(sys.key, { notes: e.target.value })}
                                className={inputCls} />
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}
              <textarea rows={noteType === 'Sports physical' && !readOnly ? 8 : 4} placeholder="General: Alert and in no acute distress…" value={objective}
                disabled={readOnly}
                onChange={e => setObjective(e.target.value)}
                className={textareaCls} />

              {/* Photo upload */}
              <div className="mt-3">
                <div className="text-[10px] font-semibold text-[#999] uppercase tracking-wider mb-2">Visit Photos</div>
                {photos.length > 0 && (
                  <div className="grid grid-cols-2 gap-3 mb-3">
                    {photos.map((photo, i) => (
                      <div key={i} className="border border-[#E8E8E4] rounded-xl overflow-hidden bg-white">
                        <img src={photo.url} alt={photo.caption || `Photo ${i + 1}`}
                          className="w-full h-36 object-cover cursor-pointer"
                          onClick={() => window.open(photo.url, '_blank')} />
                        <div className="p-2 flex items-center gap-2">
                          <input
                            type="text"
                            placeholder="Caption (optional)…"
                            value={photo.caption}
                            disabled={readOnly}
                            onChange={e => setPhotos(prev => prev.map((p, j) => j === i ? { ...p, caption: e.target.value } : p))}
                            className="flex-1 text-[12px] border border-[#E8E8E4] rounded-lg px-2 py-1 outline-none focus:border-[#7F77DD] font-sans disabled:bg-[#F8F8F6] disabled:text-[#999]" />
                          {!readOnly && (
                            <button onClick={() => setPhotos(prev => prev.filter((_, j) => j !== i))}
                              className="text-[#999] hover:text-[#cc2200] transition-colors flex-shrink-0">
                              <Trash2 size={14} />
                            </button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                {!readOnly && (
                  <>
                    <input
                      ref={photoInputRef}
                      type="file"
                      accept="image/*"
                      className="hidden"
                      onChange={e => { const f = e.target.files?.[0]; if (f) handlePhotoFile(f); e.target.value = '' }} />
                    <button
                      type="button"
                      disabled={photoUploading}
                      onClick={() => photoInputRef.current?.click()}
                      className="flex items-center gap-1.5 text-[13px] text-[#7F77DD] font-medium hover:text-[#534AB7] transition-colors disabled:opacity-50">
                      <Camera size={14} />
                      {photoUploading ? 'Uploading…' : 'Add photo'}
                    </button>
                  </>
                )}
              </div>
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

            {/* CPT Codes / Procedures */}
            <section>
              <div className={sectionHeader}>Procedures &amp; Fees</div>

              {/* Selected codes */}
              {cptCodes.length > 0 && (
                <div className="space-y-1.5 mb-3">
                  {cptCodes.map(c => (
                    <div key={c.code} className="flex items-center justify-between px-3 py-2 bg-white border border-[#E8E8E4] rounded-lg">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className={`text-[11px] font-semibold px-1.5 py-0.5 rounded flex-shrink-0 ${c.category === 'Procedure' ? 'bg-[#EEEDFE] text-[#3C3489]' : 'bg-[#FEF3E8] text-[#633806]'}`}>
                          {c.code}
                        </span>
                        <span className="text-[13px] text-[#1A1A2E] truncate">{c.description}</span>
                      </div>
                      <div className="flex items-center gap-2 flex-shrink-0 ml-2">
                        <span className="text-[13px] font-medium text-[#1A1A2E]">${c.charge_amount.toFixed(2)}</span>
                        {!readOnly && (
                          <button onClick={() => setCptCodes(prev => prev.filter(x => x.code !== c.code))}
                            className="text-[#999] hover:text-[#791F1F] transition-colors">
                            <X size={13} />
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                  {/* Total */}
                  <div className="flex justify-end px-3 pt-1">
                    <span className="text-[12px] font-semibold text-[#1A1A2E]">
                      Total: ${cptCodes.reduce((sum, c) => sum + c.charge_amount, 0).toFixed(2)}
                    </span>
                  </div>
                </div>
              )}

              {/* Add codes picker */}
              {!readOnly && (
                <div>
                  <button
                    onClick={() => setCptOpen(o => !o)}
                    className="flex items-center gap-1.5 text-[13px] text-[#7F77DD] font-medium hover:text-[#534AB7] transition-colors mb-2">
                    <span className="text-lg leading-none">+</span> Add procedure or fee
                  </button>

                  {cptOpen && (
                    <div className="border border-[#E8E8E4] rounded-xl overflow-hidden bg-white">
                      {/* Search */}
                      <div className="p-2 border-b border-[#F1EFE8]">
                        <input
                          type="text"
                          placeholder="Search by code or description…"
                          value={cptSearch}
                          onChange={e => setCptSearch(e.target.value)}
                          className="w-full px-3 py-1.5 border border-[#E8E8E4] rounded-lg text-[13px] outline-none focus:border-[#7F77DD] font-sans"
                          autoFocus
                        />
                      </div>
                      {/* Tabs */}
                      <div className="flex border-b border-[#F1EFE8]">
                        {(['Procedure', 'Non-Covered Services'] as const).map(tab => (
                          <button key={tab}
                            onClick={() => setCptTab(tab)}
                            className={`flex-1 py-2 text-[12px] font-medium transition-colors ${cptTab === tab ? 'text-[#7F77DD] border-b-2 border-[#7F77DD]' : 'text-[#999]'}`}>
                            {tab === 'Procedure' ? 'Insurance Procedures' : 'Convenience & Self-Pay'}
                          </button>
                        ))}
                      </div>
                      {/* Code list */}
                      <div className="max-h-48 overflow-y-auto">
                        {feeSchedule
                          .filter(c => c.category === cptTab)
                          .filter(c => !cptSearch || c.code.toLowerCase().includes(cptSearch.toLowerCase()) || c.description.toLowerCase().includes(cptSearch.toLowerCase()))
                          .filter(c => !cptCodes.find(x => x.code === c.code))
                          .map(c => (
                            <button key={c.code}
                              onClick={() => { setCptCodes(prev => [...prev, c]); }}
                              className="w-full text-left px-3 py-2 hover:bg-[#FAFAF8] border-b border-[#F8F8F6] last:border-0 flex items-center justify-between gap-2 transition-colors">
                              <div className="flex items-center gap-2 min-w-0">
                                <span className="text-[11px] font-semibold text-[#7F77DD] flex-shrink-0">{c.code}</span>
                                <span className="text-[12px] text-[#1A1A2E] truncate">{c.description}</span>
                              </div>
                              <span className="text-[12px] font-medium text-[#555] flex-shrink-0">${c.charge_amount.toFixed(2)}</span>
                            </button>
                          ))
                        }
                        {feeSchedule.filter(c => c.category === cptTab).filter(c => !cptSearch || c.code.toLowerCase().includes(cptSearch.toLowerCase()) || c.description.toLowerCase().includes(cptSearch.toLowerCase())).filter(c => !cptCodes.find(x => x.code === c.code)).length === 0 && (
                          <div className="px-3 py-3 text-[12px] text-[#999]">No codes match your search.</div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )}
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
          <div className="flex items-center justify-between gap-2 px-6 py-4 border-t border-[#E8E8E4] bg-white flex-shrink-0">
            <div className="flex-1">
              {signError && <div className="text-[12px] text-[#DC2626]">{signError}</div>}
            </div>
            <div className="flex items-center gap-2">
              <Button variant="secondary" onClick={saveDraft} loading={saving} disabled={signing}>
                Save draft
              </Button>
              <Button variant="teal" onClick={signNote} loading={signing} disabled={saving}>
                Sign &amp; lock note
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
