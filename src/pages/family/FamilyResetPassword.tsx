import { useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { Button } from '../../components/ui/Button'
import { Input } from '../../components/ui/Input'
import { PracticeLogo } from '../../lib/practice'

export function FamilyResetPassword() {
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const token = searchParams.get('token') ?? ''

  const [newPassword, setNewPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    if (newPassword !== confirm) { setError('Passwords do not match.'); return }
    if (newPassword.length < 8) { setError('Password must be at least 8 characters.'); return }
    setLoading(true)
    try {
      const res = await fetch('/api/families/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, newPassword }),
      })
      if (!res.ok) {
        const { error } = await res.json()
        setError(error || 'Reset failed. Your link may have expired.')
      } else {
        setDone(true)
        setTimeout(() => navigate('/family/login'), 2500)
      }
    } catch {
      setError('Something went wrong. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  if (!token) {
    return (
      <div className="min-h-screen bg-[#FAFAF8] flex items-center justify-center p-4">
        <div className="bg-white border border-[#E8E8E4] rounded-xl shadow-sm p-7 max-w-sm w-full text-center">
          <p className="text-[14px] text-[#791F1F]">Invalid reset link.</p>
          <Link to="/family/forgot-password" className="mt-4 block text-[13px] text-[#7F77DD] hover:underline">Request a new one</Link>
        </div>
      </div>
    )
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
            {done ? (
              <div className="text-center">
                <div className="w-12 h-12 rounded-full bg-[#E1F5EE] flex items-center justify-center mx-auto mb-4">
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#1D9E75" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                </div>
                <h2 className="font-display text-lg font-medium text-[#1A1A2E] mb-2">Password updated!</h2>
                <p className="text-[13px] text-[#555]">Redirecting you to sign in…</p>
              </div>
            ) : (
              <>
                <h1 className="font-display text-xl font-medium text-[#1A1A2E] mb-1">Set new password</h1>
                <p className="text-[13px] text-[#999] mb-5">Choose a password that's at least 8 characters.</p>
                <form onSubmit={handleSubmit} className="space-y-4">
                  <Input label="New password" type="password" placeholder="••••••••" value={newPassword} onChange={e => setNewPassword(e.target.value)} required />
                  <Input label="Confirm new password" type="password" placeholder="••••••••" value={confirm} onChange={e => setConfirm(e.target.value)} required />
                  {error && <div className="p-3 rounded-lg bg-[#FCEBEB] text-[13px] text-[#791F1F]">{error}</div>}
                  <Button type="submit" className="w-full !py-2.5" loading={loading}>Set new password</Button>
                </form>
                <p className="text-center text-[13px] text-[#999] mt-5">
                  <Link to="/family/login" className="text-[#7F77DD] font-medium hover:underline">Back to sign in</Link>
                </p>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
