import { useEffect, useState } from 'react'
import { format } from 'date-fns'
import { FileText, AlertCircle, CheckCircle, XCircle, Clock, Send, ChevronDown, ChevronUp, RefreshCw, ExternalLink, Receipt } from 'lucide-react'
import { Button } from '../../components/ui/Button'
import { getUnbilledNotes, getClaims, generateClaim, submitClaim, testClaim, updateClaim, deleteClaim } from '../../lib/api'
import { PatientStatementModal } from './PatientStatementModal'

type Tab = 'unbilled' | 'review' | 'submitted'

const STATUS_BADGE: Record<string, { label: string; cls: string; icon: any }> = {
  pending_review: { label: 'Pending Review', cls: 'bg-[#FEF3E8] text-[#633806]', icon: Clock },
  submitted:      { label: 'Submitted',      cls: 'bg-[#E1F5EE] text-[#085041]', icon: Send },
  accepted:       { label: 'Accepted',       cls: 'bg-[#E1F5EE] text-[#085041]', icon: CheckCircle },
  rejected:       { label: 'Rejected',       cls: 'bg-[#FEE2E2] text-[#7F1D1D]', icon: XCircle },
  error:          { label: 'Error',          cls: 'bg-[#FEE2E2] text-[#7F1D1D]', icon: AlertCircle },
}

const KNOWN_PAYERS: Record<string, string> = {
  'BCBS of NC': 'UPICO', 'Aetna': '60054', 'Cigna': '62308',
  'United Healthcare': '87726', 'UMR': '39026', 'Humana': '61101',
  'PHCS / MultiPlan': '52133', 'Coventry': '38217',
  'Select Health': '53589', 'MedCost': '56196', 'Healthgram': '56162',
}

function fmtDate(d: string | null) {
  if (!d) return '—'
  try {
    const s = String(d).split('T')[0]
    const [y, m, day] = s.split('-').map(Number)
    return format(new Date(y, m - 1, day), 'MMM d, yyyy')
  } catch { return d }
}

function fmtMoney(n: any) {
  const v = parseFloat(n ?? 0)
  return isNaN(v) ? '—' : `$${v.toFixed(2)}`
}

