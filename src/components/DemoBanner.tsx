import { useState } from 'react'
import { X } from 'lucide-react'

export function DemoBanner() {
  const [dismissed, setDismissed] = useState(
    () => sessionStorage.getItem('demo-banner-dismissed') === 'true'
  )
  if (dismissed) return null

  function dismiss() {
    sessionStorage.setItem('demo-banner-dismissed', 'true')
    setDismissed(true)
  }

  return (
    <div className="bg-[#1A1A2E] text-white text-[12px] flex items-center justify-between px-4 py-2.5 gap-4">
      <div className="flex items-center gap-3 flex-wrap">
        <span className="bg-[#7F77DD]/25 text-[#AFA9EC] text-[11px] font-semibold px-2 py-0.5 rounded-full uppercase tracking-wider flex-shrink-0">
          Demo
        </span>
        <span className="text-white/70">
          This is a live demo of the Roam platform. Explore freely — data resets weekly.
        </span>
        <span className="text-white/40 hidden sm:inline">·</span>
        <a href="/login" className="text-[#AFA9EC] hover:text-white transition-colors hidden sm:inline">
          Provider portal →
        </a>
        <a href="/family/login" className="text-[#AFA9EC] hover:text-white transition-colors hidden sm:inline">
          Family portal →
        </a>
      </div>
      <button
        onClick={dismiss}
        aria-label="Dismiss demo banner"
        className="p-1.5 hover:bg-white/10 rounded transition-colors flex-shrink-0"
      >
        <X size={13} />
      </button>
    </div>
  )
}
