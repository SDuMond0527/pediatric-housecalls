import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Stethoscope, ArrowRight } from 'lucide-react'
import { familyGetEncounterNotes } from '../../lib/api'
import { useFamilyAuth } from '../../contexts/FamilyAuthContext'
import { formatApiDate } from '../../lib/dateUtils'

interface EncounterNote {
  id: string
  appointment_id: string | null
  child_id: string
  child_name: string
  visit_type: string | null
  scheduled_date: string | null
  provider_name: string | null
}

function fmt(d: string | null): string {
  if (!d) return 'Date unknown'
  return formatApiDate(d, 'EEEE, MMMM d, yyyy') || d
}

/**
 * Landing page for parents arriving via the pedshousecalls.com /
 * phc-team.com marketing-site "Request school note" button. Shows
 * recent visits, lets parent pick one, then forwards into the
 * existing school-excuse-request form (which already uses the
 * ?appointment=<uuid> contract). Reached at /family/school-note.
 *
 * Sara 2026-10-05 — replaces the old email-to-info@ workflow.
 */
export function FamilySchoolNotePicker() {
  const { children } = useFamilyAuth()
  const [notes, setNotes] = useState<EncounterNote[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    familyGetEncounterNotes()
      .then((data: any[]) => {
        // Last 60 days only — school notes for older visits are rare and
        // usually indicate the parent is confused about which visit they
        // mean. If they genuinely need one for an older visit, they can
        // call the office.
        const cutoff = new Date()
        cutoff.setDate(cutoff.getDate() - 60)
        const recent = (data ?? []).filter(n => {
          if (!n.scheduled_date) return false
          try {
            return new Date(n.scheduled_date) >= cutoff
          } catch { return false }
        })
        setNotes(recent)
      })
      .catch(e => setError(e?.message ?? 'Failed to load your visits'))
      .finally(() => setLoading(false))
  }, [])

  const multiChild = (children?.length ?? 0) > 1

  return (
    <div className="max-w-xl mx-auto">
      <div className="mb-6">
        <h1 className="font-display text-[22px] font-semibold text-[#1A1A2E]">Request a school note</h1>
        <p className="text-[13px] text-[#1A1A2E] mt-1 leading-relaxed">
          Pick the visit you need a school note for. We'll generate the PDF and email it to you right away — no waiting.
        </p>
      </div>

      {loading && (
        <div className="py-10 text-center text-[13px] text-[#1A1A2E]/70">Loading your recent visits…</div>
      )}

      {!loading && error && (
        <div className="bg-[#FCEBEB] border border-[#F5C6C6] rounded-xl p-4 text-[13px] text-[#991B1B]">
          {error}
        </div>
      )}

      {!loading && !error && notes.length === 0 && (
        <div className="bg-white border border-[#E8E8E4] rounded-2xl p-8 text-center shadow-sm">
          <Stethoscope size={32} className="text-[#E8E8E4] mx-auto mb-3" />
          <div className="text-[14px] font-medium text-[#1A1A2E]">No recent visits found</div>
          <div className="text-[13px] text-[#1A1A2E]/70 mt-2 leading-relaxed">
            We only show visits from the last 60 days. If you need a school note for an older visit, please call our office so we can look it up.
          </div>
        </div>
      )}

      {!loading && !error && notes.length > 0 && (
        <div className="space-y-3">
          {notes.map(n => {
            const canRequest = !!n.appointment_id
            const target = n.appointment_id
              ? `/family/school-excuse-request?appointment=${encodeURIComponent(n.appointment_id)}`
              : '#'
            const cardBase = 'bg-white border border-[#E8E8E4] rounded-xl p-4 shadow-sm transition-colors'
            const cardInteractive = canRequest ? 'hover:border-[#AFA9EC] cursor-pointer' : 'opacity-60 cursor-not-allowed'
            return (
              <Link
                key={n.id}
                to={target}
                className={`block ${cardBase} ${cardInteractive}`}
                onClick={e => { if (!canRequest) e.preventDefault() }}
                aria-disabled={!canRequest}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="font-display text-[15px] font-semibold text-[#1A1A2E]">
                      {fmt(n.scheduled_date)}
                    </div>
                    <div className="text-[12px] text-[#1A1A2E] mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
                      {n.visit_type && (
                        <span className="text-[11px] font-medium bg-[#EEEDFE] text-[#3C3489] px-2 py-0.5 rounded-full">
                          {n.visit_type}
                        </span>
                      )}
                      {n.provider_name && <span>{n.provider_name}</span>}
                      {multiChild && n.child_name && (
                        <span className="text-[#7F77DD] font-medium">{n.child_name}</span>
                      )}
                    </div>
                  </div>
                  {canRequest && <ArrowRight size={16} className="text-[#7F77DD] mt-1 flex-shrink-0" />}
                </div>
              </Link>
            )
          })}
        </div>
      )}
    </div>
  )
}
