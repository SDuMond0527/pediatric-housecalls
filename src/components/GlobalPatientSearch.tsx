import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Search } from 'lucide-react'
import { searchChildren } from '../lib/api'
import { useAuth } from '../contexts/AuthContext'
import { ChartNumberPill } from './ChartNumberPill'

// Global patient search — mounted in the header of every admin +
// provider page. Debounced live-suggest with keyboard nav; clicking a
// result routes to the correct chart URL (admin vs. provider). Escape
// closes; clicking outside closes.
export function GlobalPatientSearch() {
  const navigate = useNavigate()
  const { provider } = useAuth()
  const isAdmin = !!provider?.is_admin
  const [q, setQ] = useState('')
  const [results, setResults] = useState<any[]>([])
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [highlight, setHighlight] = useState(0)
  const containerRef = useRef<HTMLDivElement>(null)
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (debounceTimer.current) clearTimeout(debounceTimer.current)
    if (!q.trim()) { setResults([]); setLoading(false); return }
    setLoading(true)
    debounceTimer.current = setTimeout(async () => {
      try {
        const rows = await searchChildren(q.trim(), false)
        setResults(Array.isArray(rows) ? rows.slice(0, 8) : [])
      } catch {
        setResults([])
      } finally {
        setLoading(false)
      }
    }, 250)
    return () => { if (debounceTimer.current) clearTimeout(debounceTimer.current) }
  }, [q])

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  function goToChart(id: string) {
    navigate(isAdmin ? `/admin/chart/${id}` : `/chart/${id}`)
    setOpen(false)
    setQ('')
    setHighlight(0)
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Escape') { setOpen(false); (e.currentTarget as HTMLInputElement).blur() }
    else if (e.key === 'ArrowDown') { setHighlight(h => Math.min(h + 1, Math.max(results.length - 1, 0))); e.preventDefault() }
    else if (e.key === 'ArrowUp') { setHighlight(h => Math.max(h - 1, 0)); e.preventDefault() }
    else if (e.key === 'Enter' && results[highlight]) { goToChart(results[highlight].id) }
  }

  return (
    <div ref={containerRef} className="relative w-full max-w-sm">
      <div className="relative">
        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#999] pointer-events-none" />
        <input
          type="text"
          value={q}
          onChange={e => { setQ(e.target.value); setOpen(true); setHighlight(0) }}
          onFocus={() => { if (q.trim()) setOpen(true) }}
          onKeyDown={onKeyDown}
          placeholder="Search patients…"
          className="w-full pl-8 pr-3 py-1.5 border border-[#E8E8E4] rounded-lg text-[13px] outline-none focus:border-[#7F77DD] bg-white"
        />
      </div>
      {open && q.trim() && (
        <div className="absolute top-full left-0 right-0 mt-1 bg-white border border-[#E8E8E4] rounded-lg shadow-lg z-[45] max-h-80 overflow-y-auto">
          {loading ? (
            <div className="px-3 py-2 text-[13px] text-[#555]">Searching…</div>
          ) : results.length === 0 ? (
            <div className="px-3 py-2 text-[13px] text-[#555]">No patients found</div>
          ) : (
            results.map((c, i) => {
              const name = [c.first_name, c.last_name].filter(Boolean).join(' ') || c.display_label || 'Unknown'
              const dob = c.date_of_birth ? String(c.date_of_birth).split('T')[0] : ''
              return (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => goToChart(c.id)}
                  onMouseEnter={() => setHighlight(i)}
                  className={`w-full text-left px-3 py-2 border-b border-[#F1EFE8] last:border-0 ${i === highlight ? 'bg-[#F5F4FE]' : 'hover:bg-[#FAFAF8]'}`}>
                  <div className="text-[13px] font-medium text-[#1A1A2E] flex items-center gap-2 flex-wrap">
                    <span>{name}</span>
                    <ChartNumberPill value={c.chart_number} size="xs" />
                  </div>
                  {dob && <div className="text-[11px] text-[#555]">DOB {dob}</div>}
                </button>
              )
            })
          )}
        </div>
      )}
    </div>
  )
}
