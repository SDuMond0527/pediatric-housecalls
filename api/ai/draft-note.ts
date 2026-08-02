import type { VercelRequest, VercelResponse } from '@vercel/node'
import Anthropic from '@anthropic-ai/sdk'
import { createRemoteJWKSet, jwtVerify } from 'jose'

async function verifyToken(authHeader: string | undefined): Promise<string> {
  if (!authHeader?.startsWith('Bearer ')) throw new Error('Missing token')
  const token = authHeader.slice(7)
  const region = process.env.VITE_AWS_REGION || 'us-east-2'
  const userPoolId = process.env.VITE_AWS_USER_POOL_ID || ''
  const JWKS = createRemoteJWKSet(new URL(`https://cognito-idp.${region}.amazonaws.com/${userPoolId}/.well-known/jwks.json`))
  const { payload } = await jwtVerify(token, JWKS, { issuer: `https://cognito-idp.${region}.amazonaws.com/${userPoolId}` })
  if (!payload.sub) throw new Error('No sub in token')
  return payload.sub
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  try {
    await verifyToken(req.headers.authorization)
  } catch {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const {
    chief_complaint,
    note_type,
    patient_age,
    vitals,
    existing_subjective,
    existing_objective,
  } = req.body as {
    chief_complaint?: string
    note_type?: string
    patient_age?: string
    vitals?: {
      temperature_f?: string
      heart_rate?: string
      respiratory_rate?: string
      oxygen_saturation?: string
      weight_lbs?: string
      height_in?: string
      systolic_bp?: string
      diastolic_bp?: string
    }
    existing_subjective?: string
    existing_objective?: string
  }

  if (!chief_complaint?.trim() && !existing_subjective?.trim()) {
    return res.status(400).json({ error: 'chief_complaint or existing_subjective required' })
  }

  const vitalsLines: string[] = []
  if (vitals?.temperature_f)    vitalsLines.push(`Temperature: ${vitals.temperature_f}°F`)
  if (vitals?.heart_rate)       vitalsLines.push(`Heart rate: ${vitals.heart_rate} bpm`)
  if (vitals?.respiratory_rate) vitalsLines.push(`Respiratory rate: ${vitals.respiratory_rate} breaths/min`)
  if (vitals?.oxygen_saturation)vitalsLines.push(`O2 saturation: ${vitals.oxygen_saturation}%`)
  if (vitals?.weight_lbs)       vitalsLines.push(`Weight: ${vitals.weight_lbs} lbs`)
  if (vitals?.height_in)        vitalsLines.push(`Height: ${vitals.height_in} in`)
  if (vitals?.systolic_bp && vitals?.diastolic_bp) vitalsLines.push(`BP: ${vitals.systolic_bp}/${vitals.diastolic_bp} mmHg`)

  const prompt = `You are a pediatric physician assistant helping draft a clinical SOAP note for a pediatric housecalls practice. The provider will review and edit everything — your job is to produce a solid first draft that saves them time.

Visit context:
- Visit type: ${note_type || 'In-person visit'}
- Patient age: ${patient_age || 'Pediatric patient'}
- Chief complaint: ${chief_complaint || '(see subjective below)'}
${vitalsLines.length ? `- Vitals:\n${vitalsLines.map(v => `  ${v}`).join('\n')}` : ''}
${existing_subjective ? `- Existing subjective notes: ${existing_subjective}` : ''}
${existing_objective ? `- Existing objective notes: ${existing_objective}` : ''}

Draft a SOAP note with exactly these four sections. Use plain clinical prose — no headers, no bullet points inside each section, no markdown. Each section should be 1-4 sentences appropriate to the complaint and visit type. If vitals are provided, incorporate them naturally into the objective. Keep assessment focused on the most likely diagnosis. Keep plan practical and specific to pediatric outpatient care.

Respond with valid JSON only, no explanation:
{
  "subjective": "...",
  "objective": "...",
  "assessment": "...",
  "plan": "..."
}`

  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
    const message = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    })

    const text = (message.content[0] as { type: string; text: string }).text.trim()
    const json = JSON.parse(text.replace(/^```json?\n?/, '').replace(/\n?```$/, ''))
    return res.status(200).json(json)
  } catch (err: any) {
    console.error('[ai/draft-note] error:', err?.message)
    return res.status(500).json({ error: err?.message || 'AI draft failed' })
  }
}
