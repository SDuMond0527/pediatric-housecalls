import type { VercelRequest, VercelResponse } from '@vercel/node'
import { neon } from '@neondatabase/serverless'
import { createRemoteJWKSet, jwtVerify } from 'jose'

// Provider AI Agent — Week 1 MVP. Sara 2026-11-10.
//
// POST /api/agent/chat
//   body: {
//     message: string,                   // provider's utterance
//     context: {
//       child_id?: string,               // currently-open patient chart
//       appointment_id?: string,         // currently-open appointment
//     },
//     conversation_id?: string,          // continues an existing session; omitted = new session
//   }
//
// Response (non-streaming for Phase 1 Week 1 — streaming is a polish
// for later): {
//   conversation_id: string,
//   reply: string,                        // text to show in the chat log
//   tool_calls: Array<{                   // present if the agent called any tools
//     name: string,
//     arguments: object,
//     result: object,
//   }>,
//   proposals: Array<{                    // write-tool proposals, Week 2+
//     id: string,
//     kind: string,
//     payload: object,
//   }>,
// }
//
// Week 1 tools wired: ONE — get_patient_context (read-only). Write
// tools (schedule_follow_up, prepare_prescription, etc.) land in Week 2+
// behind the proposals/authorize flow. See
// project_provider_ai_agent_phase1.md.
//
// LLM path: direct Anthropic API via ANTHROPIC_API_KEY (same as
// api/encounter-notes/[id]/draft-avi.ts). TODO: migrate to AWS Bedrock
// once Sara enables Claude model access in her AWS account — Bedrock
// is covered by her existing AWS BAA, which is the HIPAA-correct path
// she chose in the plan. API surface here stays stable across that
// migration; it's a vendor swap behind the callLLM() helper.

async function verifyToken(authHeader: string | undefined): Promise<string> {
  if (!authHeader?.startsWith('Bearer ')) throw new Error('Missing token')
  const token = authHeader.slice(7)
  const region = process.env.VITE_AWS_REGION || 'us-east-2'
  const poolId = process.env.VITE_AWS_USER_POOL_ID || ''
  const JWKS = createRemoteJWKSet(new URL(`https://cognito-idp.${region}.amazonaws.com/${poolId}/.well-known/jwks.json`))
  const { payload } = await jwtVerify(token, JWKS, { issuer: `https://cognito-idp.${region}.amazonaws.com/${poolId}` })
  if (!payload.sub) throw new Error('No sub in token')
  return payload.sub as string
}

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || ''
const MODEL = 'claude-sonnet-4-6'

// System prompt — baked guardrails. These are the SAFETY rules Sara
// listed in project_provider_ai_agent_phase1.md. They go in every
// turn so Claude can't be prompt-injected out of them.
const SYSTEM_PROMPT = `You are an agent embedded in GoRoam, a pediatric house-call EMR. You are speaking to a licensed clinician mid-workflow.

Your job: understand the clinician's request, call read-only tools to answer factual questions about the patient, and (in future phases) prepare write actions for the clinician to authorize. You are NOT a clinical reasoner.

HARD RULES:
1. Never diagnose, triage, assess risk, or recommend treatment. You summarize and prepare, nothing more.
2. Never execute a write action yourself. Every write goes through a proposal the clinician authorizes with a button click.
3. If a request is ambiguous, ASK for clarification. Never guess. Never make up facts not present in the patient's chart.
4. Dose and medication details must be rendered in structured form, not just prose. Repeat key numbers in words to catch decimal errors.
5. When discussing allergies or interactions, always defer to the EMR's existing allergy/interaction checks — do not bypass them.
6. If you don't have enough context (patient_id / appointment_id missing), say so. Don't guess which patient is meant.
7. You have access to tools. Use them to look things up; don't rely on general medical knowledge for facts about this patient.

TONE: Terse, clinician-to-clinician. Match the pace of a busy provider mid-day. Skip pleasantries.`

