import { useEffect, useState } from 'react'
import { AlertCircle, CheckCircle2, Phone, Plus, X } from 'lucide-react'
import { getAllPcps, updatePcp, addPcp } from '../../lib/api'
import { Button } from '../../components/ui/Button'
import { Input } from '../../components/ui/Input'

export function AdminPcps() {
  const [pcps, setPcps] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editFax, setEditFax] = useState('')
  const [editName, setEditName] = useState('')
  const [saving, setSaving] = useState(false)
  const [showAdd, setShowAdd] = useState(false)
  const [newName, setNewName] = useState('')
  const [newFax, setNewFax] = useState('')
  const [adding, setAdding] = useState(false)

  useEffect(() => { load() }, [])

  async function load() {
    setLoading(true)
    try { setPcps(await getAllPcps()) } finally { setLoading(false) }
  }

  function startEdit(p: any) {
    setEditingId(p.id)
    setEditFax(p.fax_number || '')
    setEditName(p.name || '')
  }

  async function save(id: string) {
    setSaving(true)
    try {
      const updated = await updatePcp(id, { name: editName.trim() || undefined, fax_number: editFax.trim() || undefined })
      setPcps(prev => prev.map(p => p.id === id ? { ...p, ...updated } : p))
      setEditingId(null)
    } finally { setSaving(false) }
  }

  async function handleAdd() {
    if (!newName.trim()) return
    setAdding(true)
    try {
      const row = await addPcp({ name: newName.trim(), fax_number: newFax.trim() || undefined })
      setPcps(prev => [row, ...prev])
      setNewName('')
      setNewFax('')
      setShowAdd(false)
    } finally { setAdding(false) }
  }

  async function toggleActive(p: any) {
    const updated = await updatePcp(p.id, { is_active: !p.is_active })
    setPcps(prev => prev.map(x => x.id === p.id ? { ...x, ...updated } : x))
  }

  const missing = pcps.filter(p => p.is_active && !p.fax_number)
  const hasFax  = pcps.filter(p => p.is_active && p.fax_number)
  const inactive = pcps.filter(p => !p.is_active)

  return (
    <div className="p-6 max-w-3xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-[22px] font-display font-semibold text-[#1A1A2E]">PCP Directory</h1>
          <p className="text-[13px] text-[#999] mt-0.5">
            {missing.length > 0
              ? <span className="text-[#D97706] font-medium">{missing.length} practice{missing.length !== 1 ? 's' : ''} missing a fax number</span>
              : <span className="text-[#1D9E75]">All active practices have fax numbers</span>}
          </p>
        </div>
        <Button size="sm" onClick={() => setShowAdd(v => !v)}>
          <Plus size={14} /> Add practice
        </Button>
      </div>

      {showAdd && (
        <div className="border border-[#E8E8E4] rounded-xl p-4 bg-white mb-5 space-y-3">
          <p className="text-[12px] font-semibold text-[#1A1A2E] uppercase tracking-wider">New practice</p>
          <div className="grid grid-cols-2 gap-3">
            <Input label="Practice name" placeholder="Growing Up Pediatrics" value={newName} onChange={e => setNewName(e.target.value)} />
            <Input label="Fax number" placeholder="704-555-0100" value={newFax} onChange={e => setNewFax(e.target.value)} />
          </div>
          <div className="flex gap-2 justify-end">
            <button onClick={() => setShowAdd(false)} className="text-[13px] text-[#999] hover:text-[#555] px-3 py-1.5">Cancel</button>
            <Button size="sm" loading={adding} onClick={handleAdd}>Add</Button>
          </div>
        </div>
      )}

      {loading ? (
        <div className="text-[13px] text-[#999] text-center py-12">Loading…</div>
      ) : (
        <div className="space-y-6">
          {missing.length > 0 && (
            <section>
              <div className="flex items-center gap-2 mb-2">
                <AlertCircle size={14} className="text-[#D97706]" />
                <h2 className="text-[12px] font-semibold text-[#D97706] uppercase tracking-wider">Missing fax number ({missing.length})</h2>
              </div>
              <div className="border border-[#FDE68A] rounded-xl overflow-hidden">
                {missing.map((p, i) => (
                  <PcpRow key={p.id} p={p} editing={editingId === p.id} editFax={editFax} editName={editName}
                    onEditFax={setEditFax} onEditName={setEditName} onStart={() => startEdit(p)}
                    onSave={() => save(p.id)} onCancel={() => setEditingId(null)} saving={saving}
                    onToggleActive={() => toggleActive(p)}
                    border={i < missing.length - 1} />
                ))}
              </div>
            </section>
          )}

          {hasFax.length > 0 && (
            <section>
              <div className="flex items-center gap-2 mb-2">
                <CheckCircle2 size={14} className="text-[#1D9E75]" />
                <h2 className="text-[12px] font-semibold text-[#1D9E75] uppercase tracking-wider">Fax on file ({hasFax.length})</h2>
              </div>
              <div className="border border-[#E8E8E4] rounded-xl overflow-hidden">
                {hasFax.map((p, i) => (
                  <PcpRow key={p.id} p={p} editing={editingId === p.id} editFax={editFax} editName={editName}
                    onEditFax={setEditFax} onEditName={setEditName} onStart={() => startEdit(p)}
                    onSave={() => save(p.id)} onCancel={() => setEditingId(null)} saving={saving}
                    onToggleActive={() => toggleActive(p)}
                    border={i < hasFax.length - 1} />
                ))}
              </div>
            </section>
          )}

          {inactive.length > 0 && (
            <section>
              <h2 className="text-[12px] font-semibold text-[#999] uppercase tracking-wider mb-2">Inactive ({inactive.length})</h2>
              <div className="border border-[#E8E8E4] rounded-xl overflow-hidden opacity-60">
                {inactive.map((p, i) => (
                  <PcpRow key={p.id} p={p} editing={editingId === p.id} editFax={editFax} editName={editName}
                    onEditFax={setEditFax} onEditName={setEditName} onStart={() => startEdit(p)}
                    onSave={() => save(p.id)} onCancel={() => setEditingId(null)} saving={saving}
                    onToggleActive={() => toggleActive(p)}
                    border={i < inactive.length - 1} />
                ))}
              </div>
            </section>
          )}
        </div>
      )}
    </div>
  )
}

