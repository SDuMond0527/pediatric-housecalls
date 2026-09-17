import type { VercelRequest, VercelResponse } from '@vercel/node'
import { neon } from '@neondatabase/serverless'
import { createRemoteJWKSet, jwtVerify } from 'jose'

const PRACTICE_NAME = process.env.PRACTICE_NAME || 'Pediatric House Calls PLLC'

async function verifyFamilyToken(authHeader: string | undefined): Promise<string> {
  if (!authHeader?.startsWith('Bearer ')) throw new Error('Missing token')
  const token = authHeader.slice(7)
  const region = process.env.VITE_AWS_REGION || 'us-east-2'
  const poolId = process.env.VITE_FAMILY_USER_POOL_ID || ''
  const JWKS = createRemoteJWKSet(new URL(`https://cognito-idp.${region}.amazonaws.com/${poolId}/.well-known/jwks.json`))
  const { payload } = await jwtVerify(token, JWKS, { issuer: `https://cognito-idp.${region}.amazonaws.com/${poolId}` })
  if (!payload.sub) throw new Error('No sub')
  return payload.sub as string
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  let sub: string
  try {
    sub = await verifyFamilyToken(req.headers.authorization)
  } catch {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const sql = neon(process.env.DATABASE_URL!)

  const [fam] = await sql`
    SELECT id, practice_id FROM family_profiles WHERE cognito_sub = ${sub} LIMIT 1
  `
  if (!fam) return res.json([])

  const children = await sql`
    SELECT id, first_name, last_name FROM children WHERE family_id = ${fam.id}::uuid
  `
  if (!children.length) return res.json([])

  const childIds = children.map((c: any) => c.id as string)
  const childMap: Record<string, string> = {}
  children.forEach((c: any) => { childMap[c.id] = `${c.first_name} ${c.last_name}`.trim() })

  // Single-note HTML download — /api/family/encounter-notes?id=<UUID>&format=html.
  // Auth is the family Cognito token; ownership is enforced by matching
  // the note's child_id against the family's children. Family-friendly
  // template (no fax boilerplate, no CPT / billing details).
  if (req.query.id && (req.query.format === 'html' || req.query.download === '1')) {
    const noteId = String(req.query.id)
    const [note] = await sql`
      SELECT en.*, a.scheduled_date, a.scheduled_time, a.visit_type,
             a.after_visit_instructions,
             p.name AS provider_name,
             c.first_name, c.last_name, c.date_of_birth
      FROM encounter_notes en
      LEFT JOIN appointments a ON a.id = en.appointment_id
      LEFT JOIN providers p ON p.id = a.provider_id
      LEFT JOIN children c ON c.id = en.child_id
      WHERE en.id = ${noteId}::uuid
        AND en.practice_id = ${fam.practice_id}::uuid
        AND en.child_id = ANY(${childIds}::uuid[])
        AND en.is_signed = true
      LIMIT 1
    `
    if (!note) return res.status(404).json({ error: 'Note not found' })

    const fmtDate = (d: any) => {
      if (!d) return '—'
      try { return new Date(String(d)).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) }
      catch { return String(d) }
    }
    const esc = (s: any) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]!))
    const diagnoses: { code?: string; name?: string }[] = Array.isArray(note.diagnoses) ? note.diagnoses : []
    const childName = [note.first_name, note.last_name].filter(Boolean).join(' ') || childMap[note.child_id] || 'Patient'

    const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<title>Visit note — ${esc(childName)} — ${esc(fmtDate(note.scheduled_date))}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif; font-size: 13px; color: #1A1A2E; margin: 40px; line-height: 1.55; max-width: 800px; }
  .header { border-bottom: 2px solid #7F77DD; padding-bottom: 14px; margin-bottom: 24px; }
  .practice { font-size: 20px; font-weight: 700; color: #1A1A2E; }
  .subtitle { color: #555; font-size: 12px; margin-top: 4px; }
  .meta { display: grid; grid-template-columns: 1fr 1fr; gap: 6px 24px; margin-bottom: 24px; background: #FAFAF8; padding: 14px 16px; border-radius: 8px; }
  .meta-label { font-weight: 600; font-size: 10px; text-transform: uppercase; letter-spacing: 0.05em; color: #666; }
  .meta-val { font-size: 13px; color: #1A1A2E; }
  h3 { font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: #7F77DD; margin: 20px 0 6px; font-weight: 700; }
  .section { white-space: pre-wrap; padding: 4px 0 8px; }
  .dx { margin: 4px 0; }
  .dx code { background: #EEEDFE; color: #3C3489; padding: 2px 6px; border-radius: 4px; font-family: 'SF Mono', Menlo, monospace; font-size: 12px; font-weight: 600; margin-right: 6px; }
  .print-hint { margin-top: 32px; padding: 12px 16px; background: #EEEDFE; border-radius: 8px; color: #3C3489; font-size: 12px; }
  @media print { .print-hint { display: none; } body { margin: 20px; } }
</style>
</head><body>
<div class="header">
  <div class="practice">${esc(PRACTICE_NAME)}</div>
  <div class="subtitle">Visit note for ${esc(childName)}</div>
</div>

<div class="meta">
  <div><div class="meta-label">Patient</div><div class="meta-val">${esc(childName)}</div></div>
  <div><div class="meta-label">Date of birth</div><div class="meta-val">${esc(fmtDate(note.date_of_birth))}</div></div>
  <div><div class="meta-label">Date of service</div><div class="meta-val">${esc(fmtDate(note.scheduled_date))}${note.scheduled_time ? ' · ' + esc(note.scheduled_time) : ''}</div></div>
  <div><div class="meta-label">Visit type</div><div class="meta-val">${esc(note.visit_type || note.note_type || '—')}</div></div>
  <div><div class="meta-label">Provider</div><div class="meta-val">${esc(note.provider_name || '—')}</div></div>
  <div><div class="meta-label">Signed</div><div class="meta-val">${esc(fmtDate(note.signed_at))}</div></div>
</div>

${note.chief_complaint ? `<h3>Reason for visit</h3><div class="section">${esc(note.chief_complaint)}</div>` : ''}
${note.assessment      ? `<h3>Assessment</h3><div class="section">${esc(note.assessment)}</div>` : ''}
${note.plan            ? `<h3>Plan</h3><div class="section">${esc(note.plan)}</div>` : ''}
${note.after_visit_instructions ? `<h3>After-visit instructions</h3><div class="section">${esc(note.after_visit_instructions)}</div>` : ''}

${diagnoses.length ? `<h3>Diagnoses</h3>${diagnoses.map(d => `<div class="dx">${d.code ? `<code>${esc(d.code)}</code>` : ''}${esc(d.name ?? '')}</div>`).join('')}` : ''}

<div class="print-hint">
  <strong>To save as PDF:</strong> use your browser's Print (⌘P / Ctrl+P) → Destination: <em>Save as PDF</em>.
</div>

</body></html>`

    const dateStr = String(note.scheduled_date ?? note.signed_at ?? '').slice(0, 10) || 'undated'
    const slug = childName.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'patient'
    const filename = `visit_note_${slug}_${dateStr}.html`

    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`)
    res.setHeader('Cache-Control', 'private, max-age=300')
    return res.status(200).send(html)
  }

  const notes = await sql`
    SELECT
      en.id,
      en.child_id,
      en.appointment_id,
      en.note_type,
      en.chief_complaint,
      en.assessment,
      en.plan,
      en.diagnoses,
      en.vaccine_administrations,
      en.signed_at,
      a.visit_type,
      a.scheduled_date,
      a.scheduled_time,
      a.after_visit_instructions,
      p.name AS provider_name
    FROM encounter_notes en
    LEFT JOIN appointments a ON a.id = en.appointment_id
    LEFT JOIN providers p ON p.id = a.provider_id
    WHERE en.child_id = ANY(${childIds}::uuid[])
      AND en.practice_id = ${fam.practice_id}::uuid
      AND en.is_signed = true
    ORDER BY a.scheduled_date DESC NULLS LAST
    LIMIT 50
  `

  const result = notes.map((n: any) => ({
    id: n.id,
    child_id: n.child_id,
    child_name: childMap[n.child_id] ?? 'Unknown',
    appointment_id: n.appointment_id,
    note_type: n.note_type,
    chief_complaint: n.chief_complaint,
    assessment: n.assessment,
    plan: n.plan,
    after_visit_instructions: n.after_visit_instructions,
    // Send only diagnosis names, not billing codes
    diagnoses: (n.diagnoses ?? []).map((dx: any) => dx.name).filter(Boolean),
    vaccine_administrations: n.note_type === 'In-home vaccine administration' ? (n.vaccine_administrations ?? []) : undefined,
    signed_at: n.signed_at,
    visit_type: n.visit_type,
    scheduled_date: n.scheduled_date,
    scheduled_time: n.scheduled_time,
    provider_name: n.provider_name,
  }))

  return res.json(result)
}
