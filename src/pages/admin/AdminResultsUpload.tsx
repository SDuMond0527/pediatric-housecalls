import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Upload, ArrowLeft, Search } from 'lucide-react'
import { apiFetch, createResult, type ResultType } from '../../lib/api'
import { useSettings } from '../../contexts/PracticeSettingsContext'

// Manual upload intake for a new pathology or lab result. Phase 1:
// biller / provider fills the form, attaches a PDF via existing
// blob upload endpoint, submits. Phase 2+: vendor integrations
// (dermatopath labs, LabCorp, etc.) would populate this table
// directly via webhook. Sara 2026-11-15.

type PatientOption = { id: string; label: string; model: 'patient_profile' | 'child' }

export function AdminResultsUpload() {
  const { type: urlType } = useParams<{ type: string }>()
  const navigate = useNavigate()
  const { settings } = useSettings()
  const type: ResultType = urlType === 'labs' ? 'lab' : 'pathology'
  const label = type === 'pathology' ? 'Pathology' : 'Lab'
  const isPediatric = settings.uses_pediatric_patients !== false

  // Patient picker — search as you type.
  const [patientSearch, setPatientSearch] = useState('')
  const [patientResults, setPatientResults] = useState<PatientOption[]>([])
  const [patient, setPatient] = useState<PatientOption | null>(null)

  useEffect(() => {
    const q = patientSearch.trim()
    if (q.length < 2) { setPatientResults([]); return }
    const t = setTimeout(async () => {
      try {
        // Uses the practice's patient model. Pediatric practices still
        // query the children endpoint; adult practices will query
        // patient_profiles once that endpoint ships. For now, try
        // children first (what exists) and defer patient_profiles
        // search to Sara's patient-portal/import build.
        const rows = isPediatric
          ? await apiFetch<any[]>(`/api/children?q=${encodeURIComponent(q)}`)
          : []
        setPatientResults((rows ?? []).slice(0, 10).map(r => ({
          id: r.id,
          label: `${r.first_name ?? ''} ${r.last_name ?? ''} ${r.date_of_birth ? '· DOB ' + String(r.date_of_birth).slice(0,10) : ''}`.trim(),
          model: 'child' as const,
        })))
      } catch { setPatientResults([]) }
    }, 250)
    return () => clearTimeout(t)
  }, [patientSearch, isPediatric])

  // Core fields.
  const [specimenDate, setSpecimenDate] = useState('')
  const [specimenType, setSpecimenType] = useState('')
  const [specimenSite, setSpecimenSite] = useState('')
  const [sourceLab, setSourceLab] = useState('')
  const [sourceProvider, setSourceProvider] = useState('')
  const [reportText, setReportText] = useState('')
  const [reportPdfUrl, setReportPdfUrl] = useState('')

  // Pathology-only.
  const [marginsStatus, setMarginsStatus] = useState('')
  const [breslowDepth, setBreslowDepth] = useState('')
  const [clarkLevel, setClarkLevel] = useState('')

  // Lab-only.
  const [testName, setTestName] = useState('')
  const [resultValue, setResultValue] = useState('')
  const [resultUnit, setResultUnit] = useState('')
  const [referenceRange, setReferenceRange] = useState('')
  const [abnormalFlag, setAbnormalFlag] = useState('')

  const [uploading, setUploading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')

  async function handlePdf(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setErr(''); setUploading(true)
    try {
      const fd = new FormData()
      fd.append('file', file)
      const r = await fetch('/api/upload-blob', { method: 'POST', body: fd })
      if (!r.ok) throw new Error(`Upload failed (${r.status})`)
      const { url } = await r.json()
      setReportPdfUrl(url)
    } catch (e: any) {
      setErr(e?.message ?? 'Upload failed')
    } finally {
      setUploading(false)
    }
  }

  async function save() {
    if (!patient) { setErr('Pick a patient first.'); return }
    setErr(''); setSaving(true)
    try {
      const body: any = {
        type,
        [patient.model === 'patient_profile' ? 'patient_profile_id' : 'child_id']: patient.id,
        specimen_date: specimenDate || null,
        specimen_type: specimenType || null,
        specimen_site: specimenSite || null,
        source_lab: sourceLab || null,
        source_provider: sourceProvider || null,
        report_text: reportText || null,
        report_pdf_url: reportPdfUrl || null,
      }
      if (type === 'pathology') {
        body.margins_status = marginsStatus || null
        body.breslow_depth_mm = breslowDepth ? Number(breslowDepth) : null
        body.clark_level = clarkLevel ? Number(clarkLevel) : null
      } else {
        body.test_name = testName || null
        body.result_value = resultValue || null
        body.result_unit = resultUnit || null
        body.reference_range = referenceRange || null
        body.abnormal_flag = abnormalFlag || null
      }
      await createResult(body)
      navigate(`/admin/results/${urlType}`)
    } catch (e: any) {
      setErr(e?.message ?? 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  const inputCls = 'w-full px-3 py-2 border border-[#E8E8E4] rounded-lg text-[13px] outline-none focus:border-[#7F77DD] bg-white'
  const labelCls = 'block text-[11px] font-medium text-[#1A1A2E] mb-1.5 uppercase tracking-wider'

  return (
    <div>
      <div className="bg-white border-b border-[#E8E8E4] px-6 py-4 flex items-center gap-3 sticky top-0 z-10">
        <button onClick={() => navigate(`/admin/results/${urlType}`)}
          className="p-1.5 rounded-lg hover:bg-[#F1EFE8]">
          <ArrowLeft size={16} className="text-[#1A1A2E]/70" />
        </button>
        <div>
          <div className="font-display text-[18px] font-medium text-[#1A1A2E]">Upload {label.toLowerCase()} result</div>
          <div className="text-[12px] text-[#1A1A2E]/70">Attach the PDF and fill in the key fields. Nothing is sent to the patient at this step.</div>
        </div>
      </div>

      <div className="p-6 max-w-2xl space-y-4">
        {/* Patient picker */}
        <div className="bg-white border border-[#E8E8E4] rounded-xl p-4">
          <label className={labelCls}>Patient</label>
          {patient ? (
            <div className="flex items-center justify-between gap-2 p-2 rounded-lg bg-[#F7F5FF] border border-[#AFA9EC]">
              <span className="text-[13px] text-[#1A1A2E]">{patient.label}</span>
              <button onClick={() => { setPatient(null); setPatientSearch('') }}
                className="text-[11px] text-[#7F77DD] hover:underline">Change</button>
            </div>
          ) : (
            <>
              <div className="relative">
                <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[#1A1A2E]/40" />
                <input type="text" value={patientSearch} onChange={e => setPatientSearch(e.target.value)}
                  placeholder="Type patient name or DOB…" className={`${inputCls} pl-7`} />
              </div>
              {patientResults.length > 0 && (
                <div className="mt-2 border border-[#E8E8E4] rounded-lg overflow-hidden bg-white">
                  {patientResults.map(p => (
                    <button key={p.id} onClick={() => setPatient(p)}
                      className="w-full text-left px-3 py-2 text-[13px] hover:bg-[#F1EFE8] border-b border-[#F1EFE8] last:border-b-0">
                      {p.label}
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
        </div>

        {/* Specimen / source */}
        <div className="bg-white border border-[#E8E8E4] rounded-xl p-4 grid grid-cols-2 gap-3">
          <div>
            <label className={labelCls}>Specimen date</label>
            <input type="date" value={specimenDate} onChange={e => setSpecimenDate(e.target.value)} className={inputCls} />
          </div>
          <div>
            <label className={labelCls}>{type === 'pathology' ? 'Specimen type' : 'Collection type'}</label>
            <input type="text" value={specimenType} onChange={e => setSpecimenType(e.target.value)}
              placeholder={type === 'pathology' ? 'e.g. Punch biopsy' : 'e.g. Venipuncture'} className={inputCls} />
          </div>
          <div className="col-span-2">
            <label className={labelCls}>{type === 'pathology' ? 'Anatomical site' : 'Collection location'}</label>
            <input type="text" value={specimenSite} onChange={e => setSpecimenSite(e.target.value)}
              placeholder={type === 'pathology' ? 'e.g. Left shoulder' : 'e.g. In-office draw'} className={inputCls} />
          </div>
          <div>
            <label className={labelCls}>Source lab</label>
            <input type="text" value={sourceLab} onChange={e => setSourceLab(e.target.value)}
              placeholder={type === 'pathology' ? 'e.g. Dermatopath Associates' : 'e.g. Quest Diagnostics'} className={inputCls} />
          </div>
          <div>
            <label className={labelCls}>{type === 'pathology' ? 'Pathologist' : 'Ordering lab'}</label>
            <input type="text" value={sourceProvider} onChange={e => setSourceProvider(e.target.value)}
              placeholder={type === 'pathology' ? 'Pathologist name' : 'Reviewing MD'} className={inputCls} />
          </div>
        </div>

        {/* Pathology fields */}
        {type === 'pathology' && (
          <div className="bg-white border border-[#E8E8E4] rounded-xl p-4 grid grid-cols-3 gap-3">
            <div>
              <label className={labelCls}>Margins</label>
              <select value={marginsStatus} onChange={e => setMarginsStatus(e.target.value)} className={inputCls}>
                <option value="">—</option>
                <option value="clear">Clear</option>
                <option value="close">Close</option>
                <option value="involved">Involved</option>
                <option value="not_applicable">N/A</option>
              </select>
            </div>
            <div>
              <label className={labelCls}>Breslow (mm)</label>
              <input type="number" step="0.01" value={breslowDepth} onChange={e => setBreslowDepth(e.target.value)}
                placeholder="e.g. 0.75" className={inputCls} />
            </div>
            <div>
              <label className={labelCls}>Clark level</label>
              <input type="number" min="1" max="5" value={clarkLevel} onChange={e => setClarkLevel(e.target.value)}
                placeholder="I–V" className={inputCls} />
            </div>
          </div>
        )}

        {/* Lab fields */}
        {type === 'lab' && (
          <div className="bg-white border border-[#E8E8E4] rounded-xl p-4 grid grid-cols-2 gap-3">
            <div className="col-span-2">
              <label className={labelCls}>Test name</label>
              <input type="text" value={testName} onChange={e => setTestName(e.target.value)}
                placeholder="e.g. Comprehensive metabolic panel" className={inputCls} />
            </div>
            <div>
              <label className={labelCls}>Result value</label>
              <input type="text" value={resultValue} onChange={e => setResultValue(e.target.value)}
                placeholder="e.g. 142" className={inputCls} />
            </div>
            <div>
              <label className={labelCls}>Unit</label>
              <input type="text" value={resultUnit} onChange={e => setResultUnit(e.target.value)}
                placeholder="e.g. mg/dL" className={inputCls} />
            </div>
            <div>
              <label className={labelCls}>Reference range</label>
              <input type="text" value={referenceRange} onChange={e => setReferenceRange(e.target.value)}
                placeholder="e.g. 136–145" className={inputCls} />
            </div>
            <div>
              <label className={labelCls}>Abnormal flag</label>
              <select value={abnormalFlag} onChange={e => setAbnormalFlag(e.target.value)} className={inputCls}>
                <option value="">—</option>
                <option value="H">High (H)</option>
                <option value="HH">Critical high (HH)</option>
                <option value="L">Low (L)</option>
                <option value="LL">Critical low (LL)</option>
                <option value="A">Abnormal (A)</option>
              </select>
            </div>
          </div>
        )}

        {/* Report text + PDF */}
        <div className="bg-white border border-[#E8E8E4] rounded-xl p-4 space-y-3">
          <div>
            <label className={labelCls}>Report text</label>
            <textarea value={reportText} onChange={e => setReportText(e.target.value)} rows={6}
              placeholder="Paste the full report body here (optional if you're attaching a PDF)."
              className={inputCls + ' resize-y'} />
          </div>
          <div>
            <label className={labelCls}>Report PDF</label>
            {reportPdfUrl ? (
              <div className="flex items-center justify-between gap-2 p-2 rounded-lg bg-[#D1FAE5] border border-[#A7E3B8]">
                <a href={reportPdfUrl} target="_blank" rel="noopener noreferrer"
                  className="text-[13px] text-[#065F46] hover:underline truncate">Attached · open</a>
                <button onClick={() => setReportPdfUrl('')} className="text-[11px] text-[#065F46] hover:underline">Remove</button>
              </div>
            ) : (
              <label className="inline-flex items-center gap-1.5 px-3 py-1.5 border border-[#E8E8E4] text-[12px] font-medium rounded-lg bg-white hover:bg-[#F1EFE8] cursor-pointer">
                <Upload size={12} /> {uploading ? 'Uploading…' : 'Choose PDF'}
                <input type="file" accept="application/pdf,image/*" onChange={handlePdf} className="hidden" />
              </label>
            )}
          </div>
        </div>

        {err && (
          <div className="text-[12px] text-[#991B1B] bg-[#FCEBEB] border border-[#F5C6C6] px-3 py-2 rounded-lg">{err}</div>
        )}

        <div className="flex items-center justify-end gap-2">
          <button onClick={() => navigate(`/admin/results/${urlType}`)}
            className="px-3 py-1.5 text-[12px] font-medium text-[#1A1A2E] border border-[#E8E8E4] rounded-lg hover:bg-[#F1EFE8]">
            Cancel
          </button>
          <button onClick={save} disabled={saving || !patient}
            className="px-3 py-1.5 text-[12px] font-medium bg-[#7F77DD] text-white rounded-lg hover:bg-[#6B64C8] disabled:opacity-50">
            {saving ? 'Saving…' : 'Save result'}
          </button>
        </div>
      </div>
    </div>
  )
}
