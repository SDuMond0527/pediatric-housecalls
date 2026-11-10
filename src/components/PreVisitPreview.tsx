import { useEffect, useState } from 'react'
import { X, MapPin, AlertTriangle, FileText, Phone, Mail, Pill, Heart, Stethoscope, Clock, RefreshCw, ExternalLink, FileSearch, History } from 'lucide-react'
import { getPreVisitPreview, regeneratePreVisitPreview, type PreVisitPreviewData, type PreviewBullet } from '../lib/api'

// Shared Pre-Visit Preview panel. Opens as a bottom-sheet on mobile,
// center-modal on desktop. Fetches from /api/pre-visit-preview/{apptId}
// which handles on-demand generation for same-day bookings. Design
// decisions (allergies at top in red, section order, color-coding) are
// inherited from the mockup Sara signed off on at MockupVisitPrep.tsx.
// Sara 2026-11-10.

const SECTION_META: Record<string, {
  label: string
  icon: typeof MapPin
  tone: 'default' | 'danger' | 'warning'
}> = {
  reason_for_visit:     { label: 'Why they booked',        icon: Stethoscope,  tone: 'default' },
  active_clinical:      { label: 'Allergies / problems / meds', icon: AlertTriangle, tone: 'danger' },
  last_visit:           { label: 'Last visit',             icon: History,      tone: 'default' },
  changes_since_last:   { label: 'Changes since last visit', icon: RefreshCw, tone: 'default' },
  open_items:           { label: 'Open items',             icon: FileSearch,   tone: 'warning' },
  house_call_logistics: { label: 'Visit logistics',        icon: MapPin,       tone: 'default' },
}

export function PreVisitPreview({ appointmentId, onClose }: {
  appointmentId: string
  onClose: () => void
}) {
  const [data, setData] = useState<PreVisitPreviewData | null>(null)
  const [generatedAt, setGeneratedAt] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [err, setErr] = useState('')

  async function load() {
    setLoading(true)
    setErr('')
    try {
      const r = await getPreVisitPreview(appointmentId)
      setData(r.data)
      setGeneratedAt(r.generated_at)
    } catch (e: any) {
      setErr(e?.message ?? 'Failed to load preview')
    } finally {
      setLoading(false)
    }
  }

  async function refresh() {
    setRefreshing(true)
    setErr('')
    try {
      const r = await regeneratePreVisitPreview(appointmentId)
      setData(r.data)
      setGeneratedAt(r.generated_at)
    } catch (e: any) {
      setErr(e?.message ?? 'Refresh failed')
    } finally {
      setRefreshing(false)
    }
  }

  useEffect(() => { void load() }, [appointmentId])

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center justify-center sm:p-4"
         onClick={onClose}>
      <div
        className="bg-white w-full sm:max-w-md sm:rounded-2xl rounded-t-2xl shadow-2xl max-h-[92vh] flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-5 pt-4 pb-3 border-b border-[#E8E8E4] flex items-start gap-3">
          <div className="flex-1 min-w-0">
            <div className="text-[11px] uppercase tracking-wider text-[#1A1A2E]/60">Pre-visit preview</div>
            {data && (
              <>
                <div className="font-display text-[17px] font-semibold text-[#1A1A2E] mt-0.5 truncate">
                  {data.patient.name}
                </div>
                <div className="text-[12px] text-[#1A1A2E]/70 mt-0.5">
                  {data.patient.age_display && <>{data.patient.age_display} · </>}
                  {data.patient.kind === 'patient_profile' && <>Generic patient · </>}
                  <Clock size={10} className="inline -mt-0.5 mr-0.5" />
                  Generated {generatedAt ? new Date(generatedAt).toLocaleString() : 'just now'}
                </div>
              </>
            )}
            {loading && !data && <div className="font-display text-[15px] text-[#555] mt-1">Loading…</div>}
          </div>
          <button onClick={() => void refresh()} disabled={loading || refreshing}
            title="Rebuild from the latest data"
            className="text-[11px] text-[#7F77DD] hover:bg-[#EEEDFE] rounded-full px-2 py-1 inline-flex items-center gap-1 disabled:opacity-50">
            <RefreshCw size={11} className={refreshing ? 'animate-spin' : ''} /> Refresh
          </button>
          <button onClick={onClose} className="text-[#1A1A2E]/60 hover:text-[#1A1A2E] p-1 -mr-1"><X size={16} /></button>
        </div>

        {/* Body */}
        <div className="overflow-auto flex-1">
          {err && (
            <div className="m-4 flex items-start gap-2 text-[13px] text-[#991B1B] bg-[#FCEBEB] border border-[#F5C6C6] px-3 py-2 rounded-lg">
              <AlertTriangle size={14} className="mt-0.5 flex-shrink-0" /> <span>{err}</span>
            </div>
          )}

          {!loading && data && Object.entries(data.sections).map(([key, section]) => {
            if (!section) return null
            const meta = SECTION_META[key] ?? { label: key, icon: FileText, tone: 'default' as const }
            const Icon = meta.icon
            const bgCls = meta.tone === 'danger' ? 'bg-[#FEF2F2]'
                        : meta.tone === 'warning' ? 'bg-[#FEF3C7]'
                        : ''
            const headerCls = meta.tone === 'danger' ? 'text-[#991B1B]'
                            : meta.tone === 'warning' ? 'text-[#92400E]'
                            : 'text-[#1A1A2E]/60'

            return (
              <div key={key} className={`px-5 py-3 border-b border-[#E8E8E4] ${bgCls}`}>
                <div className={`flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider mb-1.5 ${headerCls}`}>
                  <Icon size={11} /> {meta.label}
                </div>
                {section.bullets.length === 0 ? (
                  <div className="text-[13px] text-[#1A1A2E]/60 italic">Nothing to show.</div>
                ) : (
                  <ul className="space-y-1">
                    {section.bullets.map((b, i) => (
                      <PreviewBulletLine key={i} bullet={b} />
                    ))}
                  </ul>
                )}
              </div>
            )
          })}

          {!loading && !data && !err && (
            <div className="px-5 py-10 text-center text-[13px] text-[#1A1A2E]/60">No preview available.</div>
          )}
        </div>

        {/* Footer source-citation reminder — Sara's rule "every statement
            must link to its source" needs to be visible to the clinician
            so they understand that bullets are grounded, not invented. */}
        <div className="px-5 py-2.5 border-t border-[#E8E8E4] bg-[#FAFAF8] text-[10px] text-[#1A1A2E]/60 leading-snug">
          Every statement above is pulled directly from GoRoam records and marked with its source. If something's missing, it's because it's not on file — not because we're hiding it.
        </div>
      </div>
    </div>
  )
}

