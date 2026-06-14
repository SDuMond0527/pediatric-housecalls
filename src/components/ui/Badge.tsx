import type { ReactNode } from 'react'

interface BadgeProps {
  children: ReactNode
  color?: string
  textColor?: string
  variant?: 'purple' | 'teal' | 'amber' | 'blue' | 'red' | 'green' | 'gray'
}

const VARIANTS = {
  purple: { bg: '#EEEDFE', text: '#3C3489' },
  teal:   { bg: '#E1F5EE', text: '#085041' },
  amber:  { bg: '#FAEEDA', text: '#633806' },
  blue:   { bg: '#E6F1FB', text: '#0C447C' },
  red:    { bg: '#FCEBEB', text: '#791F1F' },
  green:  { bg: '#EAF3DE', text: '#27500A' },
  gray:   { bg: '#F1EFE8', text: '#888780' },
}

export function Badge({ children, color, textColor, variant }: BadgeProps) {
  const v = variant ? VARIANTS[variant] : null
  const bg = color || v?.bg || VARIANTS.gray.bg
  const tc = textColor || v?.text || VARIANTS.gray.text
  return (
    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium whitespace-nowrap"
      style={{ background: bg, color: tc }}>
      {children}
    </span>
  )
}
