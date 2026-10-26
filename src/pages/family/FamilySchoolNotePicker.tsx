import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Stethoscope, ArrowRight } from 'lucide-react'
import { familyGetVisitsForSchoolNote } from '../../lib/api'
import { useFamilyAuth } from '../../contexts/FamilyAuthContext'
import { formatApiDate } from '../../lib/dateUtils'

interface Visit {
  appointment_id: string
  scheduled_date: string | null
  visit_type: string | null
  child_id: string
  child_first_name: string | null
  child_last_name: string | null
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
  const [visits, setVisits] = useState<Visit[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    // Pulls from appointments directly (server caps at 60 days) so the
    // parent can request a school note the moment a visit is on the
    // calendar — provider doesn't have to open or sign the encounter
    // note first. Sara 2026-10-26.
    familyGetVisitsForSchoolNote()
      .then(data => setVisits(data ?? []))
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

      {!loading && !error && visits.length === 0 && (
        <div className="bg-white border border-[#E8E8E4] rounded-2xl p-8 text-center shadow-sm">
          <Stethoscope size={32} className="text-[#E8E8E4] mx-auto mb-3" />
          <div className="text-[14px] font-medium text-[#1A1A2E]">No recent visits found</div>
          <div className="text-[13px] text-[#1A1A2E]/70 mt-2 leading-relaxed">
            We only show visits from the last 60 days. If you need a school note for an older visit, please call our office so we can look it up.
          </div>
        </div>
      )}

      {!loading && !error && visits.length > 0 && (
        <div className="space-y-3">
          {visits.map(v => {
            const target = `/family/school-excuse-request?appointment=${encodeURIComponent(v.appointment_id)}`
            const childName = [v.child_first_name, v.child_last_name].filter(Boolean).join(' ').trim()
            return (
              <Link
                key={v.appointment_id}
                to={target}
                className="block bg-white border border-[#E8E8E4] rounded-xl p-4 shadow-sm transition-colors hover:border-[#AFA9EC] cursor-pointer"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="font-display text-[15px] font-semibold text-[#1A1A2E]">
                      {fmt(v.scheduled_date)}
                    </div>
                    <div className="text-[12px] text-[#1A1A2E] mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
                      {v.visit_type && (
                        <span className="text-[11px] font-medium bg-[#EEEDFE] text-[#3C3489] px-2 py-0.5 rounded-full">
                          {v.visit_type}
                        </span>
                      )}
                      {v.provider_name && <span>{v.provider_name}</span>}
                      {multiChild && childName && (
                        <span className="text-[#7F77DD] font-medium">{childName}</span>
                      )}
                    </div>
                  </div>
                  <ArrowRight size={16} className="text-[#7F77DD] mt-1 flex-shrink-0" />
                </div>
              </Link>
            )
          })}
        </div>
      )}
    </div>
  )
}
