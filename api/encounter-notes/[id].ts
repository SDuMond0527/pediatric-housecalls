import type { VercelRequest, VercelResponse } from '@vercel/node'
import { neon } from '@neondatabase/serverless'
import { createRemoteJWKSet, jwtVerify } from 'jose'

const PRACTICE_NAME = process.env.PRACTICE_NAME || 'Pediatric House Calls PLLC'
const PRACTICE_PHONE = process.env.PRACTICE_PHONE || ''

function toE164(fax: string): string {
  const digits = fax.replace(/\D/g, '')
  return digits.length === 10 ? `+1${digits}` : `+${digits}`
}

function buildNoteHtml(note: any, child: any, pcp: any, provider: any, appt: any): string {
  const fmtDate = (d: string | null | undefined) => {
    if (!d) return '—'
    try { return new Date(d).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) }
    catch { return d }
  }
  const diagnoses: { code: string; name: string }[] = Array.isArray(note.diagnoses) ? note.diagnoses : []
  const childName = [child?.first_name, child?.last_name].filter(Boolean).join(' ') || 'Unknown'

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<style>
  body { font-family: Arial, sans-serif; font-size: 13px; color: #222; margin: 40px; line-height: 1.5; }
  .header { border-bottom: 2px solid #333; padding-bottom: 12px; margin-bottom: 20px; }
  .practice { font-size: 18px; font-weight: bold; }
  .meta { display: grid; grid-template-columns: 1fr 1fr; gap: 4px 24px; margin-bottom: 20px; background: #f5f5f5; padding: 12px; border-radius: 4px; }
  .meta-label { font-weight: bold; font-size: 11px; text-transform: uppercase; color: #555; }
  h3 { font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em; color: #555; border-bottom: 1px solid #ddd; padding-bottom: 4px; margin: 16px 0 6px; }
  .section { margin-bottom: 12px; white-space: pre-wrap; }
  .dx { margin: 3px 0; }
  .footer { margin-top: 30px; border-top: 1px solid #ccc; padding-top: 12px; font-size: 11px; color: #777; }
</style>
</head><body>
<div class="header">
  <div class="practice">${PRACTICE_NAME}</div>
  <div style="font-size:12px;color:#555;margin-top:4px;">CONFIDENTIAL MEDICAL RECORD — FACSIMILE TRANSMISSION</div>
  ${PRACTICE_PHONE ? `<div style="font-size:12px;color:#555;">Tel: ${PRACTICE_PHONE}</div>` : ''}
</div>

<div class="meta">
  <div><div class="meta-label">Patient</div>${childName}</div>
  <div><div class="meta-label">Date of Birth</div>${fmtDate(child?.date_of_birth)}</div>
  <div><div class="meta-label">Date of Service</div>${fmtDate(appt?.scheduled_date)}</div>
  <div><div class="meta-label">Visit Type</div>${appt?.visit_type || '—'}</div>
  <div><div class="meta-label">Rendering Provider</div>${provider?.name || '—'}</div>
  <div><div class="meta-label">Signed</div>${fmtDate(note.signed_at)}</div>
</div>

${note.chief_complaint ? `<h3>Chief Complaint</h3><div class="section">${note.chief_complaint}</div>` : ''}
${note.subjective     ? `<h3>Subjective (History)</h3><div class="section">${note.subjective}</div>` : ''}
${note.objective      ? `<h3>Objective (Exam)</h3><div class="section">${note.objective}</div>` : ''}
${note.assessment     ? `<h3>Assessment</h3><div class="section">${note.assessment}</div>` : ''}
${note.plan           ? `<h3>Plan</h3><div class="section">${note.plan}</div>` : ''}

${diagnoses.length ? `<h3>Diagnoses</h3>${diagnoses.map(d => `<div class="dx"><strong>${d.code}</strong> — ${d.name}</div>`).join('')}` : ''}

<div class="footer">
  This fax is intended only for ${pcp?.name || 'the recipient practice'}. It may contain confidential health information protected by HIPAA.
  If received in error, please destroy and notify ${PRACTICE_NAME} at ${PRACTICE_PHONE || 'our office'}.
</div>
</body></html>`
}

async function faxNoteToPcp(note: any, practiceId: string, sql: any): Promise<void> {
  const projectId  = process.env.SINCH_PROJECT_ID
  const keyId      = process.env.SINCH_KEY_ID
  const keySecret  = process.env.SINCH_KEY_SECRET
  const fromNumber = process.env.SINCH_FAX_NUMBER

  if (!projectId || !keyId || !keySecret || !fromNumber) {
    console.log('[fax] Sinch credentials not configured — skipping')
    return
  }

  if (!note.child_id) return

  // Load child → PCP fax number
  const [child] = await sql`
    SELECT c.*, p.id AS pcp_id_val, p.name AS pcp_name, p.fax_number AS pcp_fax
    FROM children c
    LEFT JOIN pcps p ON p.id = c.pcp_id
    WHERE c.id = ${note.child_id}::uuid AND c.practice_id = ${practiceId}::uuid
    LIMIT 1
  `
  if (!child?.pcp_fax) {
    console.log(`[fax] No PCP fax on file for child ${note.child_id} — skipping`)
    return
  }

  const [provider] = note.provider_id
    ? await sql`SELECT name FROM providers WHERE id = ${note.provider_id}::uuid LIMIT 1`
    : [null]

  const [appt] = note.appointment_id
    ? await sql`SELECT scheduled_date, visit_type FROM appointments WHERE id = ${note.appointment_id}::uuid LIMIT 1`
    : [null]

  const html = buildNoteHtml(note, child, { name: child.pcp_name, fax_number: child.pcp_fax }, provider, appt)

  const form = new FormData()
  form.append('to', toE164(child.pcp_fax))
  form.append('from', toE164(fromNumber))
  form.append('file', new Blob([html], { type: 'text/html' }), 'note.html')

  const sinchRes = await fetch(
    `https://fax.api.sinch.com/v3/projects/${projectId}/faxes`,
    {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${keyId}:${keySecret}`).toString('base64'),
      },
      body: form,
    }
  )

  const result = await sinchRes.json().catch(() => ({}))

  if (sinchRes.ok) {
    await sql`
      UPDATE encounter_notes SET pcp_faxed_at = now(), pcp_fax_id = ${result.id ?? null}
      WHERE id = ${note.id}::uuid
    `
    console.log(`[fax] Sent note ${note.id} to ${child.pcp_name} (${child.pcp_fax}) — Sinch fax id: ${result.id}`)
  } else {
    console.error('[fax] Sinch error:', JSON.stringify(result))
  }
}

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
  let sub: string
  try {
    sub = await verifyToken(req.headers.authorization)
  } catch {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const sql = neon(process.env.DATABASE_URL!)
  const { id } = req.query as Record<string, string>
  if (!id) return res.status(400).json({ error: 'id required' })

  const providerRows = await sql`SELECT practice_id FROM providers WHERE cognito_sub = ${sub} LIMIT 1`
  if (!providerRows.length) return res.status(403).json({ error: 'Provider not found' })
  const practiceId = providerRows[0].practice_id as string

  if (req.method === 'GET') {
    const rows = await sql`SELECT * FROM encounter_notes WHERE id = ${id}::uuid AND practice_id = ${practiceId}::uuid LIMIT 1`
    return res.json(rows[0] ?? null)
  }

  // Admin-only PATCH: update diagnoses and/or cpt_codes on any note (including signed)
  if (req.method === 'PATCH') {
    const [provRow] = await sql`SELECT is_admin FROM providers WHERE cognito_sub = ${sub} AND practice_id = ${practiceId}::uuid LIMIT 1`
    if (!provRow?.is_admin) return res.status(403).json({ error: 'Admin only' })

    const { diagnoses, cpt_codes } = req.body
    const [row] = await sql`
      UPDATE encounter_notes SET
        diagnoses  = COALESCE(${diagnoses  != null ? JSON.stringify(diagnoses)  : null}::jsonb, diagnoses),
        cpt_codes  = COALESCE(${cpt_codes  != null ? JSON.stringify(cpt_codes)  : null}::jsonb, cpt_codes),
        updated_at = now()
      WHERE id = ${id}::uuid AND practice_id = ${practiceId}::uuid
      RETURNING *`
    if (!row) return res.status(404).json({ error: 'Note not found' })
    return res.json(row)
  }

  if (req.method === 'PUT') {
    const [existing] = await sql`SELECT is_signed FROM encounter_notes WHERE id = ${id}::uuid AND practice_id = ${practiceId}::uuid LIMIT 1`
    if (!existing) return res.status(404).json({ error: 'Note not found' })

    const { note_type, chief_complaint, subjective, objective, assessment, plan, diagnoses, cpt_codes, photos, is_signed, child_id } = req.body

    const unlocking = is_signed === false
    if (existing.is_signed && !unlocking) return res.status(403).json({ error: 'Cannot edit a signed note' })

    const signing = is_signed === true

    const [row] = await sql`
      UPDATE encounter_notes SET
        note_type       = COALESCE(${note_type ?? null}, note_type),
        chief_complaint = COALESCE(${chief_complaint ?? null}, chief_complaint),
        subjective      = COALESCE(${subjective ?? null}, subjective),
        objective       = COALESCE(${objective ?? null}, objective),
        assessment      = COALESCE(${assessment ?? null}, assessment),
        plan            = COALESCE(${plan ?? null}, plan),
        diagnoses       = COALESCE(${diagnoses != null ? JSON.stringify(diagnoses) : null}::jsonb, diagnoses),
        cpt_codes       = COALESCE(${cpt_codes != null ? JSON.stringify(cpt_codes) : null}::jsonb, cpt_codes),
        photos          = COALESCE(${photos != null ? JSON.stringify(photos) : null}::jsonb, photos),
        child_id        = COALESCE(${child_id ?? null}::uuid, child_id),
        is_signed       = ${signing},
        signed_at       = CASE WHEN ${signing} THEN now() WHEN ${unlocking} THEN NULL ELSE signed_at END,
        updated_at      = now()
      WHERE id = ${id}::uuid AND practice_id = ${practiceId}::uuid
      RETURNING *`
    if (child_id && row?.appointment_id) {
      await sql`UPDATE appointments SET child_id = ${child_id}::uuid WHERE id = ${row.appointment_id}::uuid AND practice_id = ${practiceId}::uuid`
    }
    if (signing && row?.child_id) {
      faxNoteToPcp(row, practiceId, sql).catch(err =>
        console.error('[fax] PCP fax failed:', err?.message)
      )
    }
    return res.json(row)
  }

  res.status(405).json({ error: 'Method not allowed' })
}
