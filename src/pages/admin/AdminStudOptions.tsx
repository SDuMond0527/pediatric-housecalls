import { useEffect, useRef, useState } from 'react'
import { Gem, Plus, Pencil, Trash2, Check, Upload } from 'lucide-react'
import { Button } from '../../components/ui/Button'
import {
  getStudOptions, createStudOption, updateStudOption, deactivateStudOption, uploadStudOptionPhoto,
  type StudOption,
} from '../../lib/api'

const inputCls = 'w-full px-3 py-2 border border-[#E8E8E4] rounded-lg text-[13px] outline-none focus:border-[#7F77DD]'
const labelCls = 'block text-[11px] font-medium text-[#1A1A2E] mb-1'

type FormState = { name: string; photo_url: string; price: string; sort_order: string }
const emptyForm: FormState = { name: '', photo_url: '', price: '100', sort_order: '0' }

export function AdminStudOptions() {
  const [options, setOptions] = useState<StudOption[]>([])
  const [loading, setLoading] = useState(true)
  const [editingId, setEditingId] = useState<string | null>(null) // null=closed, ''=new, else=edit
  const [form, setForm] = useState<FormState>(emptyForm)
  const [uploading, setUploading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showInactive, setShowInactive] = useState(false)
  const fileRef = useRef<HTMLInputElement | null>(null)

  async function refresh() {
    setLoading(true); setError(null)
    try { setOptions(await getStudOptions()) }
    catch (e: any) { setError(e?.message ?? 'Failed to load') }
    finally { setLoading(false) }
  }
  useEffect(() => { refresh() }, [])

  function startAdd() { setForm(emptyForm); setEditingId('') }
  function startEdit(o: StudOption) {
    setForm({ name: o.name, photo_url: o.photo_url, price: String(o.price), sort_order: String(o.sort_order ?? 0) })
    setEditingId(o.id)
  }
  function cancel() { setEditingId(null); setError(null) }

  async function handlePhoto(file: File) {
    setUploading(true); setError(null)
    try {
      const url = await uploadStudOptionPhoto(file)
      setForm(f => ({ ...f, photo_url: url }))
    } catch (e: any) { setError(e?.message ?? 'Photo upload failed') }
    finally { setUploading(false) }
  }

  async function save() {
    if (!form.name.trim())   { setError('Name is required'); return }
    if (!form.photo_url)     { setError('Photo is required'); return }
    setSaving(true); setError(null)
    try {
      const payload = {
        name: form.name.trim(),
        photo_url: form.photo_url,
        price: Number(form.price) || 100,
        sort_order: parseInt(form.sort_order, 10) || 0,
      }
      if (editingId === '') await createStudOption(payload)
      else if (editingId)   await updateStudOption(editingId, payload)
      setEditingId(null); await refresh()
    } catch (e: any) { setError(e?.message ?? 'Save failed') }
    finally { setSaving(false) }
  }

  async function remove(o: StudOption) {
    if (!window.confirm(`Deactivate "${o.name}"? Parents will stop seeing it; existing bookings keep the record.`)) return
    try { await deactivateStudOption(o.id); await refresh() }
    catch (e: any) { setError(e?.message ?? 'Delete failed') }
  }

  const visible = options.filter(o => showInactive || o.is_active !== false)

  return (
    <div className="p-6 md:p-8 max-w-4xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-2">
          <Gem size={20} className="text-[#7F77DD]" />
          <h1 className="font-display text-[22px] font-medium text-[#1A1A2E]">Stud options</h1>
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-1.5 text-[12px] text-[#1A1A2E]/70 cursor-pointer">
            <input type="checkbox" checked={showInactive} onChange={e => setShowInactive(e.target.checked)} /> Show deactivated
          </label>
          {editingId === null && (
            <Button variant="teal" size="sm" onClick={startAdd}><Plus size={13} /> Add option</Button>
          )}
        </div>
      </div>

      <p className="text-[12px] text-[#1A1A2E]/60 -mt-2 mb-5">
        Extra stud styles parents can pick as an add-on when booking an in-home ear piercing visit. Each option is $100 by default.
      </p>

      {error && <div className="mb-4 bg-[#FEF2F2] border border-[#EF4444]/30 text-[#B91C1C] rounded-xl p-3 text-[13px]">{error}</div>}

      {editingId !== null && (
        <div className="bg-white border border-[#7F77DD] rounded-xl p-5 shadow-sm mb-4 space-y-3">
          <div className="font-medium text-[14px] text-[#1A1A2E]">{editingId === '' ? 'New stud option' : 'Edit stud option'}</div>
          <div>
            <label className={labelCls}>Photo</label>
            {form.photo_url ? (
              <div className="flex items-center gap-3">
                <img src={form.photo_url} alt="" className="w-24 h-24 object-cover rounded border border-[#E8E8E4]" />
                <Button variant="secondary" size="sm" onClick={() => setForm(f => ({ ...f, photo_url: '' }))}>Replace</Button>
              </div>
            ) : (
              <>
                <input ref={fileRef} type="file" accept="image/*" hidden
                  onChange={e => { const f = e.target.files?.[0]; if (f) handlePhoto(f); if (e.target) e.target.value = '' }} />
                <Button variant="secondary" size="sm" onClick={() => fileRef.current?.click()} loading={uploading}>
                  <Upload size={13} /> Upload photo
                </Button>
              </>
            )}
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div className="md:col-span-2">
              <label className={labelCls}>Name</label>
              <input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} className={inputCls} placeholder="e.g. Classic titanium ball" />
            </div>
            <div>
              <label className={labelCls}>Price ($)</label>
              <input value={form.price} onChange={e => setForm({ ...form, price: e.target.value.replace(/[^\d.]/g, '') })} className={inputCls} />
            </div>
          </div>
          <div className="flex items-center justify-end gap-2">
            <Button variant="secondary" size="sm" onClick={cancel}>Cancel</Button>
            <Button variant="teal" size="sm" loading={saving} onClick={save}><Check size={12} /> Save</Button>
          </div>
        </div>
      )}

      {loading ? (
        <div className="text-center text-[#1A1A2E]/50 py-12 text-[13px]">Loading…</div>
      ) : visible.length === 0 ? (
        <div className="bg-white border border-[#E8E8E4] rounded-xl p-12 text-center text-[#1A1A2E]/50 text-[13px]">
          No {showInactive ? '' : 'active '}stud options yet. Click <strong className="text-[#1A1A2E]">Add option</strong> to create one.
        </div>
      ) : (
        <ul className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4">
          {visible.map(o => (
            <li key={o.id} className={`bg-white border border-[#E8E8E4] rounded-xl p-3 ${o.is_active === false ? 'opacity-60' : ''}`}>
              <img src={o.photo_url} alt={o.name} className="w-full aspect-square object-cover rounded-lg mb-3" />
              <div className="flex items-start justify-between gap-2 mb-1">
                <div className="font-medium text-[14px] text-[#1A1A2E]">{o.name}</div>
                <div className="text-[13px] text-[#1A1A2E]/70 flex-shrink-0">${Number(o.price).toFixed(0)}</div>
              </div>
              <div className="flex gap-1 justify-end">
                <button onClick={() => startEdit(o)} className="p-1.5 rounded-lg hover:bg-[#F1EFE8] text-[#1A1A2E]/60 hover:text-[#7F77DD]" title="Edit"><Pencil size={13} /></button>
                {o.is_active !== false && (
                  <button onClick={() => remove(o)} className="p-1.5 rounded-lg hover:bg-[#FCEBEB] text-[#1A1A2E]/60 hover:text-[#991B1B]" title="Deactivate"><Trash2 size={13} /></button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
