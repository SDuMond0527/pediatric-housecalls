import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useFamilyAuth } from '../../contexts/FamilyAuthContext'
import { Button } from '../../components/ui/Button'
import { Input } from '../../components/ui/Input'
import { DemoBanner } from '../../components/DemoBanner'
import { PracticeLogo, PRACTICE_NAME, PRACTICE_TAGLINE, DEMO_MODE, DEMO_CREDS } from '../../lib/practice'

export function FamilyLogin() {
  const { signIn } = useFamilyAuth()
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)
    const { error } = await signIn(email, password)
    if (error) { setError('Invalid email or password.'); setLoading(false) }
    else navigate('/family/dashboard')
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
            {PRACTICE_TAGLINE && <div className="text-[13px] text-[#999]">{PRACTICE_TAGLINE}</div>}
            <div className="flex justify-center gap-1.5 mt-3 flex-wrap">
              {[['#EEEDFE','#3C3489','In-home visits'],['#E1F5EE','#085041','Telemedicine'],['#FAEEDA','#633806','Sports physicals']].map(([bg,tc,label]) => (
                <span key={label} className="text-[11px] px-2 py-0.5 rounded-full font-medium" style={{ background: bg, color: tc }}>{label}</span>
              ))}
            </div>
          </div>

          {DEMO_MODE && (
            <div className="mb-5">
              <p className="text-[11px] text-[#999] uppercase tracking-wider mb-2.5">Try a demo role</p>
              <button type="button"
                onClick={() => { setEmail(DEMO_CREDS.family.email); setPassword(DEMO_CREDS.family.password); setError('') }}
                className="w-full text-left p-3 rounded-xl border border-[#E8E8E4] hover:border-[#7F77DD] hover:shadow-sm transition-all bg-white group">
                <div className="flex items-center gap-2 mb-0.5">
                  <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-[#EEEDFE] text-[#3C3489]">Patient Family</span>
                  <span className="text-[11px] text-[#aaa] group-hover:text-[#7F77DD] transition-colors ml-auto">Click to pre-fill →</span>
                </div>
                <div className="text-[12px] text-[#777] mt-0.5">Book visits, view appointment history, manage your family profile</div>
                <div className="text-[11px] text-[#aaa] mt-1.5 font-mono">{DEMO_CREDS.family.email} · {DEMO_CREDS.family.password}</div>
              </button>
            </div>
          )}

          <div className="bg-white border border-[#E8E8E4] rounded-xl shadow-sm p-7">
            <h1 className="font-display text-xl font-medium text-[#1A1A2E] mb-1">Welcome back</h1>
            <p className="text-[13px] text-[#999] mb-5">Sign in to book and manage appointments</p>

            <form onSubmit={handleSubmit} className="space-y-4">
              <Input label="Email" type="email" placeholder="you@email.com" value={email} onChange={e => setEmail(e.target.value)} required />
              <div>
                <Input label="Password" type="password" placeholder="••••••••" value={password} onChange={e => setPassword(e.target.value)} required />
                <div className="text-right mt-1">
                  <Link to="/family/forgot-password" className="text-[12px] text-[#7F77DD] hover:underline">Forgot password?</Link>
                </div>
              </div>
              {error && <div className="p-3 rounded-lg bg-[#FCEBEB] text-[13px] text-[#791F1F]">{error}</div>}
              <Button type="submit" className="w-full !py-2.5" loading={loading}>Sign in</Button>
            </form>

            {!DEMO_MODE && (
              <p className="text-center text-[13px] text-[#999] mt-5">
                New to {PRACTICE_NAME}?{' '}
                <Link to="/family/signup" className="text-[#7F77DD] font-medium hover:underline">Create account</Link>
              </p>
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
