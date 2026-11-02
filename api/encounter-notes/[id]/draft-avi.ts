import type { VercelRequest, VercelResponse } from '@vercel/node'
import { neon } from '@neondatabase/serverless'
import { createRemoteJWKSet, jwtVerify } from 'jose'

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || ''

const SYSTEM_PROMPT = `You are drafting after-visit instructions for a parent on behalf of a pediatric provider at an in-home pediatric practice. The provider has written an encounter note during a house call. Your job is to turn their clinical note into clear, parent-friendly instructions.

HARD RULES — do not break any of these:
- Only use information explicitly in the provider's Plan or Assessment. Never add medications, doses, dietary advice, or follow-up recommendations that aren't there.
- If the provider named a medication but did NOT specify a dose, say "take as prescribed" — never invent a dose.
- If a medication is on the patient's allergy list, refuse to recommend it and flag the conflict instead.
- Keep language at a 7th-grade reading level. Translate medical terms into plain English (e.g., "ear infection" not "AOM", "runny nose" not "rhinitis").
- Address the parent, not the child. ("Give Graham Motrin..." not "Take Motrin...")
- End with a specific "When to reach back out to us" section that reflects the provider's own red flags from the Plan.

OUTPUT FORMAT (use these three section headings exactly, as markdown H3):

### What we found today
2-3 short sentences in plain English explaining the diagnosis the provider wrote.

### What to do at home
Bulleted list. Medications first (with doses only if the provider specified them). Then home care. Then anything else the provider mentioned.

### When to reach back out to us
Bulleted list of specific symptoms/timeframes from the provider's follow-up instructions.`

async function verifyToken(authHeader: string | undefined): Promise<string> {
  if (!authHeader?.startsWith('Bearer ')) throw new Error('Missing token')
  const token = authHeader.slice(7)
  const region = process.env.VITE_AWS_REGION || 'us-east-2'
  const poolId = process.env.VITE_AWS_USER_POOL_ID || ''
  const JWKS = createRemoteJWKSet(new URL(`https://cognito-idp.${region}.amazonaws.com/${poolId}/.well-known/jwks.json`))
  const { payload } = await jwtVerify(token, JWKS, { issuer: `https://cognito-idp.${region}.amazonaws.com/${poolId}` })
  if (!payload.sub) throw new Error('No sub')
  return payload.sub as string
}

function ageText(dob: string | null): string {
  if (!dob) return ''
  const b = new Date(dob)
  const now = new Date()
  const years = now.getFullYear() - b.getFullYear() - (now < new Date(now.getFullYear(), b.getMonth(), b.getDate()) ? 1 : 0)
  if (years >= 2) return `${years} years old`
  const months = (now.getFullYear() - b.getFullYear()) * 12 + (now.getMonth() - b.getMonth())
  return `${months} months old`
}

/**
 * POST /api/encounter-notes/[id]/draft-avi
 *
 * Reads a signed-or-unsigned encounter note, sends its clinical sections
 * to Claude, returns a parent-friendly after-visit-instructions draft.
 * Provider reviews and edits before any send — this endpoint never
 * emails or saves anything to the parent-facing record.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' })

  let sub: string
  try { sub = await verifyToken(req.headers.authorization) }
  catch { return res.status(401).json({ error: 'Unauthorized' }) }

  const noteId = String(req.query.id ?? '')
  if (!noteId) return res.status(400).json({ error: 'note id required' })

  const sql = neon(process.env.DATABASE_URL!)
  const [provider] = await sql`SELECT practice_id FROM providers WHERE cognito_sub = ${sub} LIMIT 1`
  if (!provider) return res.status(403).json({ error: 'Provider not found' })

  const [note] = await sql`
    SELECT en.chief_complaint, en.assessment, en.plan,
           ch.first_name AS child_first_name, ch.date_of_birth AS child_dob, ch.gender AS child_gender,
           ch.allergies AS child_allergies, ch.current_medications AS child_meds,
           p.name AS provider_name,
           a.visit_type, a.scheduled_date
    FROM encounter_notes en
    LEFT JOIN children ch ON ch.id = en.child_id
    LEFT JOIN providers p ON p.id = en.provider_id
    LEFT JOIN appointments a ON a.id = en.appointment_id
    WHERE en.id = ${noteId}::uuid AND en.practice_id = ${provider.practice_id}::uuid
    LIMIT 1`
  if (!note) return res.status(404).json({ error: 'Encounter note not found' })

  const assessment = String(note.assessment ?? '').trim()
  const plan       = String(note.plan ?? '').trim()
  if (!assessment && !plan) {
    return res.status(422).json({ error: 'No assessment or plan on this encounter note yet.' })
  }

  const user = `Patient: ${note.child_first_name ?? 'Patient'} (${ageText(note.child_dob)}, ${note.child_gender ?? ''})
Visit type: ${note.visit_type ?? ''}
Visit date: ${String(note.scheduled_date ?? '').slice(0, 10)}
Provider: ${note.provider_name ?? ''}

Allergies: ${note.child_allergies || 'None documented'}
Current medications: ${note.child_meds || 'None documented'}

Chief complaint: ${note.chief_complaint ?? ''}

Assessment (from provider's note):
${assessment}

Plan (from provider's note):
${plan}

Draft the after-visit instructions.`

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-opus-4-7',
        max_tokens: 1024,
        thinking: { type: 'adaptive' },
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: user }],
      }),
    })
    if (!r.ok) {
      const errText = await r.text().catch(() => '')
      console.error('[avi draft] anthropic error:', r.status, errText.slice(0, 400))
      return res.status(502).json({ error: 'Draft service is unavailable right now. Type your own or try again.' })
    }
    const data = await r.json()
    let text = ''
    for (const block of data.content ?? []) {
      if (block.type === 'text') text += block.text
    }
    return res.json({ text: text.trim() })
  } catch (e: any) {
    console.error('[avi draft] fetch failed:', e?.message)
    return res.status(502).json({ error: 'Draft service is unavailable right now. Type your own or try again.' })
  }
}
