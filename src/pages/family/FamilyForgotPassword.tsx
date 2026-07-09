import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Button } from '../../components/ui/Button'
import { Input } from '../../components/ui/Input'
import { PracticeLogo } from '../../lib/practice'

export function FamilyForgotPassword() {
  const [email, setEmail] = useState('')
  const [loading, setLoading] = useState(false)
  const [sent, setSent] = useState(false)
  const [error, setError] = useState('')

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      await fetch('/api/families/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      })
      setSent(true)
    } catch {
      setError('Something went wrong. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-[#FAFAF8] flex flex-col">
      <div className="flex-1 flex items-center justify-center p-4">
        <div className="w-full max-w-sm">
          <div className="text-center mb-8">
            <div className="font-display text-2xl font-medium text-[#1A1A2E] mb-1">
              <PracticeLogo />
            </div>
          </div>

          <div className="bg-white border border-[#E8E8E4] rounded-xl shadow-sm p-7">
            {sent ? (
              <div className="text-center">
                <div className="w-12 h-12 rounded-full bg-[#E1F5EE] flex items-center justify-center mx-auto mb-4">
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#1D9E75" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                </div>
                <h2 className="font-display text-lg font-medium text-[#1A1A2E] mb-2">Check your email</h2>
                <p className="text-[13px] text-[#555] leading-relaxed mb-5">
                  If <strong>{email}</strong> is registered, you'll receive a password reset link shortly. Check your spam folder if you don't see it within a few minutes.
                </p>
                <Link to="/family/login" className="text-[13px] text-[#7F77DD] font-medium hover:underline">
                  Back to sign in
                </Link>
              </div>
            ) : (
              <>
                <h1 className="font-display text-xl font-medium text-[#1A1A2E] mb-1">Forgot password?</h1>
                <p className="text-[13px] text-[#999] mb-5">Enter your email and we'll send you a reset link.</p>
                <form onSubmit={handleSubmit} className="space-y-4">
                  <Input label="Email" type="email" placeholder="you@email.com" value={email} onChange={e => setEmail(e.target.value)} required />
                  {error && <div className="p-3 rounded-lg bg-[#FCEBEB] text-[13px] text-[#791F1F]">{error}</div>}
                  <Button type="submit" className="w-full !py-2.5" loading={loading}>Send reset link</Button>
                </form>
                <p className="text-center text-[13px] text-[#999] mt-5">
                  <Link to="/family/login" className="text-[#7F77DD] font-medium hover:underline">Back to sign in</Link>
                </p>
              </>
            )}
          </div>

          <p className="text-center text-[12px] text-[#999] mt-4">
            Are you a provider?{' '}
            <Link to="/login" className="text-[#555] hover:underline">Provider portal →</Link>
          </p>
        </div>
      </div>
    </div>
  )
}
