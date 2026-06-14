import { forwardRef } from 'react'
import type { InputHTMLAttributes } from 'react'

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string
  error?: string
}

export const Input = forwardRef<HTMLInputElement, InputProps>(({ label, error, className = '', ...props }, ref) => (
  <div className="flex flex-col gap-1">
    {label && <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider">{label}</label>}
    <input ref={ref}
      className={`w-full px-3 py-2.5 rounded-lg border text-[#1A1A2E] placeholder-[#999] text-sm transition-all outline-none
        ${error ? 'border-[#F09595] bg-[#FCEBEB]' : 'border-[#E8E8E4] bg-white focus:border-[#7F77DD] focus:ring-2 focus:ring-[#7F77DD]/10'}
        ${className}`}
      {...props} />
    {error && <p className="text-xs text-[#791F1F]">{error}</p>}
  </div>
))
Input.displayName = 'Input'
