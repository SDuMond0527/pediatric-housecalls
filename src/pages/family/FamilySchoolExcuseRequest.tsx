import { useEffect, useMemo, useState } from 'react'
import { useSearchParams, useNavigate } from 'react-router-dom'
import { format } from 'date-fns'
import { CheckCircle2, ArrowLeft } from 'lucide-react'
import { familyGetEncounterNotes, familyGetBookingRequests, familySubmitSchoolExcuseRequest } from '../../lib/api'
import { useFamilyAuth } from '../../contexts/FamilyAuthContext'
import { Button } from '../../components/ui/Button'

/**
 * Reached from the post-visit email link:
 *   /family/school-excuse-request?appointment=<uuid>
 *
 * Auto-fills patient / DOB / visit date from the appointment (owned by
 * this family; server verifies again). Parent adds excuse dates + any
 * extra notes; on submit we email pam@pedshousecalls.com.
 */
export function FamilySchoolExcuseRequest() {
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const appointmentId = params.get('appointment') || ''
  const { children } = useFamilyAuth()

  const [loading, setLoading] = useState(true)
  const [appointment, setAppointment] = useState<any>(null)
  const [child, setChild] = useState<any>(null)
  const [excuseDates, setExcuseDates] = useState('')
  const [notes, setNotes] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    async function load() {
      if (!appointmentId) { setLoading(false); return }
      try {
        // Pull the family's booking requests + notes so we can locate
        // the appointment context. Both endpoints are already family-
        // scoped by Cognito; server re-checks ownership on submit.
        const [notes, brs] = await Promise.all([
          familyGetEncounterNotes().catch(() => []),
          familyGetBookingRequests().catch(() => []),
        ])
        if (cancelled) return
        const noteMatch = (notes ?? []).find((n: any) => n.appointment_id === appointmentId)
        const brMatch = (brs ?? []).find((br: any) => br.appointment_id === appointmentId)
        const appt = noteMatch ?? brMatch ?? null
        if (appt) {
          const kidId = appt.child_id ?? brMatch?.child_id ?? null
          const kid = children?.find(c => c.id === kidId) ?? null
          setAppointment(appt)
          setChild(kid)
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [appointmentId, children])

  const visitDateFormatted = useMemo(() => {
    const d = appointment?.scheduled_date
    if (!d) return '—'
    try {
      const [y, m, day] = String(d).split('T')[0].split('-').map(Number)
      return format(new Date(y, m - 1, day), 'EEEE, MMMM d, yyyy')
    } catch { return String(d) }
  }, [appointment])

  const dobFormatted = useMemo(() => {
    const d = child?.date_of_birth
    if (!d) return '—'
    try {
      const [y, m, day] = String(d).split('T')[0].split('-').map(Number)
      return format(new Date(y, m - 1, day), 'MMMM d, yyyy')
    } catch { return String(d) }
  }, [child])

  const childName = child ? [child.first_name, child.last_name].filter(Boolean).join(' ') : ''

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    if (!excuseDates.trim()) {
      setError('Please tell us which dates need to be excused.')
      return
    }
    setSubmitting(true)
    try {
      await familySubmitSchoolExcuseRequest({
        appointment_id: appointmentId,
        excuse_dates: excuseDates.trim(),
        additional_notes: notes.trim(),
      })
      setSubmitted(true)
    } catch (err: any) {
      setError(err?.message ?? 'Something went wrong. Please try again.')
    } finally {
      setSubmitting(false)
    }
  }

  if (submitted) {
    return (
      <div className="max-w-xl mx-auto">
        <div className="bg-white border border-[#A9DFBF] rounded-2xl p-8 text-center shadow-sm">
          <CheckCircle2 size={40} className="text-[#1D9E75] mx-auto mb-3" />
          <h2 className="font-display text-[20px] font-semibold text-[#1A1A2E] mb-2">Request received</h2>
          <p className="text-[14px] text-[#1A1A2E]/80 leading-relaxed">
            Thanks! We'll email your school note within 24 hours.
          </p>
          <Button onClick={() => navigate('/family/dashboard')} className="mt-6">
            Back to dashboard
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="max-w-xl mx-auto">
      <button
        onClick={() => navigate(-1)}
        className="inline-flex items-center gap-1 text-[13px] text-[#7F77DD] hover:underline mb-4">
        <ArrowLeft size={14} /> Back
      </button>

      <div className="mb-6">
        <h1 className="font-display text-[22px] font-semibold text-[#1A1A2E]">Request a school note</h1>
        <p className="text-[13px] text-[#1A1A2E] mt-1">
          Fill in the dates you need excused. We'll email your school note within 24 hours.
        </p>
      </div>

      {loading && <div className="py-10 text-center text-[13px] text-[#1A1A2E]/70">Loading visit details…</div>}

      {!loading && !appointment && (
        <div className="bg-[#FCEBEB] border border-[#F5C6C6] rounded-xl p-4 text-[13px] text-[#991B1B]">
          We couldn't find this visit. If you just had a visit, please try again from the email link.
        </div>
      )}

      {!loading && appointment && (
        <form onSubmit={handleSubmit} className="bg-white border border-[#E8E8E4] rounded-2xl p-6 shadow-sm space-y-5">
          {/* Auto-populated fields */}
          <div className="bg-[#FAFAF8] rounded-xl border border-[#E8E8E4] p-4 space-y-2 text-[13px]">
            <div className="flex justify-between">
              <span className="text-[#555]">Patient</span>
              <span className="font-medium text-[#1A1A2E]">{childName || '—'}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-[#555]">Date of birth</span>
              <span className="text-[#1A1A2E]">{dobFormatted}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-[#555]">Visit date</span>
              <span className="text-[#1A1A2E]">{visitDateFormatted}</span>
            </div>
          </div>

          <div>
            <label className="block text-[12px] font-semibold text-[#555] mb-1.5 uppercase tracking-wider">
              What dates does your child need to be excused for? <span className="text-[#B91C1C]">*</span>
            </label>
            <input
              type="text"
              value={excuseDates}
              onChange={e => setExcuseDates(e.target.value)}
              placeholder="e.g. September 9 – 11, 2026"
              className="w-full px-3 py-2.5 border border-[#E8E8E4] rounded-lg text-[14px] outline-none focus:border-[#7F77DD] focus:ring-2 focus:ring-[#7F77DD]/10"
              required
            />
          </div>

          <div>
            <label className="block text-[12px] font-semibold text-[#555] mb-1.5 uppercase tracking-wider">
              Any other notes to include on the school excuse?
            </label>
            <textarea
              value={notes}
              onChange={e => setNotes(e.target.value)}
              rows={4}
              placeholder="e.g. Please include activity restrictions, gym exemption, etc."
              className="w-full px-3 py-2.5 border border-[#E8E8E4] rounded-lg text-[14px] outline-none focus:border-[#7F77DD] focus:ring-2 focus:ring-[#7F77DD]/10 resize-y"
            />
          </div>

          {error && (
            <div className="bg-[#FCEBEB] border border-[#F5C6C6] rounded-lg p-3 text-[13px] text-[#991B1B]">
              {error}
            </div>
          )}

          <div className="flex gap-2 justify-end pt-2">
            <Button variant="secondary" onClick={() => navigate(-1)} disabled={submitting}>
              Cancel
            </Button>
            <Button type="submit" loading={submitting}>
              Send request
            </Button>
          </div>
        </form>
      )}
    </div>
  )
}
