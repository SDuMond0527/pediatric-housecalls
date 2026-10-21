import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Bell } from 'lucide-react'
import { getProviderReplyBadge, markProviderRepliesSeen, type ProviderReplyBadgeItem } from '../lib/api'

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const m = Math.floor(diff / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

export function ProviderReplyBell() {
  const navigate = useNavigate()
  const [count, setCount] = useState(0)
  const [items, setItems] = useState<ProviderReplyBadgeItem[]>([])
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  const refresh = useCallback(() => {
    getProviderReplyBadge()
      .then(d => { setCount(d.count ?? 0); setItems(d.items ?? []) })
      .catch(() => {})
  }, [])

  useEffect(() => {
    refresh()
    const interval = setInterval(refresh, 30000)
    const onChanged = () => refresh()
    window.addEventListener('claims:changed', onChanged)
    return () => {
      clearInterval(interval)
      window.removeEventListener('claims:changed', onChanged)
    }
  }, [refresh])

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  const handleToggle = () => {
    const next = !open
    setOpen(next)
    if (next && count > 0) {
      markProviderRepliesSeen().then(() => setCount(0)).catch(() => {})
    }
  }

  const handleItemClick = (claimId: string) => {
    setOpen(false)
    navigate(`/admin/claims?claim=${claimId}`)
  }

  return (
    <div ref={containerRef} className="relative flex-shrink-0">
      <button
        onClick={handleToggle}
        className="relative p-2 rounded-lg hover:bg-[#F1EFE8] transition-colors text-[#1A1A2E]"
        aria-label="Provider replies"
      >
        <Bell size={18} />
        {count > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] px-1 bg-[#EF4444] text-white text-[10px] font-semibold rounded-full flex items-center justify-center">
            {count > 9 ? '9+' : count}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-2 w-[360px] max-h-[480px] overflow-y-auto bg-white border border-[#E8E8E4] rounded-lg shadow-lg z-50">
          <div className="px-4 py-3 border-b border-[#E8E8E4] flex items-center justify-between">
            <div className="font-medium text-[#1A1A2E] text-[13px]">Provider replies</div>
            {items.length > 0 && (
              <div className="text-[11px] text-[#1A1A2E]/50">Last 20</div>
            )}
          </div>
          {items.length === 0 ? (
            <div className="px-4 py-8 text-center text-[12px] text-[#1A1A2E]/50">No new replies.</div>
          ) : (
            <ul className="divide-y divide-[#E8E8E4]">
              {items.map(item => {
                const patient = [item.patient_first_name, item.patient_last_name].filter(Boolean).join(' ') || 'Patient'
                return (
                  <li key={item.id}>
                    <button
                      onClick={() => handleItemClick(item.claim_id)}
                      className="w-full text-left px-4 py-3 hover:bg-[#F1EFE8] transition-colors"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="font-medium text-[13px] text-[#1A1A2E] truncate">
                          {item.provider_name} · {patient}
                        </div>
                        <div className="text-[11px] text-[#1A1A2E]/50 flex-shrink-0">{timeAgo(item.created_at)}</div>
                      </div>
                      <div className="text-[12px] text-[#1A1A2E]/70 mt-1 line-clamp-2">{item.body}</div>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
