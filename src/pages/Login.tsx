import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import { Input } from '../components/ui/Input'
import { Button } from '../components/ui/Button'

export function Login() {
  const { signIn } = useAuth()
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
    if (error) { setError('Invalid credentials. Please try again.'); setLoading(false) }
    else navigate('/')
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
          <form onSubmit={handleSubmit} className="space-y-4">
            <Input label="Email" type="email" placeholder="you@pediatrichousecalls.com"
              value={email} onChange={e => setEmail(e.target.value)} required />
            <Input label="Password" type="password" placeholder="••••••••"
              value={password} onChange={e => setPassword(e.target.value)} required />
            {error && <div className="p-3 rounded-lg bg-[#FCEBEB] text-[13px] text-[#791F1F]">{error}</div>}
            <Button type="submit" className="w-full !py-2.5" loading={loading}>Sign in to provider portal</Button>
          </form>
        </div>

        <p className="text-center text-[12px] text-[#999] mt-4">
          Contact your administrator if you need access.
        </p>
      </div>
    </div>
  )
}
