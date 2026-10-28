import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { Check, Loader2, Upload } from 'lucide-react'
import { getAgencyBySlug, submitAgencyReferral, uploadReferralCardImage } from '../../lib/api'

const inputCls = 'w-full px-3 py-2 border border-[#E8E8E4] rounded-lg text-[14px] focus:outline-none focus:border-[#7F77DD]'
const labelCls = 'block text-[12px] font-medium text-[#1A1A2E] mb-1.5'
const sectionCls = 'bg-white border border-[#E8E8E4] rounded-xl p-5 space-y-4'
const sectionTitle = 'text-[14px] font-semibold text-[#1A1A2E] uppercase tracking-wider mb-2'

const INSURANCE_OPTIONS = [
  '', 'Aetna', 'Blue Cross Blue Shield NC', 'Blue Cross Blue Shield (other state)', 'Cigna',
  'Humana', 'Medcost', 'Meritain', 'UnitedHealthcare', 'Self-Pay', 'Other',
]

export function AgencyReferral() {
  const { slug = '' } = useParams()
  const [agency, setAgency] = useState<{ id: string; name: string; slug: string } | null>(null)
  const [agencyLoading, setAgencyLoading] = useState(true)
  const [agencyError, setAgencyError] = useState<string | null>(null)

  const [submitting, setSubmitting] = useState(false)
  const [done, setDone] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  // Submitting nurse
  const [refProviderName, setRefProviderName] = useState('')
  const [attest, setAttest] = useState(false)

  // Patient
  const [pFirst, setPFirst] = useState('')
  const [pLast, setPLast] = useState('')
  const [pDob, setPDob] = useState('')
  const [pGender, setPGender] = useState('')

  // Guardian / contact + address
  const [parentName, setParentName] = useState('')
  const [parentPhone, setParentPhone] = useState('')
  const [parentEmail, setParentEmail] = useState('')
  const [parentAddress, setParentAddress] = useState('')

  // Insurance
  const [insProvider, setInsProvider] = useState('')
  const [memberId, setMemberId] = useState('')
  const [subName, setSubName] = useState('')
  const [subDob, setSubDob] = useState('')
  const [subGender, setSubGender] = useState('')
  const [frontUrl, setFrontUrl] = useState<string | null>(null)
  const [backUrl, setBackUrl] = useState<string | null>(null)
  const [uploadingFront, setUploadingFront] = useState(false)
  const [uploadingBack, setUploadingBack] = useState(false)

  // Clinical (change in condition)
  const [changeSummary, setChangeSummary] = useState('')
  const [symptoms, setSymptoms] = useState('')
  const [onset, setOnset] = useState('')
  const [vitals, setVitals] = useState('')
  const [lastVisitDate, setLastVisitDate] = useState('')
  const [baselineMeds, setBaselineMeds] = useState('')
  const [otherNotes, setOtherNotes] = useState('')

  useEffect(() => {
    getAgencyBySlug(slug)
      .then(setAgency)
      .catch(e => setAgencyError(e?.message ?? "This referral link isn't recognized."))
      .finally(() => setAgencyLoading(false))
  }, [slug])

  async function handleCardUpload(which: 'front' | 'back', file: File) {
    const setUploading = which === 'front' ? setUploadingFront : setUploadingBack
    const setUrl      = which === 'front' ? setFrontUrl : setBackUrl
    setUploading(true)
    try {
      const url = await uploadReferralCardImage(file)
      setUrl(url)
    } catch (e: any) {
      setErr(`Card upload failed: ${e?.message ?? 'unknown error'}`)
    } finally {
      setUploading(false)
    }
  }

  async function handleSubmit() {
    setErr(null)
    setSubmitting(true)
    try {
      await submitAgencyReferral({
        agency_slug: slug,
        referring_provider_name: refProviderName,
        provider_attestation: attest,
        patient_first_name: pFirst,
        patient_last_name: pLast,
        patient_dob: pDob,
        patient_gender: pGender || null,
        parent_name: parentName,
        parent_phone: parentPhone,
        parent_email: parentEmail || null,
        parent_address: parentAddress,
        insurance_provider: insProvider || null,
        insurance_member_id: memberId || null,
        subscriber_name: subName || null,
        subscriber_dob: subDob || null,
        subscriber_gender: subGender || null,
        insurance_card_front_url: frontUrl,
        insurance_card_back_url: backUrl,
        change_summary: changeSummary,
        symptoms, onset, vitals,
        last_visit_date: lastVisitDate,
        baseline_meds: baselineMeds,
        other_notes: otherNotes,
      })
      setDone(true)
    } catch (e: any) {
      setErr(e?.message ?? 'Submit failed')
    } finally {
      setSubmitting(false)
    }
  }

  if (agencyLoading) {
    return (
      <div className="min-h-screen bg-[#F6F3EE] flex items-center justify-center">
        <div className="text-[13px] text-[#1A1A2E]/60 flex items-center gap-2"><Loader2 size={14} className="animate-spin" /> Loading…</div>
      </div>
    )
  }

  if (agencyError || !agency) {
    return (
      <div className="min-h-screen bg-[#F6F3EE] flex items-center justify-center p-6">
        <div className="max-w-md bg-white border border-[#E8E8E4] rounded-xl p-6 text-center space-y-2">
          <h1 className="font-display text-[18px] font-medium text-[#1A1A2E]">Referral link not found</h1>
          <p className="text-[13px] text-[#1A1A2E]/70">
            {agencyError ?? "Check with your administrator for the correct URL."}
          </p>
        </div>
      </div>
    )
  }

  if (done) {
    return (
      <div className="min-h-screen bg-[#F6F3EE] flex items-center justify-center p-6">
        <div className="max-w-md bg-white border border-[#E8E8E4] rounded-xl p-8 text-center space-y-3">
          <div className="w-12 h-12 bg-[#1D9E75]/10 rounded-full flex items-center justify-center mx-auto">
            <Check size={24} className="text-[#1D9E75]" />
          </div>
          <h1 className="font-display text-[20px] font-medium text-[#1A1A2E]">Referral received</h1>
          <p className="text-[14px] text-[#1A1A2E]/70">
            Thanks — our team has been notified and will call back shortly to triage.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-[#F6F3EE] py-8 px-4">
      <div className="max-w-2xl mx-auto space-y-5">
        <div className="text-center space-y-1">
          <h1 className="font-display text-[24px] font-medium text-[#1A1A2E]">Patient change-in-condition referral</h1>
          <p className="text-[13px] text-[#1A1A2E]/70">Referring from <strong>{agency.name}</strong></p>
        </div>

        {err && (
          <div className="bg-[#FEF2F2] border border-[#EF4444]/30 text-[#B91C1C] rounded-xl p-3 text-[13px]">{err}</div>
        )}

        <div className={sectionCls}>
          <div className={sectionTitle}>Submitting nurse</div>
          <div>
            <label className={labelCls}>Your name <span className="text-[#EF4444]">*</span></label>
            <input value={refProviderName} onChange={e => setRefProviderName(e.target.value)} className={inputCls} placeholder="Jane Doe, RN" />
          </div>
          <label className="flex items-start gap-2 cursor-pointer">
            <input type="checkbox" checked={attest} onChange={e => setAttest(e.target.checked)} className="mt-0.5" />
            <span className="text-[12px] text-[#1A1A2E]">I am a licensed nurse referring this patient as part of their active care.</span>
          </label>
        </div>

        <div className={sectionCls}>
          <div className={sectionTitle}>Patient</div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelCls}>First name <span className="text-[#EF4444]">*</span></label>
              <input value={pFirst} onChange={e => setPFirst(e.target.value)} className={inputCls} />
            </div>
            <div>
              <label className={labelCls}>Last name <span className="text-[#EF4444]">*</span></label>
              <input value={pLast} onChange={e => setPLast(e.target.value)} className={inputCls} />
            </div>
            <div>
              <label className={labelCls}>Date of birth <span className="text-[#EF4444]">*</span></label>
              <input type="date" value={pDob} onChange={e => setPDob(e.target.value)} className={inputCls} />
            </div>
            <div>
              <label className={labelCls}>Gender</label>
              <select value={pGender} onChange={e => setPGender(e.target.value)} className={inputCls}>
                <option value="">—</option>
                <option value="M">Male</option>
                <option value="F">Female</option>
                <option value="O">Other / not specified</option>
              </select>
            </div>
          </div>
        </div>

        <div className={sectionCls}>
          <div className={sectionTitle}>Guardian / primary contact</div>
          <div>
            <label className={labelCls}>Name <span className="text-[#EF4444]">*</span></label>
            <input value={parentName} onChange={e => setParentName(e.target.value)} className={inputCls} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelCls}>Phone <span className="text-[#EF4444]">*</span></label>
              <input value={parentPhone} onChange={e => setParentPhone(e.target.value)} className={inputCls} placeholder="704-555-0199" />
            </div>
            <div>
              <label className={labelCls}>Email</label>
              <input value={parentEmail} onChange={e => setParentEmail(e.target.value)} className={inputCls} />
            </div>
          </div>
          <div>
            <label className={labelCls}>Visit address <span className="text-[#EF4444]">*</span></label>
            <input value={parentAddress} onChange={e => setParentAddress(e.target.value)} className={inputCls} placeholder="123 Main St, Charlotte, NC 28210" />
          </div>
        </div>

        <div className={sectionCls}>
          <div className={sectionTitle}>Insurance (if known)</div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelCls}>Insurance company</label>
              <select value={insProvider} onChange={e => setInsProvider(e.target.value)} className={inputCls}>
                {INSURANCE_OPTIONS.map(o => <option key={o} value={o}>{o || '—'}</option>)}
              </select>
            </div>
            <div>
              <label className={labelCls}>Member ID</label>
              <input value={memberId} onChange={e => setMemberId(e.target.value)} className={inputCls} />
            </div>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className={labelCls}>Subscriber name</label>
              <input value={subName} onChange={e => setSubName(e.target.value)} className={inputCls} />
            </div>
            <div>
              <label className={labelCls}>Subscriber DOB</label>
              <input type="date" value={subDob} onChange={e => setSubDob(e.target.value)} className={inputCls} />
            </div>
            <div>
              <label className={labelCls}>Subscriber gender</label>
              <select value={subGender} onChange={e => setSubGender(e.target.value)} className={inputCls}>
                <option value="">—</option>
                <option value="M">Male</option>
                <option value="F">Female</option>
                <option value="O">Other</option>
              </select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            {(['front', 'back'] as const).map(side => {
              const url = side === 'front' ? frontUrl : backUrl
              const uploading = side === 'front' ? uploadingFront : uploadingBack
              return (
                <div key={side}>
                  <label className={labelCls}>Card photo — {side}</label>
                  {url ? (
                    <div className="flex items-center gap-2">
                      <img src={url} alt="" className="w-20 h-14 object-cover rounded border border-[#E8E8E4]" />
                      <button type="button" onClick={() => (side === 'front' ? setFrontUrl(null) : setBackUrl(null))}
                        className="text-[12px] text-[#EF4444]">Replace</button>
                    </div>
                  ) : (
                    <label className="flex items-center justify-center gap-2 border-2 border-dashed border-[#E8E8E4] rounded-lg py-6 cursor-pointer hover:border-[#7F77DD]">
                      {uploading ? <Loader2 size={16} className="animate-spin text-[#7F77DD]" /> : <Upload size={16} className="text-[#1A1A2E]/60" />}
                      <span className="text-[12px] text-[#1A1A2E]/70">{uploading ? 'Uploading…' : 'Take or choose photo'}</span>
                      <input type="file" accept="image/*" capture="environment"
                        className="hidden"
                        onChange={e => { const f = e.target.files?.[0]; if (f) handleCardUpload(side, f); e.currentTarget.value = '' }}
                      />
                    </label>
                  )}
                </div>
              )
            })}
          </div>
        </div>

        <div className={sectionCls}>
          <div className={sectionTitle}>Change in condition</div>
          <div>
            <label className={labelCls}>What's changed? <span className="text-[#EF4444]">*</span></label>
            <textarea rows={3} value={changeSummary} onChange={e => setChangeSummary(e.target.value)} className={inputCls}
              placeholder="New cough and lethargy over the last 24 hours, worse this morning." />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelCls}>Symptoms</label>
              <input value={symptoms} onChange={e => setSymptoms(e.target.value)} className={inputCls} />
            </div>
            <div>
              <label className={labelCls}>Symptom onset</label>
              <input value={onset} onChange={e => setOnset(e.target.value)} className={inputCls} placeholder="~24 hrs ago" />
            </div>
          </div>
          <div>
            <label className={labelCls}>Current vitals</label>
            <input value={vitals} onChange={e => setVitals(e.target.value)} className={inputCls} placeholder="T 101.4F · HR 112 · RR 24 · SpO2 96%" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelCls}>Last PCP / clinician visit</label>
              <input type="date" value={lastVisitDate} onChange={e => setLastVisitDate(e.target.value)} className={inputCls} />
            </div>
            <div>
              <label className={labelCls}>Baseline meds</label>
              <input value={baselineMeds} onChange={e => setBaselineMeds(e.target.value)} className={inputCls} placeholder="e.g. Albuterol prn, Flovent BID" />
            </div>
          </div>
          <div>
            <label className={labelCls}>Other notes</label>
            <textarea rows={2} value={otherNotes} onChange={e => setOtherNotes(e.target.value)} className={inputCls} />
          </div>
        </div>

        <button
          onClick={handleSubmit}
          disabled={submitting}
          className="w-full py-3 bg-[#7F77DD] text-white font-semibold text-[14px] rounded-xl hover:bg-[#6B61C7] transition-colors disabled:opacity-60"
        >
          {submitting ? 'Submitting…' : 'Send referral'}
        </button>
      </div>
    </div>
  )
}
