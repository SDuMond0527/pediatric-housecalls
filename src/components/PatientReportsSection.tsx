import { useCallback, useEffect, useRef, useState } from 'react'
import { Upload, FileText, Trash2, Download, X } from 'lucide-react'
import { format } from 'date-fns'
import {
  getPatientReports,
  familyGetPatientReports,
  createPatientReport,
  familyCreatePatientReport,
  deletePatientReport,
  uploadPatientReportFile,
  type PatientReport,
} from '../lib/api'

type Kind = 'lab' | 'radiology'
type Role = 'provider' | 'family'

interface Props {
  childId: string
  kind: Kind
  role: Role
}

const KIND_LABEL: Record<Kind, string> = { lab: 'Lab reports', radiology: 'Radiology reports' }
const KIND_HELPER: Record<Kind, string> = {
  lab: 'Upload PDFs of lab reports that come back from the imaging center or lab.',
  radiology: 'Upload PDFs of radiology reports from the imaging center.',
}

function prettySize(bytes: number | null): string {
  if (!bytes || bytes <= 0) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

async function downloadToDisk(url: string, filename: string) {
  try {
    const r = await fetch(url)
    const blob = await r.blob()
    const objUrl = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = objUrl; a.download = filename; a.click()
    URL.revokeObjectURL(objUrl)
  } catch {
    // Cross-origin fetch may fail — fall back to opening in a new tab.
    window.open(url, '_blank')
  }
}

/**
 * Reports section rendered inside a patient chart (provider+admin view
 * via PatientChart.tsx) and inside the family portal (FamilyLabs /
 * FamilyRadiology pages). Same component across all three audiences —
 * the `role` prop just picks which auth pool to use and whether to
 * show the delete button.
 */
export function PatientReportsSection({ childId, kind, role }: Props) {
  const [reports, setReports] = useState<PatientReport[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [pendingFile, setPendingFile] = useState<File | null>(null)
  const [titleInput, setTitleInput] = useState('')
  const fileInputRef = useRef<HTMLInputElement>(null)

  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [confirmingDelete, setConfirmingDelete] = useState<PatientReport | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const fetcher = role === 'provider' ? getPatientReports : familyGetPatientReports
      const data = await fetcher(childId, kind)
      setReports(data ?? [])
    } catch (e: any) {
      setError(e?.message || 'Failed to load reports')
    } finally {
      setLoading(false)
    }
  }, [childId, kind, role])

  useEffect(() => { load() }, [load])

  function onPickFile() {
    fileInputRef.current?.click()
  }

  function onFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]
    if (!f) return
    setPendingFile(f)
    // Default title to the filename without extension — user can edit.
    setTitleInput(f.name.replace(/\.[^.]+$/, ''))
    setUploadError(null)
    // Reset the input so re-selecting the same file still fires onChange.
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  async function doUpload() {
    if (!pendingFile) return
    if (!titleInput.trim()) {
      setUploadError('Give this report a short title (e.g. "CBC — Jan 2026").')
      return
    }
    setUploading(true)
    setUploadError(null)
    try {
      const uploaded = await uploadPatientReportFile(pendingFile, { child_id: childId, kind, role })
      const creator = role === 'provider' ? createPatientReport : familyCreatePatientReport
      const row = await creator({
        child_id: childId,
        kind,
        title: titleInput.trim(),
        blob_url: uploaded.url,
        filename: uploaded.filename,
        mime_type: uploaded.mime_type,
        size_bytes: uploaded.size_bytes,
      })
      setReports(prev => [row, ...prev])
      setPendingFile(null)
      setTitleInput('')
    } catch (e: any) {
      setUploadError(e?.message || 'Upload failed')
    } finally {
      setUploading(false)
    }
  }

  async function doDelete(r: PatientReport) {
    setDeletingId(r.id)
    try {
      await deletePatientReport(r.id)
      setReports(prev => prev.filter(x => x.id !== r.id))
      setConfirmingDelete(null)
    } catch (e: any) {
      setUploadError(e?.message || 'Delete failed')
    } finally {
      setDeletingId(null)
    }
  }

  const canDelete = role === 'provider'

  return (
    <div className="bg-white border border-[#E8E8E4] rounded-xl p-4 shadow-sm">
      <div className="flex items-center justify-between mb-3">
        <div>
          <div className="font-display text-[14px] font-semibold text-[#1A1A2E]">{KIND_LABEL[kind]}</div>
          <div className="text-[11px] text-[#1A1A2E] mt-0.5">{KIND_HELPER[kind]}</div>
        </div>
        <button
          onClick={onPickFile}
          disabled={uploading}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-[#7F77DD] text-white text-[12px] font-medium rounded-lg hover:bg-[#6C64C8] transition-colors disabled:opacity-50"
        >
          <Upload size={13} />
          Upload report
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="application/pdf,image/*"
          onChange={onFileChange}
          className="hidden"
        />
      </div>

      {/* Pending upload — give the file a title before saving */}
      {pendingFile && (
        <div className="bg-[#FAFAF8] border border-[#E8E8E4] rounded-lg p-3 mb-3">
          <div className="flex items-start justify-between gap-3">
            <div className="flex-1 min-w-0">
              <div className="text-[12px] font-medium text-[#1A1A2E] truncate">{pendingFile.name}</div>
              <div className="text-[11px] text-[#555] mt-0.5">{prettySize(pendingFile.size)}</div>
              <input
                value={titleInput}
                onChange={e => setTitleInput(e.target.value)}
                placeholder="Title (e.g. CBC — Jan 2026)"
                className="w-full mt-2 px-2.5 py-1.5 text-[12px] border border-[#E8E8E4] rounded-md focus:outline-none focus:ring-2 focus:ring-[#7F77DD]/30"
              />
            </div>
            <button
              onClick={() => { setPendingFile(null); setTitleInput(''); setUploadError(null) }}
              className="p-1 text-[#777] hover:text-[#1A1A2E]"
              aria-label="Cancel"
            ><X size={14} /></button>
          </div>
          {uploadError && (
            <div className="text-[11px] text-red-600 bg-red-50 px-2 py-1 rounded mt-2">{uploadError}</div>
          )}
          <div className="flex items-center gap-2 justify-end mt-2">
            <button
              onClick={() => { setPendingFile(null); setTitleInput('') }}
              disabled={uploading}
              className="px-3 py-1.5 text-[12px] text-[#666] border border-[#E8E8E4] rounded-md hover:bg-[#F1EFE8]"
            >Cancel</button>
            <button
              onClick={doUpload}
              disabled={uploading}
              className="px-3 py-1.5 text-[12px] bg-[#7F77DD] text-white rounded-md hover:bg-[#6C64C8] disabled:opacity-50 font-medium"
            >{uploading ? 'Uploading…' : 'Save report'}</button>
          </div>
        </div>
      )}

      {uploadError && !pendingFile && (
        <div className="text-[12px] text-red-600 bg-red-50 px-3 py-2 rounded-lg mb-3">{uploadError}</div>
      )}

      {/* List */}
      {loading ? (
        <div className="text-center py-6 text-[12px] text-[#555]">Loading reports…</div>
      ) : error ? (
        <div className="text-[12px] text-red-500 bg-red-50 px-3 py-2 rounded-lg">{error}</div>
      ) : reports.length === 0 ? (
        <div className="text-center py-6 text-[12px] text-[#1A1A2E]">
          No {kind === 'lab' ? 'lab' : 'radiology'} reports uploaded yet.
        </div>
      ) : (
        <div className="divide-y divide-[#F1EFE8]">
          {reports.map(r => (
            <div key={r.id} className="flex items-center gap-3 py-2.5">
              <FileText size={16} className="text-[#7F77DD] flex-shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="text-[13px] font-medium text-[#1A1A2E] truncate">{r.title}</div>
                <div className="text-[11px] text-[#555] mt-0.5 truncate">
                  {r.filename}
                  {r.size_bytes ? ` · ${prettySize(r.size_bytes)}` : ''}
                  {' · '}
                  Uploaded by {r.uploaded_by_name}
                  {r.uploaded_at ? ` on ${format(new Date(r.uploaded_at), 'MMM d, yyyy')}` : ''}
                </div>
              </div>
              <button
                onClick={() => downloadToDisk(r.blob_url, r.filename)}
                className="flex items-center gap-1 px-2 py-1 text-[11px] text-[#5B54B5] hover:bg-[#7F77DD]/10 rounded-md"
                title="Download"
              ><Download size={13} /> Download</button>
              {canDelete && (
                <button
                  onClick={() => setConfirmingDelete(r)}
                  className="p-1.5 text-[#999] hover:text-red-500 hover:bg-red-50 rounded-md"
                  title="Delete"
                ><Trash2 size={14} /></button>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Delete confirmation modal */}
      {confirmingDelete && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl shadow-xl max-w-md w-full p-5">
            <div className="font-display text-[16px] font-semibold text-[#1A1A2E]">Delete this report?</div>
            <div className="text-[13px] text-[#555] mt-2">
              <strong>{confirmingDelete.title}</strong> ({confirmingDelete.filename}) will be permanently removed. This cannot be undone.
            </div>
            <div className="flex items-center gap-2 justify-end mt-4">
              <button
                onClick={() => setConfirmingDelete(null)}
                disabled={deletingId === confirmingDelete.id}
                className="px-3 py-2 text-[13px] text-[#666] border border-[#E8E8E4] rounded-md hover:bg-[#F1EFE8]"
              >Cancel</button>
              <button
                onClick={() => doDelete(confirmingDelete)}
                disabled={deletingId === confirmingDelete.id}
                className="px-3 py-2 text-[13px] bg-red-500 text-white rounded-md hover:bg-red-600 disabled:opacity-50 font-medium"
              >{deletingId === confirmingDelete.id ? 'Deleting…' : 'Delete report'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
