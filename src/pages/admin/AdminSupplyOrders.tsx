import { useEffect, useState } from 'react'
import { Package, Plus, Loader2, CheckCircle2, X, Pencil, Trash2, RefreshCw, Truck, PackageCheck, AlertCircle } from 'lucide-react'
import { format } from 'date-fns'
import {
  getSupplies, createSupply, updateSupply, archiveSupply,
  getSupplyRequests, supplyRequestAction,
  type Supply, type SupplyRequest,
} from '../../lib/api'

// Admin page for managing the supplies catalog + processing provider
// requests. Two tabs:
//   1. Queue — pending/in-flight requests across all providers.
//   2. Catalog — CRUD for the supplies catalog (Pam seeds items here).
//
// Sara 2026-11-19.

function fmtDate(d: string | null | undefined) {
  if (!d) return '—'
  try { return format(new Date(d), 'MMM d, h:mm a') } catch { return d }
}

const STATUS_PILL: Record<string, { label: string; cls: string }> = {
  requested: { label: 'Requested',  cls: 'bg-[#FEF3C7] text-[#78350F]' },
  ordered:   { label: 'Ordered',    cls: 'bg-[#DBEAFE] text-[#1E3A8A]' },
  shipped:   { label: 'Shipped',    cls: 'bg-[#EEEDFE] text-[#3C3489]' },
  received:  { label: 'Received',   cls: 'bg-[#DCFCE7] text-[#166534]' },
  cancelled: { label: 'Cancelled',  cls: 'bg-[#F3F4F6] text-[#555]' },
}

export function AdminSupplyOrders() {
  const [tab, setTab] = useState<'queue' | 'catalog'>('queue')

  return (
    <div>
      <div className="bg-white border-b border-[#E8E8E4] px-6 py-4 sticky top-0 z-10">
        <div className="flex items-center gap-2 mb-1">
          <Package size={18} className="text-[#7F77DD]" />
          <div className="font-display text-[18px] font-medium text-[#1A1A2E]">Supply orders</div>
        </div>
        <div className="text-[12px] text-[#555]">Replaces the monthly Google Form. Pam seeds the catalog and processes requests here.</div>
        <div className="flex items-center gap-1 border-b border-transparent mt-3 -mb-4">
          {(['queue','catalog'] as const).map(t => (
            <button key={t} onClick={() => setTab(t)}
              className={`px-4 py-2 text-[13px] font-medium border-b-2 ${tab === t ? 'border-[#7F77DD] text-[#1A1A2E]' : 'border-transparent text-[#555] hover:text-[#1A1A2E]'}`}>
              {t === 'queue' ? 'Queue' : 'Catalog'}
            </button>
          ))}
        </div>
      </div>
      <div className="p-6 max-w-5xl">
        {tab === 'queue' ? <QueueTab /> : <CatalogTab />}
      </div>
    </div>
  )
}

