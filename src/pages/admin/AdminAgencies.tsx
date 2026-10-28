import { useEffect, useState } from 'react'
import { Building2, Plus, Pencil, Trash2, Check, Link as LinkIcon, Copy } from 'lucide-react'
import { Button } from '../../components/ui/Button'
import { getAgencies, createAgency, updateAgency, deactivateAgency, type Agency } from '../../lib/api'

const inputCls = 'w-full px-3 py-2 border border-[#E8E8E4] rounded-lg text-[13px] outline-none focus:border-[#7F77DD]'
const labelCls = 'block text-[11px] font-medium text-[#1A1A2E] mb-1'

type FormState = {
  name: string
  contact_name: string
  phone: string
  email: string
  fax: string
  address: string
  notes: string
}
const emptyForm: FormState = { name: '', contact_name: '', phone: '', email: '', fax: '', address: '', notes: '' }

export function AdminAgencies() {
  const [agencies, setAgencies] = useState<Agency[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null) // null = closed, '' = adding new, else = editing by id
  const [form, setForm] = useState<FormState>(emptyForm)
  const [submitting, setSubmitting] = useState(false)
  const [showInactive, setShowInactive] = useState(false)

  async function refresh() {
    setLoading(true); setError(null)
    try {
      const rows = await getAgencies()
      setAgencies(rows ?? [])
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load agencies')
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { refresh() }, [])

  function startAdd() {
    setForm(emptyForm)
    setEditingId('')
  }
  function startEdit(a: Agency) {
    setForm({
      name: a.name,
      contact_name: a.contact_name ?? '',
      phone: a.phone ?? '',
      email: a.email ?? '',
      fax: a.fax ?? '',
      address: a.address ?? '',
      notes: a.notes ?? '',
    })
    setEditingId(a.id)
  }
  function cancel() { setEditingId(null); setError(null) }

  async function save() {
    if (!form.name.trim()) { setError('Name is required'); return }
    setSubmitting(true); setError(null)
    try {
      const payload: Partial<Agency> = {
        name: form.name.trim(),
        contact_name: form.contact_name.trim() || null,
        phone: form.phone.trim() || null,
        email: form.email.trim() || null,
        fax: form.fax.trim() || null,
        address: form.address.trim() || null,
        notes: form.notes.trim() || null,
      }
      if (editingId === '') await createAgency(payload)
      else if (editingId) await updateAgency(editingId, payload)
      setEditingId(null)
      await refresh()
    } catch (e: any) {
      setError(e?.message ?? 'Save failed')
    } finally {
      setSubmitting(false)
    }
  }

  async function remove(a: Agency) {
    if (!window.confirm(`Deactivate "${a.name}"? Existing referrals will still show the agency name, but it will stop accepting new submissions.`)) return
    try { await deactivateAgency(a.id); await refresh() }
    catch (e: any) { setError(e?.message ?? 'Deactivate failed') }
  }

  const visible = agencies.filter(a => showInactive || a.is_active)

  async function copyUrl(slug: string) {
    const url = `${window.location.origin}/referral/agency/${slug}`
    try { await navigator.clipboard.writeText(url); alert(`Copied:\n${url}`) }
    catch { prompt('Copy this URL:', url) }
  }

  return (
    <div className="p-6 md:p-8 max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-2">
          <Building2 size={20} className="text-[#7F77DD]" />
          <h1 className="font-display text-[22px] font-medium text-[#1A1A2E]">Referral partners</h1>
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-1.5 text-[12px] text-[#1A1A2E]/70 cursor-pointer">
            <input type="checkbox" checked={showInactive} onChange={e => setShowInactive(e.target.checked)} />
            Show deactivated
          </label>
          {editingId === null && (
            <Button variant="teal" size="sm" onClick={startAdd}>
              <Plus size={13} /> Add agency
            </Button>
          )}
        </div>
      </div>

      <p className="text-[12px] text-[#1A1A2E]/60 -mt-2 mb-5">
        Home-care agencies that refer patients to us. Each agency gets its own QR-coded intake URL. Patient charts stay under this practice.
      </p>

      {error && (
        <div className="mb-4 bg-[#FEF2F2] border border-[#EF4444]/30 text-[#B91C1C] rounded-xl p-3 text-[13px]">{error}</div>
      )}

      {editingId !== null && (
        <div className="bg-white border border-[#7F77DD] rounded-xl p-5 shadow-sm mb-4 space-y-3">
          <div className="font-medium text-[14px] text-[#1A1A2E]">{editingId === '' ? 'New agency' : 'Edit agency'}</div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <label className={labelCls}>Name *</label>
              <input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} className={inputCls} placeholder="Pediatric Partners Home Care" />
            </div>
            <div>
              <label className={labelCls}>Contact person</label>
              <input value={form.contact_name} onChange={e => setForm({ ...form, contact_name: e.target.value })} className={inputCls} placeholder="Jane Doe, RN — DON" />
            </div>
            <div>
              <label className={labelCls}>Phone</label>
              <input value={form.phone} onChange={e => setForm({ ...form, phone: e.target.value })} className={inputCls} placeholder="704-555-0199" />
            </div>
            <div>
              <label className={labelCls}>Email</label>
              <input value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} className={inputCls} placeholder="intake@agency.com" />
            </div>
            <div>
              <label className={labelCls}>Fax (for note-back)</label>
              <input value={form.fax} onChange={e => setForm({ ...form, fax: e.target.value })} className={inputCls} placeholder="704-555-0188" />
            </div>
            <div>
              <label className={labelCls}>Address</label>
              <input value={form.address} onChange={e => setForm({ ...form, address: e.target.value })} className={inputCls} />
            </div>
          </div>
          <div>
            <label className={labelCls}>Notes (internal)</label>
            <textarea value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} rows={2} className={inputCls} />
          </div>
          <div className="flex items-center justify-end gap-2">
            <Button variant="secondary" size="sm" onClick={cancel}>Cancel</Button>
            <Button variant="teal" size="sm" loading={submitting} onClick={save}>
              <Check size={12} /> Save
            </Button>
          </div>
        </div>
      )}

      {loading ? (
        <div className="text-center text-[#1A1A2E]/50 py-12 text-[13px]">Loading…</div>
      ) : visible.length === 0 ? (
        <div className="bg-white border border-[#E8E8E4] rounded-xl p-12 text-center text-[#1A1A2E]/50 text-[13px]">
          No {showInactive ? '' : 'active '}agencies yet. Click <strong className="text-[#1A1A2E]">Add agency</strong> to create one.
        </div>
      ) : (
        <ul className="space-y-3">
          {visible.map(a => (
            <li key={a.id} className={`bg-white border rounded-xl p-4 ${a.is_active ? 'border-[#E8E8E4]' : 'border-[#E8E8E4] opacity-60'}`}>
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-display text-[15px] font-medium text-[#1A1A2E]">{a.name}</span>
                    {!a.is_active && <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-[#F3F4F6] text-[#374151]">INACTIVE</span>}
                  </div>
                  <div className="text-[12px] text-[#1A1A2E]/70 mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
                    {a.contact_name && <span>{a.contact_name}</span>}
                    {a.phone && <span>☎ {a.phone}</span>}
                    {a.email && <span>✉ {a.email}</span>}
                    {a.fax && <span>Fax {a.fax}</span>}
                  </div>
                  {a.is_active && (
                    <button
                      onClick={() => copyUrl(a.slug)}
                      className="mt-2 inline-flex items-center gap-1.5 text-[11px] text-[#7F77DD] hover:text-[#5F58B8]"
                      title="Copy referral URL"
                    >
                      <LinkIcon size={11} /> /referral/agency/{a.slug}
                      <Copy size={10} className="opacity-60" />
                    </button>
                  )}
                </div>
                <div className="flex gap-1 flex-shrink-0">
                  <button onClick={() => startEdit(a)} className="p-1.5 rounded-lg hover:bg-[#F1EFE8] text-[#1A1A2E]/60 hover:text-[#7F77DD]" title="Edit"><Pencil size={13} /></button>
                  {a.is_active && (
                    <button onClick={() => remove(a)} className="p-1.5 rounded-lg hover:bg-[#FCEBEB] text-[#1A1A2E]/60 hover:text-[#991B1B]" title="Deactivate"><Trash2 size={13} /></button>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
