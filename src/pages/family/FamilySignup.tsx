import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Check, Circle } from 'lucide-react'
import { useFamilyAuth } from '../../contexts/FamilyAuthContext'
import { Button } from '../../components/ui/Button'
import { Input } from '../../components/ui/Input'

export function FamilySignup() {
  const { signUp } = useFamilyAuth()
  const [form, setForm] = useState({ email: '', phone: '', password: '', confirm: '' })
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  function set(k: string, v: string) { setForm(f => ({ ...f, [k]: v })) }

  // Phone is required. Providers cannot send e-prescriptions or reach the
  // family without one. Enforced client-side here and server-side on
  // /api/families/me and /api/waitlist-entries. See memory:
  // feedback_phone_required_everywhere.md.
  function normalizedPhone(raw: string): string {
    return raw.replace(/\D/g, '')
  }

  // Match Cognito's default password policy so parents see requirements
  // up front instead of hitting a cryptic Cognito rejection ("Password
  // did not conform with policy: Password must have symbol characters")
  // AFTER they submit. Sara + a specific parent case 2026-09-25.
  function passwordChecks(pw: string) {
    return {
      length: pw.length >= 8,
      upper:  /[A-Z]/.test(pw),
      lower:  /[a-z]/.test(pw),
      number: /\d/.test(pw),
      symbol: /[^a-zA-Z0-9]/.test(pw),
    }
  }
  const pwChecks = passwordChecks(form.password)
  const pwAllPass = pwChecks.length && pwChecks.upper && pwChecks.lower && pwChecks.number && pwChecks.symbol

  // Translate common Cognito error messages into friendlier UI text so
  // a parent isn't left staring at raw AWS text. Falls back to the
  // original message if we don't recognize the shape.
  function friendlyError(msg: string): string {
    const s = String(msg ?? '')
    if (/UsernameExistsException|already exists/i.test(s)) {
      return 'An account already exists with this email. Try signing in, or use "Forgot password" if needed.'
    }
    if (/InvalidPasswordException|Password did not conform|password policy/i.test(s)) {
      return 'Password does not meet the requirements below. Make sure it includes uppercase, lowercase, a number, and a symbol.'
    }
    if (/InvalidParameterException.*email|Invalid email/i.test(s)) {
      return 'That email address doesn\'t look valid. Double-check for typos.'
    }
    return s
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    const digits = normalizedPhone(form.phone)
    if (digits.length !== 10) { setError('Please enter a valid 10-digit phone number.'); return }
    if (!pwAllPass) {
      setError('Password does not meet all requirements. See the checklist below the password field.')
      return
    }
    if (form.password !== form.confirm) { setError("Passwords don't match."); return }
    setLoading(true)
    // Stash phone for FamilySetup to pick up and save with the family profile.
    // FamilySetup now also renders its own phone input so the parent can
    // always type it there if sessionStorage doesn't survive the handoff.
    try { sessionStorage.setItem('phc_signup_phone', digits) } catch {}
    const { error } = await signUp(form.email, form.password)
    if (error) { setError(friendlyError(error.message)); setLoading(false); return }
    window.location.href = '/family/setup'
  }

  const passwordDirty = form.password.length > 0

  return (
    <div className="min-h-screen bg-[#FAFAF8] flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <div className="font-display text-2xl font-medium text-[#1A1A2E] mb-1">
            Pediatric<span style={{ color: '#7F77DD' }}>Housecalls</span>
          </div>
          <div className="text-[13px] text-[#1A1A2E]">Create your family account</div>
        </div>

        <div className="bg-white border border-[#E8E8E4] rounded-xl shadow-sm p-7">
          <h1 className="font-display text-xl font-medium text-[#1A1A2E] mb-1">Create account</h1>
          <p className="text-[13px] text-[#1A1A2E] mb-5">Your information is kept private and secure.</p>

          <form onSubmit={handleSubmit} className="space-y-4">
            <Input label="Email" type="email" placeholder="you@email.com" value={form.email} onChange={e => set('email', e.target.value)} required />
            <Input label="Mobile phone" type="tel" placeholder="(704) 555-0000" value={form.phone} onChange={e => set('phone', e.target.value)} required />
            <div>
              <Input label="Password" type="password" placeholder="At least 8 characters" value={form.password} onChange={e => set('password', e.target.value)} required />
              {(passwordDirty || !pwAllPass) && (
                <ul className="mt-2 space-y-0.5 text-[11px]">
                  <PwRule ok={pwChecks.length} label="At least 8 characters" />
                  <PwRule ok={pwChecks.upper}  label="An uppercase letter (A–Z)" />
                  <PwRule ok={pwChecks.lower}  label="A lowercase letter (a–z)" />
                  <PwRule ok={pwChecks.number} label="A number (0–9)" />
                  <PwRule ok={pwChecks.symbol} label="A symbol (! @ # $ % etc.)" />
                </ul>
              )}
            </div>
            <Input label="Confirm password" type="password" placeholder="Re-enter your password" value={form.confirm} onChange={e => set('confirm', e.target.value)} required />
            {error && <div className="p-3 rounded-lg bg-[#FCEBEB] text-[13px] text-[#791F1F]">{error}</div>}
            <Button type="submit" className="w-full !py-2.5" loading={loading}>Create account</Button>
          </form>

          <p className="text-center text-[13px] text-[#1A1A2E] mt-5">
            Already have an account?{' '}
            <Link to="/family/login" className="text-[#7F77DD] font-medium hover:underline">Sign in</Link>
          </p>
        </div>
      </div>
    </div>
  )
}

function PwRule({ ok, label }: { ok: boolean; label: string }) {
  return (
    <li className={`flex items-center gap-1.5 ${ok ? 'text-[#085041]' : 'text-[#8A8A8A]'}`}>
      {ok
        ? <Check size={12} className="text-[#1D9E75] flex-shrink-0" />
        : <Circle size={10} className="text-[#8A8A8A] flex-shrink-0" />}
      <span>{label}</span>
    </li>
  )
}
