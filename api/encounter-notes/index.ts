import type { VercelRequest, VercelResponse } from '@vercel/node'
import { neon } from '@neondatabase/serverless'
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
  let sub: string
  try {
    sub = await verifyToken(req.headers.authorization)
  } catch {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const sql = neon(process.env.DATABASE_URL!)

  const providerRows = await sql`SELECT practice_id FROM providers WHERE cognito_sub = ${sub} LIMIT 1`
  if (!providerRows.length) return res.status(403).json({ error: 'Provider not found' })
  const practiceId = providerRows[0].practice_id as string

  if (req.method === 'GET') {
    const { appointment_id, child_id } = req.query as Record<string, string>

    if (appointment_id) {
      const rows = await sql`SELECT * FROM encounter_notes WHERE appointment_id = ${appointment_id}::uuid AND practice_id = ${practiceId}::uuid LIMIT 1`
      return res.json(rows[0] ?? null)
    }

    if (child_id) {
      const rows = await sql`
        SELECT en.*, a.visit_type, a.scheduled_date, a.scheduled_time, a.zone,
               p.name as provider_name,
               COALESCE(en.pcp_faxed_to_name, pc.name) as pcp_fax_name
        FROM encounter_notes en
        JOIN appointments a ON a.id = en.appointment_id
        LEFT JOIN providers p ON p.id = en.provider_id
        LEFT JOIN children ch ON ch.id = en.child_id
        LEFT JOIN pcps pc ON pc.id = ch.pcp_id
        WHERE en.child_id = ${child_id}::uuid AND en.practice_id = ${practiceId}::uuid
        ORDER BY a.scheduled_date DESC`
      return res.json(rows)
    }

    return res.status(400).json({ error: 'appointment_id or child_id required' })
  }

  if (req.method === 'POST') {
    const { appointment_id, child_id, provider_id, note_type, chief_complaint, subjective, objective, assessment, plan, diagnoses, cpt_codes, photos, vaccine_administrations, iv_administration } = req.body
    if (!appointment_id) return res.status(400).json({ error: 'appointment_id required' })

    const diagnosesVal = diagnoses ?? []
    const cptCodesVal  = cpt_codes  ?? []
    const photosVal    = photos     ?? []

    const [row] = await sql`
      INSERT INTO encounter_notes (practice_id, appointment_id, child_id, provider_id, note_type, chief_complaint, subjective, objective, assessment, plan, diagnoses, cpt_codes, photos, vaccine_administrations, iv_administration)
      VALUES (
        ${practiceId}::uuid,
        ${appointment_id}::uuid,
        ${child_id ?? null}::uuid,
        ${provider_id ?? null}::uuid,
        ${note_type ?? null},
        ${chief_complaint ?? null},
        ${subjective ?? null},
        ${objective ?? null},
        ${assessment ?? null},
        ${plan ?? null},
        ${JSON.stringify(diagnosesVal)}::jsonb,
        ${JSON.stringify(cptCodesVal)}::jsonb,
        ${JSON.stringify(photosVal)}::jsonb,
        ${vaccine_administrations ? JSON.stringify(vaccine_administrations) : null}::jsonb,
        ${iv_administration ? JSON.stringify(iv_administration) : null}::jsonb
      )
      RETURNING *`
    if (child_id) {
      await sql`UPDATE appointments SET child_id = ${child_id}::uuid WHERE id = ${appointment_id}::uuid AND practice_id = ${practiceId}::uuid`
    }

    // RN IV fluids note pending signature → ping Dr. Sara DuMond (matches
    // the sign-restriction rule in EncounterNoteModal). Best-effort SMS +
    // email so the note doesn't sit unsigned. Fire and forget — never blocks
    // the response.
    try {
      const [apptRow] = await sql`SELECT visit_type FROM appointments WHERE id = ${appointment_id}::uuid AND practice_id = ${practiceId}::uuid LIMIT 1`
      const visitType = String((apptRow as any)?.visit_type ?? '')
      const isRnIvFluidsNote =
        /iv/i.test(visitType)
        && /fluid/i.test(visitType)
        && /(rn|administration|in-home)/i.test(visitType)
        && !/screening/i.test(visitType)
      if (isRnIvFluidsNote) {
        const [creatorRow] = provider_id
          ? await sql`SELECT name, role FROM providers WHERE id = ${provider_id}::uuid LIMIT 1`
          : [null]
        const creatorRole = String((creatorRow as any)?.role ?? '')
        const creatorName = String((creatorRow as any)?.name ?? '')
        if (creatorRole && creatorRole !== 'MD' && creatorRole !== 'PNP') {
          // Look up the supervising signer's phone/email. Currently Dr. Sara
          // DuMond per practice policy — matches the vaccine signing rule.
          const [signer] = await sql`SELECT name, phone, email FROM providers WHERE name = 'Dr. Sara DuMond' AND practice_id = ${practiceId}::uuid LIMIT 1`
          const [childRow] = child_id
            ? await sql`SELECT first_name, last_name FROM children WHERE id = ${child_id}::uuid LIMIT 1`
            : [null]
          const patientLabel = childRow
            ? [String((childRow as any).first_name || ''), String((childRow as any).last_name || '')].filter(Boolean).join(' ')
            : 'a patient'
          const PORTAL_URL = process.env.PORTAL_URL || 'https://phc-team.com'
          const PRACTICE_NAME = process.env.PRACTICE_NAME || 'Pediatric Housecalls'
          const smsBody = `${PRACTICE_NAME}: ${creatorName || 'RN'} completed an IV fluids visit note for ${patientLabel}. Please sign — ${PORTAL_URL}/today`
          const emailSubject = `[Sign] IV fluids note pending — ${patientLabel}`
          const emailHtml = `<!DOCTYPE html><html><body style="font-family:sans-serif;color:#1A1A2E;">
<h2>${PRACTICE_NAME} — IV fluids note pending your signature</h2>
<p><strong>${creatorName || 'The administering RN'}</strong> completed an in-home IV fluids visit note for <strong>${patientLabel}</strong> and left it as a draft for you to sign as the supervising / rendering provider.</p>
<p><a href="${PORTAL_URL}/today" style="background:#7F77DD;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none;">Open my schedule</a></p>
</body></html>`
          const TWILIO_SID = process.env.TWILIO_ACCOUNT_SID || ''
          const TWILIO_KEY = process.env.TWILIO_API_KEY_SID || ''
          const TWILIO_SEC = process.env.TWILIO_API_KEY_SECRET || ''
          const TWILIO_FROM = process.env.TWILIO_FROM_NUMBER || ''
          const RESEND_KEY = process.env.RESEND_API_KEY || ''
          const FROM_EMAIL = process.env.FROM_EMAIL || 'appointments@phcbooking.com'
          if (signer?.phone && TWILIO_SID && TWILIO_KEY) {
            fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`, {
              method: 'POST',
              headers: {
                Authorization: `Basic ${Buffer.from(`${TWILIO_KEY}:${TWILIO_SEC}`).toString('base64')}`,
                'Content-Type': 'application/x-www-form-urlencoded',
              },
              body: new URLSearchParams({ From: TWILIO_FROM, To: signer.phone as string, Body: smsBody }),
            }).catch(e => console.error('[rn-iv-note] SMS err:', e))
          }
          if (signer?.email && RESEND_KEY) {
            fetch('https://api.resend.com/emails', {
              method: 'POST',
              headers: { Authorization: `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({ from: `${PRACTICE_NAME} <${FROM_EMAIL}>`, to: signer.email, subject: emailSubject, html: emailHtml }),
            }).catch(e => console.error('[rn-iv-note] email err:', e))
          }
        }
      }
    } catch (e) {
      console.error('[rn-iv-note] notify err:', e)
    }

    return res.json(row)
  }

  res.status(405).json({ error: 'Method not allowed' })
}
