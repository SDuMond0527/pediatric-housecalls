import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { CreditCard, Lock } from 'lucide-react'
import { useFamilyAuth } from '../../contexts/FamilyAuthContext'
import { getFamilyAccessToken } from '../../contexts/FamilyAuthContext'
import { Button } from '../../components/ui/Button'
import { PRACTICE_NAME } from '../../lib/practice'

declare global {
  interface Window { Square: any }
}

function getSquareLocationId(familyState: string | null, zip: string | null): string {
  if (familyState === 'VA') return import.meta.env.VITE_SQUARE_LOCATION_ID_VIRGINIA || import.meta.env.VITE_SQUARE_LOCATION_ID
  if (zip?.startsWith('27'))  return import.meta.env.VITE_SQUARE_LOCATION_ID_RALEIGH  || import.meta.env.VITE_SQUARE_LOCATION_ID
  return import.meta.env.VITE_SQUARE_LOCATION_ID
}

function loadSquareScript(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (window.Square) { resolve(); return }
    const existing = document.getElementById('square-sdk')
    if (existing) {
      if (window.Square) { resolve(); return }
      existing.addEventListener('load', () => resolve())
      existing.addEventListener('error', () => reject(new Error('Failed to load payment SDK')))
      return
    }
    const script = document.createElement('script')
    script.id = 'square-sdk'
    const appId = import.meta.env.VITE_SQUARE_APP_ID || ''
    script.src = appId.startsWith('sandbox-')
      ? 'https://sandbox.web.squarecdn.com/v1/square.js'
      : 'https://web.squarecdn.com/v1/square.js'
    script.onload  = () => resolve()
    script.onerror = () => reject(new Error('Failed to load payment SDK'))
    document.head.appendChild(script)
  })
}

export function FamilyAddCard() {
  const { user, family, loading, refreshFamily } = useFamilyAuth()
  const navigate = useNavigate()

  const cardRef = useRef<any>(null)
  const [cardReady, setCardReady]   = useState(false)
  const [cardError, setCardError]   = useState('')
  const [cardSaving, setCardSaving] = useState(false)

  // Redirect to login if not authenticated
  useEffect(() => {
    if (!loading && !user) navigate('/family/login')
    if (!loading && user && !family) navigate('/family/setup')
  }, [user, family, loading])

  // Load Square SDK
  useEffect(() => {
    if (!user || loading) return
    let destroyed = false
    setCardReady(false)
    setCardError('')

    async function initSquare() {
      try {
        if (!import.meta.env.VITE_SQUARE_APP_ID || !import.meta.env.VITE_SQUARE_LOCATION_ID) {
          throw new Error('Payment system is not configured. Please contact support.')
        }
        await loadSquareScript()
        const payments = window.Square.payments(
          import.meta.env.VITE_SQUARE_APP_ID,
          getSquareLocationId(family?.state ?? null, family?.zip ?? null),
        )
        const card = await payments.card()
        if (destroyed) { await card.destroy(); return }
        await card.attach('#square-card-container')
        cardRef.current = card
        setCardReady(true)
      } catch (e: any) {
        setCardError(e.message || 'Could not load payment form. Please refresh.')
      }
    }

    initSquare()
    return () => {
      destroyed = true
      cardRef.current?.destroy()
      cardRef.current = null
    }
  }, [user, loading])

  async function saveCard() {
    if (!cardRef.current || !cardReady) return
    setCardSaving(true); setCardError('')

    const result = await cardRef.current.tokenize()
    if (result.status !== 'OK') {
      setCardError(result.errors?.[0]?.message || 'Card verification failed. Please check your details.')
      setCardSaving(false)
      return
    }

    const token = await getFamilyAccessToken()
    const resp = await fetch('/api/save-payment-method', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ nonce: result.token }),
    })
    const data = await resp.json().catch(() => ({}))
    if (!resp.ok || !data?.ok) {
      setCardError(data?.error || 'Could not save your card. Please try again.')
      setCardSaving(false)
      return
    }

    await refreshFamily()
    navigate('/family/dashboard')
  }

  if (loading) return (
    <div className="min-h-screen flex items-center justify-center bg-[#FAFAF8]">
      <div className="font-display text-lg text-[#1A1A2E]/40">Loading…</div>
    </div>
  )

  return (
    <div className="min-h-screen bg-[#FAFAF8] flex items-start justify-center p-4 pt-12">
      <div className="w-full max-w-md">

        <div className="text-center mb-8">
          <div className="font-display text-2xl font-medium text-[#1A1A2E] mb-1">
            Pediatric<span style={{ color: '#7F77DD' }}>Housecalls</span>
          </div>
          <p className="text-[13px] text-[#999] mt-1">A card on file is required to book appointments</p>
        </div>

        <div className="bg-white border border-[#E8E8E4] rounded-xl shadow-sm p-7 space-y-5">
          <div>
            <h2 className="font-display text-lg font-medium text-[#1A1A2E] mb-1">Add a card on file</h2>
            <p className="text-[13px] text-[#555] leading-relaxed">
              We require a card on file to cover our{' '}
              <strong className="text-[#1A1A2E]">$75 late-cancellation fee</strong> for in-person visits
              cancelled within 2 hours of the scheduled time. We also require the card on file for convenience
              fees which will be automatically charged after the visit is completed. You will receive an emailed
              receipt from Square after your card has been charged. Please see payment policy on the booking
              confirmation page for further information.
            </p>
          </div>

          <div className="space-y-2">
            <label className="text-[11px] font-medium text-[#555] uppercase tracking-wider block">Card details</label>
            <div id="square-card-container"
              className="min-h-[90px] border border-[#E8E8E4] rounded-lg p-3 bg-white focus-within:border-[#7F77DD] transition-colors" />
            {!cardReady && !cardError && (
              <p className="text-[12px] text-[#999] text-center py-1">Loading secure payment form…</p>
            )}
          </div>

          <div className="flex items-center gap-2 p-3 bg-[#FAFAF8] border border-[#E8E8E4] rounded-lg">
            <Lock size={13} className="text-[#999] flex-shrink-0" />
            <p className="text-[11px] text-[#999] leading-snug">
              Your card is encrypted and stored securely by Square. {PRACTICE_NAME} never sees your full card number.
            </p>
          </div>

          {cardError && <div className="p-3 rounded-lg bg-[#FCEBEB] text-[13px] text-[#791F1F]">{cardError}</div>}

          <Button className="w-full !py-2.5" loading={cardSaving} disabled={!cardReady} onClick={saveCard}>
            <CreditCard size={15} /> Save card and continue
          </Button>
        </div>
      </div>
    </div>
  )
}
