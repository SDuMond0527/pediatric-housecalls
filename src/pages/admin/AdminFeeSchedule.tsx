import { useEffect, useMemo, useState } from 'react'
import { DollarSign, Plus, RefreshCw, Save, X, Archive, RotateCcw } from 'lucide-react'
import {
  getFeeSchedule, createFeeScheduleRow, updateFeeScheduleRow, archiveFeeScheduleRow,
  type FeeScheduleRow,
} from '../../lib/api'

// Per-practice fee schedule editor. Admins add CPT codes with prices,
// edit them, archive the ones they stop offering. The Procedures &
// Fees dropdown inside the encounter note reads from this table.
// Sara 2026-11-16, built so Dr. Cash can self-manage derm procedure
// prices without SQL.

export function AdminFeeSchedule() {
  const [rows, setRows] = useState<FeeScheduleRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [includeArchived, setIncludeArchived] = useState(false)
  const [search, setSearch] = useState('')
  const [newCode, setNewCode] = useState('')
  const [newDesc, setNewDesc] = useState('')
  const [newCategory, setNewCategory] = useState('')
  const [newAmount, setNewAmount] = useState('')
  const [adding, setAdding] = useState(false)
  const [editingCode, setEditingCode] = useState<string | null>(null)
  const [draft, setDraft] = useState<{ description: string; category: string; charge_amount: string; place_of_service: string }>({ description: '', category: '', charge_amount: '', place_of_service: '' })
  const [busy, setBusy] = useState<string | null>(null)

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const data = await getFeeSchedule({ include_archived: includeArchived })
      setRows(Array.isArray(data) ? data : [])
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load fee schedule')
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { void load() }, [includeArchived])

  async function add() {
    if (!newCode.trim())     { alert('Code required.'); return }
    if (!newDesc.trim())     { alert('Description required.'); return }
    const amount = Number(newAmount)
    if (!Number.isFinite(amount) || amount < 0) { alert('Charge amount must be a non-negative number.'); return }
    setAdding(true)
    try {
      await createFeeScheduleRow({
        code: newCode.trim(),
        description: newDesc.trim(),
        category: newCategory.trim() || undefined,
        charge_amount: amount,
      })
      setNewCode(''); setNewDesc(''); setNewCategory(''); setNewAmount('')
      await load()
    } catch (e: any) { alert('Add failed: ' + (e?.message ?? '')) }
    finally { setAdding(false) }
  }

  function startEdit(r: FeeScheduleRow) {
    setEditingCode(r.code)
    setDraft({
      description:    r.description ?? '',
      category:       r.category ?? '',
      charge_amount:  String(r.charge_amount ?? ''),
      place_of_service: r.place_of_service ?? '',
    })
  }
  async function saveEdit(code: string) {
    const amount = Number(draft.charge_amount)
    if (!draft.description.trim()) { alert('Description required.'); return }
    if (!Number.isFinite(amount) || amount < 0) { alert('Charge amount must be a non-negative number.'); return }
    setBusy(code)
    try {
      await updateFeeScheduleRow(code, {
        description: draft.description.trim(),
        category: draft.category.trim() || 'Other',
        charge_amount: amount,
        place_of_service: draft.place_of_service.trim() || undefined,
      })
      setEditingCode(null)
      await load()
    } catch (e: any) { alert('Save failed: ' + (e?.message ?? '')) }
    finally { setBusy(null) }
  }
  async function archive(code: string) {
    if (!confirm(`Archive ${code}? It will stop appearing in the encounter note's Procedures & Fees dropdown. Historical charges keep this code.`)) return
    setBusy(code)
    try { await archiveFeeScheduleRow(code); await load() }
    catch (e: any) { alert('Archive failed: ' + (e?.message ?? '')) }
    finally { setBusy(null) }
  }
  async function unarchive(code: string) {
    setBusy(code)
    try { await updateFeeScheduleRow(code, { is_active: true }); await load() }
    catch (e: any) { alert('Unarchive failed: ' + (e?.message ?? '')) }
    finally { setBusy(null) }
  }

  const filtered = useMemo(() => {
    const s = search.trim().toLowerCase()
    if (!s) return rows
    return rows.filter(r =>
      r.code.toLowerCase().includes(s) ||
      (r.description ?? '').toLowerCase().includes(s) ||
      (r.category ?? '').toLowerCase().includes(s)
    )
  }, [rows, search])

  // Group by category for display.
  const grouped = useMemo(() => {
    const map = new Map<string, FeeScheduleRow[]>()
    for (const r of filtered) {
      const cat = r.category || 'Other'
      if (!map.has(cat)) map.set(cat, [])
      map.get(cat)!.push(r)
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }, [filtered])

  return (
    <div>
      <div className="bg-white border-b border-[#E8E8E4] px-6 py-4 flex items-center justify-between sticky top-0 z-10">
        <div className="flex items-center gap-2.5">
          <DollarSign size={18} className="text-[#7F77DD]" />
          <div>
            <div className="font-display text-[18px] font-medium text-[#1A1A2E]">Fee schedule</div>
            <div className="text-[12px] text-[#1A1A2E]/70">Procedures and prices this practice can add to a visit.</div>
          </div>
        </div>
        <button onClick={() => void load()}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 border border-[#E8E8E4] text-[12px] font-medium rounded-lg bg-white hover:bg-[#F1EFE8]">
          <RefreshCw size={12} className={loading ? 'animate-spin' : ''} /> Refresh
        </button>
      </div>

      <div className="p-6 max-w-5xl space-y-4">
        <div className="flex items-center gap-3">
          <input type="text" value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Search by code, description, category…"
            className="flex-1 px-2.5 py-1.5 text-[12px] border border-[#E8E8E4] rounded-lg bg-white outline-none focus:border-[#7F77DD]" />
          <label className="flex items-center gap-1.5 text-[11px] text-[#1A1A2E]/70 cursor-pointer">
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
          <div className="grid grid-cols-[110px_1fr_140px_110px_auto] gap-2 items-end">
            <div>
              <label className="block text-[10px] text-[#1A1A2E]/60 uppercase tracking-wide mb-1">Code</label>
              <input type="text" value={newCode}
                onChange={e => setNewCode(e.target.value.toUpperCase())}
                placeholder="11100"
                className="w-full px-2.5 py-1.5 text-[12px] font-mono border border-[#E8E8E4] rounded-lg bg-white outline-none focus:border-[#7F77DD]" />
            </div>
            <div>
              <label className="block text-[10px] text-[#1A1A2E]/60 uppercase tracking-wide mb-1">Description</label>
              <input type="text" value={newDesc}
                onChange={e => setNewDesc(e.target.value)}
                placeholder="Shave biopsy, single lesion"
                className="w-full px-2.5 py-1.5 text-[12px] border border-[#E8E8E4] rounded-lg bg-white outline-none focus:border-[#7F77DD]" />
            </div>
            <div>
              <label className="block text-[10px] text-[#1A1A2E]/60 uppercase tracking-wide mb-1">Category</label>
              <input type="text" value={newCategory}
                onChange={e => setNewCategory(e.target.value)}
                placeholder="Biopsies"
                className="w-full px-2.5 py-1.5 text-[12px] border border-[#E8E8E4] rounded-lg bg-white outline-none focus:border-[#7F77DD]" />
            </div>
            <div>
              <label className="block text-[10px] text-[#1A1A2E]/60 uppercase tracking-wide mb-1">Charge $</label>
              <input type="number" step="0.01" min="0" value={newAmount}
                onChange={e => setNewAmount(e.target.value)}
                placeholder="85.00"
                className="w-full px-2.5 py-1.5 text-[12px] font-mono text-right border border-[#E8E8E4] rounded-lg bg-white outline-none focus:border-[#7F77DD]" />
            </div>
            <button onClick={() => void add()} disabled={adding}
              className="inline-flex items-center gap-1 px-3 py-1.5 bg-[#7F77DD] text-white text-[12px] font-medium rounded-lg hover:bg-[#6B64C8] disabled:opacity-50">
              <Plus size={12} /> Add
            </button>
          </div>
        </div>

        {/* Grouped list */}
        {grouped.length === 0 && !loading ? (
          <div className="text-[13px] text-[#1A1A2E]/60 py-12 text-center bg-white rounded-xl border border-[#E8E8E4]">
            No procedures yet. Add your first one above.
          </div>
        ) : (
          <div className="space-y-4">
            {grouped.map(([category, items]) => (
              <div key={category} className="bg-white border border-[#E8E8E4] rounded-xl overflow-hidden">
                <div className="px-4 py-2 bg-[#FAFAF8] border-b border-[#E8E8E4] text-[11px] font-semibold text-[#1A1A2E] uppercase tracking-wide">{category}</div>
                <table className="w-full text-[12px]">
                  <thead>
                    <tr className="text-[10px] text-[#1A1A2E]/60 uppercase tracking-wide">
                      <th className="text-left px-3 py-1.5 w-24">Code</th>
                      <th className="text-left px-3 py-1.5">Description</th>
                      <th className="text-right px-3 py-1.5 w-24">Charge</th>
                      <th className="text-right px-3 py-1.5 w-48">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#F1EFE8]">
                    {items.map(r => (
                      <tr key={r.code} className={r.is_active === false ? 'bg-[#FEF8E7] text-[#1A1A2E]/60' : ''}>
                        {editingCode === r.code ? (
                          <>
                            <td className="px-3 py-2 font-mono">{r.code}</td>
                            <td className="px-3 py-2">
                              <input type="text" value={draft.description}
                                onChange={e => setDraft(d => ({ ...d, description: e.target.value }))}
                                className="w-full px-2 py-1 text-[12px] border border-[#E8E8E4] rounded bg-white outline-none focus:border-[#7F77DD]" />
                              <input type="text" value={draft.category}
                                placeholder="Category"
                                onChange={e => setDraft(d => ({ ...d, category: e.target.value }))}
                                className="mt-1 w-full px-2 py-1 text-[11px] border border-[#E8E8E4] rounded bg-white outline-none focus:border-[#7F77DD]" />
                            </td>
                            <td className="px-3 py-2 text-right">
                              <input type="number" step="0.01" min="0" value={draft.charge_amount}
                                onChange={e => setDraft(d => ({ ...d, charge_amount: e.target.value }))}
                                className="w-full px-2 py-1 text-[12px] font-mono text-right border border-[#E8E8E4] rounded bg-white outline-none focus:border-[#7F77DD]" />
                            </td>
                            <td className="px-3 py-2 text-right">
                              <div className="inline-flex items-center gap-1">
                                <button onClick={() => saveEdit(r.code)} disabled={busy === r.code}
                                  className="inline-flex items-center gap-1 px-2 py-1 bg-[#7F77DD] text-white text-[11px] font-medium rounded hover:bg-[#6B64C8] disabled:opacity-50">
                                  <Save size={10} /> Save
                                </button>
                                <button onClick={() => setEditingCode(null)}
                                  className="inline-flex items-center gap-1 px-2 py-1 border border-[#E8E8E4] text-[11px] font-medium rounded bg-white hover:bg-[#F1EFE8]">
                                  <X size={10} /> Cancel
                                </button>
                              </div>
                            </td>
                          </>
                        ) : (
                          <>
                            <td className="px-3 py-2 font-mono">{r.code}</td>
                            <td className="px-3 py-2">{r.description}</td>
                            <td className="px-3 py-2 text-right font-mono">${Number(r.charge_amount).toFixed(2)}</td>
                            <td className="px-3 py-2 text-right">
                              <div className="inline-flex items-center gap-1">
                                <button onClick={() => startEdit(r)} disabled={busy === r.code}
                                  className="inline-flex items-center gap-1 px-2 py-1 border border-[#E8E8E4] text-[11px] font-medium rounded bg-white hover:bg-[#F1EFE8] disabled:opacity-50">
                                  Edit
                                </button>
                                {r.is_active === false ? (
                                  <button onClick={() => unarchive(r.code)} disabled={busy === r.code}
                                    className="inline-flex items-center gap-1 px-2 py-1 border border-[#E8E8E4] text-[11px] font-medium rounded bg-white hover:bg-[#F1EFE8] disabled:opacity-50">
                                    <RotateCcw size={10} /> Restore
                                  </button>
                                ) : (
                                  <button onClick={() => archive(r.code)} disabled={busy === r.code}
                                    className="inline-flex items-center gap-1 px-2 py-1 border border-[#E8E8E4] text-[11px] font-medium rounded bg-white hover:bg-[#F1EFE8] disabled:opacity-50">
                                    <Archive size={10} /> Archive
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
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
