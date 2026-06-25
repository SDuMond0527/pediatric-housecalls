import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Search, ChevronRight } from 'lucide-react'
import { format, parseISO, differenceInYears } from 'date-fns'
import { searchChildren } from '../lib/api'

function calcAge(dob: string): string {
  try {
    const years = differenceInYears(new Date(), parseISO(dob))
    return `${years} yo`
  } catch {
    return ''
  }
}

function formatDob(raw: string): string {
  try {
    const s = String(raw).split('T')[0]
    return format(parseISO(s), 'MMM d, yyyy')
  } catch {
    return raw
  }
}

export function Patients() {
  const navigate = useNavigate()
  const [allChildren, setAllChildren] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')
  const [searchResults, setSearchResults] = useState<any[]>([])
  const [searchLoading, setSearchLoading] = useState(false)
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    async function loadAll() {
      setLoading(true)
      try {
        // Load a broad initial set using the search endpoint
        const rows = await searchChildren(' ').catch(() => [] as any[])
        setAllChildren(rows ?? [])
      } finally {
        setLoading(false)
      }
    }
    loadAll()
  }, [])

  function onQueryChange(q: string) {
    setQuery(q)
    if (searchTimer.current) clearTimeout(searchTimer.current)
    if (!q.trim()) {
      setSearchResults([])
      return
    }
    searchTimer.current = setTimeout(async () => {
      setSearchLoading(true)
      try {
        const rows = await searchChildren(q.trim())
        setSearchResults(rows ?? [])
      } catch {
        setSearchResults([])
      }
      setSearchLoading(false)
    }, 300)
  }

  const isSearching = query.trim().length > 0
  const displayed = isSearching ? searchResults : allChildren

  function childName(c: any): string {
    return [c.first_name, c.last_name].filter(Boolean).join(' ') || c.display_label || 'Unknown'
  }

  function familyLabel(c: any): string {
    return c.family_display_name || c.family_email || ''
  }

  function dobStr(c: any): string {
    if (!c.date_of_birth) return ''
    return String(c.date_of_birth instanceof Date ? c.date_of_birth.toISOString() : c.date_of_birth).split('T')[0]
  }

  function initials(c: any): string {
    return childName(c).split(' ').map((p: string) => p[0]).filter(Boolean).slice(0, 2).join('')
  }

  return (
    <div className="min-h-screen bg-[#FAFAF8]">
      {/* Header */}
      <div className="bg-white border-b border-[#E8E8E4] px-6 py-4 flex items-center justify-between sticky top-0 z-10">
        <div className="font-display text-[18px] font-medium text-[#1A1A2E]">Patients</div>
        <div className="relative w-64">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#999]" />
          <input
            type="text"
            placeholder="Search by name…"
            value={query}
            onChange={e => onQueryChange(e.target.value)}
            className="w-full pl-8 pr-3 py-2 border border-[#E8E8E4] rounded-lg text-[14px] outline-none focus:border-[#7F77DD] font-sans"
          />
        </div>
      </div>

      <div className="p-6 max-w-3xl mx-auto">
        {loading ? (
          <div className="text-center py-16 text-[#999] text-[14px]">Loading patients…</div>
        ) : searchLoading ? (
          <div className="text-center py-16 text-[#999] text-[14px]">Searching…</div>
        ) : displayed.length === 0 ? (
          <div className="text-center py-16">
            <div className="text-[#999] text-[14px]">
              {isSearching ? 'No patients found matching your search.' : 'No patients on file.'}
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            {displayed.map((child: any) => {
              const dob = dobStr(child)
              const age = dob ? calcAge(dob) : ''
              const fam = familyLabel(child)

              return (
                <button
                  key={child.id}
                  onClick={() => navigate(`/chart/${child.id}`)}
                  className="w-full text-left flex items-center gap-4 px-5 py-4 bg-white border border-[#E8E8E4] rounded-xl hover:border-[#AFA9EC] hover:bg-[#FAFAF8] transition-all group">
                  <div className="w-9 h-9 rounded-full bg-[#EEEDFE] flex items-center justify-center flex-shrink-0">
                    <span className="text-[12px] font-semibold text-[#7F77DD]">{initials(child)}</span>
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="font-display text-[15px] font-medium text-[#1A1A2E]">{childName(child)}</div>
                    <div className="text-[12px] text-[#999] mt-0.5 flex items-center gap-2 flex-wrap">
                      {dob && <span>{formatDob(dob)}{age ? ` · ${age}` : ''}</span>}
                      {fam && <span className="text-[#555]">{fam}</span>}
                    </div>
                  </div>
                  <ChevronRight size={14} className="text-[#ccc] group-hover:text-[#7F77DD] transition-colors flex-shrink-0" />
                </button>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