function QueueTab() {
  const [rows, setRows] = useState<SupplyRequest[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [actingOn, setActingOn] = useState<string | null>(null)

  async function load() {
    setLoading(true); setErr(null)
    try {
      const data = await getSupplyRequests({ scope: 'all', status: 'open' })
      setRows(data)
    } catch (e: any) { setErr(e?.message ?? 'Failed to load queue') }
    finally { setLoading(false) }
  }
  useEffect(() => { void load() }, [])

  async function act(id: string, action: 'mark_ordered' | 'mark_shipped' | 'mark_received' | 'cancel') {
    setActingOn(id); setErr(null)
    try {
      await supplyRequestAction(id, { action })
      await load()
    } catch (e: any) { setErr(e?.message ?? 'Action failed') }
    finally { setActingOn(null) }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-[13px] text-[#555]">{loading ? 'Loading…' : `${rows.length} open request${rows.length === 1 ? '' : 's'}`}</div>
        <button onClick={load} disabled={loading}
          className="inline-flex items-center gap-1 text-[12px] text-[#555] border border-[#E8E8E4] rounded-lg px-2.5 py-1 bg-white hover:bg-[#F1EFE8] disabled:opacity-50">
          <RefreshCw size={12} className={loading ? 'animate-spin' : ''} /> Refresh
        </button>
      </div>
      {err && <div className="flex items-start gap-2 text-[12px] text-[#991B1B] bg-[#FCEBEB] border border-[#F5C6C6] px-3 py-2 rounded-lg"><AlertCircle size={14} className="mt-0.5 flex-shrink-0" /> {err}</div>}
      {!loading && rows.length === 0 && (
        <div className="rounded-xl border border-dashed border-[#E8E8E4] bg-[#FAFAF8] px-6 py-10 text-center">
          <Package size={28} className="mx-auto text-[#7F77DD] mb-2 opacity-70" />
          <div className="text-[14px] font-medium text-[#1A1A2E] mb-1">No open requests.</div>
          <div className="text-[12px] text-[#555]">When providers submit requests they'll show up here.</div>
        </div>
      )}
      {rows.map(r => {
        const pill = STATUS_PILL[r.status] ?? STATUS_PILL.requested
        const busy = actingOn === r.id
        return (
          <div key={r.id} className="bg-white border border-[#E8E8E4] rounded-xl p-4">
            <div className="flex items-start justify-between gap-3 flex-wrap">
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap mb-1">
                  <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold ${pill.cls}`}>{pill.label}</span>
                  <span className="text-[13px] font-medium text-[#1A1A2E]">{r.provider_name}</span>
                  <span className="text-[11px] text-[#777]">· {fmtDate(r.requested_at)}</span>
                </div>
                {r.shipping_address && (
                  <div className="text-[12px] text-[#555] mt-0.5"><strong className="text-[#1A1A2E]">Ship to:</strong> {r.shipping_address}</div>
                )}
                {r.notes && <div className="text-[12px] text-[#555] mt-0.5 italic">Note: {r.notes}</div>}
                <div className="mt-2 border-t border-[#F1EFE8] pt-2">
                  <table className="w-full text-[12px]">
                    <tbody className="divide-y divide-[#F1EFE8]">
                      {r.items.map(it => (
                        <tr key={it.id}>
                          <td className="py-1.5 text-[#1A1A2E] font-medium">{it.supply_name}</td>
                          <td className="py-1.5 text-[#555] text-right tabular-nums">× {it.quantity}{it.unit_label ? ` (${it.unit_label})` : ''}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
              <div className="flex flex-col gap-1.5 flex-shrink-0">
                {r.status === 'requested' && (
                  <button onClick={() => act(r.id, 'mark_ordered')} disabled={busy}
                    className="inline-flex items-center gap-1 px-2.5 py-1 text-[12px] font-medium text-white bg-[#1A1A2E] rounded-lg hover:bg-[#333] disabled:opacity-50">
                    <CheckCircle2 size={12} /> Mark ordered
                  </button>
                )}
                {(r.status === 'requested' || r.status === 'ordered') && (
                  <button onClick={() => act(r.id, 'mark_shipped')} disabled={busy}
                    className="inline-flex items-center gap-1 px-2.5 py-1 text-[12px] font-medium text-white bg-[#7F77DD] rounded-lg hover:bg-[#6B64C8] disabled:opacity-50">
                    <Truck size={12} /> Mark shipped
                  </button>
                )}
                {r.status === 'shipped' && (
                  <button onClick={() => act(r.id, 'mark_received')} disabled={busy}
                    className="inline-flex items-center gap-1 px-2.5 py-1 text-[12px] font-medium text-white bg-[#1D9E75] rounded-lg hover:bg-[#188960] disabled:opacity-50">
                    <PackageCheck size={12} /> Mark received
                  </button>
                )}
                <button onClick={() => act(r.id, 'cancel')} disabled={busy}
                  className="inline-flex items-center gap-1 px-2.5 py-1 text-[12px] text-[#7F1D1D] border border-[#FDA4AF] rounded-lg hover:bg-[#FEE2E2] disabled:opacity-50">
                  <X size={12} /> Cancel
                </button>
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}

function CatalogTab() {
  const [rows, setRows] = useState<Supply[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [editing, setEditing] = useState<Supply | 'new' | null>(null)

  async function load() {
    setLoading(true); setErr(null)
    try { setRows(await getSupplies(true)) }
    catch (e: any) { setErr(e?.message ?? 'Failed to load catalog') }
    finally { setLoading(false) }
  }
  useEffect(() => { void load() }, [])

  async function doArchive(id: string) {
    if (!confirm('Archive this supply? It stays on historical requests but can no longer be ordered.')) return
    try { await archiveSupply(id); await load() }
    catch (e: any) { alert(e?.message ?? 'Archive failed') }
  }

  async function doUnarchive(s: Supply) {
    try { await updateSupply(s.id, { is_active: true }); await load() }
    catch (e: any) { alert(e?.message ?? 'Unarchive failed') }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-[13px] text-[#555]">{loading ? 'Loading…' : `${rows.filter(r => r.is_active).length} active, ${rows.filter(r => !r.is_active).length} archived`}</div>
        <button onClick={() => setEditing('new')}
          className="inline-flex items-center gap-1 px-3 py-1.5 text-[12px] font-medium text-white bg-[#7F77DD] rounded-lg hover:bg-[#6B64C8]">
          <Plus size={13} /> Add supply
        </button>
      </div>
      {err && <div className="text-[12px] text-[#991B1B]">{err}</div>}

      {editing && (
        <SupplyEditor
          initial={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={async () => { setEditing(null); await load() }}
        />
      )}

      <div className="bg-white border border-[#E8E8E4] rounded-xl overflow-hidden">
        <table className="w-full text-[12px]">
          <thead className="bg-[#FAFAF8] text-[10px] uppercase text-[#1A1A2E]/60">
            <tr>
              <th className="text-left px-3 py-2">Name</th>
              <th className="text-left px-3 py-2">Unit</th>
              <th className="text-left px-3 py-2">Default qty</th>
              <th className="text-left px-3 py-2">CPT</th>
              <th className="text-left px-3 py-2">Units/box</th>
              <th className="text-right px-3 py-2">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#F1EFE8]">
            {rows.map(s => (
              <tr key={s.id} className={s.is_active ? '' : 'opacity-50'}>
                <td className="px-3 py-2 text-[#1A1A2E] font-medium">
                  {s.name}
                  {s.description && <div className="text-[11px] text-[#555] font-normal">{s.description}</div>}
                </td>
                <td className="px-3 py-2 text-[#555]">{s.unit_label ?? '—'}</td>
                <td className="px-3 py-2 text-[#555]">{s.default_quantity}</td>
                <td className="px-3 py-2 font-mono text-[11px] text-[#3C3489]">{s.associated_cpt_code ?? '—'}</td>
                <td className="px-3 py-2 text-[#555]">{s.units_per_box ?? '—'}</td>
                <td className="px-3 py-2 text-right">
                  <div className="inline-flex items-center gap-1">
                    <button onClick={() => setEditing(s)} className="p-1.5 rounded hover:bg-[#F1EFE8] text-[#555]"><Pencil size={12} /></button>
                    {s.is_active
                      ? <button onClick={() => doArchive(s.id)} className="p-1.5 rounded hover:bg-[#FEE2E2] text-[#7F1D1D]"><Trash2 size={12} /></button>
                      : <button onClick={() => doUnarchive(s)} className="text-[11px] text-[#7F77DD] hover:underline px-2">Unarchive</button>}
                  </div>
                </td>
              </tr>
            ))}
            {!loading && rows.length === 0 && (
              <tr><td colSpan={6} className="px-3 py-10 text-center text-[#555]">Catalog is empty. Click "Add supply" to seed the first item.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function SupplyEditor(props: { initial: Supply | null; onClose: () => void; onSaved: () => void }) {
  const isNew = !props.initial
  const [name, setName] = useState(props.initial?.name ?? '')
  const [unitLabel, setUnitLabel] = useState(props.initial?.unit_label ?? '')
  const [description, setDescription] = useState(props.initial?.description ?? '')
  const [defaultQty, setDefaultQty] = useState(String(props.initial?.default_quantity ?? 1))
  const [cpt, setCpt] = useState(props.initial?.associated_cpt_code ?? '')
  const [unitsPerBox, setUnitsPerBox] = useState(props.initial?.units_per_box != null ? String(props.initial.units_per_box) : '')
  const [sortOrder, setSortOrder] = useState(String(props.initial?.sort_order ?? 100))
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function save() {
    setErr(null)
    if (!name.trim()) { setErr('Name required'); return }
    setBusy(true)
    const payload: Partial<Supply> = {
      name: name.trim(),
      unit_label: unitLabel.trim() || null,
      description: description.trim() || null,
      default_quantity: Math.max(1, Number(defaultQty) | 0),
      associated_cpt_code: cpt.trim() || null,
      units_per_box: unitsPerBox.trim() ? (Number(unitsPerBox) | 0) : null,
      sort_order: Number(sortOrder) | 0,
    }
    try {
      if (isNew) await createSupply(payload)
      else      await updateSupply(props.initial!.id, payload)
      props.onSaved()
    } catch (e: any) { setErr(e?.message ?? 'Save failed') }
    finally { setBusy(false) }
  }

  return (
    <div className="bg-white border border-[#7F77DD] rounded-xl p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-[14px] font-medium text-[#1A1A2E]">{isNew ? 'Add supply' : `Edit: ${props.initial?.name}`}</div>
        <button onClick={props.onClose} className="text-[#555] hover:text-[#1A1A2E]"><X size={16} /></button>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Name"><input value={name} onChange={e => setName(e.target.value)} className="w-full px-3 py-2 text-[13px] border border-[#E8E8E4] rounded-lg bg-white outline-none focus:border-[#7F77DD]" /></Field>
        <Field label="Unit label (e.g. “box of 25”)"><input value={unitLabel} onChange={e => setUnitLabel(e.target.value)} className="w-full px-3 py-2 text-[13px] border border-[#E8E8E4] rounded-lg bg-white outline-none focus:border-[#7F77DD]" /></Field>
      </div>
      <Field label="Description (optional)">
        <textarea value={description} onChange={e => setDescription(e.target.value)} rows={2}
          className="w-full px-3 py-2 text-[13px] border border-[#E8E8E4] rounded-lg bg-white outline-none focus:border-[#7F77DD] resize-y" />
      </Field>
      <div className="grid grid-cols-3 gap-3">
        <Field label="Default qty"><input value={defaultQty} onChange={e => setDefaultQty(e.target.value.replace(/\D/g,''))} className="w-full px-3 py-2 text-[13px] font-mono border border-[#E8E8E4] rounded-lg" /></Field>
        <Field label="CPT (Phase 2)"><input value={cpt} onChange={e => setCpt(e.target.value)} placeholder="e.g. 87880" className="w-full px-3 py-2 text-[13px] font-mono border border-[#E8E8E4] rounded-lg" /></Field>
        <Field label="Units per box"><input value={unitsPerBox} onChange={e => setUnitsPerBox(e.target.value.replace(/\D/g,''))} placeholder="e.g. 25" className="w-full px-3 py-2 text-[13px] font-mono border border-[#E8E8E4] rounded-lg" /></Field>
      </div>
      <Field label="Sort order (lower = earlier)">
        <input value={sortOrder} onChange={e => setSortOrder(e.target.value.replace(/\D/g,''))} className="w-full px-3 py-2 text-[13px] font-mono border border-[#E8E8E4] rounded-lg" />
      </Field>
      {err && <div className="text-[12px] text-[#991B1B]">{err}</div>}
      <div className="flex justify-end gap-2">
        <button onClick={props.onClose} className="px-3 py-1.5 text-[13px] text-[#555] border border-[#E8E8E4] rounded-lg hover:bg-[#F1EFE8]">Cancel</button>
        <button onClick={save} disabled={busy} className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[13px] font-medium text-white bg-[#7F77DD] rounded-lg hover:bg-[#6B64C8] disabled:opacity-50">
          {busy && <Loader2 size={12} className="animate-spin" />} Save
        </button>
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="text-[11px] font-semibold text-[#1A1A2E] uppercase tracking-wider block mb-1">{label}</label>
      {children}
    </div>
  )
}
