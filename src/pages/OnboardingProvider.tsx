import { useEffect, useState } from 'react'
import { useSearchParams, useNavigate } from 'react-router-dom'
import { CheckCircle2, AlertCircle, Loader2, ChevronRight, ChevronLeft, Sparkles } from 'lucide-react'
import { resolveInvite, npiLookup, finalizeOnboarding, type InviteResolveResponse } from '../lib/api'

// Token-scoped onboarding wizard for an invited provider. Loads the
// invite, walks the new provider through 3 steps (NPI + ID, profile,
// review), then calls /api/onboarding/provider POST to write the
// providers row and consume the invite.
//
// No JWT required — the invite token is the credential. The Cognito
// account was pre-provisioned by the admin invite endpoint; the new
// provider signs in via the normal /login flow after this wizard
// completes.
//
// Sara 2026-11-19.

const AVATAR_COLORS: Array<{ bg: string; fg: string; name: string }> = [
  { bg: '#EEEDFE', fg: '#3C3489', name: 'Lavender' },
  { bg: '#E0F5F0', fg: '#0F5E4E', name: 'Mint' },
  { bg: '#FEF3C7', fg: '#78350F', name: 'Honey' },
  { bg: '#FFE4E6', fg: '#9F1239', name: 'Rose' },
  { bg: '#DBEAFE', fg: '#1E3A8A', name: 'Sky' },
  { bg: '#F3E8FF', fg: '#6B21A8', name: 'Plum' },
  { bg: '#D1FAE5', fg: '#064E3B', name: 'Jade' },
]

