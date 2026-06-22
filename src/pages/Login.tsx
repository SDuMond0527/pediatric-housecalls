import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import { Input } from '../components/ui/Input'
import { Button } from '../components/ui/Button'

export function Login() {
  const { user, loading: authLoading, signIn, confirmNewPassword } = useAuth()
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [needsNewPassword, setNeedsNewPassword] = useState(false)

  // Navigate once auth state confirms the user is signed in
  useEffect(() => {
    if (user && !authLoading) navigate('/')
  }, [user, authLoading, navigate])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)
    const { error, needsNewPassword } = await signIn(email, password)
    if (error) setError(error.message || 'Sign in failed')
    else if (needsNewPassword) setNeedsNewPassword(true)
    setLoading(false)
  }

  async function handleNewPassword(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    if (newPassword !== confirmPassword) { setError('Passwords do not match.'); return }
    if (newPassword.length < 8) { setError('Password must be at least 8 characters.'); return }
    setLoading(true)
    const { error } = await confirmNewPassword(newPassword)
    if (error) setError(error.message)
    setLoading(false)
  }

  return (
    <div className="min-h-screen bg-[#FAFAF8] flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <div className="font-display text-2xl font-medium text-[#1A1A2E] mb-1">
            Pediatric<span style={{ color: '#7F77DD' }}>Housecalls</span>
          </div>
          <div className="text-[13px] text-[#999]">Provider portal</div>
        </div>

        <div className="bg-white border border-[#E8E8E4] rounded-xl shadow-sm p-7">
          {!needsNewPassword ? (
            <form onSubmit={handleSubmit} className="space-y-4">
              <Input label="Email" type="email" placeholder="you@pediatrichousecalls.com"
                value={email} onChange={e => setEmail(e.target.value)} required />
              <Input label="Password" type="password" placeholder="••••••••"
                value={password} onChange={e => setPassword(e.target.value)} required />
              {error && <div className="p-3 rounded-lg bg-[#FCEBEB] text-[13px] text-[#791F1F]">{error}</div>}
              <Button type="submit" className="w-full !py-2.5" loading={loading}>Sign in to provider portal</Button>
            </form>
          ) : (
            <form onSubmit={handleNewPassword} className="space-y-4">
              <div className="text-[13px] text-[#555] mb-2">
                Please set a permanent password to continue.
              </div>
              <Input label="New password" type="password" placeholder="••••••••"
                value={newPassword} onChange={e => setNewPassword(e.target.value)} required />
              <Input label="Confirm new password" type="password" placeholder="••••••••"
                value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)} required />
              {error && <div className="p-3 rounded-lg bg-[#FCEBEB] text-[13px] text-[#791F1F]">{error}</div>}
              <Button type="submit" className="w-full !py-2.5" loading={loading}>Set password & sign in</Button>
            </form>
          )}
        </div>

        <p className="text-center text-[12px] text-[#999] mt-4">
          Contact your administrator if you need access.
        </p>
      </div>
    </div>
  )
}
