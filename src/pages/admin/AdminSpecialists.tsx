import { useEffect, useState } from 'react'
import { Stethoscope, Plus, Pencil, Trash2, Check, X, AlertCircle } from 'lucide-react'
import { Button } from '../../components/ui/Button'
import { getSpecialists, createSpecialist, updateSpecialist, archiveSpecialist, type Specialist } from '../../lib/api'

// Practice-wide directory of specialists that receive referrals via
// fax. Mirrors the AdminPcps directory pattern. Sara 2026-09-21.

const emptyForm = { name: '', specialty: '', phone: '', fax_number: '', address: '', notes: '' }

export function AdminSpecialists() {
  const [rows, setRows] = useState<Specialist[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [includeInactive, setIncludeInactive] = useState(false)
  const [addOpen, setAddOpen] = useState(false)
  const [form, setForm] = useState({ ...emptyForm })
  const [saving, setSaving] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editForm, setEditForm] = useState({ ...emptyForm })

  async function load() {
    setLoading(true); setError(null)
    try { setRows(await getSpecialists({ includeInactive })) }
    catch (e: any) { setError(e?.message ?? 'Failed to load specialists') }
    finally { setLoading(false) }
  }
  useEffect(() => { load() }, [includeInactive])

  async function handleCreate() {
    if (!form.name.trim()) return
    setSaving(true); setError(null)
    try {
      const created = await createSpecialist({
        name: form.name.trim(),
        specialty: form.specialty.trim() || null,
        phone: form.phone.trim() || null,
        fax_number: form.fax_number.trim() || null,
        address: form.address.trim() || null,
        notes: form.notes.trim() || null,
      })
      setRows(prev => [...prev, created].sort((a, b) => (a.specialty ?? 'zzz').localeCompare(b.specialty ?? 'zzz') || a.name.localeCompare(b.name)))
      setForm({ ...emptyForm })
      setAddOpen(false)
    } catch (e: any) { setError(e?.message ?? 'Failed to create') }
    finally { setSaving(false) }
  }

  function startEdit(s: Specialist) {
    setEditingId(s.id)
    setEditForm({
      name: s.name,
      specialty: s.specialty ?? '',
      phone: s.phone ?? '',
      fax_number: s.fax_number ?? '',
      address: s.address ?? '',
      notes: s.notes ?? '',
    })
  }

  async function handleSaveEdit() {
    if (!editingId) return
    setSaving(true); setError(null)
    try {
      const updated = await updateSpecialist(editingId, {
        name: editForm.name.trim(),
        specialty: editForm.specialty.trim() || null,
        phone: editForm.phone.trim() || null,
        fax_number: editForm.fax_number.trim() || null,
        address: editForm.address.trim() || null,
        notes: editForm.notes.trim() || null,
      })
      setRows(prev => prev.map(r => r.id === updated.id ? updated : r))
      setEditingId(null)
    } catch (e: any) { setError(e?.message ?? 'Failed to save') }
    finally { setSaving(false) }
  }

  async function handleArchive(s: Specialist) {
    if (!window.confirm(`Archive ${s.name}? They'll stop appearing in the "New referral" dropdown, but past referrals still reference them.`)) return
    setSaving(true); setError(null)
    try {
      await archiveSpecialist(s.id)
      setRows(prev => includeInactive
        ? prev.map(r => r.id === s.id ? { ...r, is_active: false } : r)
        : prev.filter(r => r.id !== s.id))
    } catch (e: any) { setError(e?.message ?? 'Failed to archive') }
    finally { setSaving(false) }
  }

  const inputCls = 'w-full px-3 py-2 border border-[#E8E8E4] rounded-lg text-[13px] outline-none focus:border-[#7F77DD] bg-white'

  return (
    <div>
      <div className="bg-white border-b border-[#E8E8E4] px-6 py-4 sticky top-0 z-10 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Stethoscope size={18} className="text-[#7F77DD]" />
          <div>
            <div className="font-display text-[18px] font-medium text-[#1A1A2E]">Specialist directory</div>
            <div className="text-[12px] text-[#1A1A2E]/70 mt-0.5">People you refer to. Add anyone here; they show up in the "New referral" picker on a patient chart.</div>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <label className="text-[12px] text-[#1A1A2E]/70 flex items-center gap-1.5">
            <input type="checkbox" checked={includeInactive} onChange={e => setIncludeInactive(e.target.checked)} />
            Show archived
          </label>
          <Button size="sm" variant="secondary" onClick={() => { setAddOpen(true); setForm({ ...emptyForm }) }}>
            <Plus size={13} /> Add specialist
          </Button>
        </div>
      </div>

      {error && (
        <div className="mx-6 mt-3 flex items-start gap-2 text-[13px] text-[#991B1B] bg-[#FCEBEB] border border-[#F5C6C6] px-3 py-2 rounded-lg">
          <AlertCircle size={14} className="mt-0.5 flex-shrink-0" /> <span>{error}</span>
        </div>
      )}

      <div className="p-6 max-w-4xl space-y-3">
        {addOpen && (
          <div className="p-4 border-2 border-[#7F77DD] rounded-xl bg-white space-y-2.5">
            <div className="grid grid-cols-2 gap-2.5">
              <div>
                <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-1">Name *</label>
                <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} className={inputCls} autoFocus />
              </div>
              <div>
                <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-1">Specialty</label>
                <input value={form.specialty} onChange={e => setForm(f => ({ ...f, specialty: e.target.value }))} className={inputCls} placeholder="e.g. Dermatology" />
              </div>
              <div>
                <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-1">Phone</label>
                <input value={form.phone} onChange={e => setForm(f => ({ ...f, phone: e.target.value }))} className={inputCls} />
              </div>
              <div>
                <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-1">Fax number *</label>
                <input value={form.fax_number} onChange={e => setForm(f => ({ ...f, fax_number: e.target.value }))} className={inputCls} placeholder="(704) 555-0000" />
              </div>
              <div className="col-span-2">
                <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-1">Address</label>
                <input value={form.address} onChange={e => setForm(f => ({ ...f, address: e.target.value }))} className={inputCls} />
              </div>
              <div className="col-span-2">
                <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block mb-1">Notes</label>
                <textarea value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} rows={2} className={`${inputCls} resize-y`} />
              </div>
            </div>
            <div className="flex gap-2">
              <Button size="sm" variant="teal" loading={saving} disabled={!form.name.trim()} onClick={handleCreate}>
                <Check size={12} /> Save
              </Button>
              <Button size="sm" variant="secondary" onClick={() => { setAddOpen(false); setForm({ ...emptyForm }) }}>
                <X size={12} /> Cancel
              </Button>
            </div>
          </div>
        )}

        {loading && <div className="text-center py-12 text-[13px] text-[#1A1A2E]/60">Loading…</div>}
        {!loading && rows.length === 0 && (
          <div className="text-center py-16">
            <Stethoscope size={32} className="text-[#1A1A2E]/20 mx-auto mb-3" />
            <div className="text-[14px] text-[#1A1A2E]/70">No specialists yet.</div>
            <Button className="mt-4" size="sm" variant="teal" onClick={() => setAddOpen(true)}>
              <Plus size={13} /> Add your first specialist
            </Button>
          </div>
        )}

        {rows.map(s => {
          const isEditing = editingId === s.id
          if (isEditing) {
            return (
              <div key={s.id} className="p-4 border-2 border-[#7F77DD] rounded-xl bg-white space-y-2.5">
                <div className="grid grid-cols-2 gap-2.5">
                  <input value={editForm.name} onChange={e => setEditForm(f => ({ ...f, name: e.target.value }))} className={inputCls} placeholder="Name" />
                  <input value={editForm.specialty} onChange={e => setEditForm(f => ({ ...f, specialty: e.target.value }))} className={inputCls} placeholder="Specialty" />
                  <input value={editForm.phone} onChange={e => setEditForm(f => ({ ...f, phone: e.target.value }))} className={inputCls} placeholder="Phone" />
                  <input value={editForm.fax_number} onChange={e => setEditForm(f => ({ ...f, fax_number: e.target.value }))} className={inputCls} placeholder="Fax number" />
                  <input value={editForm.address} onChange={e => setEditForm(f => ({ ...f, address: e.target.value }))} className={`${inputCls} col-span-2`} placeholder="Address" />
                  <textarea value={editForm.notes} onChange={e => setEditForm(f => ({ ...f, notes: e.target.value }))} rows={2} className={`${inputCls} col-span-2 resize-y`} placeholder="Notes" />
                </div>
                <div className="flex gap-2">
                  <Button size="sm" variant="teal" loading={saving} disabled={!editForm.name.trim()} onClick={handleSaveEdit}>
                    <Check size={12} /> Save
                  </Button>
                  <Button size="sm" variant="secondary" onClick={() => setEditingId(null)}>
                    <X size={12} /> Cancel
                  </Button>
                </div>
              </div>
            )
          }
          return (
            <div key={s.id} className={`group p-4 border rounded-xl bg-white ${s.is_active ? 'border-[#E8E8E4]' : 'border-[#F1EFE8] bg-[#FAFAF8] opacity-70'}`}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-display text-[15px] font-medium text-[#1A1A2E]">{s.name}</span>
                    {s.specialty && <span className="text-[12px] px-2 py-0.5 rounded-full bg-[#EEEDFE] text-[#3C3489]">{s.specialty}</span>}
                    {!s.is_active && <span className="text-[11px] px-2 py-0.5 rounded-full bg-[#F1EFE8] text-[#555]">Archived</span>}
                  </div>
                  <div className="text-[12px] text-[#1A1A2E]/70 mt-1 flex flex-wrap gap-x-4 gap-y-0.5">
                    {s.fax_number && <span>Fax: <strong>{s.fax_number}</strong></span>}
                    {s.phone && <span>Phone: {s.phone}</span>}
                    {s.address && <span>{s.address}</span>}
                  </div>
                  {s.notes && <div className="text-[12px] text-[#1A1A2E]/60 mt-1 whitespace-pre-wrap">{s.notes}</div>}
                  {!s.fax_number && (
                    <div className="text-[11px] text-[#8A4B00] bg-[#FFF4E5] border border-[#F5D5A6] rounded px-2 py-1 inline-block mt-2">
                      ⚠ No fax on file — referrals to this specialist will fail
                    </div>
                  )}
                </div>
                {s.is_active && (
                  <div className="flex gap-1 flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button onClick={() => startEdit(s)} className="p-1.5 text-[#1A1A2E]/60 hover:text-[#7F77DD]" title="Edit">
                      <Pencil size={13} />
                    </button>
                    <button onClick={() => handleArchive(s)} className="p-1.5 text-[#1A1A2E]/60 hover:text-[#991B1B]" title="Archive">
                      <Trash2 size={13} />
                    </button>
                  </div>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
