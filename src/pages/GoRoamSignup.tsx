import { useState } from 'react'
import { Check } from 'lucide-react'
import { Button } from '../components/ui/Button'
import { Input } from '../components/ui/Input'

const PLANS = [
  {
    key: 'starter',
    name: 'Starter',
    price: 199,
    description: 'Perfect for small practices getting started',
    features: ['Up to 2 providers', 'Patient scheduling & management', 'Family portal', 'Encounter notes & EHR', 'Email & SMS notifications'],
  },
  {
    key: 'practice',
    name: 'Practice',
    price: 349,
    description: 'For growing practices with full needs',
    features: ['Up to 5 providers', 'Everything in Starter', 'Analytics & reporting', 'Insurance claims management', 'Waitlist management', 'Broadcast messaging'],
    highlight: true,
  },
  {
    key: 'enterprise',
    name: 'Enterprise',
    price: 599,
    description: 'Unlimited scale with white-label options',
    features: ['Unlimited providers', 'Everything in Practice', 'White-label branding', 'Custom integrations', 'Priority support', 'Dedicated onboarding'],
  },
]

export function GoRoamSignup() {
  const [selectedPlan, setSelectedPlan] = useState<string | null>(null)
  const [practiceName, setPracticeName] = useState('')
  const [adminName, setAdminName] = useState('')
  const [adminEmail, setAdminEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!selectedPlan) { setError('Please select a plan.'); return }
    setError('')
    setLoading(true)
    try {
      const res = await fetch('/api/stripe/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan: selectedPlan, practice_name: practiceName, admin_name: adminName, admin_email: adminEmail, phone }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Something went wrong')
      window.location.href = data.url
    } catch (err: any) {
      setError(err.message ?? 'Something went wrong')
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-[#FAFAF8]">
      <div className="bg-white border-b border-[#E8E8E4] px-6 py-5 text-center">
        <img src="/logo.png" alt="Pediatric Housecalls" className="h-16 w-auto mx-auto mb-3" />
        <div className="font-display text-2xl font-medium text-[#1A1A2E]">GoRoam Health</div>
        <div className="text-[14px] text-[#999] mt-1">The modern platform for house call pediatric practices</div>
      </div>

      <div className="max-w-5xl mx-auto px-6 py-12">
        <div className="text-center mb-10">
          <h1 className="font-display text-3xl font-medium text-[#1A1A2E] mb-2">Choose your plan</h1>
          <p className="text-[15px] text-[#777]">All plans include a 30-day free trial. No credit card charged until trial ends.</p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-5 mb-12">
          {PLANS.map(plan => (
            <button
              key={plan.key}
              onClick={() => setSelectedPlan(plan.key)}
              className={`text-left p-6 rounded-2xl border-2 transition-all relative ${
                selectedPlan === plan.key
                  ? 'border-[#7F77DD] bg-[#EEEDFE] shadow-lg'
                  : plan.highlight
                  ? 'border-[#7F77DD] bg-white shadow-md'
                  : 'border-[#E8E8E4] bg-white hover:border-[#AFA9EC] hover:shadow-sm'
              }`}
            >
              {plan.highlight && (
                <div className="absolute -top-3 left-1/2 -translate-x-1/2 bg-[#7F77DD] text-white text-[11px] font-semibold px-3 py-1 rounded-full">
                  Most popular
                </div>
              )}
              {selectedPlan === plan.key && (
                <div className="absolute top-4 right-4 w-6 h-6 rounded-full bg-[#7F77DD] flex items-center justify-center">
                  <Check size={12} className="text-white" />
                </div>
              )}
              <div className="font-display text-xl font-medium text-[#1A1A2E] mb-1">{plan.name}</div>
              <div className="text-[13px] text-[#999] mb-4">{plan.description}</div>
              <div className="mb-5">
                <span className="text-3xl font-bold text-[#1A1A2E]">${plan.price}</span>
                <span className="text-[13px] text-[#999]">/month</span>
              </div>
              <ul className="space-y-2">
                {plan.features.map(f => (
                  <li key={f} className="flex items-start gap-2 text-[13px] text-[#555]">
                    <Check size={13} className="text-[#7F77DD] flex-shrink-0 mt-0.5" />
                    {f}
                  </li>
                ))}
              </ul>
            </button>
          ))}
        </div>

        <div className="max-w-lg mx-auto bg-white border border-[#E8E8E4] rounded-2xl shadow-sm p-8">
          <h2 className="font-display text-xl font-medium text-[#1A1A2E] mb-1">Practice information</h2>
          <p className="text-[13px] text-[#999] mb-6">Tell us about your practice to get started.</p>

          <form onSubmit={handleSubmit} className="space-y-4">
            <Input label="Practice name" placeholder="e.g. Charlotte Pediatric Housecalls"
              value={practiceName} onChange={e => setPracticeName(e.target.value)} required />
            <Input label="Your name" placeholder="Dr. Jane Smith"
              value={adminName} onChange={e => setAdminName(e.target.value)} required />
            <Input label="Email address" type="email" placeholder="you@yourpractice.com"
              value={adminEmail} onChange={e => setAdminEmail(e.target.value)} required />
            <Input label="Phone number" type="tel" placeholder="(704) 555-0100"
              value={phone} onChange={e => setPhone(e.target.value)} />

            {selectedPlan && (
              <div className="p-3 bg-[#EEEDFE] rounded-lg text-[13px] text-[#3C3489]">
                Selected plan: <span className="font-semibold capitalize">{selectedPlan}</span> — ${PLANS.find(p => p.key === selectedPlan)?.price}/month
              </div>
            )}

            {error && <div className="p-3 rounded-lg bg-[#FCEBEB] text-[13px] text-[#791F1F]">{error}</div>}

            <Button type="submit" className="w-full !py-3" loading={loading}>
              Continue to payment →
            </Button>
          </form>

          <p className="text-center text-[12px] text-[#999] mt-4">
            30-day free trial · Cancel anytime · Secure payment via Stripe
          </p>
        </div>
      </div>
    </div>
  )
}
