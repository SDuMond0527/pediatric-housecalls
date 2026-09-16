import { useEffect, useRef, useState } from 'react'
import { Search, Check, X } from 'lucide-react'
import type { PharmacyMatch } from '../lib/api'

/**
 * Free-text pharmacy → DoseSpot-backed autocomplete.
 *
 * Parent types a store name (or refines by zip), we hit
 * /api/dosespot/pharmacy-search, they pick one, and we call
 * onSelect with BOTH a human-readable label AND the concrete
 * DoseSpot pharmacy_id. The intake form stores both — the label
 * for chart display, the id so future DoseSpot SSO launches assign
 * this exact pharmacy without any fuzzy match.
 */
export function PharmacyAutocomplete({
  value,
  pharmacyId,
  defaultZip,
  defaultState,
  onSelect,
  onClear,
  search,
}: {
  /** Current display text (readable pharmacy name + address). */
  value: string
  /** DoseSpot ID of the currently-selected pharmacy, or null. */
  pharmacyId: number | null
  defaultZip: string
  defaultState: string
  /** Called when the parent picks a pharmacy from the dropdown. */
  onSelect: (m: { label: string; dosespot_pharmacy_id: number }) => void
  /** Called when the parent clears the selection. */
  onClear: () => void
  /** The API caller to use — family surfaces pass familySearchPharmacies,
   *  staff surfaces pass searchPharmacies. Both hit the same endpoint. */
  search: (q: string, zip: string, state: string) => Promise<{ items: PharmacyMatch[] }>
}) {
  const [query, setQuery]     = useState('')
  const [zip, setZip]         = useState(defaultZip || '')
  const [results, setResults] = useState<PharmacyMatch[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError]     = useState<string | null>(null)
  const [open, setOpen]       = useState(false)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (pharmacyId) { setOpen(false); return }
    if (debounceRef.current) clearTimeout(debounceRef.current)
    const trimmed = query.trim()
    if (!trimmed && !zip.trim()) { setResults([]); setError(null); return }
    debounceRef.current = setTimeout(async () => {
      setLoading(true)
      setError(null)
      try {
        const { items } = await search(trimmed, zip.trim(), defaultState || '')
        setResults(items ?? [])
        setOpen(true)
      } catch (e: any) {
        setError(e?.message ?? 'Search failed')
      } finally {
        setLoading(false)
      }
    }, 400)
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current) }
  }, [query, zip, pharmacyId, defaultState, search])

  // Selected state — show the picked pharmacy with a clear button.
  if (pharmacyId && value) {
    return (
      <div className="rounded-lg border border-[#1D9E75] bg-[#F0FDF4] p-3">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-start gap-2 min-w-0">
            <Check size={14} className="text-[#1D9E75] flex-shrink-0 mt-0.5" />
            <div className="text-[13px] text-[#1A1A2E] min-w-0">
              <div className="font-medium truncate">{value}</div>
              <div className="text-[11px] text-[#0F5F44]">DoseSpot pharmacy ID {pharmacyId}</div>
            </div>
          </div>
          <button
            type="button"
            onClick={() => { onClear(); setQuery(''); setResults([]); setOpen(false) }}
            className="text-[#0F5F44] hover:text-[#0A3F2E] flex-shrink-0"
            title="Change pharmacy">
            <X size={14} />
          </button>
        </div>
      </div>
    )
  }

  // Search state.
  return (
    <div className="relative">
      <div className="grid grid-cols-3 gap-2">
        <div className="col-span-2 relative">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[#aeaeb2]" />
          <input
            type="text"
            className="w-full pl-8 pr-3 py-2.5 border border-[#E8E8E4] rounded-lg text-[14px] focus:border-[#7F77DD] outline-none"
            placeholder="Pharmacy name (e.g. Publix, CVS)"
            value={query}
            onChange={e => setQuery(e.target.value)}
            onFocus={() => { if (results.length) setOpen(true) }} />
        </div>
        <input
          type="text"
          inputMode="numeric"
          maxLength={5}
          className="w-full px-3 py-2.5 border border-[#E8E8E4] rounded-lg text-[14px] focus:border-[#7F77DD] outline-none"
          placeholder="Zip"
          value={zip}
          onChange={e => setZip(e.target.value.replace(/\D/g, ''))} />
      </div>

      {loading && <div className="text-[11px] text-[#1A1A2E]/60 mt-1.5">Searching pharmacies…</div>}
      {error   && <div className="text-[11px] text-[#991B1B] mt-1.5">{error}</div>}

      {open && !loading && (
        <div className="absolute z-30 left-0 right-0 mt-1 bg-white border border-[#E8E8E4] rounded-lg shadow-lg max-h-72 overflow-y-auto">
          {results.length === 0 ? (
            <div className="px-3 py-3 text-[12px] text-[#1A1A2E]/70">
              No pharmacies found for these search terms. Try a different name or zip.
            </div>
          ) : (
            <>
              {results.map(r => (
                <button
                  type="button"
                  key={r.id}
                  onClick={() => {
                    const label = `${r.name} — ${r.address}, ${r.city}, ${r.state} ${r.zip}`.replace(/\s+,/g, ',').replace(/,\s+,/g, ',').trim()
                    onSelect({ label, dosespot_pharmacy_id: r.id })
                    setOpen(false)
                    setQuery('')
                  }}
                  className="w-full text-left px-3 py-2.5 hover:bg-[#F1EFE8] transition-colors border-b border-[#F1EFE8] last:border-b-0">
                  <div className="text-[13px] font-medium text-[#1A1A2E]">{r.name}</div>
                  <div className="text-[11px] text-[#555]">
                    {[r.address, r.city, r.state, r.zip].filter(Boolean).join(', ')}
                    {r.phone && <span> · {r.phone}</span>}
                  </div>
                </button>
              ))}
              <div className="px-3 py-1.5 text-[10px] text-[#1A1A2E]/50 bg-[#FAFAF8] border-t border-[#F1EFE8]">
                Powered by DoseSpot's pharmacy directory
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}