export function AdminClaims() {
  const [tab, setTab] = useState<Tab>('unbilled')
  const [unbilled, setUnbilled] = useState<any[]>([])
  const [claims, setClaims] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [generating, setGenerating] = useState<string | null>(null)
  const [regenerating, setRegenerating] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState<string | null>(null)
  const [testing, setTesting] = useState<string | null>(null)
  const [testResults, setTestResults] = useState<Record<string, any>>({})
  const [reopening, setReopening] = useState<string | null>(null)
  const [saving, setSaving] = useState<string | null>(null)
  const [statementClaim, setStatementClaim] = useState<any>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [editPayer, setEditPayer] = useState<Record<string, { name: string; id: string }>>({})
  const [editPatient, setEditPatient] = useState<Record<string, {
    patient_first_name: string; patient_last_name: string; patient_dob: string; patient_gender: string;
    patient_address: string; patient_city: string; patient_state: string; patient_zip: string;
    member_id: string; group_number: string;
    subscriber_name: string; subscriber_dob: string; subscriber_gender: string;
  }>>({})

  async function load() {
    setLoading(true)
    const [u, review, errored, submitted] = await Promise.all([
      getUnbilledNotes().catch(() => []),
      getClaims('pending_review').catch(() => []),
      getClaims('error').catch(() => []),
      getClaims('submitted').catch(() => []),
    ])
    setUnbilled(u)
    setClaims([...review, ...errored, ...submitted])
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  async function handleGenerate(noteId: string) {
    setGenerating(noteId)
    try {
      await generateClaim(noteId)
      await load()
      setTab('review')
    } catch (e: any) {
      alert(e.message || 'Failed to generate claim')
    } finally {
      setGenerating(null)
    }
  }

  async function handleTest(claimId: string) {
    setTesting(claimId)
    try {
      const result = await testClaim(claimId)
      const ack = result.acknowledgment
      // Stedi validation error (e.g. bad field) — ack has errors[] array
      if (!result.accepted && ack?.errors?.length) {
        const msgs = ack.errors.map((e: any) => e.message ?? e.description ?? JSON.stringify(e)).join('; ')
        setTestResults(prev => ({ ...prev, [claimId]: { error: msgs } }))
        return
      }
      // 277CA structured response
      const status = ack?.transactionSets?.[0]?.claimStatusInformation?.[0]?.claimStatus ?? (result.accepted ? 'A' : null)
      const errors = ack?.transactionSets?.[0]?.claimStatusInformation?.[0]?.claimStatusDetails ?? []
      setTestResults(prev => ({ ...prev, [claimId]: { status, errors, raw: ack } }))
    } catch (e: any) {
      setTestResults(prev => ({ ...prev, [claimId]: { error: e.message } }))
    } finally {
      setTesting(null)
    }
  }

  async function handleRegenerate(claimId: string, noteId: string) {
    if (!confirm('Delete this claim and regenerate it from the current note? Use this if CPT codes were added after the claim was first generated.')) return
    setRegenerating(claimId)
    try {
      await deleteClaim(claimId)
      await generateClaim(noteId)
      await load()
    } catch (e: any) {
      alert(e.message || 'Regeneration failed')
    } finally {
      setRegenerating(null)
    }
  }

  async function handleSubmit(claimId: string) {
    if (!confirm('Submit this claim to insurance? This cannot be undone.')) return
    setSubmitting(claimId)
    try {
      await submitClaim(claimId)
      await load()
    } catch (e: any) {
      alert(e.message || 'Submission failed')
    } finally {
      setSubmitting(null)
    }
  }

  async function handleReopen(claimId: string) {
    setReopening(claimId)
    try {
      await updateClaim(claimId, { status: 'pending_review' })
      await load()
      setTab('review')
    } catch (e: any) {
      alert(e.message || 'Failed to reopen claim')
    } finally {
      setReopening(null)
    }
  }

  async function handlePayerSave(claimId: string) {
    const p = editPayer[claimId]
    if (!p) return
    setSaving(claimId)
    setSaveError(null)
    try {
      await updateClaim(claimId, { payer_name: p.name, payer_id: p.id })
      setEditPayer(prev => { const n = { ...prev }; delete n[claimId]; return n })
      await load()
    } catch (e: any) {
      setSaveError(e.message ?? 'Save failed')
    } finally {
      setSaving(null)
    }
  }

  async function handlePatientSave(claimId: string) {
    const p = editPatient[claimId]
    if (!p) return
    setSaving(claimId + '_patient')
    setSaveError(null)
    try {
      await updateClaim(claimId, p)
      setEditPatient(prev => { const n = { ...prev }; delete n[claimId]; return n })
      await load()
    } catch (e: any) {
      setSaveError(e.message ?? 'Save failed')
    } finally {
      setSaving(null)
    }
  }

  const reviewClaims = claims.filter(c => c.status === 'pending_review' || c.status === 'error')
  const submittedClaims = claims.filter(c => c.status !== 'pending_review' && c.status !== 'error')

  const tabCls = (t: Tab) =>
    `px-4 py-2.5 text-[13px] font-medium border-b-2 transition-colors ${tab === t ? 'border-[#7F77DD] text-[#7F77DD]' : 'border-transparent text-[#999] hover:text-[#555]'}`

  return (
    <div className="p-8">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="font-display text-[22px] font-medium text-[#1A1A2E]">Claims</h1>
          <p className="text-[13px] text-[#999] mt-0.5">Generate and submit insurance claims from signed encounter notes</p>
        </div>
        <button onClick={load} className="flex items-center gap-1.5 text-[12px] text-[#999] hover:text-[#555] transition-colors">
          <RefreshCw size={13} /> Refresh
        </button>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-[#E8E8E4] mb-6">
        <button className={tabCls('unbilled')} onClick={() => setTab('unbilled')}>
          Unbilled ({unbilled.length})
        </button>
        <button className={tabCls('review')} onClick={() => setTab('review')}>
          Pending Review ({reviewClaims.length})
        </button>
        <button className={tabCls('submitted')} onClick={() => setTab('submitted')}>
          Submitted ({submittedClaims.length})
        </button>
      </div>

      {loading ? (
        <div className="text-[#999] text-[13px] py-12 text-center">Loading…</div>
      ) : (
        <>
          {/* UNBILLED TAB */}
          {tab === 'unbilled' && (
            <div className="space-y-2">
              {unbilled.length === 0 && (
                <div className="text-center py-12 text-[#999] text-[13px]">No unbilled signed notes.</div>
              )}
              {unbilled.map(n => (
                <div key={n.note_id} className="bg-white border border-[#E8E8E4] rounded-xl p-4 flex items-center justify-between gap-4">
                  <div className="flex items-center gap-3 min-w-0">
                    <FileText size={16} className="text-[#7F77DD] flex-shrink-0" />
                    <div className="min-w-0">
                      <div className="text-[14px] font-medium text-[#1A1A2E]">
                        {[n.child_first_name, n.child_last_name].filter(Boolean).join(' ') || 'Unknown patient'}
                      </div>
                      <div className="text-[12px] text-[#999] mt-0.5">
                        {fmtDate(n.scheduled_date)} · {n.visit_type}
                        {n.insurance_provider && ` · ${n.insurance_provider}`}
                        {n.insurance_member_id && ` · Member: ${n.insurance_member_id}`}
                      </div>
                      <div className="flex gap-2 mt-1 flex-wrap">
                        {(n.diagnoses ?? []).map((d: any) => (
                          <span key={d.code} className="text-[10px] bg-[#EEEDFE] text-[#3C3489] px-1.5 py-0.5 rounded font-medium">{d.code}</span>
                        ))}
                        {(n.cpt_codes ?? []).map((c: any) => (
                          <span key={c.code} className="text-[10px] bg-[#F1EFE8] text-[#555] px-1.5 py-0.5 rounded font-medium">{c.code}</span>
                        ))}
                      </div>
                    </div>
                  </div>
                  <Button variant="secondary" size="sm"
                    loading={generating === n.note_id}
                    onClick={() => handleGenerate(n.note_id)}>
                    Generate claim
                  </Button>
                </div>
              ))}
            </div>
          )}

          {/* PENDING REVIEW TAB */}
          {tab === 'review' && (
            <div className="space-y-3">
              {reviewClaims.length === 0 && (
                <div className="text-center py-12 text-[#999] text-[13px]">No claims pending review.</div>
              )}
              {reviewClaims.map(c => {
                const isOpen = expanded === c.id
                const ep = editPayer[c.id]
                const missingPayer = !c.payer_id
                const isError = c.status === 'error'
                const stediError = (() => {
                  if (!c.submission_error) return null
                  try {
                    const parsed = JSON.parse(c.submission_error)
                    return parsed?.errors?.[0]?.description ?? parsed?.message ?? c.submission_error
                  } catch { return c.submission_error }
                })()
                return (
                  <div key={c.id} className="bg-white border border-[#E8E8E4] rounded-xl overflow-hidden">
                    <button className="w-full flex items-center justify-between px-4 py-3.5 text-left hover:bg-[#FAFAF8] transition-colors"
                      onClick={() => setExpanded(isOpen ? null : c.id)}>
                      <div className="flex items-center gap-3 min-w-0">
                        <FileText size={15} className="text-[#7F77DD] flex-shrink-0" />
                        <div>
                          <div className="text-[14px] font-medium text-[#1A1A2E]">
                            {[(c.child_first_name ?? c.patient_first_name), (c.child_last_name ?? c.patient_last_name)].filter(Boolean).join(' ') || 'Unknown patient'}
                            <span className="ml-2 text-[12px] font-normal text-[#999]">{fmtDate(c.service_date)}</span>
                          </div>
                          <div className="flex items-center gap-2 mt-0.5">
                            {isError ? (
                              <span className="text-[11px] text-[#DC2626] font-medium flex items-center gap-1">
                                <AlertCircle size={11} /> Submission failed — click to retry
                              </span>
                            ) : missingPayer ? (
                              <span className="text-[11px] text-[#DC2626] font-medium flex items-center gap-1">
                                <AlertCircle size={11} /> Payer ID missing — review required
                              </span>
                            ) : (
                              <span className="text-[12px] text-[#555]">{c.payer_name} · {fmtMoney(c.total_charge)}</span>
                            )}
                          </div>
                        </div>
                      </div>
                      {isOpen ? <ChevronUp size={15} className="text-[#999] flex-shrink-0" /> : <ChevronDown size={15} className="text-[#999] flex-shrink-0" />}
                    </button>

                    {isOpen && (
                      <div className="px-4 pb-4 border-t border-[#F1EFE8] pt-4 space-y-4">
                        {stediError && (
                          <div className="bg-[#FEE2E2] border border-[#FECACA] rounded-lg px-3 py-2.5 text-[12px] text-[#7F1D1D]">
                            <span className="font-semibold">Stedi rejection: </span>{stediError}
                          </div>
                        )}
                        {/* Claim detail grid */}
                        {editPatient[c.id] ? (
                          <div className="space-y-3">
                            <div className="text-[11px] font-semibold text-[#999] uppercase tracking-wider">Patient info</div>
                            <div className="grid grid-cols-2 gap-3">
                              <div>
                                <label className="text-[11px] text-[#555] block mb-1">First name</label>
                                <input className="w-full px-2.5 py-1.5 border border-[#E8E8E4] rounded-lg text-[13px] outline-none focus:border-[#7F77DD]"
                                  value={editPatient[c.id].patient_first_name}
                                  onChange={e => setEditPatient(p => ({ ...p, [c.id]: { ...p[c.id], patient_first_name: e.target.value } }))} />
                              </div>
                              <div>
                                <label className="text-[11px] text-[#555] block mb-1">Last name</label>
                                <input className="w-full px-2.5 py-1.5 border border-[#E8E8E4] rounded-lg text-[13px] outline-none focus:border-[#7F77DD]"
                                  value={editPatient[c.id].patient_last_name}
                                  onChange={e => setEditPatient(p => ({ ...p, [c.id]: { ...p[c.id], patient_last_name: e.target.value } }))} />
                              </div>
                              <div>
                                <label className="text-[11px] text-[#555] block mb-1">Date of birth</label>
                                <input type="date" className="w-full px-2.5 py-1.5 border border-[#E8E8E4] rounded-lg text-[13px] outline-none focus:border-[#7F77DD]"
                                  value={editPatient[c.id].patient_dob}
                                  onChange={e => setEditPatient(p => ({ ...p, [c.id]: { ...p[c.id], patient_dob: e.target.value } }))} />
                              </div>
                              <div>
                                <label className="text-[11px] text-[#555] block mb-1">Sex</label>
                                <select className="w-full px-2.5 py-1.5 border border-[#E8E8E4] rounded-lg text-[13px] bg-white outline-none focus:border-[#7F77DD]"
                                  value={editPatient[c.id].patient_gender}
                                  onChange={e => setEditPatient(p => ({ ...p, [c.id]: { ...p[c.id], patient_gender: e.target.value } }))}>
                                  <option value="">—</option>
                                  <option value="M">Male</option>
                                  <option value="F">Female</option>
                                </select>
                              </div>
                            </div>
                            <div className="col-span-2">
                                <label className="text-[11px] text-[#555] block mb-1">Street address</label>
                                <input className="w-full px-2.5 py-1.5 border border-[#E8E8E4] rounded-lg text-[13px] outline-none focus:border-[#7F77DD]"
                                  value={editPatient[c.id].patient_address}
                                  onChange={e => setEditPatient(p => ({ ...p, [c.id]: { ...p[c.id], patient_address: e.target.value } }))} />
                              </div>
                              <div>
                                <label className="text-[11px] text-[#555] block mb-1">City</label>
                                <input className="w-full px-2.5 py-1.5 border border-[#E8E8E4] rounded-lg text-[13px] outline-none focus:border-[#7F77DD]"
                                  value={editPatient[c.id].patient_city}
                                  onChange={e => setEditPatient(p => ({ ...p, [c.id]: { ...p[c.id], patient_city: e.target.value } }))} />
                              </div>
                              <div className="grid grid-cols-2 gap-2">
                                <div>
                                  <label className="text-[11px] text-[#555] block mb-1">State</label>
                                  <input className="w-full px-2.5 py-1.5 border border-[#E8E8E4] rounded-lg text-[13px] outline-none focus:border-[#7F77DD]"
                                    value={editPatient[c.id].patient_state}
                                    onChange={e => setEditPatient(p => ({ ...p, [c.id]: { ...p[c.id], patient_state: e.target.value } }))} />
                                </div>
                                <div>
                                  <label className="text-[11px] text-[#555] block mb-1">ZIP</label>
                                  <input className="w-full px-2.5 py-1.5 border border-[#E8E8E4] rounded-lg text-[13px] outline-none focus:border-[#7F77DD]"
                                    value={editPatient[c.id].patient_zip}
                                    onChange={e => setEditPatient(p => ({ ...p, [c.id]: { ...p[c.id], patient_zip: e.target.value } }))} />
                                </div>
                              </div>
                            <div className="text-[11px] font-semibold text-[#999] uppercase tracking-wider pt-1">Insurance</div>
                            <div className="grid grid-cols-2 gap-3">
                              <div>
                                <label className="text-[11px] text-[#555] block mb-1">Member ID</label>
                                <input className="w-full px-2.5 py-1.5 border border-[#E8E8E4] rounded-lg text-[13px] outline-none focus:border-[#7F77DD]"
                                  value={editPatient[c.id].member_id}
                                  onChange={e => setEditPatient(p => ({ ...p, [c.id]: { ...p[c.id], member_id: e.target.value } }))} />
                              </div>
                              <div>
                                <label className="text-[11px] text-[#555] block mb-1">Group #</label>
                                <input className="w-full px-2.5 py-1.5 border border-[#E8E8E4] rounded-lg text-[13px] outline-none focus:border-[#7F77DD]"
                                  value={editPatient[c.id].group_number}
                                  onChange={e => setEditPatient(p => ({ ...p, [c.id]: { ...p[c.id], group_number: e.target.value } }))} />
                              </div>
                              <div>
                                <label className="text-[11px] text-[#555] block mb-1">Subscriber name</label>
                                <input className="w-full px-2.5 py-1.5 border border-[#E8E8E4] rounded-lg text-[13px] outline-none focus:border-[#7F77DD]"
                                  value={editPatient[c.id].subscriber_name}
                                  onChange={e => setEditPatient(p => ({ ...p, [c.id]: { ...p[c.id], subscriber_name: e.target.value } }))} />
                              </div>
                              <div>
                                <label className="text-[11px] text-[#555] block mb-1">Subscriber DOB</label>
                                <input type="date" className="w-full px-2.5 py-1.5 border border-[#E8E8E4] rounded-lg text-[13px] outline-none focus:border-[#7F77DD]"
                                  value={editPatient[c.id].subscriber_dob}
                                  onChange={e => setEditPatient(p => ({ ...p, [c.id]: { ...p[c.id], subscriber_dob: e.target.value } }))} />
                              </div>
                              <div>
                                <label className="text-[11px] text-[#555] block mb-1">Subscriber sex</label>
                                <select className="w-full px-2.5 py-1.5 border border-[#E8E8E4] rounded-lg text-[13px] bg-white outline-none focus:border-[#7F77DD]"
                                  value={editPatient[c.id].subscriber_gender}
                                  onChange={e => setEditPatient(p => ({ ...p, [c.id]: { ...p[c.id], subscriber_gender: e.target.value } }))}>
                                  <option value="">—</option>
                                  <option value="M">Male</option>
                                  <option value="F">Female</option>
                                </select>
                              </div>
                            </div>
                            {saveError && saving === null && <div className="text-[12px] text-[#DC2626]">{saveError}</div>}
                            <div className="flex gap-2 pt-1">
                              <Button size="sm" variant="teal" loading={saving === c.id + '_patient'} onClick={() => handlePatientSave(c.id)}>Save</Button>
                              <Button size="sm" variant="secondary" onClick={() => { setEditPatient(prev => { const n = { ...prev }; delete n[c.id]; return n }); setSaveError(null) }}>Cancel</Button>
                            </div>
                          </div>
                        ) : (
                          <div>
                            <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-[13px]">
                              <div><span className="text-[#999]">Patient: </span><span className="text-[#1A1A2E] font-medium">{[c.patient_first_name, c.patient_last_name].filter(Boolean).join(' ') || '—'}</span></div>
                              <div><span className="text-[#999]">DOB: </span><span className="text-[#1A1A2E]">{fmtDate(c.patient_dob)}</span></div>
                              <div><span className="text-[#999]">Subscriber: </span><span className="text-[#1A1A2E] font-medium">{c.subscriber_name || '—'}</span></div>
                              <div><span className="text-[#999]">Subscriber DOB: </span><span className="text-[#1A1A2E]">{fmtDate(c.subscriber_dob)}</span></div>
                              <div><span className="text-[#999]">Member ID: </span><span className="text-[#1A1A2E]">{c.member_id || '—'}</span></div>
                              <div><span className="text-[#999]">Group #: </span><span className="text-[#1A1A2E]">{c.group_number || '—'}</span></div>
                              <div><span className="text-[#999]">Service date: </span><span className="text-[#1A1A2E]">{fmtDate(c.service_date)}</span></div>
                              <div><span className="text-[#999]">Rendering provider: </span><span className="text-[#1A1A2E]">{c.rendering_provider_name || '—'} ({c.rendering_provider_npi || 'no NPI'})</span></div>
                            </div>
                            <button
                              onClick={() => setEditPatient(prev => ({ ...prev, [c.id]: {
                                patient_first_name: c.patient_first_name ?? '',
                                patient_last_name: c.patient_last_name ?? '',
                                patient_dob: c.patient_dob ? String(c.patient_dob).split('T')[0] : '',
                                patient_gender: c.patient_gender ?? '',
                                patient_address: c.patient_address ?? '',
                                patient_city: c.patient_city ?? '',
                                patient_state: c.patient_state ?? '',
                                patient_zip: c.patient_zip ?? '',
                                member_id: c.member_id ?? '',
                                group_number: c.group_number ?? '',
                                subscriber_name: c.subscriber_name ?? '',
                                subscriber_dob: c.subscriber_dob ? String(c.subscriber_dob).split('T')[0] : '',
                                subscriber_gender: c.subscriber_gender ?? '',
                              }}))}
                              className="mt-2 text-[11px] text-[#7F77DD] hover:underline">
                              Edit patient &amp; insurance info
                            </button>
                          </div>
                        )}

                        {/* Payer */}
                        <div>
                          <div className="text-[11px] font-semibold text-[#999] uppercase tracking-wider mb-2">Payer</div>
                          {ep ? (
                            <div className="flex gap-2 items-end flex-wrap">
                              <div>
                                <label className="text-[11px] text-[#555] block mb-1">Insurance company</label>
                                <select value={ep.name}
                                  onChange={e => {
                                    const name = e.target.value
                                    const id = KNOWN_PAYERS[name] ?? ''
                                    setEditPayer(prev => ({ ...prev, [c.id]: { name, id } }))
                                  }}
                                  className="px-2.5 py-1.5 border border-[#E8E8E4] rounded-lg text-[13px] bg-white outline-none focus:border-[#7F77DD]">
                                  <option value="">— select —</option>
                                  {Object.keys(KNOWN_PAYERS).map(k => <option key={k} value={k}>{k}</option>)}
                                  <option value="Other">Other</option>
                                </select>
                              </div>
                              <div>
                                <label className="text-[11px] text-[#555] block mb-1">EDI Payer ID</label>
                                <input type="text" value={ep.id}
                                  onChange={e => setEditPayer(prev => ({ ...prev, [c.id]: { ...prev[c.id], id: e.target.value } }))}
                                  className="px-2.5 py-1.5 border border-[#E8E8E4] rounded-lg text-[13px] outline-none focus:border-[#7F77DD] w-28" />
                              </div>
                              <Button size="sm" variant="teal" loading={saving === c.id} onClick={() => handlePayerSave(c.id)}>Save</Button>
                              <Button size="sm" variant="secondary" onClick={() => { setEditPayer(prev => { const n = { ...prev }; delete n[c.id]; return n }); setSaveError(null) }}>Cancel</Button>
                            </div>
                          ) : (
                            <div className="flex items-center gap-3">
                              <span className={`text-[13px] ${missingPayer ? 'text-[#DC2626] font-medium' : 'text-[#1A1A2E]'}`}>
                                {c.payer_name || '—'}{c.payer_id ? ` (ID: ${c.payer_id})` : ' — ID unknown'}
                              </span>
                              <button onClick={() => setEditPayer(prev => ({ ...prev, [c.id]: { name: c.payer_name ?? '', id: c.payer_id ?? '' } }))}
                                className="text-[11px] text-[#7F77DD] hover:underline">Edit</button>
                            </div>
                          )}
                        </div>

                        {/* Diagnoses + CPT */}
                        <div className="grid grid-cols-2 gap-4">
                          <div>
                            <div className="text-[11px] font-semibold text-[#999] uppercase tracking-wider mb-1.5">Diagnoses</div>
                            <div className="space-y-1">
                              {(c.diagnoses ?? []).map((d: any) => (
                                <div key={d.code} className="text-[12px] text-[#1A1A2E]">
                                  <span className="font-semibold text-[#7F77DD]">{d.code}</span> {d.name}
                                </div>
                              ))}
                            </div>
                          </div>
                          <div>
                            <div className="text-[11px] font-semibold text-[#999] uppercase tracking-wider mb-1.5">Procedures &amp; Fees</div>
                            <div className="space-y-1">
                              {(c.cpt_codes ?? []).map((cp: any) => (
                                <div key={cp.code} className="flex justify-between text-[12px]">
                                  <span className="text-[#1A1A2E]"><span className="font-semibold text-[#555]">{cp.code}</span> {cp.description}</span>
                                  <span className="text-[#1A1A2E] font-medium ml-2 flex-shrink-0">{fmtMoney(cp.charge_amount)}</span>
                                </div>
                              ))}
                              <div className="text-[12px] font-semibold text-[#1A1A2E] pt-1 border-t border-[#F1EFE8]">
                                Total: {fmtMoney(c.total_charge)}
                              </div>
                            </div>
                          </div>
                        </div>

                        {/* Test result */}
                        {testResults[c.id] && (
                          <div className={`rounded-lg px-3 py-2.5 text-[12px] border ${testResults[c.id].error ? 'bg-[#FEE2E2] border-[#FECACA] text-[#7F1D1D]' : testResults[c.id].status === 'A' ? 'bg-[#E1F5EE] border-[#A7F3D0] text-[#085041]' : 'bg-[#FEF3E8] border-[#FDE68A] text-[#633806]'}`}>
                            {testResults[c.id].error ? (
                              <>
                                <span><span className="font-semibold">Rejected: </span>{testResults[c.id].error}</span>
                                <button className="mt-1 ml-2 text-[11px] underline opacity-70" onClick={() => setTestResults(p => { const n={...p}; delete n[c.id]; return n })}>dismiss</button>
                              </>
                            ) : (
                              <>
                                <span className="font-semibold">
                                  277CA: {testResults[c.id].status === 'A' ? 'Accepted ✓' : testResults[c.id].status === 'R' ? 'Rejected' : testResults[c.id].status ? `Status: ${testResults[c.id].status}` : 'Response received'}
                                </span>
                                {testResults[c.id].errors?.length > 0 && (
                                  <ul className="mt-1 ml-3 list-disc space-y-0.5">
                                    {testResults[c.id].errors.map((e: any, i: number) => (
                                      <li key={i}>{e.statusCodeDescription ?? e.statusCode ?? JSON.stringify(e)}</li>
                                    ))}
                                  </ul>
                                )}
                                {!testResults[c.id].status && testResults[c.id].raw && (
                                  <pre className="mt-1 text-[10px] whitespace-pre-wrap break-all opacity-80">{JSON.stringify(testResults[c.id].raw, null, 2)}</pre>
                                )}
                                <button className="mt-1 text-[11px] underline opacity-70" onClick={() => setTestResults(p => { const n={...p}; delete n[c.id]; return n })}>dismiss</button>
                              </>
                            )}
                          </div>
                        )}

                        {/* Submit / Regenerate buttons */}
                        <div className="flex justify-between items-center pt-1">
                          <div className="flex gap-2">
                            {(!c.cpt_codes?.length || parseFloat(c.total_charge ?? 0) === 0) && c.encounter_note_id && (
                              <Button variant="secondary" size="sm"
                                loading={regenerating === c.id}
                                onClick={() => handleRegenerate(c.id, c.encounter_note_id)}>
                                <RefreshCw size={12} className="mr-1.5" /> Regenerate from note
                              </Button>
                            )}
                            <Button variant="secondary" size="sm"
                              loading={testing === c.id}
                              disabled={!!testing || missingPayer}
                              onClick={() => handleTest(c.id)}>
                              Test claim
                            </Button>
                          </div>
                          <Button variant="teal"
                            loading={submitting === c.id}
                            disabled={!!submitting || missingPayer}
                            onClick={() => handleSubmit(c.id)}>
                            <Send size={13} className="mr-1.5" /> Submit to insurance
                          </Button>
                        </div>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}

          {/* SUBMITTED TAB */}
          {tab === 'submitted' && (
            <div className="space-y-2">
              {submittedClaims.length === 0 && (
                <div className="text-center py-12 text-[#999] text-[13px]">No submitted claims yet.</div>
              )}
              {submittedClaims.map(c => {
                const badge = STATUS_BADGE[c.status] ?? STATUS_BADGE.submitted
                const Icon = badge.icon
                return (
                  <div key={c.id} className="bg-white border border-[#E8E8E4] rounded-xl p-4 flex items-center justify-between gap-4">
                    <div className="flex items-center gap-3 min-w-0">
                      <FileText size={15} className="text-[#7F77DD] flex-shrink-0" />
                      <div>
                        <div className="text-[14px] font-medium text-[#1A1A2E]">
                          {[(c.child_first_name ?? c.patient_first_name), (c.child_last_name ?? c.patient_last_name)].filter(Boolean).join(' ') || 'Unknown patient'}
                          <span className="ml-2 text-[12px] font-normal text-[#999]">{fmtDate(c.service_date)}</span>
                        </div>
                        <div className="text-[12px] text-[#999] mt-0.5">
                          {c.payer_name} · {fmtMoney(c.total_charge)}
                          {c.stedi_claim_id && ` · Ref: ${c.stedi_claim_id}`}
                        </div>
                        {c.submission_error && (
                          <div className="text-[11px] text-[#DC2626] mt-1">{c.submission_error}</div>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0">
                      <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold ${badge.cls}`}>
                        <Icon size={11} /> {badge.label}
                      </span>
                      <Button size="sm" variant="secondary"
                        loading={reopening === c.id}
                        onClick={() => handleReopen(c.id)}>
                        Reopen
                      </Button>
                      <a
                        href="https://portal.stedi.com/app/healthcare/claims"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-[11px] text-[#7F77DD] hover:underline whitespace-nowrap"
                      >
                        View in Stedi <ExternalLink size={10} />
                      </a>
                      <button
                        onClick={() => setStatementClaim(c)}
                        className="inline-flex items-center gap-1 text-[11px] text-[#7F77DD] hover:underline whitespace-nowrap font-medium">
                        <Receipt size={11} /> Statement
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </>
      )}

      {statementClaim && (
        <PatientStatementModal
          claim={statementClaim}
          onClose={() => setStatementClaim(null)}
          onSent={() => setStatementClaim(null)}
        />
      )}
    </div>
  )
}
