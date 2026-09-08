import { useEffect, useState } from 'react'
import { ChevronDown, Stethoscope } from 'lucide-react'
import { format, parseISO } from 'date-fns'
import { familyGetEncounterNotes } from '../../lib/api'
import { useFamilyAuth } from '../../contexts/FamilyAuthContext'

interface EncounterNote {
  id: string
  child_id: string
  child_name: string
  chief_complaint: string | null
  assessment: string | null
  plan: string | null
  after_visit_instructions: string | null
  diagnoses: string[]
  signed_at: string
  visit_type: string | null
  scheduled_date: string | null
  scheduled_time: string | null
  provider_name: string | null
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return 'Date unknown'
  try {
    return format(parseISO(dateStr), 'MMMM d, yyyy')
  } catch {
    return dateStr
  }
}

export function FamilyVisitHistory() {
  const { children } = useFamilyAuth()
  const [notes, setNotes] = useState<EncounterNote[]>([])
  const [loading, setLoading] = useState(true)
  const [expanded, setExpanded] = useState<string | null>(null)

  useEffect(() => {
    familyGetEncounterNotes()
      .then(data => setNotes(data ?? []))
      .catch(() => setNotes([]))
      .finally(() => setLoading(false))
  }, [])

  const multiChild = (children?.length ?? 0) > 1

  return (
    <div>
      <div className="mb-6">
        <h1 className="font-display text-[22px] font-semibold text-[#1A1A2E]">Visit history</h1>
        <p className="text-[13px] text-[#999] mt-1">Notes from completed and signed visits</p>
      </div>

      {loading && (
        <div className="text-center py-16 text-[#999] text-[14px]">Loading visit notes…</div>
      )}

      {!loading && notes.length === 0 && (
        <div className="text-center py-16">
          <Stethoscope size={32} className="text-[#E8E8E4] mx-auto mb-3" />
          <div className="text-[14px] text-[#999]">No completed visit notes yet.</div>
          <div className="text-[13px] text-[#bbb] mt-1">Notes will appear here after a provider signs off on a visit.</div>
        </div>
      )}

      <div className="space-y-3">
        {notes.map(note => {
          const isOpen = expanded === note.id
          const hasContent = note.chief_complaint || note.assessment || note.plan ||
            note.after_visit_instructions || note.diagnoses.length > 0

          return (
            <div key={note.id} className="bg-white border border-[#E8E8E4] rounded-xl overflow-hidden shadow-sm">
              <button
                className="w-full text-left px-5 py-4 flex items-start justify-between gap-3"
                onClick={() => setExpanded(isOpen ? null : note.id)}
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap mb-1">
                    <span className="font-display text-[15px] font-semibold text-[#1A1A2E]">
                      {formatDate(note.scheduled_date)}
                    </span>
                    {note.visit_type && (
                      <span className="text-[11px] font-medium bg-[#EEEDFE] text-[#3C3489] px-2 py-0.5 rounded-full">
                        {note.visit_type}
                      </span>
                    )}
                  </div>
                  <div className="text-[12px] text-[#999] flex flex-wrap gap-x-3 gap-y-0.5">
                    {note.provider_name && <span>{note.provider_name}</span>}
                    {multiChild && note.child_name && (
                      <span className="text-[#7F77DD]">{note.child_name}</span>
                    )}
                    {note.scheduled_time && <span>{note.scheduled_time}</span>}
                  </div>
                  {note.chief_complaint && !isOpen && (
                    <div className="text-[12px] text-[#555] mt-1.5 truncate">
                      {note.chief_complaint}
                    </div>
                  )}
                </div>
                {hasContent && (
                  <ChevronDown
                    size={14}
                    className={`text-[#999] flex-shrink-0 mt-1 transition-transform ${isOpen ? 'rotate-180' : ''}`}
                  />
                )}
              </button>

              {isOpen && hasContent && (
                <div className="px-5 pb-5 border-t border-[#F1EFE8] pt-4 space-y-4">
                  {note.chief_complaint && (
                    <div>
                      <div className="text-[10px] font-semibold text-[#7F77DD] uppercase tracking-wider mb-1">
                        Reason for visit
                      </div>
                      <div className="text-[13px] text-[#1A1A2E] whitespace-pre-line">{note.chief_complaint}</div>
                    </div>
                  )}

                  {note.diagnoses.length > 0 && (
                    <div>
                      <div className="text-[10px] font-semibold text-[#7F77DD] uppercase tracking-wider mb-2">
                        Diagnoses
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {note.diagnoses.map((name, i) => (
                          <span key={i} className="text-[12px] font-medium bg-[#EEEDFE] text-[#3C3489] px-2.5 py-1 rounded-full">
                            {name}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}

                  {note.assessment && (
                    <div>
                      <div className="text-[10px] font-semibold text-[#7F77DD] uppercase tracking-wider mb-1">
                        Assessment
                      </div>
                      <div className="text-[13px] text-[#1A1A2E] whitespace-pre-line">{note.assessment}</div>
                    </div>
                  )}

                  {note.plan && (
                    <div>
                      <div className="text-[10px] font-semibold text-[#7F77DD] uppercase tracking-wider mb-1">
                        Plan
                      </div>
                      <div className="text-[13px] text-[#1A1A2E] whitespace-pre-line">{note.plan}</div>
                    </div>
                  )}

                  {note.after_visit_instructions && (
                    <div className="bg-[#F0FBF7] border border-[#B6E8D6] rounded-xl px-4 py-3">
                      <div className="text-[10px] font-semibold text-[#1A7D5A] uppercase tracking-wider mb-1">
                        After-visit instructions
                      </div>
                      <div className="text-[13px] text-[#1A1A2E] whitespace-pre-line">{note.after_visit_instructions}</div>
                    </div>
                  )}

                  <div className="text-[11px] text-[#bbb] pt-1 border-t border-[#F1EFE8]">
                    Note signed {note.signed_at ? format(new Date(note.signed_at), 'MMM d, yyyy') : ''}
                    {note.provider_name ? ` by ${note.provider_name}` : ''}
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
