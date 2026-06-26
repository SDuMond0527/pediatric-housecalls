export const PRACTICE_NAME = import.meta.env.VITE_PRACTICE_NAME || 'Pediatric Housecalls'
export const ACCENT_COLOR = import.meta.env.VITE_ACCENT_COLOR || '#7F77DD'
export const VENMO_HANDLE = import.meta.env.VITE_VENMO_HANDLE || 'Pediatric-Housecalls'
export const PRACTICE_TAGLINE = import.meta.env.VITE_PRACTICE_TAGLINE || ''

export function PracticeLogo({ className }: { className?: string }) {
  const parts = PRACTICE_NAME.trim().split(/\s+/)
  if (parts.length === 1) return <span className={className}>{PRACTICE_NAME}</span>
  const last = parts[parts.length - 1]
  const rest = parts.slice(0, -1).join(' ')
  return (
    <span className={className}>
      {rest}<span style={{ color: ACCENT_COLOR }}>{last}</span>
    </span>
  )
}
