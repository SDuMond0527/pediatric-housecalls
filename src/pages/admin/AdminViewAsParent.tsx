import { useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { format } from 'date-fns'
import { ArrowLeft, Eye, Clock, User, Stethoscope, FileText, FlaskConical, Activity, CalendarPlus, Home, Download } from 'lucide-react'
import { getFamilyPortalView, downloadEncounterNoteHtml } from '../../lib/api'
import { ChartNumberPill } from '../../components/ChartNumberPill'
import { PatientBillingList, type BillingStatement } from '../../components/PatientBillingList'
import { PatientReportsSection } from '../../components/PatientReportsSection'
import { VISIT_TYPE_INFO } from '../../lib/zipData'

type Tab = 'home' | 'visits' | 'school-notes' | 'labs' | 'radiology' | 'book' | 'profile'

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

function safeFormat(value: string | null | undefined, fmt: string, suffix = ''): string {
  if (!value) return '—'
  try {
    const d = new Date(value)
    if (isNaN(d.getTime())) return '—'
    return format(d, fmt) + suffix
  } catch { return '—' }
}

function fmtDate(d: string | null | undefined) {
  if (!d) return '—'
  try {
    const s = String(d).split('T')[0]
    const [y, m, day] = s.split('-').map(Number)
    return format(new Date(y, m - 1, day), 'MMM d, yyyy')
  } catch { return d ?? '—' }
}

export function AdminViewAsParent() {
  const { familyId } = useParams<{ familyId: string }>()
  const navigate = useNavigate()
  const [data, setData] = useState<Awaited<ReturnType<typeof getFamilyPortalView>> | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('home')

  useEffect(() => {
    if (!familyId) return
    setLoading(true)
    getFamilyPortalView(familyId)
      .then(d => { setData(d); setError(null) })
      .catch(e => setError(e?.message ?? 'Failed to load family view'))
      .finally(() => setLoading(false))
  }, [familyId])

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#FAFAF8]">
        <div className="font-display text-lg text-[#1A1A2E]/40">Loading family portal…</div>
      </div>
    )
  }

  if (error || !data) {
    return (
      <div className="p-8">
        <button onClick={() => navigate(-1)} className="text-[13px] text-[#7F77DD] flex items-center gap-1 mb-4">
          <ArrowLeft size={13} /> Back
        </button>
        <div className="text-[13px] text-red-600">{error ?? 'No data'}</div>
      </div>
    )
  }

  const { family, children, bookings, waitlist, offers, encounter_notes, statements } = data as any
  const schoolNotes: SchoolNote[] = (data as any).school_notes ?? []
  const displayName = family.display_name || family.email || 'this family'

  return (
    <div className="min-h-screen bg-[#FAFAF8]">
      {/* View-as-parent banner — makes it obvious this is an impersonation view. */}
      <div className="bg-[#EEEDFE] border-b border-[#AFA9EC] px-6 py-3 flex items-center justify-between gap-4 sticky top-0 z-30">
        <div className="flex items-center gap-3 min-w-0">
          <Eye size={16} className="text-[#7F77DD] flex-shrink-0" />
          <div className="min-w-0">
            <div className="font-display text-[14px] font-medium text-[#1A1A2E] truncate">
              Viewing {displayName}'s parent portal
            </div>
            <div className="text-[11px] text-[#1A1A2E]/70">Read-only · Admin impersonation view</div>
          </div>
        </div>
        <button
          onClick={() => navigate(-1)}
          className="text-[12px] font-medium text-[#7F77DD] flex items-center gap-1 hover:underline flex-shrink-0">
          <ArrowLeft size={12} /> Back to chart
        </button>
      </div>

      {/* Tab bar — matches the parent portal nav in FamilyLayout exactly. */}
      <div className="bg-white border-b border-[#E8E8E4] px-6 py-3 flex items-center gap-1 overflow-x-auto">
        {[
          { key: 'home'         as const, label: 'Home',          icon: Home },
          { key: 'visits'       as const, label: 'Visits',        icon: Stethoscope },
          { key: 'school-notes' as const, label: 'School notes',  icon: FileText },
          { key: 'labs'         as const, label: 'Labs',          icon: FlaskConical },
          { key: 'radiology'    as const, label: 'Radiology',     icon: Activity },
          { key: 'book'         as const, label: 'Book a visit',  icon: CalendarPlus },
          { key: 'profile'      as const, label: 'Profile',       icon: User },
        ].map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[13px] font-medium transition-colors ${
              tab === key
                ? 'bg-[#EEEDFE] text-[#3C3489]'
                : 'text-[#555] hover:bg-[#F1EFE8]'
            }`}>
            <Icon size={13} />
            {label}
          </button>
        ))}
      </div>

      <div className="p-6 max-w-4xl mx-auto space-y-6">
        {tab === 'home' && (
          <HomeTab
            family={family}
            children={children}
            bookings={bookings}
            waitlist={waitlist}
            offers={offers}
            statements={statements}
          />
        )}
        {tab === 'visits'       && <VisitsTab notes={encounter_notes} />}
        {tab === 'school-notes' && <SchoolNotesTab schoolNotes={schoolNotes} notes={encounter_notes} multiChild={children.length > 1} />}
        {tab === 'labs'         && <ReportsTab children={children} kind="lab" />}
        {tab === 'radiology'    && <ReportsTab children={children} kind="radiology" />}
        {tab === 'book'         && <BookTab />}
        {tab === 'profile'      && <ProfileTab family={family} children={children} />}
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────

function HomeTab({ family, children, bookings, waitlist, offers, statements }: {
  family: any; children: any[]; bookings: any[]; waitlist: any[]; offers: any[]; statements: BillingStatement[]
}) {
  const upcoming = bookings.filter(b => b.status !== 'cancelled' && new Date(b.preferred_date + 'T23:59:59') >= new Date())
  const past = bookings.filter(b => b.status !== 'cancelled' && new Date(b.preferred_date + 'T23:59:59') < new Date())
  const greeting = family.display_name
    ? `Welcome back, ${family.display_name.replace(/^The\s+/i, '')}!`
    : 'Welcome back!'

  return (
    <div className="space-y-6">
      <div className="bg-white border border-[#E8E8E4] rounded-xl p-6 shadow-sm">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="font-display text-2xl font-medium text-[#1A1A2E]">{greeting}</h1>
            <p className="text-[13px] text-[#1A1A2E] mt-1">
              {children.length} child{children.length !== 1 ? 'ren' : ''} on file
              {family.zip && ` · ${family.zip}`}
            </p>
          </div>
        </div>
        {children.length > 0 && (
          <div className="flex gap-2 mt-4 flex-wrap">
            {children.map(child => (
              <div key={child.id} className="flex items-center gap-2 bg-[#FAFAF8] border border-[#E8E8E4] rounded-lg px-3 py-2">
                <div className="w-7 h-7 rounded-full bg-[#EEEDFE] flex items-center justify-center text-[11px] font-medium text-[#3C3489]">
                  {String(child.display_label || child.first_name || '?').charAt(0).toUpperCase()}
                </div>
                <div className="text-[13px] font-medium text-[#1A1A2E]">{child.display_label || `${child.first_name} ${child.last_name}`}</div>
                <ChartNumberPill value={(child as any).chart_number} size="xs" />
              </div>
            ))}
          </div>
        )}
      </div>

      {offers.length > 0 && (
        <div>
          <h2 className="text-[13px] font-semibold text-[#1D9E75] uppercase tracking-wider mb-3">A spot opened up</h2>
          <div className="space-y-3">
            {offers.map(offer => (
              <div key={offer.id} className="bg-white border-2 border-[#1D9E75] rounded-xl p-4 shadow-sm">
                <div className="font-display text-[15px] font-medium text-[#1A1A2E] mb-1">
                  {offer.visit_type || 'In-home visit'} with {offer.provider_name}
                </div>
                <div className="flex items-center gap-3 text-[12px] text-[#555] flex-wrap">
                  <span className="flex items-center gap-1">
                    <Clock size={11} />
                    {safeFormat(offer.offered_date ? offer.offered_date + 'T12:00:00' : null, 'EEEE, MMMM d')} at {offer.offered_time}
                  </span>
                  {offer.zone && <span>· {offer.zone}</span>}
                </div>
                <p className="text-[11px] text-[#1A1A2E] mt-1.5">
                  Expires {safeFormat(offer.expires_at, 'MMM d')} at {safeFormat(offer.expires_at, 'h:mm a')}
                </p>
              </div>
            ))}
          </div>
        </div>
      )}

      {waitlist.length > 0 && (
        <div>
          <h2 className="text-[13px] font-semibold text-[#555] uppercase tracking-wider mb-3">On the waitlist</h2>
          <div className="space-y-2">
            {waitlist.map((entry: any) => (
              <div key={entry.id} className="bg-white border border-[#E8E8E4] rounded-xl p-4 shadow-sm">
                <div className="font-display text-[14px] font-medium text-[#1A1A2E]">{entry.visit_type || 'In-home visit'}</div>
                <div className="text-[12px] text-[#1A1A2E] mt-0.5 flex flex-wrap gap-x-3">
                  {entry.zip && <span>Zip {entry.zip}</span>}
                  {entry.preferred_time_window && <span>{entry.preferred_time_window}</span>}
                  <span>Added {safeFormat(entry.created_at, 'MMM d')}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {upcoming.length > 0 && (
        <div>
          <h2 className="text-[13px] font-semibold text-[#555] uppercase tracking-wider mb-3">Upcoming appointments</h2>
          <div className="space-y-2">
            {upcoming.map((b: any) => <BookingCard key={b.id} booking={b} />)}
          </div>
        </div>
      )}

      {past.length > 0 && (
        <div>
          <h2 className="text-[13px] font-semibold text-[#555] uppercase tracking-wider mb-3">Past visits</h2>
          <div className="space-y-2">
            {past.slice(0, 5).map((b: any) => <BookingCard key={b.id} booking={b} past />)}
          </div>
        </div>
      )}

      {upcoming.length === 0 && past.length === 0 && waitlist.length === 0 && offers.length === 0 && (
        <div className="bg-white border border-[#E8E8E4] rounded-xl p-10 text-center shadow-sm">
          <Clock size={28} className="text-[#aeaeb2] mx-auto mb-3" />
          <div className="text-[13px] text-[#1A1A2E]">No appointments or waitlist entries.</div>
        </div>
      )}

      <div>
        <h2 className="text-[13px] font-semibold text-[#555] uppercase tracking-wider mb-3">Billing</h2>
        <PatientBillingList
          statements={statements}
          loading={false}
          error={null}
          showPatientName={children.length > 1}
          emptyLabel="No statements yet."
        />
      </div>
    </div>
  )
}

function BookingCard({ booking, past = false }: { booking: any; past?: boolean }) {
  const vt = VISIT_TYPE_INFO[booking.visit_type as keyof typeof VISIT_TYPE_INFO]
  const statusColor = booking.status === 'confirmed'
    ? { bg: '#E1F5EE', text: '#085041', label: 'Confirmed' }
    : booking.status === 'pending'
    ? { bg: '#FAEEDA', text: '#633806', label: 'Pending' }
    : { bg: '#F1EFE8', text: '#888780', label: 'Cancelled' }

  return (
    <div className={`bg-white border border-[#E8E8E4] rounded-xl p-4 shadow-sm ${past ? 'opacity-70' : ''}`}>
      <div className="flex items-start gap-3">
        <div className="w-10 h-10 rounded-xl flex items-center justify-center text-xl flex-shrink-0"
          style={{ background: vt?.bg || '#EEEDFE' }}>
          {vt?.icon || '📅'}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-display text-[15px] font-medium text-[#1A1A2E]">{booking.visit_type}</span>
            <span className="text-[11px] px-2 py-0.5 rounded-full font-medium"
              style={{ background: statusColor.bg, color: statusColor.text }}>
              {statusColor.label}
            </span>
          </div>
          <div className="flex items-center gap-3 mt-1 text-[12px] text-[#1A1A2E]">
            <span className="flex items-center gap-1">
              <Clock size={11} />
              {safeFormat(booking.preferred_date ? booking.preferred_date + 'T12:00:00' : null, 'EEE, MMM d')} at {booking.preferred_time}
            </span>
            {booking.preferred_provider && <span>· {booking.preferred_provider}</span>}
          </div>
          <div className="text-[11px] text-[#aeaeb2] mt-1">Ref: {booking.reference_code}</div>
        </div>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────

function VisitsTab({ notes }: { notes: any[] }) {
  const signedNotes = notes.filter(n => n.signed_at)
  if (signedNotes.length === 0) {
    return (
      <div className="bg-white border border-[#E8E8E4] rounded-xl p-10 text-center shadow-sm">
        <Stethoscope size={28} className="text-[#aeaeb2] mx-auto mb-3" />
        <div className="text-[13px] text-[#1A1A2E]">No visit notes yet.</div>
      </div>
    )
  }
  return (
    <div className="space-y-3">
      {signedNotes.map(n => (
        <div key={n.id} className="bg-white border border-[#E8E8E4] rounded-xl p-4 shadow-sm">
          <div className="flex items-start justify-between gap-3 mb-1">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-display text-[15px] font-medium text-[#1A1A2E]">{n.child_name}</span>
              <span className="text-[12px] text-[#555]">· {n.visit_type || n.note_type}</span>
            </div>
            <button
              onClick={() => downloadEncounterNoteHtml(n.id).catch(e => alert(e?.message ?? 'Download failed'))}
              className="inline-flex items-center gap-1 text-[12px] text-[#7F77DD] hover:underline font-medium flex-shrink-0"
              title="Opens the visit note in a new tab. Use ⌘P / Ctrl+P → Save as PDF.">
              <Download size={12} /> Download
            </button>
          </div>
          <div className="text-[12px] text-[#1A1A2E]/70 mb-2">
            {safeFormat(n.scheduled_date, 'EEE, MMM d, yyyy')}
            {n.provider_name && <span> · {n.provider_name}</span>}
          </div>
          {n.chief_complaint && (
            <div className="text-[13px] text-[#1A1A2E]"><span className="font-semibold">Reason for visit: </span>{n.chief_complaint}</div>
          )}
          {n.diagnoses?.length > 0 && (
            <div className="text-[13px] text-[#1A1A2E] mt-1">
              <span className="font-semibold">Diagnoses: </span>{n.diagnoses.join(', ')}
            </div>
          )}
          {n.assessment && (
            <div className="text-[13px] text-[#1A1A2E] mt-1"><span className="font-semibold">Assessment: </span>{n.assessment}</div>
          )}
          {n.plan && (
            <div className="text-[13px] text-[#1A1A2E] mt-1"><span className="font-semibold">Plan: </span>{n.plan}</div>
          )}
          {n.after_visit_instructions && (
            <div className="text-[13px] text-[#1A1A2E] mt-1"><span className="font-semibold">Take-home instructions: </span>{n.after_visit_instructions}</div>
          )}
        </div>
      ))}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────

function SchoolNotesTab({ schoolNotes, notes, multiChild }: { schoolNotes: SchoolNote[]; notes: any[]; multiChild: boolean }) {
  const signedNotes = notes.filter(n => n.signed_at)
  return (
    <div>
      <section className="mb-10">
        <div className="flex items-center gap-2 mb-3">
          <FileText size={16} className="text-[#7F77DD]" />
          <h2 className="font-display text-[15px] font-semibold text-[#1A1A2E]">School excuse notes</h2>
        </div>
        {schoolNotes.length === 0 ? (
          <div className="text-center py-10 bg-white border border-[#E8E8E4] rounded-xl">
            <FileText size={28} className="text-[#E8E8E4] mx-auto mb-2" />
            <div className="text-[13px] text-[#1A1A2E]">No school excuse notes yet.</div>
          </div>
        ) : (
          <div className="space-y-3">
            {schoolNotes.map(sn => (
              <div key={sn.id} className="bg-white border border-[#E8E8E4] rounded-xl px-5 py-4 flex items-start justify-between gap-3 shadow-sm">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap mb-1">
                    <span className="font-display text-[14px] font-semibold text-[#1A1A2E]">{sn.excuse_dates_text}</span>
                    {multiChild && (
                      <span className="text-[11px] font-medium bg-[#EEEDFE] text-[#3C3489] px-2 py-0.5 rounded-full">{sn.child_name}</span>
                    )}
                  </div>
                  <div className="text-[12px] text-[#1A1A2E] flex flex-wrap gap-x-3 gap-y-0.5">
                    {sn.provider_name && <span>{sn.provider_name}</span>}
                    <span className="text-[#555]">Generated {safeFormat(sn.created_at, 'MMM d, yyyy')}</span>
                  </div>
                </div>
                <a href={sn.blob_url} target="_blank" rel="noopener noreferrer"
                   className="inline-flex items-center gap-1 text-[12px] text-[#7F77DD] hover:underline flex-shrink-0">
                  <Download size={12} /> Download PDF
                </a>
              </div>
            ))}
          </div>
        )}
      </section>

      <section>
        <div className="flex items-center gap-2 mb-3">
          <Stethoscope size={16} className="text-[#7F77DD]" />
          <h2 className="font-display text-[15px] font-semibold text-[#1A1A2E]">Visit notes</h2>
        </div>
        {signedNotes.length === 0 ? (
          <div className="text-center py-10 bg-white border border-[#E8E8E4] rounded-xl">
            <Stethoscope size={28} className="text-[#E8E8E4] mx-auto mb-2" />
            <div className="text-[13px] text-[#1A1A2E]">No completed visit notes yet.</div>
          </div>
        ) : (
          <div className="space-y-3">
            {signedNotes.map(n => (
              <div key={n.id} className="bg-white border border-[#E8E8E4] rounded-xl px-5 py-4 flex items-start justify-between gap-3 shadow-sm">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap mb-1">
                    <span className="font-display text-[14px] font-semibold text-[#1A1A2E]">
                      {safeFormat(n.scheduled_date, 'MMMM d, yyyy')}
                    </span>
                    {n.visit_type && (
                      <span className="text-[11px] font-medium bg-[#EEEDFE] text-[#3C3489] px-2 py-0.5 rounded-full">{n.visit_type}</span>
                    )}
                    {multiChild && (
                      <span className="text-[11px] font-medium bg-[#F1EFE8] text-[#1A1A2E] px-2 py-0.5 rounded-full">{n.child_name}</span>
                    )}
                  </div>
                  <div className="text-[12px] text-[#1A1A2E]">{n.provider_name || '—'}</div>
                </div>
                <button
                  type="button"
                  onClick={() => downloadEncounterNoteHtml(n.id).catch(e => alert(e?.message ?? 'Download failed'))}
                  className="inline-flex items-center gap-1 text-[12px] text-[#7F77DD] hover:underline flex-shrink-0">
                  <Download size={12} /> Download
                </button>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────

function ReportsTab({ children, kind }: { children: any[]; kind: 'lab' | 'radiology' }) {
  const label = kind === 'lab' ? 'Lab reports' : 'Radiology reports'
  const emptyIcon = kind === 'lab'
    ? <FlaskConical size={32} className="text-[#E8E8E4] mx-auto mb-3" />
    : <Activity size={32} className="text-[#E8E8E4] mx-auto mb-3" />
  const multiChild = (children?.length ?? 0) > 1

  return (
    <div>
      <div className="mb-6">
        <h1 className="font-display text-[22px] font-semibold text-[#1A1A2E]">{label}</h1>
        <p className="text-[13px] text-[#1A1A2E] mt-1">
          Reports uploaded by the family or added by our team.
        </p>
      </div>

      {(!children || children.length === 0) ? (
        <div className="text-center py-16">
          {emptyIcon}
          <div className="text-[14px] text-[#1A1A2E]">No children on file.</div>
        </div>
      ) : (
        <div className="space-y-6">
          {children.map(child => (
            <div key={child.id}>
              {multiChild && (
                <div className="text-[13px] font-semibold text-[#7F77DD] mb-2">
                  {[child.first_name, child.last_name].filter(Boolean).join(' ') || child.display_label}
                </div>
              )}
              <PatientReportsSection childId={child.id} kind={kind} role="provider" />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────

function BookTab() {
  return (
    <div className="bg-white border border-[#E8E8E4] rounded-xl p-10 text-center shadow-sm">
      <CalendarPlus size={28} className="text-[#aeaeb2] mx-auto mb-3" />
      <div className="font-display text-[15px] font-medium text-[#1A1A2E] mb-1">Book a visit</div>
      <div className="text-[13px] text-[#1A1A2E]/70 max-w-md mx-auto">
        Booking is disabled from the admin impersonation view. To schedule a visit for this family,
        use the chart's booking tools or the main schedule.
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────

function ProfileTab({ family, children }: { family: any; children: any[] }) {
  return (
    <div className="space-y-6">
      <div className="bg-white border border-[#E8E8E4] rounded-xl p-6 shadow-sm">
        <div className="text-[11px] font-semibold text-[#7F77DD] uppercase tracking-wider mb-3">Family profile</div>
        <div className="grid grid-cols-2 gap-4 text-[13px]">
          <Field label="Display name" value={family.display_name} />
          <Field label="Email" value={family.email} />
          <Field label="Phone" value={family.phone} />
          <Field label="Address" value={family.address_line1} />
          <Field label="City" value={family.city} />
          <Field label="State" value={family.state} />
          <Field label="Zip" value={family.zip} />
          <Field label="Card on file" value={family.square_card_id ? `Last 4: ${family.card_last4 ?? '—'} · exp ${family.card_exp_month ?? '?'}/${family.card_exp_year ?? '?'}` : 'None'} />
        </div>
      </div>

      {children.map(child => (
        <div key={child.id} className="bg-white border border-[#E8E8E4] rounded-xl p-6 shadow-sm">
          <div className="text-[11px] font-semibold text-[#7F77DD] uppercase tracking-wider mb-3">{child.display_label || `${child.first_name} ${child.last_name}`}</div>
          <div className="grid grid-cols-2 gap-4 text-[13px]">
            <Field label="First name" value={child.first_name} />
            <Field label="Last name" value={child.last_name} />
            <Field label="Nickname" value={child.nickname} />
            <Field label="Date of birth" value={fmtDate(child.date_of_birth)} />
            <Field label="Sex" value={child.gender === 'M' ? 'Male' : child.gender === 'F' ? 'Female' : child.gender} />
            <Field label="Preferred pharmacy" value={child.preferred_pharmacy} />
            <Field label="PCP" value={child.pcp} />
            <Field label="Allergies" value={child.allergies} full />
            <Field label="Current medications" value={child.current_medications} full />
            <Field label="Medical history" value={child.medical_history} full />
            <Field label="Vaccination status" value={child.vaccination_status} full />
            <div className="col-span-2 border-t border-[#E8E8E4] pt-3 mt-1">
              <div className="text-[10px] font-semibold text-[#1A1A2E] uppercase tracking-wider mb-2">Insurance</div>
              <div className="grid grid-cols-2 gap-4">
                <Field label="Provider" value={child.insurance_provider} />
                <Field label="Member ID" value={child.insurance_member_id} />
                <Field label="Group #" value={child.insurance_group_number} />
                <Field label="Dep code (BCBS NC)" value={child.insurance_dependent_code} />
                <Field label="Subscriber" value={child.insurance_subscriber_name} />
                <Field label="Subscriber DOB" value={fmtDate(child.insurance_subscriber_dob)} />
                <Field label="Subscriber sex" value={child.insurance_subscriber_gender === 'M' ? 'Male' : child.insurance_subscriber_gender === 'F' ? 'Female' : child.insurance_subscriber_gender} />
                <Field label="Relationship" value={child.insurance_subscriber_relationship} />
              </div>
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}

function Field({ label, value, full }: { label: string; value: any; full?: boolean }) {
  return (
    <div className={full ? 'col-span-2' : ''}>
      <div className="text-[10px] text-[#1A1A2E]/60 uppercase tracking-wide mb-0.5">{label}</div>
      <div className="text-[13px] text-[#1A1A2E]">{value != null && String(value).trim() !== '' ? String(value) : '—'}</div>
    </div>
  )
}
