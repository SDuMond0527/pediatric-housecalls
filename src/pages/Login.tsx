import { useState, useEffect } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import { Input } from '../components/ui/Input'
import { Button } from '../components/ui/Button'
import { DemoBanner } from '../components/DemoBanner'
import { DEMO_MODE, DEMO_CREDS, PracticeLogo } from '../lib/practice'

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
    <div className="min-h-screen bg-[#FAFAF8] flex flex-col">
      {DEMO_MODE && <DemoBanner />}
      <div className="flex-1 flex items-center justify-center p-4">
        <div className="w-full max-w-sm">
          <div className="text-center mb-8">
            <div className="font-display text-2xl font-medium text-[#1A1A2E] mb-1">
              <PracticeLogo />
            </div>
            <div className="text-[13px] text-[#999]">Provider portal</div>
          </div>

          {DEMO_MODE && !needsNewPassword && (
            <div className="mb-5">
              <p className="text-[11px] text-[#999] uppercase tracking-wider mb-2.5">Try a demo role</p>
              <div className="space-y-2">
                {([
                  { role: 'Admin', desc: 'Analytics, scheduling, patient & provider management', bg: '#FAEEDA', tc: '#633806', creds: DEMO_CREDS.admin },
                  { role: 'Provider', desc: "Today's schedule, patient notes, availability settings", bg: '#E1F5EE', tc: '#085041', creds: DEMO_CREDS.provider },
                ] as const).map(({ role, desc, bg, tc, creds }) => (
                  <button key={role} type="button"
                    onClick={() => { setEmail(creds.email); setPassword(creds.password); setError('') }}
                    className="w-full text-left p-3 rounded-xl border border-[#E8E8E4] hover:border-[#7F77DD] hover:shadow-sm transition-all bg-white group">
                    <div className="flex items-center gap-2 mb-0.5">
                      <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full" style={{ background: bg, color: tc }}>{role}</span>
                      <span className="text-[11px] text-[#aaa] group-hover:text-[#7F77DD] transition-colors ml-auto">Click to pre-fill →</span>
                    </div>
                    <div className="text-[12px] text-[#777] mt-0.5">{desc}</div>
                    <div className="text-[11px] text-[#aaa] mt-1.5 font-mono">{creds.email} · {creds.password}</div>
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="bg-white border border-[#E8E8E4] rounded-xl shadow-sm p-7">
            {!needsNewPassword ? (
              <form onSubmit={handleSubmit} className="space-y-4">
                <Input label="Email" type="email" placeholder="you@example.com"
                  value={email} onChange={e => setEmail(e.target.value)} required />
                <div>
                  <Input label="Password" type="password" placeholder="••••••••" showPasswordToggle
                    value={password} onChange={e => setPassword(e.target.value)} required />
                  <div className="text-right mt-1">
                    <Link to="/forgot-password" className="text-[12px] text-[#7F77DD] hover:underline">Forgot password?</Link>
                  </div>
                </div>
                {error && <div className="p-3 rounded-lg bg-[#FCEBEB] text-[13px] text-[#791F1F]">{error}</div>}
                <Button type="submit" className="w-full !py-2.5" loading={loading}>Sign in to provider portal</Button>
              </form>
            ) : (
              <form onSubmit={handleNewPassword} className="space-y-4">
                <div className="text-[13px] text-[#555] mb-2">
                  Please set a permanent password to continue.
                </div>
                <Input label="New password" type="password" placeholder="••••••••" showPasswordToggle
                  value={newPassword} onChange={e => setNewPassword(e.target.value)} required />
                <Input label="Confirm new password" type="password" placeholder="••••••••" showPasswordToggle
                  value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)} required />
                {error && <div className="p-3 rounded-lg bg-[#FCEBEB] text-[13px] text-[#791F1F]">{error}</div>}
                <Button type="submit" className="w-full !py-2.5" loading={loading}>Set password & sign in</Button>
              </form>
            )}
          </div>

          <p className="text-center text-[12px] text-[#999] mt-4">
            {DEMO_MODE
              ? <>Try the <Link to="/family/login" className="text-[#7F77DD] hover:underline">family portal →</Link></>
              : 'Contact your administrator if you need access.'
            }
          </p>
          <p className="text-center text-[11px] text-[#bbb] mt-3">
            <Link to="/terms" className="hover:text-[#7F77DD]">Terms of Service</Link>
            {' · '}
            <Link to="/privacy" className="hover:text-[#7F77DD]">Privacy Policy</Link>
          </p>
        </div>
      </div>
    </div>
  )
}
