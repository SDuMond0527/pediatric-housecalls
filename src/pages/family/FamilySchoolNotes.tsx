import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { FileText, Stethoscope, Download, Plus } from 'lucide-react'
import {
  familyGetSchoolNotes,
  familyGetEncounterNotes,
  familyDownloadEncounterNoteHtml,
} from '../../lib/api'
import { useFamilyAuth } from '../../contexts/FamilyAuthContext'
import { formatApiDate } from '../../lib/dateUtils'

interface SchoolNote {
  id: string
  child_id: string
  child_name: string
  excuse_dates_text: string
  provider_name: string | null
  blob_url: string
  filename: string
  sent_at: string | null
  status: string
  created_at: string
  visit_date: string | null
  visit_type: string | null
}

interface EncounterNote {
  id: string
  child_id: string
  child_name: string
  visit_type: string | null
  scheduled_date: string | null
  provider_name: string | null
  signed_at: string
}

function fmtDate(d: string | null | undefined, fallback = 'Date unknown'): string {
  if (!d) return fallback
  return formatApiDate(d, 'MMMM d, yyyy') || d
}

export function FamilySchoolNotes() {
  const { children } = useFamilyAuth()
  const [schoolNotes, setSchoolNotes] = useState<SchoolNote[]>([])
  const [encounterNotes, setEncounterNotes] = useState<EncounterNote[]>([])
  const [loadingSchool, setLoadingSchool] = useState(true)
  const [loadingEncounter, setLoadingEncounter] = useState(true)

  useEffect(() => {
    familyGetSchoolNotes()
      .then(data => setSchoolNotes(data ?? []))
      .catch(() => setSchoolNotes([]))
      .finally(() => setLoadingSchool(false))
    familyGetEncounterNotes()
      .then(data => setEncounterNotes((data ?? []) as EncounterNote[]))
      .catch(() => setEncounterNotes([]))
      .finally(() => setLoadingEncounter(false))
  }, [])

  const multiChild = (children?.length ?? 0) > 1

  return (
    <div>
      <div className="mb-6 flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="font-display text-[22px] font-semibold text-[#1A1A2E]">School notes</h1>
          <p className="text-[13px] text-[#1A1A2E] mt-1">
            Download school excuse notes and visit notes from completed visits
          </p>
        </div>
        <Link
          to="/family/school-note"
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[13px] font-medium bg-[#EEEDFE] text-[#3C3489] hover:bg-[#DBD9F9] transition-colors"
        >
          <Plus size={14} /> Request a school note
        </Link>
      </div>

      <section className="mb-10">
        <div className="flex items-center gap-2 mb-3">
          <FileText size={16} className="text-[#7F77DD]" />
          <h2 className="font-display text-[15px] font-semibold text-[#1A1A2E]">School excuse notes</h2>
        </div>

        {loadingSchool && (
          <div className="text-center py-10 text-[#1A1A2E] text-[14px]">Loading school notes…</div>
        )}

        {!loadingSchool && schoolNotes.length === 0 && (
          <div className="text-center py-10 bg-white border border-[#E8E8E4] rounded-xl">
            <FileText size={28} className="text-[#E8E8E4] mx-auto mb-2" />
            <div className="text-[13px] text-[#1A1A2E]">No school excuse notes yet.</div>
            <div className="text-[12px] text-[#555] mt-1">
              Request one from the button above after a sick visit.
            </div>
          </div>
        )}

        <div className="space-y-3">
          {schoolNotes.map(note => (
            <div
              key={note.id}
              className="bg-white border border-[#E8E8E4] rounded-xl px-5 py-4 flex items-start justify-between gap-3 shadow-sm"
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap mb-1">
                  <span className="font-display text-[14px] font-semibold text-[#1A1A2E]">
                    {note.excuse_dates_text}
                  </span>
                  {multiChild && (
                    <span className="text-[11px] font-medium bg-[#EEEDFE] text-[#3C3489] px-2 py-0.5 rounded-full">
                      {note.child_name}
                    </span>
                  )}
                </div>
                <div className="text-[12px] text-[#1A1A2E] flex flex-wrap gap-x-3 gap-y-0.5">
                  {note.provider_name && <span>{note.provider_name}</span>}
                  <span className="text-[#555]">Generated {fmtDate(note.created_at)}</span>
                </div>
              </div>
              <a
                href={note.blob_url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-[12px] text-[#7F77DD] hover:underline flex-shrink-0"
              >
                <Download size={12} /> Download PDF
              </a>
            </div>
          ))}
        </div>
      </section>

      <section>
        <div className="flex items-center gap-2 mb-3">
          <Stethoscope size={16} className="text-[#7F77DD]" />
          <h2 className="font-display text-[15px] font-semibold text-[#1A1A2E]">Visit notes</h2>
        </div>

        {loadingEncounter && (
          <div className="text-center py-10 text-[#1A1A2E] text-[14px]">Loading visit notes…</div>
        )}

        {!loadingEncounter && encounterNotes.length === 0 && (
          <div className="text-center py-10 bg-white border border-[#E8E8E4] rounded-xl">
            <Stethoscope size={28} className="text-[#E8E8E4] mx-auto mb-2" />
            <div className="text-[13px] text-[#1A1A2E]">No completed visit notes yet.</div>
            <div className="text-[12px] text-[#555] mt-1">
              Notes appear here once a provider signs off on a visit.
            </div>
          </div>
        )}

        <div className="space-y-3">
          {encounterNotes.map(note => (
            <div
              key={note.id}
              className="bg-white border border-[#E8E8E4] rounded-xl px-5 py-4 flex items-start justify-between gap-3 shadow-sm"
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap mb-1">
                  <span className="font-display text-[14px] font-semibold text-[#1A1A2E]">
                    {fmtDate(note.scheduled_date)}
                  </span>
                  {note.visit_type && (
                    <span className="text-[11px] font-medium bg-[#EEEDFE] text-[#3C3489] px-2 py-0.5 rounded-full">
                      {note.visit_type}
                    </span>
                  )}
                  {multiChild && (
                    <span className="text-[11px] font-medium bg-[#F1EFE8] text-[#1A1A2E] px-2 py-0.5 rounded-full">
                      {note.child_name}
                    </span>
                  )}
                </div>
                <div className="text-[12px] text-[#1A1A2E]">
                  {note.provider_name || '—'}
                </div>
              </div>
              <button
                type="button"
                onClick={() =>
                  familyDownloadEncounterNoteHtml(note.id).catch(err =>
                    alert(err?.message ?? 'Download failed')
                  )
                }
                className="inline-flex items-center gap-1 text-[12px] text-[#7F77DD] hover:underline flex-shrink-0"
                title="Opens the visit note in a new tab. Use ⌘P → Save as PDF to save."
              >
                <Download size={12} /> Download
              </button>
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}
