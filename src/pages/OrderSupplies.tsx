import { useEffect, useState } from 'react'
import { Package, Loader2, CheckCircle2, X, AlertCircle, PackageCheck } from 'lucide-react'
import { format } from 'date-fns'
import {
  getSupplies, getSupplyRequests, createSupplyRequest, supplyRequestAction,
  type Supply, type SupplyRequest,
} from '../lib/api'
import { useAuth } from '../contexts/AuthContext'

// Provider-facing "Order supplies" page. Catalog on the left/top,
// pick quantities + ship-to on the right/bottom, submit → request
// goes to admin queue. Shows this provider's recent order history
// underneath.
//
// Gated behind practice setting providers_can_order_supplies — the
// route is only added to App.tsx when that flag is true.
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

export function OrderSupplies() {
  const { provider } = useAuth()
  const [catalog, setCatalog] = useState<Supply[]>([])
  const [history, setHistory] = useState<SupplyRequest[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)

  // Per-supply picked quantity (0 = not requested).
  const [picked, setPicked] = useState<Record<string, number>>({})
  const [shippingAddress, setShippingAddress] = useState<string>(((provider as any)?.home_address ?? '') as string)
  const [notes, setNotes] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [success, setSuccess] = useState(false)

  async function load() {
    setLoading(true); setErr(null)
    try {
      const [cs, rs] = await Promise.all([getSupplies(), getSupplyRequests({ scope: 'mine' })])
      setCatalog(cs); setHistory(rs)
    } catch (e: any) { setErr(e?.message ?? 'Failed to load') }
    finally { setLoading(false) }
  }
  useEffect(() => { void load() }, [])

  useEffect(() => {
    if (!shippingAddress && (provider as any)?.home_address) {
      setShippingAddress(((provider as any).home_address ?? '') as string)
    }
  }, [provider, shippingAddress])

  function setQty(supplyId: string, qty: number) {
    setPicked(prev => {
      const next = { ...prev }
      if (qty > 0) next[supplyId] = qty
      else delete next[supplyId]
      return next
    })
  }

  async function submit() {
    setErr(null); setSuccess(false)
    const items = Object.entries(picked).map(([supply_id, quantity]) => ({ supply_id, quantity }))
    if (items.length === 0) { setErr('Pick at least one item.'); return }
    if (!shippingAddress.trim()) { setErr('Shipping address required.'); return }
    setSubmitting(true)
    try {
      await createSupplyRequest({
        items,
        shipping_address: shippingAddress.trim(),
        notes: notes.trim() || undefined,
      })
      setPicked({}); setNotes(''); setSuccess(true)
      await load()
    } catch (e: any) { setErr(e?.message ?? 'Submit failed') }
    finally { setSubmitting(false) }
  }

  async function cancel(id: string) {
    if (!confirm('Cancel this request?')) return
    try { await supplyRequestAction(id, { action: 'cancel' }); await load() }
    catch (e: any) { alert(e?.message ?? 'Cancel failed') }
  }

  async function markReceived(id: string) {
    try { await supplyRequestAction(id, { action: 'mark_received' }); await load() }
    catch (e: any) { alert(e?.message ?? 'Action failed') }
  }

  const pickedCount = Object.keys(picked).length
  const totalItems = Object.values(picked).reduce((a, b) => a + b, 0)

  return (
    <div className="max-w-4xl mx-auto px-6 py-6 space-y-6">
      <div>
        <div className="flex items-center gap-2 mb-1">
          <Package size={22} className="text-[#7F77DD]" />
          <h1 className="font-display text-[22px] font-medium text-[#1A1A2E]">Order supplies</h1>
        </div>
        <div className="text-[13px] text-[#555]">Pick what you need, confirm your shipping address, and submit. Your admin fulfills from a central supplier.</div>
      </div>

      {err && <div className="flex items-start gap-2 text-[12px] text-[#991B1B] bg-[#FCEBEB] border border-[#F5C6C6] px-3 py-2 rounded-lg"><AlertCircle size={14} className="mt-0.5 flex-shrink-0" /> {err}</div>}
      {success && <div className="flex items-start gap-2 text-[12px] text-[#166534] bg-[#DCFCE7] border border-[#BBF7D0] px-3 py-2 rounded-lg"><CheckCircle2 size={14} className="mt-0.5 flex-shrink-0" /> Request submitted. It'll appear in the history below.</div>}

      {/* Catalog */}
      <div className="bg-white border border-[#E8E8E4] rounded-xl p-4">
        <div className="text-[13px] font-semibold text-[#1A1A2E] mb-2">Catalog</div>
        {loading && <div className="text-[13px] text-[#555] py-6 text-center"><Loader2 size={14} className="animate-spin inline mr-2" /> Loading…</div>}
        {!loading && catalog.length === 0 && <div className="text-[13px] text-[#555] py-6 text-center">No supplies in your practice catalog yet.</div>}
        <div className="space-y-1.5">
          {catalog.map(s => {
            const qty = picked[s.id] ?? 0
            return (
              <div key={s.id} className={`flex items-center gap-3 p-2 rounded-lg ${qty > 0 ? 'bg-[#F7F6FE] border border-[#D5D1F3]' : 'hover:bg-[#FAFAF8]'}`}>
                <div className="flex-1 min-w-0">
                  <div className="text-[13px] text-[#1A1A2E] font-medium">{s.name}</div>
                  {s.unit_label && <div className="text-[11px] text-[#555]">{s.unit_label}</div>}
                  {s.description && <div className="text-[11px] text-[#777] italic">{s.description}</div>}
                </div>
                <div className="flex items-center gap-1">
                  <button onClick={() => setQty(s.id, Math.max(0, qty - 1))}
                    className="w-7 h-7 rounded-lg border border-[#E8E8E4] bg-white hover:bg-[#F1EFE8] text-[#555] text-[13px]">−</button>
                  <input type="number" value={qty} min={0}
                    onChange={e => setQty(s.id, Math.max(0, Number(e.target.value) | 0))}
                    className="w-12 text-center px-1 py-1 text-[13px] font-mono border border-[#E8E8E4] rounded-lg bg-white" />
                  <button onClick={() => setQty(s.id, qty + 1)}
                    className="w-7 h-7 rounded-lg border border-[#E8E8E4] bg-white hover:bg-[#F1EFE8] text-[#555] text-[13px]">+</button>
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* Ship-to + submit */}
      {catalog.length > 0 && (
        <div className="bg-white border border-[#E8E8E4] rounded-xl p-4 space-y-3">
          <div>
            <label className="text-[11px] font-semibold text-[#1A1A2E] uppercase tracking-wider block mb-1">Ship to</label>
            <textarea value={shippingAddress} onChange={e => setShippingAddress(e.target.value)} rows={2}
              placeholder="Street, City, State, ZIP"
              className="w-full px-3 py-2 text-[13px] border border-[#E8E8E4] rounded-lg bg-white outline-none focus:border-[#7F77DD] resize-y" />
            <div className="text-[11px] text-[#555] mt-1">Prefilled from your profile's home address. Edit for this order only.</div>
          </div>
          <div>
            <label className="text-[11px] font-semibold text-[#1A1A2E] uppercase tracking-wider block mb-1">Notes for admin (optional)</label>
            <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={2}
              placeholder="Anything special? Size preferences, specific brand, etc."
              className="w-full px-3 py-2 text-[13px] border border-[#E8E8E4] rounded-lg bg-white outline-none focus:border-[#7F77DD] resize-y" />
          </div>
          <div className="flex items-center justify-between pt-1">
            <div className="text-[12px] text-[#555]">
              {pickedCount === 0 ? 'Pick at least one item.' : `${pickedCount} item${pickedCount === 1 ? '' : 's'} · ${totalItems} units total`}
            </div>
            <button onClick={submit} disabled={submitting || pickedCount === 0}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-[13px] font-medium text-white bg-[#7F77DD] rounded-lg hover:bg-[#6B64C8] disabled:opacity-50">
              {submitting && <Loader2 size={13} className="animate-spin" />} Submit request
            </button>
          </div>
        </div>
      )}

      {/* History */}
      <div>
        <div className="text-[13px] font-semibold text-[#1A1A2E] mb-2">Your recent orders</div>
        {history.length === 0 && <div className="text-[13px] text-[#555] bg-[#FAFAF8] border border-dashed border-[#E8E8E4] rounded-xl p-6 text-center">No orders yet.</div>}
        <div className="space-y-2">
          {history.map(r => {
            const pill = STATUS_PILL[r.status] ?? STATUS_PILL.requested
            return (
              <div key={r.id} className="bg-white border border-[#E8E8E4] rounded-xl p-3">
                <div className="flex items-center justify-between gap-3 flex-wrap mb-1">
                  <div className="flex items-center gap-2">
                    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold ${pill.cls}`}>{pill.label}</span>
                    <span className="text-[11px] text-[#777]">{fmtDate(r.requested_at)}</span>
                  </div>
                  <div className="flex items-center gap-1">
                    {r.status === 'requested' && (
                      <button onClick={() => cancel(r.id)} className="inline-flex items-center gap-1 text-[11px] text-[#7F1D1D] hover:underline">
                        <X size={11} /> Cancel
                      </button>
                    )}
                    {r.status === 'shipped' && (
                      <button onClick={() => markReceived(r.id)} className="inline-flex items-center gap-1 text-[11px] text-[#166534] font-medium hover:underline">
                        <PackageCheck size={11} /> Mark received
                      </button>
                    )}
                  </div>
                </div>
                <div className="text-[12px] text-[#555]">
                  {r.items.map(i => `${i.supply_name} × ${i.quantity}`).join(', ')}
                </div>
                {r.shipping_address && <div className="text-[11px] text-[#777] mt-1">Ship to: {r.shipping_address}</div>}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