export function OnboardingProvider() {
  const [search] = useSearchParams()
  const navigate = useNavigate()
  const token = search.get('token') ?? ''

  const [invite, setInvite] = useState<any | null>(null)
  const [resolveErr, setResolveErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const [step, setStep] = useState<1 | 2 | 3 | 'done'>(1)

  // Step 1 state
  const [npi, setNpi] = useState('')
  const [npiLooking, setNpiLooking] = useState(false)
  const [npiLookupResult, setNpiLookupResult] = useState<any | null>(null)
  const [npiError, setNpiError] = useState<string | null>(null)

  // Step 2 state
  const [dea, setDea] = useState('')
  const [statesLicensed, setStatesLicensed] = useState<string[]>([])
  const [initials, setInitials] = useState('')
  const [avatarIdx, setAvatarIdx] = useState(0)
  const [bio, setBio] = useState('')
  const [phone, setPhone] = useState('')
  const [dosespotId, setDosespotId] = useState('')

  // Step 3 state
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)

  useEffect(() => {
    if (!token) { setResolveErr('No invite token in the URL. Use the link from your invite email.'); setLoading(false); return }
    resolveInvite(token)
      .then((r: InviteResolveResponse) => {
        if (r.state === 'valid') {
          setInvite(r.invite)
          setInitials((r.invite.first_name?.[0] ?? '') + (r.invite.last_name?.[0] ?? ''))
        } else {
          setResolveErr((r as any).error ?? 'This invite is not usable.')
        }
      })
      .catch(e => setResolveErr(e?.message ?? 'Could not load invite'))
      .finally(() => setLoading(false))
  }, [token])

  async function doNpiLookup() {
    setNpiError(null)
    setNpiLookupResult(null)
    if (!/^\d{10}$/.test(npi)) { setNpiError('NPI must be exactly 10 digits'); return }
    setNpiLooking(true)
    try {
      const r = await npiLookup(npi)
      setNpiLookupResult(r)
      // Pre-fill states licensed from the taxonomy's state if we have it.
      if (r.taxonomy?.state && statesLicensed.length === 0) {
        setStatesLicensed([r.taxonomy.state])
      }
    } catch (e: any) {
      setNpiError(e?.message ?? 'Lookup failed')
    } finally {
      setNpiLooking(false)
    }
  }

  async function submit() {
    setSubmitError(null)
    setSubmitting(true)
    try {
      await finalizeOnboarding({
        token,
        npi,
        taxonomy_code: npiLookupResult?.taxonomy?.code ?? null,
        dea_number: dea.trim() || null,
        states_licensed: statesLicensed,
        initials,
        avatar_color: AVATAR_COLORS[avatarIdx].bg,
        avatar_text_color: AVATAR_COLORS[avatarIdx].fg,
        bio: bio.trim() || null,
        phone: phone.trim() || null,
        dosespot_clinician_id: dosespotId.trim() || null,
      })
      setStep('done')
    } catch (e: any) {
      setSubmitError(e?.message ?? 'Finalize failed')
    } finally {
      setSubmitting(false)
    }
  }

  if (loading) {
    return <WizardShell><div className="py-10 text-center text-[13px] text-[#555]"><Loader2 size={18} className="animate-spin inline mr-2" /> Loading…</div></WizardShell>
  }
  if (resolveErr || !invite) {
    return (
      <WizardShell>
        <div className="py-10 text-center">
          <AlertCircle size={28} className="text-[#991B1B] mx-auto mb-3" />
          <div className="text-[14px] font-medium text-[#1A1A2E] mb-1">We couldn't load your invite</div>
          <div className="text-[13px] text-[#555]">{resolveErr}</div>
        </div>
      </WizardShell>
    )
  }

  if (step === 'done') {
    return (
      <WizardShell>
        <div className="py-10 text-center">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-full bg-[#DCFCE7] mb-4">
            <Sparkles size={28} className="text-[#166534]" />
          </div>
          <div className="text-[18px] font-display font-medium text-[#1A1A2E] mb-1">You're all set, {invite.first_name}.</div>
          <div className="text-[13px] text-[#555] max-w-md mx-auto mb-6">
            Your account at <strong>{invite.practice_name}</strong> is live. Sign in with the temp password from your invite email — you'll be prompted to set a permanent password.
          </div>
          <button onClick={() => navigate('/login')} className="inline-flex items-center gap-1.5 px-5 py-2.5 bg-[#7F77DD] text-white text-[13px] font-medium rounded-lg hover:bg-[#6B64C8]">
            Sign in now
          </button>
        </div>
      </WizardShell>
    )
  }

  return (
    <WizardShell>
      <div className="mb-5">
        <div className="text-[11px] text-[#555] uppercase tracking-wider">Setting up — {invite.practice_name}</div>
        <div className="font-display text-[20px] font-medium text-[#1A1A2E] mt-1">Welcome, {invite.first_name}.</div>
        {invite.welcome_note && (
          <div className="mt-3 bg-[#F7F6FE] border-l-3 border-[#7F77DD] p-3 text-[13px] text-[#1A1A2E] leading-relaxed">{invite.welcome_note}</div>
        )}
      </div>

      <StepIndicator current={step as 1 | 2 | 3} />

      {step === 1 && (
        <div className="space-y-4">
          <SectionHeader title="Confirm your NPI" sub="We'll pull your name, taxonomy, and credentials from the NPPES registry so you don't have to re-type them." />
          <div className="flex gap-2">
            <input
              value={npi}
              onChange={e => setNpi(e.target.value.replace(/\D/g, '').slice(0, 10))}
              placeholder="10-digit NPI"
              className="flex-1 px-3 py-2 text-[13px] font-mono border border-[#E8E8E4] rounded-lg bg-white outline-none focus:border-[#7F77DD]"
            />
            <button onClick={doNpiLookup} disabled={npiLooking || npi.length !== 10} className="inline-flex items-center gap-1.5 px-4 py-2 bg-[#1A1A2E] text-white text-[13px] font-medium rounded-lg hover:bg-[#333] disabled:opacity-50">
              {npiLooking && <Loader2 size={13} className="animate-spin" />} Look up
            </button>
          </div>
          {npiError && (
            <div className="flex items-start gap-2 text-[12px] text-[#991B1B] bg-[#FCEBEB] border border-[#F5C6C6] px-3 py-2 rounded-lg">
              <AlertCircle size={14} className="mt-0.5 flex-shrink-0" /> <span>{npiError}</span>
            </div>
          )}
          {npiLookupResult && (
            <div className="bg-[#F7FBF8] border border-[#C3E6D1] rounded-lg p-3 space-y-1.5 text-[13px]">
              <div className="flex items-center gap-2 text-[#166534] font-medium"><CheckCircle2 size={14} /> NPPES record found</div>
              <div><strong>Name:</strong> {[npiLookupResult.first_name, npiLookupResult.middle_name, npiLookupResult.last_name].filter(Boolean).join(' ')}{npiLookupResult.credential ? `, ${npiLookupResult.credential}` : ''}</div>
              {npiLookupResult.taxonomy && (
                <div><strong>Taxonomy:</strong> {npiLookupResult.taxonomy.description} ({npiLookupResult.taxonomy.code})</div>
              )}
              {npiLookupResult.taxonomy?.license && (
                <div><strong>License on file:</strong> {npiLookupResult.taxonomy.license} ({npiLookupResult.taxonomy.state})</div>
              )}
              {npiLookupResult.practice_address && (
                <div><strong>Practice address:</strong> {npiLookupResult.practice_address.city}, {npiLookupResult.practice_address.state}</div>
              )}
            </div>
          )}
          <StepButtons
            onBack={null}
            onNext={() => setStep(2)}
            nextDisabled={!npiLookupResult}
          />
        </div>
      )}

      {step === 2 && (
        <div className="space-y-5">
          <SectionHeader title="Credentials + profile" sub="Fill in your DEA (if you prescribe), licenses, and how you'd like to show up on charts and the family-facing portal." />

          <Field label="DEA number">
            <input value={dea} onChange={e => setDea(e.target.value.toUpperCase())}
              placeholder="e.g. BD1234567 (optional if you don't prescribe)"
              className="w-full px-3 py-2 text-[13px] font-mono border border-[#E8E8E4] rounded-lg bg-white outline-none focus:border-[#7F77DD]" />
          </Field>

          <Field label="States licensed">
            <StateSelector value={statesLicensed} onChange={setStatesLicensed} />
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Initials (on charts)">
              <input value={initials} onChange={e => setInitials(e.target.value.toUpperCase().slice(0, 3))}
                className="w-full px-3 py-2 text-[13px] border border-[#E8E8E4] rounded-lg bg-white outline-none focus:border-[#7F77DD]" />
            </Field>
            <Field label="Phone (optional)">
              <input value={phone} onChange={e => setPhone(e.target.value)}
                className="w-full px-3 py-2 text-[13px] border border-[#E8E8E4] rounded-lg bg-white outline-none focus:border-[#7F77DD]" />
            </Field>
          </div>

          <Field label="Avatar color">
            <div className="flex gap-2 flex-wrap">
              {AVATAR_COLORS.map((c, i) => (
                <button key={i} type="button" onClick={() => setAvatarIdx(i)}
                  className={`w-12 h-12 rounded-full flex items-center justify-center font-semibold text-[13px] border-2 ${i === avatarIdx ? 'border-[#1A1A2E]' : 'border-transparent'}`}
                  style={{ backgroundColor: c.bg, color: c.fg }} title={c.name}>
                  {initials || '••'}
                </button>
              ))}
            </div>
          </Field>

          <Field label="Short bio (optional — shows on parent-facing booking screens)">
            <textarea value={bio} onChange={e => setBio(e.target.value)} rows={3}
              placeholder="1-2 sentences about you. Specialties, years in practice, etc."
              className="w-full px-3 py-2 text-[13px] border border-[#E8E8E4] rounded-lg bg-white outline-none focus:border-[#7F77DD] resize-y" />
          </Field>

          <Field label="DoseSpot clinician ID (optional)">
            <input value={dosespotId} onChange={e => setDosespotId(e.target.value.replace(/\D/g, ''))}
              placeholder="Paste your DoseSpot clinician ID if you have one"
              className="w-full px-3 py-2 text-[13px] font-mono border border-[#E8E8E4] rounded-lg bg-white outline-none focus:border-[#7F77DD]" />
            <div className="text-[11px] text-[#555] mt-1">If you don't have one yet, leave this blank — your admin can set it later once DoseSpot provisions you.</div>
          </Field>

          <StepButtons
            onBack={() => setStep(1)}
            onNext={() => setStep(3)}
            nextDisabled={!initials || statesLicensed.length === 0}
          />
        </div>
      )}

      {step === 3 && (
        <div className="space-y-5">
          <SectionHeader title="Review" sub="Last look — once you submit, you can sign in immediately." />

          <div className="bg-white border border-[#E8E8E4] rounded-xl p-4 space-y-3 text-[13px]">
            <ReviewLine label="Name" value={`${invite.first_name} ${invite.last_name}`} />
            <ReviewLine label="Email" value={invite.email} />
            <ReviewLine label="Role" value={invite.role} />
            {invite.supervising_md_name && <ReviewLine label="Supervising MD" value={invite.supervising_md_name} />}
            <ReviewLine label="NPI" value={npi} />
            {npiLookupResult?.taxonomy?.description && <ReviewLine label="Taxonomy" value={npiLookupResult.taxonomy.description} />}
            <ReviewLine label="DEA" value={dea || '—'} />
            <ReviewLine label="States licensed" value={statesLicensed.join(', ') || '—'} />
            <ReviewLine label="Zones" value={(invite.zones ?? []).join(', ') || 'None assigned'} />
            <ReviewLine label="DoseSpot ID" value={dosespotId || 'Not set — admin can add later'} />
          </div>

          {submitError && (
            <div className="flex items-start gap-2 text-[12px] text-[#991B1B] bg-[#FCEBEB] border border-[#F5C6C6] px-3 py-2 rounded-lg">
              <AlertCircle size={14} className="mt-0.5 flex-shrink-0" /> <span>{submitError}</span>
            </div>
          )}

          <div className="flex justify-between items-center">
            <button onClick={() => setStep(2)} className="inline-flex items-center gap-1.5 text-[13px] text-[#555] hover:text-[#1A1A2E]">
              <ChevronLeft size={14} /> Back
            </button>
            <button onClick={submit} disabled={submitting}
              className="inline-flex items-center gap-1.5 px-5 py-2.5 bg-[#7F77DD] text-white text-[13px] font-medium rounded-lg hover:bg-[#6B64C8] disabled:opacity-50">
              {submitting && <Loader2 size={13} className="animate-spin" />} Submit + finalize
            </button>
          </div>
        </div>
      )}
    </WizardShell>
  )
}

function WizardShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-[#FAFAF8] py-10 px-4">
      <div className="max-w-xl mx-auto bg-white border border-[#E8E8E4] rounded-2xl shadow-sm p-7">
        {children}
      </div>
    </div>
  )
}

