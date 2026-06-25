import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { ChevronLeft, ChevronDown } from 'lucide-react'
import { format, parseISO, differenceInYears } from 'date-fns'
import { getEncounterNotes, getVitalsList, getChildrenByIds } from '../lib/api'
import { Badge } from '../components/ui/Badge'

function calcAge(dob: string): string {
  try {
    const years = differenceInYears(new Date(), parseISO(dob))
    return `${years}y`
  } catch {
    return ''
  }
}

function formatDob(dob: string): string {
  try {
    return format(parseISO(dob), 'MMM d, yyyy')
  } catch {
    return dob
  }
}

function vitalChips(v: any): string {
  const parts: string[] = []
  if (v?.temperature_f != null) parts.push(`${v.temperature_f}°F`)
  if (v?.heart_rate != null) parts.push(`HR ${v.heart_rate}`)
  if (v?.oxygen_saturation != null) parts.push(`O2 ${v.oxygen_saturation}%`)
  if (v?.weight_lbs != null) parts.push(`${v.weight_lbs} lbs`)
  return parts.join(' · ')
}

interface NoteWithVisit {
  id: string
  appointment_id: string
  child_id: string
  chief_complaint: string | null
  subjective: string | null
  objective: string | null
  assessment: string | null
  plan: string | null
  diagnoses: { code: string; name: string }[]
  is_signed: boolean
  signed_at: string | null
  visit_type: string
  scheduled_date: string
  scheduled_time: string
  zone: string
  provider_name: string | null
}

