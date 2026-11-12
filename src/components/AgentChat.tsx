import { useEffect, useRef, useState } from 'react'
import { Sparkles, Send, X, Loader2, ChevronDown, ChevronUp } from 'lucide-react'
import { agentChat, apiFetch, type AgentChatResponse } from '../lib/api'

// Floating AI Agent chat. Sara 2026-11-10 (Phase 1 Week 1).
//
// Always-on per Sara's decision. Follows the provider around via a
// floating bottom-right button. Clicking opens a panel that stays over
// the current page, keeping full context (child_id, appointment_id)
// visible to the server so the agent knows which patient / visit is
// open.
//
// Rev 2026-11-11: when patient context is present, the floating button
// and chat header show the patient's name + initials so the agent
// surface feels patient-specific instead of generic. Sara flagged that
// the previous version looked like "a general GoRoam feature" rather
// than one that's clearly tied to the open chart.

type PatientSummary = {
  name: string
  initials: string
  dob: string | null
  chart_number: string | null
}

async function fetchPatientSummary(childId: string): Promise<PatientSummary | null> {
  try {
    const rows = await apiFetch<any[]>(`/api/children?ids=${childId}`)
    const row = rows?.[0]
    if (!row) return null
    const first = String(row.first_name ?? '').trim()
    const last  = String(row.last_name  ?? '').trim()
    const name  = [first, last].filter(Boolean).join(' ') || row.display_label || 'Unknown'
    const initials = ((first[0] ?? '') + (last[0] ?? '')).toUpperCase() || name.slice(0, 2).toUpperCase()
    return {
      name,
      initials,
      dob: row.date_of_birth ? String(row.date_of_birth).slice(0, 10) : null,
      chart_number: row.chart_number ?? null,
    }
  } catch {
    return null
  }
}