function StepIndicator({ current }: { current: 1 | 2 | 3 }) {
  const steps = [
    { n: 1, label: 'NPI' },
    { n: 2, label: 'Profile' },
    { n: 3, label: 'Review' },
  ]
  return (
    <div className="flex items-center gap-2 mb-6">
      {steps.map((s, i) => (
        <div key={s.n} className="flex items-center gap-2 flex-1">
          <div className={`w-6 h-6 rounded-full flex items-center justify-center text-[11px] font-semibold ${s.n === current ? 'bg-[#7F77DD] text-white' : s.n < current ? 'bg-[#DCFCE7] text-[#166534]' : 'bg-[#F1EFE8] text-[#555]'}`}>
            {s.n < current ? '✓' : s.n}
          </div>
          <div className={`text-[11px] font-medium ${s.n === current ? 'text-[#1A1A2E]' : 'text-[#777]'}`}>{s.label}</div>
          {i < steps.length - 1 && <div className="flex-1 h-[1px] bg-[#E8E8E4]" />}
        </div>
      ))}
    </div>
  )
}

function SectionHeader({ title, sub }: { title: string; sub: string }) {
  return (
    <div>
      <div className="font-display text-[15px] font-medium text-[#1A1A2E]">{title}</div>
      <div className="text-[12px] text-[#555] mt-1 leading-relaxed">{sub}</div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="text-[11px] font-semibold text-[#1A1A2E] uppercase tracking-wider block mb-1">{label}</label>
      {children}
    </div>
  )
}

function ReviewLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <span className="text-[11px] text-[#555] uppercase tracking-wider">{label}</span>
      <span className="text-[13px] text-[#1A1A2E] text-right">{value}</span>
    </div>
  )
}

function StepButtons({ onBack, onNext, nextDisabled }: { onBack: (() => void) | null; onNext: () => void; nextDisabled?: boolean }) {
  return (
    <div className="flex justify-between items-center pt-2">
      {onBack
        ? <button onClick={onBack} className="inline-flex items-center gap-1.5 text-[13px] text-[#555] hover:text-[#1A1A2E]"><ChevronLeft size={14} /> Back</button>
        : <span />}
      <button onClick={onNext} disabled={nextDisabled}
        className="inline-flex items-center gap-1.5 px-4 py-2 bg-[#1A1A2E] text-white text-[13px] font-medium rounded-lg hover:bg-[#333] disabled:opacity-40">
        Next <ChevronRight size={14} />
      </button>
    </div>
  )
}

const US_STATES = ['AL','AK','AZ','AR','CA','CO','CT','DE','DC','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY']

function StateSelector({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const toggle = (s: string) => onChange(value.includes(s) ? value.filter(x => x !== s) : [...value, s])
  return (
    <div className="flex flex-wrap gap-1">
      {US_STATES.map(s => (
        <button key={s} type="button" onClick={() => toggle(s)}
          className={`text-[11px] px-2 py-1 rounded font-mono ${value.includes(s) ? 'bg-[#7F77DD] text-white' : 'bg-[#F1EFE8] text-[#555] hover:bg-[#E8E8E4]'}`}>
          {s}
        </button>
      ))}
    </div>
  )
}
