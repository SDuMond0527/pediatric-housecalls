import { useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { useFamilyAuth } from '../../contexts/FamilyAuthContext'
import { Button } from '../../components/ui/Button'
import { Input } from '../../components/ui/Input'
import { DemoBanner } from '../../components/DemoBanner'
import { AuthHelpFooter } from '../../components/AuthHelpFooter'
import { PracticeLogo, PRACTICE_TAGLINE, DEMO_MODE, DEMO_CREDS } from '../../lib/practice'

export function FamilyLogin() {
  const { signIn } = useFamilyAuth()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  // If the user was bounced here from an authenticated page (e.g. the
  // marketing-site school-note button → /family/school-note), send
  // them back there after login instead of the generic dashboard.
  // Validated against known-safe prefixes so a crafted ?returnTo=
  // can't bounce them off-site.
  function safeReturnTo(): string {
    const raw = params.get('returnTo') ?? ''
    if (!raw) return '/family/dashboard'
    try {
      const decoded = decodeURIComponent(raw)
      if (!decoded.startsWith('/family/')) return '/family/dashboard'
      return decoded
    } catch { return '/family/dashboard' }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)
    const { error } = await signIn(email, password)
    if (error) { setError('Invalid email or password.'); setLoading(false) }
    else navigate(safeReturnTo())
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
            {PRACTICE_TAGLINE && <div className="text-[13px] text-[#1A1A2E]">{PRACTICE_TAGLINE}</div>}
            {/* Contextual banner — if the parent arrived with ?returnTo=
                pointing at the school-note picker, tell them WHY they're
                being asked to log in. Otherwise the login page is a dead
                end that looks like a mistake. */}
            {params.get('returnTo')?.includes('/family/school-note') && (
              <div className="mt-4 mx-auto max-w-xs bg-[#EEEDFE] border border-[#C7C3F4] text-[#3C3489] rounded-xl px-4 py-3 text-[13px] leading-relaxed">
                Log in or sign up to request your school absence note. We'll email you the PDF right away.
              </div>
            )}
            <div className="flex justify-center gap-1.5 mt-3 flex-wrap">
              {[['#EEEDFE','#3C3489','In-home visits'],['#E1F5EE','#085041','Telemedicine'],['#FAEEDA','#633806','Sports physicals']].map(([bg,tc,label]) => (
                <span key={label} className="text-[11px] px-2 py-0.5 rounded-full font-medium" style={{ background: bg, color: tc }}>{label}</span>
              ))}
            </div>
          </div>

          {DEMO_MODE && (
            <div className="mb-5">
              <p className="text-[11px] text-[#1A1A2E] uppercase tracking-wider mb-2.5">Try a demo role</p>
              <button type="button"
                onClick={() => { setEmail(DEMO_CREDS.family.email); setPassword(DEMO_CREDS.family.password); setError('') }}
                className="w-full text-left p-3 rounded-xl border border-[#E8E8E4] hover:border-[#7F77DD] hover:shadow-sm transition-all bg-white group">
                <div className="flex items-center gap-2 mb-0.5">
                  <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-[#EEEDFE] text-[#3C3489]">Patient Family</span>
                  <span className="text-[11px] text-[#3C3489] group-hover:text-[#7F77DD] transition-colors ml-auto font-semibold">Click to pre-fill →</span>
                </div>
                <div className="text-[12px] text-[#777] mt-0.5">Book visits, view appointment history, manage your family profile</div>
                <div className="text-[11px] text-[#333] mt-1.5 font-mono font-semibold">{DEMO_CREDS.family.email} · {DEMO_CREDS.family.password}</div>
              </button>
            </div>
          )}

          <div className="bg-white border border-[#E8E8E4] rounded-xl shadow-sm p-7">
            <h1 className="font-display text-xl font-medium text-[#1A1A2E] mb-1">Welcome back</h1>
            <p className="text-[13px] text-[#1A1A2E] mb-5">Sign in to book and manage appointments</p>

            {!DEMO_MODE && (
              <div className="mb-5 p-4 rounded-lg bg-[#EEEDFE] border border-[#AFA9EC] text-[13px] text-[#1A1A2E] leading-relaxed">
                <strong>We have a new scheduling system!</strong> If you have never used this new scheduling system to book an appointment, please{' '}
                <Link to="/family/signup" className="text-[#7F77DD] font-semibold hover:underline">create an account</Link>{' '}
                <strong className="uppercase">even if your child has been seen many times by us in the past!</strong> You will only need to create an account one time, and every time after that, you can use your password to log directly in, with all of your information saved, and booking will be quick and easy!
              </div>
            )}

            <form onSubmit={handleSubmit} className="space-y-4">
              <Input label="Email" type="email" placeholder="you@email.com" value={email} onChange={e => setEmail(e.target.value)} required />
              <div>
                <Input label="Password" type="password" placeholder="••••••••" showPasswordToggle value={password} onChange={e => setPassword(e.target.value)} required />
                <div className="text-right mt-1">
                  <Link to="/family/forgot-password" className="text-[12px] text-[#7F77DD] hover:underline">Forgot password?</Link>
                </div>
              </div>
              {error && <div className="p-3 rounded-lg bg-[#FCEBEB] text-[13px] text-[#791F1F]">{error}</div>}
              <Button type="submit" className="w-full !py-2.5" loading={loading}>Sign in</Button>
            </form>
          </div>

          <p className="text-center text-[12px] text-[#1A1A2E] mt-4">
            Are you a provider?{' '}
            <Link to="/login" className="text-[#555] hover:underline">Provider portal →</Link>
          </p>
          <AuthHelpFooter />
        </div>
      </div>
    </div>
  )
}