export function AgentChat({ context }: {
  context?: { child_id?: string; appointment_id?: string }
}) {
  const [open, setOpen] = useState(false)
  const [input, setInput] = useState('')
  const [conversationId, setConversationId] = useState<string | null>(null)
  const [turns, setTurns] = useState<Array<{
    role: 'user' | 'agent'
    text: string
    tool_calls?: Array<{ name: string; arguments: any; result: any }>
  }>>([])
  const [sending, setSending] = useState(false)
  const [err, setErr] = useState('')
  const [patient, setPatient] = useState<PatientSummary | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!context?.child_id) { setPatient(null); return }
    let cancelled = false
    void fetchPatientSummary(context.child_id).then(p => { if (!cancelled) setPatient(p) })
    return () => { cancelled = true }
  }, [context?.child_id])

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [turns, sending])

  async function send() {
    const message = input.trim()
    if (!message || sending) return
    setErr('')
    setInput('')
    setTurns(prev => [...prev, { role: 'user', text: message }])
    setSending(true)
    try {
      const r: AgentChatResponse = await agentChat({
        message,
        context,
        conversation_id: conversationId ?? undefined,
      })
      setConversationId(r.conversation_id)
      setTurns(prev => [...prev, { role: 'agent', text: r.reply, tool_calls: r.tool_calls }])
    } catch (e: any) {
      setErr(e?.message ?? 'Agent error')
    } finally {
      setSending(false)
    }
  }

  return (
    <>
      {/* Floating button. When patient context is set, the pill shows
          the patient's initials + first name so the agent reads as
          "about this one patient" instead of "generic GoRoam
          feature." Sara 2026-11-11. */}
      {!open && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          title={patient ? `Open AI agent for ${patient.name}` : 'Open AI agent (no patient open)'}
          className="fixed bottom-6 right-6 z-40 inline-flex items-center gap-2 pl-1 pr-3.5 py-1 rounded-full bg-[#7F77DD] text-white shadow-lg hover:bg-[#6B64C8] text-[13px] font-medium"
        >
          <span className="inline-flex items-center justify-center w-7 h-7 rounded-full bg-white text-[#7F77DD] text-[11px] font-semibold">
            {patient ? patient.initials : <Sparkles size={13} />}
          </span>
          <span className="pr-1">
            Agent{patient ? ` · ${patient.name.split(' ')[0]}` : ''}
          </span>
        </button>
      )}

      {open && (
        <div className="fixed bottom-6 right-6 z-40 w-[90vw] sm:w-[420px] max-w-[500px] bg-white border border-[#E8E8E4] rounded-2xl shadow-2xl flex flex-col" style={{ maxHeight: '75vh' }}>
          {/* Header */}
          <div className="px-4 py-3 border-b border-[#E8E8E4] flex items-center justify-between bg-[#FAFAF8] rounded-t-2xl">
            <div className="flex items-center gap-2.5 min-w-0 flex-1">
              <div className="w-9 h-9 rounded-full bg-[#EEEDFE] flex items-center justify-center text-[#7F77DD] text-[12px] font-semibold flex-shrink-0">
                {patient ? patient.initials : <Sparkles size={15} />}
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-semibold text-[#1A1A2E] truncate">
                  {patient ? patient.name : 'AI agent'}
                </div>
                <div className="text-[10px] text-[#1A1A2E]/60 truncate">
                  {patient ? (
                    <>
                      Agent · {patient.chart_number ? `Chart ${patient.chart_number}` : 'Patient open'}
                      {patient.dob && ` · DOB ${patient.dob}`}
                      {context?.appointment_id && ' · visit'}
                    </>
                  ) : (
                    <>No patient open{context?.appointment_id && ' · visit context'}</>
                  )}
                </div>
              </div>
            </div>
            <button onClick={() => setOpen(false)} className="text-[#1A1A2E]/60 hover:text-[#1A1A2E] flex-shrink-0 ml-2"><X size={16} /></button>
          </div>

          {/* Guardrails banner — Sara's rule that clinicians should know what the agent is + is not. */}
          <div className="px-4 py-2 border-b border-[#F1EFE8] bg-[#FEF9E7] text-[11px] text-[#78350F] leading-snug">
            Read-only in Phase 1 Week 1. The agent can look up chart facts but can't prescribe, order, or schedule yet. Write tools are being built — nothing commits without your explicit click.
          </div>

          {/* Transcript */}
          <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-3 min-h-[200px]">
            {turns.length === 0 && (
              <div className="text-[12px] text-[#1A1A2E]/60 italic text-center mt-6">
                Try asking: "what are this patient's allergies?" or "when was the last visit?"
              </div>
            )}
            {turns.map((t, i) => (
              <ChatBubble key={i} turn={t} />
            ))}
            {sending && (
              <div className="flex items-center gap-2 text-[12px] text-[#1A1A2E]/60">
                <Loader2 size={12} className="animate-spin" /> Thinking…
              </div>
            )}
            {err && (
              <div className="text-[12px] text-[#991B1B] bg-[#FCEBEB] border border-[#F5C6C6] rounded-lg px-2.5 py-1.5">
                {err}
              </div>
            )}
          </div>

          {/* Composer */}
          <div className="p-3 border-t border-[#E8E8E4]">
            <div className="flex items-end gap-2">
              <textarea
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send() }
                }}
                placeholder="Ask the agent anything…"
                rows={1}
                className="flex-1 resize-none px-3 py-2 border border-[#E8E8E4] rounded-xl text-[13px] outline-none focus:border-[#7F77DD] max-h-32"
              />
              <button
                onClick={() => void send()}
                disabled={!input.trim() || sending}
                className="p-2 rounded-xl bg-[#7F77DD] text-white hover:bg-[#6B64C8] disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Send size={14} />
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

function ChatBubble({ turn }: { turn: {
  role: 'user' | 'agent'
  text: string
  tool_calls?: Array<{ name: string; arguments: any; result: any }>
} }) {
  const [showTools, setShowTools] = useState(false)
  if (turn.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] bg-[#7F77DD] text-white rounded-2xl rounded-br-md px-3 py-2 text-[13px] leading-snug whitespace-pre-wrap">
          {turn.text}
        </div>
      </div>
    )
  }
  return (
    <div className="flex justify-start">
      <div className="max-w-[90%] space-y-1.5">
        <div className="bg-[#F1EFE8] text-[#1A1A2E] rounded-2xl rounded-bl-md px-3 py-2 text-[13px] leading-snug whitespace-pre-wrap">
          {turn.text}
        </div>
        {turn.tool_calls && turn.tool_calls.length > 0 && (
          <div>
            <button
              onClick={() => setShowTools(s => !s)}
              className="text-[10px] text-[#7F77DD] hover:underline inline-flex items-center gap-1"
            >
              {showTools ? <ChevronUp size={9} /> : <ChevronDown size={9} />}
              {turn.tool_calls.length} data lookup{turn.tool_calls.length === 1 ? '' : 's'}
            </button>
            {showTools && (
              <div className="mt-1 space-y-1">
                {turn.tool_calls.map((tc, i) => (
                  <pre key={i} className="text-[10px] font-mono bg-[#FAFAF8] border border-[#E8E8E4] rounded-lg p-2 overflow-x-auto whitespace-pre-wrap">
                    {tc.name}({JSON.stringify(tc.arguments)}){'\n→ '}{JSON.stringify(tc.result).slice(0, 400)}
                  </pre>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
