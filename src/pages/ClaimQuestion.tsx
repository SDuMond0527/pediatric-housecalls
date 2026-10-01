import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { HelpCircle, Send, CheckCircle } from 'lucide-react'
import { getClaimActivity, submitProviderReply } from '../lib/api'
import { Button } from '../components/ui/Button'

/**
 * Provider-facing page opened from the "billing question" email/SMS.
 * Shows the biller's question, a textarea for the reply, and posts
 * the response to /api/claims/[id]/provider-reply — which logs to
 * activity_log and flips the claim status back to pending_review.
 *
 * Auth is inherited from AppLayout (the provider must be signed in).
 * Sara 2026-09-30 — closes the loop on Andrea's Notify-Provider flow.
 */
export function ClaimQuestion() {
  const { claimId = '' } = useParams<{ claimId: string }>()
  const navigate = useNavigate()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [question, setQuestion] = useState<{ body: string; created_by_name: string | null; created_at: string } | null>(null)
  const [reply, setReply] = useState('')
  const [sending, setSending] = useState(false)
  const [done, setDone] = useState(false)

  useEffect(() => {
    if (!claimId) return
    setLoading(true)
    getClaimActivity(claimId)
      .then(({ entries }) => {
        // Latest biller_question entry that has no matching provider_response
        // after it. If none, no active question.
        const sorted = [...(entries ?? [])].sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
        let latestQuestion: typeof question = null
        for (const e of sorted) {
          if (e.kind === 'biller_question') {
            latestQuestion = { body: e.body, created_by_name: e.created_by_name, created_at: e.created_at }
          } else if (e.kind === 'provider_response') {
            latestQuestion = null // question got answered
          }
        }
        setQuestion(latestQuestion)
      })
      .catch(e => setError(e?.message ?? 'Failed to load'))
      .finally(() => setLoading(false))
  }, [claimId])

  async function handleSubmit() {
    if (!reply.trim()) return
    setSending(true); setError(null)
    try {
      await submitProviderReply(claimId, reply.trim())
      setDone(true)
    } catch (e: any) {
      setError(e?.message ?? 'Reply failed')
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="max-w-2xl mx-auto p-6">
      <div className="flex items-center gap-2 mb-1 text-[#7F77DD]">
        <HelpCircle size={16} />
        <span className="text-[11px] uppercase tracking-wider font-semibold">Billing question</span>
      </div>
      <h1 className="font-display text-xl font-medium text-[#1A1A2E] mb-4">Answer the biller</h1>

      {loading && <div className="text-[13px] text-[#1A1A2E]/60 py-8">Loading…</div>}

      {!loading && error && (
        <div className="mb-4 p-3 rounded-lg bg-[#FCEBEB] text-[13px] text-[#791F1F]">{error}</div>
      )}

      {!loading && !error && !question && !done && (
        <div className="p-4 rounded-lg bg-[#F1EFE8] text-[13px] text-[#1A1A2E]">
          No active biller question on this claim. It may have already been answered.
        </div>
      )}

      {!loading && question && !done && (
        <>
          <div className="mb-5 p-4 rounded-xl bg-[#EEEDFE] border border-[#AFA9EC]">
            <div className="text-[11px] uppercase tracking-wider font-semibold text-[#3C3489] mb-2">
              Question from {question.created_by_name || 'biller'}
            </div>
            <div className="text-[14px] text-[#1A1A2E] whitespace-pre-wrap leading-relaxed">{question.body}</div>
          </div>

          <label className="text-[11px] uppercase tracking-wider font-semibold text-[#555] block mb-1.5">Your reply</label>
          <textarea
            value={reply}
            onChange={e => setReply(e.target.value)}
            disabled={sending}
            rows={5}
            placeholder="Type your answer for the biller here…"
            className="w-full px-3 py-2.5 border border-[#E8E8E4] rounded-lg text-[14px] outline-none focus:border-[#7F77DD] resize-y" />

          <div className="mt-3 flex gap-2">
            <Button variant="teal" loading={sending} disabled={!reply.trim()} onClick={handleSubmit}>
              <Send size={13} /> Send reply
            </Button>
            <Button variant="secondary" onClick={() => navigate('/today')}>Cancel</Button>
          </div>

          <p className="mt-3 text-[12px] text-[#1A1A2E]/60">
            Your reply saves to the claim's activity log and moves the claim back to the biller's queue.
          </p>
        </>
      )}

      {done && (
        <div className="mt-2 p-4 rounded-xl bg-[#E1F5EE] border border-[#8FD8BE] flex items-start gap-2">
          <CheckCircle size={16} className="text-[#085041] mt-0.5" />
          <div>
            <div className="text-[14px] font-semibold text-[#085041]">Reply sent</div>
            <div className="text-[12px] text-[#085041] mt-0.5">The biller will see your response on the claim.</div>
            <button onClick={() => navigate('/today')} className="mt-3 text-[13px] text-[#7F77DD] hover:underline">
              Back to Today →
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
