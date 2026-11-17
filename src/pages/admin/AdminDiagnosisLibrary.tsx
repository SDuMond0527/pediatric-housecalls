import { useEffect, useMemo, useState } from 'react'
import { BookOpen, Plus, RefreshCw, Save, X, Archive, RotateCcw } from 'lucide-react'
import {
  getResultDiagnoses, createResultDiagnosis, updateResultDiagnosis, archiveResultDiagnosis,
  type ResultDiagnosisRow, type ResultResourceType,
} from '../../lib/api'

// Per-practice diagnosis library for the Pathology + Labs result
// inboxes. Admins preload / edit the list; the inbox pulls from here
// for its searchable dropdown. Sara 2026-11-16.

export function AdminDiagnosisLibrary() {
  const [tab, setTab] = useState<ResultResourceType>('pathology')
  const [rows, setRows] = useState<ResultDiagnosisRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [includeArchived, setIncludeArchived] = useState(false)
  const [newLabel, setNewLabel] = useState('')
  const [newShort, setNewShort] = useState('')
  const [newSort, setNewSort] = useState('100')
  const [newMapsChronic, setNewMapsChronic] = useState(false)
  const [newIcd10, setNewIcd10] = useState('')
  const [adding, setAdding] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState<{ label: string; short_code: string; sort_order: string; maps_to_chronic_problem: boolean; default_icd10_code: string }>({ label: '', short_code: '', sort_order: '100', maps_to_chronic_problem: false, default_icd10_code: '' })
  const [busy, setBusy] = useState<string | null>(null)

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const data = await getResultDiagnoses({ resource_type: tab, include_archived: includeArchived })
      setRows(Array.isArray(data) ? data : [])
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load library')
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { void load() }, [tab, includeArchived])

  async function add() {
    if (!newLabel.trim()) { alert('Label required.'); return }
    setAdding(true)
    try {
      await createResultDiagnosis({
        resource_type: tab,
        label: newLabel.trim(),
        short_code: newShort.trim() || undefined,
        sort_order: Number(newSort) || 100,
        maps_to_chronic_problem: newMapsChronic,
        default_icd10_code: newIcd10.trim() || undefined,
      })
      setNewLabel(''); setNewShort(''); setNewSort('100'); setNewMapsChronic(false); setNewIcd10('')
      await load()
    } catch (e: any) { alert('Add failed: ' + (e?.message ?? '')) }
    finally { setAdding(false) }
  }

  function startEdit(r: ResultDiagnosisRow) {
    setEditingId(r.id)
    setDraft({
      label: r.label,
      short_code: r.short_code ?? '',
      sort_order: String(r.sort_order),
      maps_to_chronic_problem: !!r.maps_to_chronic_problem,
      default_icd10_code: r.default_icd10_code ?? '',
    })
  }
  async function saveEdit(id: string) {
    if (!draft.label.trim()) { alert('Label required.'); return }
    setBusy(id)
    try {
      await updateResultDiagnosis(id, {
        label: draft.label.trim(),
        short_code: draft.short_code.trim() || null as any,
        sort_order: Number(draft.sort_order) || 100,
        maps_to_chronic_problem: draft.maps_to_chronic_problem,
        default_icd10_code: draft.default_icd10_code.trim() || null as any,
      })
      setEditingId(null)
      await load()
    } catch (e: any) { alert('Save failed: ' + (e?.message ?? '')) }
    finally { setBusy(null) }
  }
  async function archive(id: string) {
    if (!confirm('Archive this diagnosis? It will stop appearing in the dropdown but historical results keep their label.')) return
    setBusy(id)
    try { await archiveResultDiagnosis(id); await load() }
    catch (e: any) { alert('Archive failed: ' + (e?.message ?? '')) }
    finally { setBusy(null) }
  }
  async function unarchive(id: string) {
    setBusy(id)
    try { await updateResultDiagnosis(id, { is_active: true }); await load() }
    catch (e: any) { alert('Unarchive failed: ' + (e?.message ?? '')) }
    finally { setBusy(null) }
  }

  const sorted = useMemo(() =>
    [...rows].sort((a, b) =>
      a.sort_order - b.sort_order || a.label.localeCompare(b.label)
    ),
  [rows])

  return (
    <div>
      <div className="bg-white border-b border-[#E8E8E4] px-6 py-4 flex items-center justify-between sticky top-0 z-10">
        <div className="flex items-center gap-2.5">
          <BookOpen size={18} className="text-[#7F77DD]" />
          <div>
            <div className="font-display text-[18px] font-medium text-[#1A1A2E]">Diagnosis library</div>
            <div className="text-[12px] text-[#1A1A2E]/70">Common result diagnoses this practice can pick from when signing a result.</div>
          </div>
        </div>
        <button onClick={() => void load()}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 border border-[#E8E8E4] text-[12px] font-medium rounded-lg bg-white hover:bg-[#F1EFE8]">
          <RefreshCw size={12} className={loading ? 'animate-spin' : ''} /> Refresh
        </button>
      </div>

      <div className="p-6 max-w-4xl space-y-4">
        <div className="flex items-center gap-1 border-b border-[#E8E8E4]">
          {(['pathology', 'lab'] as const).map(t => (
            <button key={t}
              onClick={() => setTab(t)}
              className={`px-3 py-2 text-[12px] font-medium border-b-2 transition-colors ${
                tab === t
                  ? 'border-[#7F77DD] text-[#7F77DD]'
                  : 'border-transparent text-[#1A1A2E]/70 hover:text-[#1A1A2E]'
              }`}>
              {t === 'pathology' ? 'Pathology' : 'Labs'}
            </button>
          ))}
          <label className="ml-auto flex items-center gap-1.5 text-[11px] text-[#1A1A2E]/70 cursor-pointer">
            <input type="checkbox" checked={includeArchived} onChange={e => setIncludeArchived(e.target.checked)}
              className="accent-[#7F77DD]" />
            Show archived
          </label>
        </div>

        {error && (
          <div className="text-[12px] text-[#991B1B] bg-[#FCEBEB] border border-[#F5C6C6] px-3 py-2 rounded-lg">{error}</div>
        )}

        {/* Add form */}
        <div className="bg-white border border-[#E8E8E4] rounded-xl p-3">
          <div className="text-[11px] font-semibold text-[#1A1A2E] uppercase tracking-wide mb-2">Add new</div>
          <div className="grid grid-cols-[1fr_110px_80px_80px_110px_auto] gap-2 items-end">
            <div>
              <label className="block text-[10px] text-[#1A1A2E]/60 uppercase tracking-wide mb-1">Label</label>
              <input type="text" value={newLabel}
                onChange={e => setNewLabel(e.target.value)}
                placeholder="e.g. Squamous cell carcinoma, well-differentiated"
                className="w-full px-2.5 py-1.5 text-[12px] border border-[#E8E8E4] rounded-lg bg-white outline-none focus:border-[#7F77DD]" />
            </div>
            <div>
              <label className="block text-[10px] text-[#1A1A2E]/60 uppercase tracking-wide mb-1">Short code</label>
              <input type="text" value={newShort}
                onChange={e => setNewShort(e.target.value)}
                placeholder="SCC-WD"
                className="w-full px-2.5 py-1.5 text-[12px] font-mono border border-[#E8E8E4] rounded-lg bg-white outline-none focus:border-[#7F77DD]" />
            </div>
            <div>
              <label className="block text-[10px] text-[#1A1A2E]/60 uppercase tracking-wide mb-1">Sort</label>
              <input type="number" value={newSort}
                onChange={e => setNewSort(e.target.value)}
                className="w-full px-2.5 py-1.5 text-[12px] font-mono border border-[#E8E8E4] rounded-lg bg-white outline-none focus:border-[#7F77DD]" />
            </div>
            <div>
              <label className="block text-[10px] text-[#1A1A2E]/60 uppercase tracking-wide mb-1" title="If checked, signing a result with this diagnosis will auto-add it to the patient's chronic problems list.">Chronic?</label>
              <label className="flex items-center h-8 justify-center cursor-pointer">
                <input type="checkbox" checked={newMapsChronic}
                  onChange={e => setNewMapsChronic(e.target.checked)}
                  className="accent-[#7F77DD] w-4 h-4" />
              </label>
            </div>
            <div>
              <label className="block text-[10px] text-[#1A1A2E]/60 uppercase tracking-wide mb-1">Default ICD-10</label>
              <input type="text" value={newIcd10}
                onChange={e => setNewIcd10(e.target.value.toUpperCase())}
                placeholder="C44.21"
                className="w-full px-2.5 py-1.5 text-[12px] font-mono border border-[#E8E8E4] rounded-lg bg-white outline-none focus:border-[#7F77DD]" />
            </div>
            <button onClick={() => void add()} disabled={adding}
              className="inline-flex items-center gap-1 px-3 py-1.5 bg-[#7F77DD] text-white text-[12px] font-medium rounded-lg hover:bg-[#6B64C8] disabled:opacity-50">
              <Plus size={12} /> Add
            </button>
          </div>
        </div>

        {/* Library table */}
        <div className="bg-white border border-[#E8E8E4] rounded-xl overflow-hidden">
          <table className="w-full text-[12px]">
            <thead className="bg-[#FAFAF8] text-[11px] text-[#1A1A2E] uppercase tracking-wide">
              <tr>
                <th className="text-left px-3 py-2">Label</th>
                <th className="text-left px-3 py-2 w-28">Short code</th>
                <th className="text-right px-3 py-2 w-16">Sort</th>
                <th className="text-center px-3 py-2 w-20" title="Adds to patient chronic problems when signed">Chronic?</th>
                <th className="text-left px-3 py-2 w-28">Default ICD-10</th>
                <th className="text-right px-3 py-2 w-40">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#F1EFE8]">
              {sorted.length === 0 && !loading && (
                <tr><td colSpan={6} className="px-3 py-8 text-center text-[#1A1A2E]/60">No entries yet. Add your first one above.</td></tr>
              )}
              {sorted.map(r => (
                <tr key={r.id} className={r.is_active ? '' : 'bg-[#FEF8E7] text-[#1A1A2E]/60'}>
                  {editingId === r.id ? (
                    <>
                      <td className="px-3 py-2">
                        <input type="text" value={draft.label}
                          onChange={e => setDraft(d => ({ ...d, label: e.target.value }))}
                          className="w-full px-2 py-1 text-[12px] border border-[#E8E8E4] rounded bg-white outline-none focus:border-[#7F77DD]" />
                      </td>
                      <td className="px-3 py-2">
                        <input type="text" value={draft.short_code}
                          onChange={e => setDraft(d => ({ ...d, short_code: e.target.value }))}
                          className="w-full px-2 py-1 text-[12px] font-mono border border-[#E8E8E4] rounded bg-white outline-none focus:border-[#7F77DD]" />
                      </td>
                      <td className="px-3 py-2 text-right">
                        <input type="number" value={draft.sort_order}
                          onChange={e => setDraft(d => ({ ...d, sort_order: e.target.value }))}
                          className="w-full px-2 py-1 text-[12px] font-mono border border-[#E8E8E4] rounded bg-white outline-none focus:border-[#7F77DD]" />
                      </td>
                      <td className="px-3 py-2 text-center">
                        <input type="checkbox" checked={draft.maps_to_chronic_problem}
                          onChange={e => setDraft(d => ({ ...d, maps_to_chronic_problem: e.target.checked }))}
                          className="accent-[#7F77DD] w-4 h-4" />
                      </td>
                      <td className="px-3 py-2">
                        <input type="text" value={draft.default_icd10_code}
                          onChange={e => setDraft(d => ({ ...d, default_icd10_code: e.target.value.toUpperCase() }))}
                          placeholder="C44.21"
                          className="w-full px-2 py-1 text-[12px] font-mono border border-[#E8E8E4] rounded bg-white outline-none focus:border-[#7F77DD]" />
                      </td>
                      <td className="px-3 py-2 text-right">
                        <div className="inline-flex items-center gap-1">
                          <button onClick={() => saveEdit(r.id)} disabled={busy === r.id}
                            className="inline-flex items-center gap-1 px-2 py-1 bg-[#7F77DD] text-white text-[11px] font-medium rounded hover:bg-[#6B64C8] disabled:opacity-50">
                            <Save size={10} /> Save
                          </button>
                          <button onClick={() => setEditingId(null)}
                            className="inline-flex items-center gap-1 px-2 py-1 border border-[#E8E8E4] text-[11px] font-medium rounded bg-white hover:bg-[#F1EFE8]">
                            <X size={10} /> Cancel
                          </button>
                        </div>
                      </td>
                    </>
                  ) : (
                    <>
                      <td className="px-3 py-2 text-[#1A1A2E]">{r.label}</td>
                      <td className="px-3 py-2 font-mono text-[11px]">{r.short_code ?? '—'}</td>
                      <td className="px-3 py-2 font-mono text-right">{r.sort_order}</td>
                      <td className="px-3 py-2 text-center">
                        {r.maps_to_chronic_problem
                          ? <span className="text-[#1D9E75] font-semibold">✓</span>
                          : <span className="text-[#1A1A2E]/30">—</span>}
                      </td>
                      <td className="px-3 py-2 font-mono text-[11px]">{r.default_icd10_code ?? '—'}</td>
                      <td className="px-3 py-2 text-right">
                        <div className="inline-flex items-center gap-1">
                          <button onClick={() => startEdit(r)} disabled={busy === r.id}
                            className="inline-flex items-center gap-1 px-2 py-1 border border-[#E8E8E4] text-[11px] font-medium rounded bg-white hover:bg-[#F1EFE8] disabled:opacity-50">
                            Edit
                          </button>
                          {r.is_active ? (
                            <button onClick={() => archive(r.id)} disabled={busy === r.id}
                              className="inline-flex items-center gap-1 px-2 py-1 border border-[#E8E8E4] text-[11px] font-medium rounded bg-white hover:bg-[#F1EFE8] disabled:opacity-50">
                              <Archive size={10} /> Archive
                            </button>
                          ) : (
                            <button onClick={() => unarchive(r.id)} disabled={busy === r.id}
                              className="inline-flex items-center gap-1 px-2 py-1 border border-[#E8E8E4] text-[11px] font-medium rounded bg-white hover:bg-[#F1EFE8] disabled:opacity-50">
                              <RotateCcw size={10} /> Restore
                            </button>
                          )}
                        </div>
                      </td>
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
