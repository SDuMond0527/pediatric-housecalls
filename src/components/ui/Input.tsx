import { forwardRef, useState } from 'react'
import type { InputHTMLAttributes } from 'react'

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string
  error?: string
  showPasswordToggle?: boolean
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ label, error, className = '', showPasswordToggle, ...props }, ref) => {
    const [showPass, setShowPass] = useState(false)
    const isPassword = props.type === 'password'
    const withToggle = showPasswordToggle && isPassword

    return (
      <div className="flex flex-col gap-1">
        {label && <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider">{label}</label>}
        <div className="relative">
          <input
            ref={ref}
            className={`w-full px-3 py-2.5 rounded-lg border text-[#1A1A2E] placeholder-[#999] text-sm transition-all outline-none
              ${error ? 'border-[#F09595] bg-[#FCEBEB]' : 'border-[#E8E8E4] bg-white focus:border-[#7F77DD] focus:ring-2 focus:ring-[#7F77DD]/10'}
              ${withToggle ? 'pr-10' : ''}
              ${className}`}
            {...props}
            type={withToggle && showPass ? 'text' : props.type}
          />
          {withToggle && (
            <button
              type="button"
              tabIndex={-1}
              aria-label={showPass ? 'Hide password' : 'Show password'}
              onClick={() => setShowPass(v => !v)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-[#bbb] hover:text-[#555] transition-colors"
            >
              {showPass ? (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/>
                  <line x1="1" y1="1" x2="23" y2="23"/>
                </svg>
              ) : (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
                  <circle cx="12" cy="12" r="3"/>
                </svg>
              )}
            </button>
          )}
        </div>
        {error && <p className="text-xs text-[#791F1F]">{error}</p>}
      </div>
    )
  }
)
Input.displayName = 'Input'