function PcpRow({ p, editing, editFax, editName, onEditFax, onEditName, onStart, onSave, onCancel, saving, onToggleActive, border }: {
  p: any; editing: boolean; editFax: string; editName: string
  onEditFax: (v: string) => void; onEditName: (v: string) => void
  onStart: () => void; onSave: () => void; onCancel: () => void
  saving: boolean; onToggleActive: () => void; border: boolean
}) {
  return (
    <div className={`px-4 py-3 bg-white ${border ? 'border-b border-[#F1EFE8]' : ''}`}>
      {editing ? (
        <div className="space-y-2">
          <input value={editName} onChange={e => onEditName(e.target.value)}
            className="w-full px-3 py-2 border border-[#E8E8E4] rounded-lg text-[13px] font-medium outline-none focus:border-[#7F77DD]" />
          <div className="flex gap-2">
            <input value={editFax} onChange={e => onEditFax(e.target.value)}
              placeholder="e.g. 704-555-0100"
              className="flex-1 px-3 py-2 border border-[#E8E8E4] rounded-lg text-[13px] outline-none focus:border-[#7F77DD]" />
            <Button size="sm" loading={saving} onClick={onSave}>Save</Button>
            <button onClick={onCancel} className="p-2 text-[#999] hover:text-[#555]"><X size={14} /></button>
          </div>
        </div>
      ) : (
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <div className="text-[13px] font-medium text-[#1A1A2E] truncate">{p.name}</div>
            <div className="flex items-center gap-1.5 mt-0.5">
              {p.fax_number
                ? <><Phone size={11} className="text-[#999]" /><span className="text-[12px] text-[#777]">{p.fax_number}</span></>
                : <span className="text-[12px] text-[#D97706] font-medium">No fax number</span>
              }
              {p.patient_count > 0 && (
                <span className="text-[11px] text-[#bbb] ml-2">{p.patient_count} patient{p.patient_count !== 1 ? 's' : ''}</span>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <button onClick={onStart} className="text-[12px] text-[#7F77DD] hover:underline">Edit</button>
            <button onClick={onToggleActive} className="text-[12px] text-[#999] hover:text-[#555]">
              {p.is_active ? 'Deactivate' : 'Reactivate'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
