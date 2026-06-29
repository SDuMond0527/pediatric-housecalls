export const PRACTICE_NAME = import.meta.env.VITE_PRACTICE_NAME || 'Pediatric Housecalls'
export const ACCENT_COLOR = import.meta.env.VITE_ACCENT_COLOR || '#7F77DD'
export const VENMO_HANDLE = import.meta.env.VITE_VENMO_HANDLE || 'Pediatric-Housecalls'
export const PRACTICE_TAGLINE = import.meta.env.VITE_PRACTICE_TAGLINE || ''

export const DEMO_MODE = import.meta.env.VITE_DEMO_MODE === 'true'
export const DEMO_CREDS = {
  admin:    { email: import.meta.env.VITE_DEMO_ADMIN_EMAIL    || '', password: import.meta.env.VITE_DEMO_ADMIN_PASSWORD    || '' },
  provider: { email: import.meta.env.VITE_DEMO_PROVIDER_EMAIL || '', password: import.meta.env.VITE_DEMO_PROVIDER_PASSWORD || '' },
  family:   { email: import.meta.env.VITE_DEMO_FAMILY_EMAIL   || '', password: import.meta.env.VITE_DEMO_FAMILY_PASSWORD   || '' },
}

export function PracticeLogo({ className }: { className?: string }) {
  return (
    <img src="/logo.png" alt={PRACTICE_NAME} className={className ?? 'h-24 w-auto mx-auto'} />
  )
}