// Tool definitions — only ONE wired for Week 1 (read-only patient
// context). Write tools land in later weeks.
const TOOLS: any[] = [
  {
    name: 'get_patient_context',
    description: 'Read factual data from the currently-open patient chart. Use this whenever the clinician asks about allergies, medications, chronic problems, recent visits, pending orders, or demographic facts. Returns structured data from GoRoam. Only works when a child_id is in context.',
    input_schema: {
      type: 'object',
      properties: {
        fields: {
          type: 'array',
          items: {
            type: 'string',
            enum: [
              'demographics',    // name, DOB, age
              'allergies',       // text field
              'medications',     // text field
              'chronic_problems', // unresolved problem list
              'last_visit',      // date, chief complaint, assessment, plan
              'pending_orders',  // labs + radiology still open
              'insurance',       // payer + member ID
            ],
          },
          description: 'Which fields to look up. Request only what you need.',
        },
      },
      required: ['fields'],
    },
  },
]

async function callAnthropic(messages: any[], systemPrompt: string): Promise<any> {
  if (!ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not configured')
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1024,
      system: systemPrompt,
      tools: TOOLS,
      messages,
    }),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Anthropic error ${res.status}: ${body.slice(0, 300)}`)
  }
  return res.json()
}

async function runTool(
  sql: any,
  practiceId: string,
  toolName: string,
  args: any,
  ctx: { child_id?: string; appointment_id?: string },
): Promise<object> {
  if (toolName !== 'get_patient_context') {
    return { error: `Tool '${toolName}' is not available in this phase.` }
  }
  const fields: string[] = Array.isArray(args?.fields) ? args.fields : []
  const childId = ctx.child_id
  if (!childId) {
    return { error: 'No patient is currently open. Ask the clinician which patient they mean.' }
  }

  const out: Record<string, unknown> = {}
  const [child] = await sql`
    SELECT id, first_name, last_name, nickname, date_of_birth::text AS date_of_birth,
           allergies, current_medications, insurance_provider, insurance_member_id
    FROM children WHERE id = ${childId}::uuid AND practice_id = ${practiceId}::uuid`
  if (!child) return { error: 'Patient not found in this practice.' }

  if (fields.includes('demographics')) {
    out.demographics = {
      name: [child.first_name, child.last_name].filter(Boolean).join(' '),
      nickname: child.nickname ?? null,
      date_of_birth: child.date_of_birth,
    }
  }
  if (fields.includes('allergies')) {
    out.allergies = child.allergies ?? null
  }
  if (fields.includes('medications')) {
    out.medications = child.current_medications ?? null
  }
  if (fields.includes('insurance')) {
    out.insurance = {
      provider: child.insurance_provider ?? null,
      member_id: child.insurance_member_id ?? null,
    }
  }
  if (fields.includes('chronic_problems')) {
    try {
      const probs = await sql`
        SELECT id, label, icd10_code, added_at
        FROM chronic_problems
        WHERE child_id = ${childId}::uuid AND resolved_at IS NULL
        ORDER BY added_at ASC`
      out.chronic_problems = probs
    } catch {
      out.chronic_problems = []
    }
  }
  if (fields.includes('last_visit')) {
    const [prior] = await sql`
      SELECT en.id, en.chief_complaint, en.assessment, en.plan, en.note_type, en.signed_at,
             a.scheduled_date::text AS scheduled_date, a.visit_type, p.name AS provider_name
      FROM encounter_notes en
      JOIN appointments a ON a.id = en.appointment_id
      LEFT JOIN providers p ON p.id = en.provider_id
      WHERE en.child_id = ${childId}::uuid AND en.is_signed = true
      ORDER BY a.scheduled_date DESC LIMIT 1`
    out.last_visit = prior ?? null
  }
  if (fields.includes('pending_orders')) {
    let labs: any[] = []
    let rads: any[] = []
    try {
      labs = await sql`SELECT id, tests, status, created_at FROM lab_orders WHERE child_id = ${childId}::uuid AND status IN ('pending', 'submitted', 'partial') ORDER BY created_at DESC`
    } catch {}
    try {
      rads = await sql`SELECT id, tests, status, created_at FROM radiology_orders WHERE child_id = ${childId}::uuid AND status IN ('pending', 'submitted', 'partial') ORDER BY created_at DESC`
    } catch {}
    out.pending_orders = { labs, radiology: rads }
  }
  return out
}

async function bootstrap(sql: any): Promise<void> {
  try {
    // Session log — one row per turn. Lets us trace what the provider
    // said, what the agent planned, which tools fired.
    await sql`
      CREATE TABLE IF NOT EXISTS agent_conversations (
        id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        practice_id    uuid NOT NULL,
        provider_id    uuid NOT NULL,
        child_id       uuid,
        appointment_id uuid,
        started_at     timestamptz NOT NULL DEFAULT NOW(),
        last_turn_at   timestamptz NOT NULL DEFAULT NOW()
      )`
    await sql`
      CREATE TABLE IF NOT EXISTS agent_turns (
        id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        conversation_id uuid NOT NULL REFERENCES agent_conversations(id) ON DELETE CASCADE,
        role            text NOT NULL,  -- 'user' | 'assistant' | 'tool_result'
        content         jsonb NOT NULL,
        created_at      timestamptz NOT NULL DEFAULT NOW()
      )`
    // Proposal store for write-tool actions awaiting authorization.
    // Unused in Week 1 (no write tools yet) but ready for Week 2.
    await sql`
      CREATE TABLE IF NOT EXISTS agent_proposals (
        id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        conversation_id uuid NOT NULL,
        practice_id     uuid NOT NULL,
        provider_id     uuid NOT NULL,
        kind            text NOT NULL,   -- 'prescription' | 'lab_order' | 'follow_up' | ...
        payload         jsonb NOT NULL,
        status          text NOT NULL DEFAULT 'pending', -- 'pending' | 'authorized' | 'cancelled' | 'expired'
        created_at      timestamptz NOT NULL DEFAULT NOW(),
        decided_at      timestamptz,
        execution_result jsonb
      )`
    await sql`CREATE INDEX IF NOT EXISTS idx_agent_turns_conversation ON agent_turns(conversation_id, created_at)`
    await sql`CREATE INDEX IF NOT EXISTS idx_agent_proposals_pending   ON agent_proposals(provider_id, status, created_at)`
  } catch (e: any) {
    console.error('[agent/chat] bootstrap error (non-fatal):', e?.message)
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  let sub: string
  try { sub = await verifyToken(req.headers.authorization) }
  catch { return res.status(401).json({ error: 'Unauthorized' }) }

  const sql = neon(process.env.DATABASE_URL!)
  await bootstrap(sql)

  const [provider] = await sql`SELECT id, name, practice_id FROM providers WHERE cognito_sub = ${sub} LIMIT 1`
  if (!provider) return res.status(403).json({ error: 'Provider not found' })
  const practiceId = provider.practice_id as string

  const body = (req.body ?? {}) as {
    message?: string
    context?: { child_id?: string; appointment_id?: string }
    conversation_id?: string
  }
  const message = String(body.message ?? '').trim()
  if (!message) return res.status(400).json({ error: 'message required' })
  const ctx = body.context ?? {}

  // Resolve or open a conversation.
  let conversationId = body.conversation_id ?? null
  if (!conversationId) {
    const [conv] = await sql`
      INSERT INTO agent_conversations (practice_id, provider_id, child_id, appointment_id)
      VALUES (${practiceId}::uuid, ${provider.id}::uuid, ${ctx.child_id ?? null}::uuid, ${ctx.appointment_id ?? null}::uuid)
      RETURNING id`
    conversationId = conv.id
  }

  // Record the provider's utterance (audit + history).
  await sql`
    INSERT INTO agent_turns (conversation_id, role, content)
    VALUES (${conversationId}::uuid, 'user', ${JSON.stringify({ text: message, context: ctx })}::jsonb)`
  try {
    await sql`
      INSERT INTO phi_audit_log (provider_id, action, resource_type, resource_id)
      VALUES (${provider.id}::uuid, 'agent_utterance', 'agent_conversation', ${conversationId})`
  } catch {}

  // Pull prior turns to feed to Claude. Only keep the last 20 turns —
  // Sara's "session memory" spec wants continuity but not unbounded.
  const priorTurns = await sql`
    SELECT role, content FROM agent_turns
    WHERE conversation_id = ${conversationId}::uuid
    ORDER BY created_at ASC
    LIMIT 20`
  const messages: any[] = []
  for (const t of priorTurns as any[]) {
    if (t.role === 'user') messages.push({ role: 'user', content: (t.content as any)?.text ?? '' })
    else if (t.role === 'assistant') messages.push({ role: 'assistant', content: (t.content as any)?.blocks ?? [] })
    else if (t.role === 'tool_result') messages.push({ role: 'user', content: (t.content as any)?.blocks ?? [] })
  }
  // The latest user message was just written above and is already in
  // the array via priorTurns. Build the systemPrompt with runtime
  // context injected so Claude knows which patient is open.
  const systemWithCtx = SYSTEM_PROMPT + `