export function PatientChart() {
  const { childId } = useParams<{ childId: string }>()
  const navigate = useNavigate()

  const [child, setChild] = useState<any | null>(null)
  const [notes, setNotes] = useState<NoteWithVisit[]>([])
  const [vitalsByAppt, setVitalsByAppt] = useState<Record<string, any>>({})
  const [loading, setLoading] = useState(true)
  const [expandedNote, setExpandedNote] = useState<string | null>(null)

  useEffect(() => {
    if (!childId) return
    const cid = childId
    async function load() {
      setLoading(true)
      const [childrenRes, notesRes, vitalsRes] = await Promise.all([
        getChildrenByIds([cid]).catch(() => [] as any[]),
        getEncounterNotes({ child_id: cid }).catch(() => [] as NoteWithVisit[]),
        getVitalsList({ child_id: cid }).catch(() => [] as any[]),
      ])
      const childRes = childrenRes?.[0] ?? null
      setChild(childRes)
      setNotes(notesRes ?? [])
      const byAppt: Record<string, any> = {}
      ;(vitalsRes ?? []).forEach((v: any) => { byAppt[v.appointment_id] = v })
      setVitalsByAppt(byAppt)
      setLoading(false)
    }
    load()
  }, [childId])

  const name = child
    ? ([child.first_name, child.last_name].filter(Boolean).join(' ') || child.display_label || 'Unknown patient')
    : 'Loading…'

  return (
    <div className="min-h-screen bg-[#FAFAF8]">
      {/* Page header */}
      <div className="bg-white border-b border-[#E8E8E4] px-6 py-4 flex items-center gap-3 sticky top-0 z-10">
        <button onClick={() => navigate(-1)}
          className="p-1.5 rounded-lg hover:bg-[#F1EFE8] text-[#555] transition-colors flex-shrink-0">
          <ChevronLeft size={18} />
        </button>
        <div className="flex-1 min-w-0">
          <div className="font-display text-[18px] font-medium text-[#1A1A2E]">{name}</div>
          {child && (
            <div className="text-[12px] text-[#999] mt-0.5 flex items-center gap-2 flex-wrap">
              {child.date_of_birth && (
                <span>DOB {formatDob(String(child.date_of_birth).split('T')[0])} ({calcAge(String(child.date_of_birth).split('T')[0])})</span>
              )}
              {child.allergies && <span className="text-[#791F1F] font-medium">Allergies: {child.allergies}</span>}
              {child.current_medications && <span>Meds: {child.current_medications}</span>}
            </div>
          )}
        </div>
        <Badge variant="purple">{notes.length} {notes.length === 1 ? 'encounter' : 'encounters'}</Badge>
      </div>

      <div className="p-6 max-w-3xl mx-auto">
        {loading ? (
          <div className="text-center py-16 text-[#999] text-[14px]">Loading chart…</div>
        ) : notes.length === 0 ? (
          <div className="text-center py-16">
            <div className="text-[#999] text-[14px]">No encounter notes on file for this patient.</div>
          </div>
        ) : (
          <div className="space-y-3">
            {notes.map(note => {
              const vitals = vitalsByAppt[note.appointment_id]
              const chips = vitals ? vitalChips(vitals) : ''
              const isOpen = expandedNote === note.id

              return (
                <div key={note.id}
                  className={`border rounded-xl bg-white overflow-hidden transition-all ${isOpen ? 'border-[#7F77DD]' : 'border-[#E8E8E4] hover:border-[#AFA9EC]'}`}>
                  {/* Summary row */}
                  <button
                    className="w-full text-left px-5 py-4 flex items-start gap-3"
                    onClick={() => setExpandedNote(isOpen ? null : note.id)}>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap mb-1">
                        <span className="font-display text-[15px] font-medium text-[#1A1A2E]">
                          {format(parseISO(note.scheduled_date), 'MMM d, yyyy')}
                        </span>
                        <Badge variant="purple">{note.visit_type}</Badge>
                        {note.is_signed && <Badge variant="teal">Signed</Badge>}
                      </div>
                      <div className="text-[12px] text-[#999] mb-1.5">
                        {note.provider_name && <span>{note.provider_name} · </span>}
                        {note.zone}
                      </div>
                      {chips && (
                        <div className="text-[11px] font-medium text-[#555] bg-[#F1EFE8] px-2.5 py-1 rounded-full inline-block mb-2">
                          {chips}
                        </div>
                      )}
                      {note.chief_complaint && (
                        <div className="text-[13px] text-[#1A1A2E]">
                          <span className="text-[#999] text-[11px]">CC: </span>{note.chief_complaint}
                        </div>
                      )}
                      {note.diagnoses?.length > 0 && (
                        <div className="flex flex-wrap gap-1.5 mt-2">
                          {note.diagnoses.map(dx => (
                            <span key={dx.code} className="text-[11px] font-medium bg-[#EEEDFE] text-[#3C3489] px-2 py-0.5 rounded-full">
                              {dx.code} – {dx.name}
                            </span>
                          ))}
                        </div>
                      )}
                      {note.plan && (
                        <div className="text-[12px] text-[#555] mt-1.5 line-clamp-2">
                          <span className="text-[#999]">Plan: </span>
                          {note.plan.length > 120 ? note.plan.slice(0, 120) + '…' : note.plan}
                        </div>
                      )}
                      {!note.chief_complaint && !note.plan && note.diagnoses?.length === 0 && (
                        <div className="text-[12px] text-[#bbb] italic mt-1">No encounter note content</div>
                      )}
                    </div>
                    <ChevronDown size={14} className={`text-[#999] flex-shrink-0 mt-1 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
                  </button>

                  {/* Expanded full note */}
                  {isOpen && (
                    <div className="px-5 pb-5 border-t border-[#E8E8E4] pt-4 space-y-4">
                      {/* Vitals expanded */}
                      {vitals && (
                        <div>
                          <div className="text-[10px] font-semibold text-[#7F77DD] uppercase tracking-wider mb-2">Vitals</div>
                          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                            {[
                              { label: 'Temp', value: vitals.temperature_f != null ? `${vitals.temperature_f}°F` : null },
                              { label: 'HR', value: vitals.heart_rate != null ? `${vitals.heart_rate} bpm` : null },
                              { label: 'RR', value: vitals.respiratory_rate != null ? `${vitals.respiratory_rate} br/min` : null },
                              { label: 'O2 sat', value: vitals.oxygen_saturation != null ? `${vitals.oxygen_saturation}%` : null },
                              { label: 'Weight', value: vitals.weight_lbs != null ? `${vitals.weight_lbs} lbs` : null },
                              { label: 'Height', value: vitals.height_in != null ? `${vitals.height_in} in` : null },
                              { label: 'BP', value: vitals.systolic_bp != null && vitals.diastolic_bp != null ? `${vitals.systolic_bp}/${vitals.diastolic_bp}` : null },
                            ].filter(d => d.value).map(d => (
                              <div key={d.label} className="bg-[#FAFAF8] border border-[#E8E8E4] rounded-lg px-3 py-2">
                                <div className="text-[10px] text-[#999] font-medium uppercase tracking-wider">{d.label}</div>
                                <div className="text-[13px] font-medium text-[#1A1A2E] mt-0.5">{d.value}</div>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {[
                        { label: 'Chief Complaint', value: note.chief_complaint },
                        { label: 'Subjective', value: note.subjective },
                        { label: 'Objective', value: note.objective },
                        { label: 'Assessment', value: note.assessment },
                        { label: 'Plan', value: note.plan },
                      ].map(({ label, value }) => value ? (
                        <div key={label}>
                          <div className="text-[10px] font-semibold text-[#7F77DD] uppercase tracking-wider mb-1">{label}</div>
                          <div className="text-[13px] text-[#1A1A2E] whitespace-pre-line">{value}</div>
                        </div>
                      ) : null)}

                      {note.diagnoses?.length > 0 && (
                        <div>
                          <div className="text-[10px] font-semibold text-[#7F77DD] uppercase tracking-wider mb-2">Diagnoses</div>
                          <div className="flex flex-wrap gap-2">
                            {note.diagnoses.map(dx => (
                              <span key={dx.code} className="text-[12px] font-medium bg-[#EEEDFE] text-[#3C3489] px-2.5 py-1 rounded-full">
                                {dx.code} – {dx.name}
                              </span>
                            ))}
                          </div>
                        </div>
                      )}

                      {note.is_signed && note.signed_at && (
                        <div className="text-[11px] text-[#999] pt-2 border-t border-[#F1EFE8]">
                          Signed {format(new Date(note.signed_at), 'MMM d, yyyy h:mm a')}
                          {note.provider_name && ` by ${note.provider_name}`}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
