import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useFamilyAuth } from '../../contexts/FamilyAuthContext'
import { Button } from '../../components/ui/Button'
import { Input } from '../../components/ui/Input'

export function FamilySignup() {
  const { signUp } = useFamilyAuth()
  const navigate = useNavigate()
  const [form, setForm] = useState({ email: '', password: '', confirm: '' })
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  function set(k: string, v: string) { setForm(f => ({ ...f, [k]: v })) }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    if (form.password.length < 8) { setError('Password must be at least 8 characters.'); return }
    if (form.password !== form.confirm) { setError("Passwords don't match."); return }
    setLoading(true)
    const { error } = await signUp(form.email, form.password)
    if (error) { setError(error.message); setLoading(false); return }
    navigate('/family/setup')
  }

  return (
    <div className="min-h-screen bg-[#FAFAF8] flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <div className="font-display text-2xl font-medium text-[#1A1A2E] mb-1">
            Pediatric<span style={{ color: '#7F77DD' }}>Housecalls</span>
          </div>
          <div className="text-[13px] text-[#999]">Create your family account</div>
        </div>

        <div className="bg-white border border-[#E8E8E4] rounded-xl shadow-sm p-7">
          <h1 className="font-display text-xl font-medium text-[#1A1A2E] mb-1">Create account</h1>
          <p className="text-[13px] text-[#999] mb-5">Your information is kept private and secure.</p>

          <form onSubmit={handleSubmit} className="space-y-4">
            <Input label="Email" type="email" placeholder="you@email.com" value={form.email} onChange={e => set('email', e.target.value)} required />
            <Input label="Password" type="password" placeholder="8+ characters" value={form.password} onChange={e => set('password', e.target.value)} required />
            <Input label="Confirm password" type="password" placeholder="••••••••" value={form.confirm} onChange={e => set('confirm', e.target.value)} required />
            {error && <div className="p-3 rounded-lg bg-[#FCEBEB] text-[13px] text-[#791F1F]">{error}</div>}
            <Button type="submit" className="w-full !py-2.5" loading={loading}>Create account</Button>
          </form>

          <p className="text-center text-[13px] text-[#999] mt-5">
            Already have an account?{' '}
            <Link to="/family/login" className="text-[#7F77DD] font-medium hover:underline">Sign in</Link>
          </p>
        </div>
      </div>
    </div>
  )
}