CURRENT CONTEXT:
  Provider: ${provider.name ?? 'Unknown'}
  Patient (child_id): ${ctx.child_id ?? 'NONE — ask clinician which patient they mean before calling tools'}
  Appointment (appointment_id): ${ctx.appointment_id ?? 'NONE'}`

  // Agentic loop — up to 4 tool rounds per turn. Keeps latency bounded.
  const toolCallsLog: Array<{ name: string; arguments: any; result: any }> = []
  let finalText = ''
  let claudeResp: any = null
  for (let round = 0; round < 4; round++) {
    claudeResp = await callAnthropic(messages, systemWithCtx)
    const stop = String(claudeResp?.stop_reason ?? '')
    const blocks: any[] = Array.isArray(claudeResp?.content) ? claudeResp.content : []
    // Store assistant turn
    await sql`
      INSERT INTO agent_turns (conversation_id, role, content)
      VALUES (${conversationId}::uuid, 'assistant', ${JSON.stringify({ blocks, stop_reason: stop })}::jsonb)`

    if (stop !== 'tool_use') {
      // No tool call — this is the final response.
      for (const b of blocks) if (b.type === 'text') finalText += b.text
      break
    }

    // Collect tool_use blocks, run each, feed results back.
    messages.push({ role: 'assistant', content: blocks })
    const toolResults: any[] = []
    for (const b of blocks) {
      if (b.type !== 'tool_use') continue
      let result: object
      try {
        result = await runTool(sql, practiceId, String(b.name), b.input ?? {}, ctx)
      } catch (e: any) {
        result = { error: `Tool crashed: ${e?.message ?? String(e)}` }
      }
      toolCallsLog.push({ name: b.name, arguments: b.input, result })
      try {
        await sql`
          INSERT INTO phi_audit_log (provider_id, action, resource_type, resource_id)
          VALUES (${provider.id}::uuid, 'agent_tool_call', 'agent_conversation', ${conversationId})`
      } catch {}
      toolResults.push({
        type: 'tool_result',
        tool_use_id: b.id,
        content: JSON.stringify(result),
      })
    }
    await sql`
      INSERT INTO agent_turns (conversation_id, role, content)
      VALUES (${conversationId}::uuid, 'tool_result', ${JSON.stringify({ blocks: toolResults })}::jsonb)`
    messages.push({ role: 'user', content: toolResults })
  }

  // Touch conversation.last_turn_at for session-memory ordering.
  try {
    await sql`UPDATE agent_conversations SET last_turn_at = NOW() WHERE id = ${conversationId}::uuid`
  } catch {}

  return res.status(200).json({
    conversation_id: conversationId,
    reply: finalText || '(no text reply)',
    tool_calls: toolCallsLog,
    proposals: [],  // Week 2+ populates this when write tools arrive.
  })
}
