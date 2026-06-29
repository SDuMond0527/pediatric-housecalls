import { CheckCircle2 } from 'lucide-react'
import { Link } from 'react-router-dom'

export function GoRoamSuccess() {
  return (
    <div className="min-h-screen bg-[#FAFAF8] flex flex-col items-center justify-center p-6">
      <div className="max-w-md w-full text-center">
        <img src="/logo.png" alt="GoRoam Health" className="h-20 w-auto mx-auto mb-8" />
        <div className="w-16 h-16 rounded-full bg-[#E6F6F2] flex items-center justify-center mx-auto mb-5">
          <CheckCircle2 size={32} className="text-[#1D9E75]" />
        </div>
        <h1 className="font-display text-2xl font-medium text-[#1A1A2E] mb-3">You're all set!</h1>
        <p className="text-[15px] text-[#777] mb-2">
          Thank you for signing up for GoRoam Health. We'll be in touch within one business day to get your practice configured and your team onboarded.
        </p>
        <p className="text-[13px] text-[#999] mb-8">
          Check your email for a confirmation receipt from Stripe.
        </p>
        <Link to="/login" className="text-[#7F77DD] text-[13px] hover:underline">
          Go to provider portal →
        </Link>
      </div>
    </div>
  )
}
