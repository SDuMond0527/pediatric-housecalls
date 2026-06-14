import type { ButtonHTMLAttributes, ReactNode } from 'react'

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'teal' | 'secondary' | 'ghost' | 'danger'
  size?: 'xs' | 'sm' | 'md'
  children: ReactNode
  loading?: boolean
}

export function Button({ variant = 'primary', size = 'md', children, loading, className = '', ...props }: ButtonProps) {
  const base = 'inline-flex items-center justify-center font-medium rounded-lg transition-all duration-150 disabled:opacity-50 disabled:cursor-not-allowed font-sans gap-1.5'
  const variants = {
    primary:   'bg-[#7F77DD] text-white hover:bg-[#534AB7]',
    teal:      'bg-[#1D9E75] text-white hover:bg-[#0F6E56]',
    secondary: 'bg-white text-[#1A1A2E] border border-[#D0D0CC] hover:bg-[#FAFAF8]',
    ghost:     'text-[#555] hover:bg-[#F1EFE8] hover:text-[#1A1A2E]',
    danger:    'bg-[#FCEBEB] text-[#791F1F] hover:bg-[#F09595]/30 border border-[#F09595]',
  }
  const sizes = { xs: 'px-2.5 py-1 text-[12px]', sm: 'px-3 py-1.5 text-[13px]', md: 'px-4 py-2 text-[13px]' }
  return (
    <button className={`${base} ${variants[variant]} ${sizes[size]} ${className}`} disabled={loading || props.disabled} {...props}>
      {loading && <svg className="animate-spin h-3.5 w-3.5" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>}
      {children}
    </button>
  )
}