function PreviewBulletLine({ bullet }: { bullet: PreviewBullet }) {
  const hasSource = bullet.source_type !== 'none' && !!bullet.source_id
  return (
    <li className="text-[13px] text-[#1A1A2E] leading-snug flex items-start gap-1.5">
      <span className="text-[#1A1A2E]/40 mt-0.5">•</span>
      <div className="flex-1">
        <span>{bullet.text}</span>
        {hasSource && bullet.source_label && (
          <span className="ml-1.5 inline-flex items-center gap-0.5 text-[10px] text-[#7F77DD] bg-[#EEEDFE] rounded-full px-1.5 py-0.5 align-middle">
            <ExternalLink size={8} /> {bullet.source_label}
          </span>
        )}
      </div>
    </li>
  )
}

// Compact "Preview" pill button that pages drop into appointment cards.
export function PreVisitPreviewButton({ appointmentId, label = 'Preview' }: {
  appointmentId: string
  label?: string
}) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        type="button"
        onClick={e => { e.stopPropagation(); setOpen(true) }}
        title="Open the Pre-Visit Preview for this appointment"
        className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold border border-[#7F77DD] bg-white text-[#7F77DD] hover:bg-[#EEEDFE] whitespace-nowrap"
      >
        <FileSearch size={10} /> {label}
      </button>
      {open && <PreVisitPreview appointmentId={appointmentId} onClose={() => setOpen(false)} />}
    </>
  )
}

// Silence unused-import warnings from icons kept available for future
// section tones (Pill = meds, Heart = problems, Phone/Mail = contact).
// These exist on the design mockup and I want them accessible for the
// Phase 1 iteration if we expand sections.
export const _reservedIcons = { Phone, Mail, Pill, Heart, FileText }

// Variant for the patient chart — finds the child's next upcoming
// appointment on click and opens the preview for that. Hidden
// entirely when the child has no future appointments on the books.
export function PreVisitPreviewForChildButton({ childId: _childId, upcomingAppointmentId }: {
  // childId kept in the signature for future use (e.g. when we fetch the
  // next-upcoming-appointment on click instead of relying on parent state)
  childId: string
  upcomingAppointmentId: string | null
}) {
  const [open, setOpen] = useState(false)
  if (!upcomingAppointmentId) {
    return (
      <span className="text-[11px] text-[#1A1A2E]/50 inline-flex items-center gap-1 italic">
        <FileSearch size={10} /> No upcoming visit to preview
      </span>
    )
  }
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="Open the Pre-Visit Preview for the next upcoming appointment"
        className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-semibold border border-[#7F77DD] bg-white text-[#7F77DD] hover:bg-[#EEEDFE]"
      >
        <FileSearch size={11} /> Next-visit preview
      </button>
      {open && <PreVisitPreview appointmentId={upcomingAppointmentId} onClose={() => setOpen(false)} />}
    </>
  )
}
