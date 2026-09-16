import { useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { format } from 'date-fns'
import { ArrowLeft, Eye, Clock, User, Stethoscope, Syringe, Home } from 'lucide-react'
import { getFamilyPortalView } from '../../lib/api'
import { PatientBillingList, type BillingStatement } from '../../components/PatientBillingList'
import { VISIT_TYPE_INFO } from '../../lib/zipData'

type Tab = 'home' | 'visits' | 'vaccines' | 'profile'

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

  const { family, children, bookings, waitlist, offers, encounter_notes, statements } = data
  const displayName = family.display_name || family.email || 'this family'

  return (
    <div className="min-h-screen bg-[#FAFAF8]">
      {/* View-as-parent banner — makes it obvious this is an impersonation
          view, not the admin's own account. Sticky at top. */}
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

      {/* Family-portal-style tab bar (mirrors AppLayout / family sidebar) */}
      <div className="bg-white border-b border-[#E8E8E4] px-6 py-3 flex items-center gap-1 overflow-x-auto">
        {[
          { key: 'home' as const,     label: 'Home',     icon: Home },
          { key: 'visits' as const,   label: 'Visits',   icon: Stethoscope },
          { key: 'vaccines' as const, label: 'Vaccines', icon: Syringe },
          { key: 'profile' as const,  label: 'Profile',  icon: User },
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
        {tab === 'visits' && <VisitsTab notes={encounter_notes} />}
        {tab === 'vaccines' && <VaccinesTab notes={encounter_notes} />}
        {tab === 'profile' && <ProfileTab family={family} children={children} />}
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
      {/* Family header — mirror FamilyDashboard's header */}
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
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Slot offers */}
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

      {/* Waitlist */}
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

      {/* Upcoming */}
      {upcoming.length > 0 && (
        <div>
          <h2 className="text-[13px] font-semibold text-[#555] uppercase tracking-wider mb-3">Upcoming appointments</h2>
          <div className="space-y-2">
            {upcoming.map((b: any) => <BookingCard key={b.id} booking={b} />)}
          </div>
        </div>
      )}

      {/* Past */}
      {past.length > 0 && (
        <div>
          <h2 className="text-[13px] font-semibold text-[#555] uppercase tracking-wider mb-3">Past visits</h2>
          <div className="space-y-2">
            {past.slice(0, 5).map((b: any) => <BookingCard key={b.id} booking={b} past />)}
          </div>
        </div>
      )}

      {/* Empty state */}
      {upcoming.length === 0 && past.length === 0 && waitlist.length === 0 && offers.length === 0 && (
        <div className="bg-white border border-[#E8E8E4] rounded-xl p-10 text-center shadow-sm">
          <Clock size={28} className="text-[#aeaeb2] mx-auto mb-3" />
          <div className="text-[13px] text-[#1A1A2E]">No appointments or waitlist entries.</div>
        </div>
      )}

      {/* Billing */}
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
          <div className="flex items-center gap-2 flex-wrap mb-1">
            <span className="font-display text-[15px] font-medium text-[#1A1A2E]">{n.child_name}</span>
            <span className="text-[12px] text-[#555]">· {n.visit_type || n.note_type}</span>
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

function VaccinesTab({ notes }: { notes: any[] }) {
  const vaccineNotes = notes.filter(n => n.note_type === 'In-home vaccine administration' && n.vaccine_administrations?.length)
  if (vaccineNotes.length === 0) {
    return (
      <div className="bg-white border border-[#E8E8E4] rounded-xl p-10 text-center shadow-sm">
        <Syringe size={28} className="text-[#aeaeb2] mx-auto mb-3" />
        <div className="text-[13px] text-[#1A1A2E]">No vaccines administered yet through Pediatric Housecalls.</div>
      </div>
    )
  }
  return (
    <div className="space-y-3">
      {vaccineNotes.map(n => (
        <div key={n.id} className="bg-white border border-[#E8E8E4] rounded-xl p-4 shadow-sm">
          <div className="flex items-center gap-2 flex-wrap mb-2">
            <span className="font-display text-[15px] font-medium text-[#1A1A2E]">{n.child_name}</span>
            <span className="text-[12px] text-[#555]">· {safeFormat(n.scheduled_date, 'MMM d, yyyy')}</span>
            {n.provider_name && <span className="text-[12px] text-[#555]">· {n.provider_name}</span>}
          </div>
          <ul className="space-y-1 text-[12px] text-[#1A1A2E]">
            {(n.vaccine_administrations ?? []).map((v: any, i: number) => (
              <li key={i} className="flex justify-between gap-3">
                <span>{v.vaccine_name || v.cvx || 'Vaccine'} {v.dose_number ? `· Dose ${v.dose_number}` : ''}</span>
                {v.lot_number && <span className="text-[#555]">Lot {v.lot_number}</span>}
              </li>
            ))}
          </ul>
        </div>
      ))}
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
