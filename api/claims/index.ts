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

const PAYER_IDS: Record<string, string> = {
  'bcbs': '560',
  'bcbs of nc': '560',
  'bcbs nc': '560',
  'blue cross': '560',
  'blue cross blue shield': '560',
  'blue cross blue shield of nc': '560',
  'aetna': '60054',
  'cigna': '62308',
  'united healthcare': '87726',
  'united health care': '87726',
  'uhc': '87726',
  'umr': '39026',
  'humana': '61101',
  'phcs': '52133',
  'multiplan': '52133',
  'coventry': '38217',
  'select health': '53589',
  'medcost': '56196',
  'healthgram': '56162',
  'bright health': '98798',
  'bright healthcare': '98798',
}

function resolvePayer(name: string | null): string | null {
  if (!name) return null
  return PAYER_IDS[name.toLowerCase().trim()] ?? null
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  let sub: string
  try { sub = await verifyToken(req.headers.authorization) } catch {
    return res.status(401).json({ error: 'Unauthorized' })
  }
  const sql = neon(process.env.DATABASE_URL!)

  const providerRows = await sql`SELECT practice_id FROM providers WHERE cognito_sub = ${sub} LIMIT 1`
  if (!providerRows.length) return res.status(403).json({ error: 'Provider not found' })
  const practiceId = providerRows[0].practice_id as string

  // GET — list claims or unbilled notes
  if (req.method === 'GET') {
    const { status, unbilled } = req.query as Record<string, string>

    if (unbilled === 'true') {
      // Signed notes with CPT codes + diagnoses that have no claim yet
      const rows = await sql`
        SELECT
          en.id AS note_id,
          en.appointment_id,
          en.child_id,
          en.provider_id,
          en.diagnoses,
          en.cpt_codes,
          en.signed_at,
          a.scheduled_date,
          a.visit_type,
          a.zone,
          c.first_name AS child_first_name,
          c.last_name  AS child_last_name,
          c.insurance_provider,
          c.insurance_member_id,
          p.name AS provider_name
        FROM encounter_notes en
        LEFT JOIN appointments a ON a.id = en.appointment_id
        LEFT JOIN children c ON c.id = en.child_id
        LEFT JOIN providers p ON p.id = en.provider_id
        LEFT JOIN claims cl ON cl.encounter_note_id = en.id
        WHERE en.is_signed = true
          AND en.practice_id = ${practiceId}::uuid
          AND cl.id IS NULL
        ORDER BY a.scheduled_date DESC NULLS LAST`
      return res.json(rows)
    }

    if (status) {
      const rows = await sql`
        SELECT cl.*, c.first_name AS child_first_name, c.last_name AS child_last_name
        FROM claims cl
        LEFT JOIN children c ON c.id = cl.child_id
        WHERE cl.status = ${status} AND cl.practice_id = ${practiceId}::uuid
        ORDER BY cl.created_at DESC`
      return res.json(rows)
    }

    const rows = await sql`
      SELECT cl.*, c.first_name AS child_first_name, c.last_name AS child_last_name
      FROM claims cl
      LEFT JOIN children c ON c.id = cl.child_id
      WHERE cl.practice_id = ${practiceId}::uuid
      ORDER BY cl.created_at DESC`
    return res.json(rows)
  }

  // POST — generate a claim from an encounter note
  if (req.method === 'POST') {
    const { encounter_note_id } = req.body
    if (!encounter_note_id) return res.status(400).json({ error: 'encounter_note_id required' })

    // Check not already claimed
    const [existing] = await sql`SELECT id FROM claims WHERE encounter_note_id = ${encounter_note_id}::uuid AND practice_id = ${practiceId}::uuid`
    if (existing) return res.status(409).json({ error: 'Claim already exists for this note', claim_id: existing.id })

    // Load note + appointment + child + provider
    const [note] = await sql`SELECT * FROM encounter_notes WHERE id = ${encounter_note_id}::uuid AND practice_id = ${practiceId}::uuid`
    if (!note) return res.status(404).json({ error: 'Note not found' })
    if (!note.is_signed) return res.status(400).json({ error: 'Note must be signed before generating a claim' })

    const [appt] = await sql`SELECT * FROM appointments WHERE id = ${note.appointment_id}::uuid AND practice_id = ${practiceId}::uuid`
    const [child] = note.child_id
      ? await sql`SELECT * FROM children WHERE id = ${note.child_id}::uuid AND practice_id = ${practiceId}::uuid`
      : [null]
    const [provider] = note.provider_id
      ? await sql`SELECT name, npi, taxonomy_code FROM providers WHERE id = ${note.provider_id}::uuid AND practice_id = ${practiceId}::uuid`
      : [null]
    const [family] = child?.family_id
      ? await sql`SELECT address, city, state, zip FROM family_profiles WHERE id = ${child.family_id}::uuid AND practice_id = ${practiceId}::uuid`
      : [null]

    const allCptCodes = Array.isArray(note.cpt_codes) ? note.cpt_codes : []
    const cptCodes = allCptCodes.filter((c: any) => c.category !== 'Non-Covered Services')
    const total = cptCodes.reduce((s: number, c: any) => s + parseFloat(c.charge_amount ?? 0), 0)

    // Determine place of service from CPT codes (use first billable code's POS, fallback to 12)
    const pos = cptCodes[0]?.place_of_service ?? (appt?.visit_type?.toLowerCase().includes('tele') ? '10' : '12')

    const payerName = child?.insurance_provider ?? null
    const payerId = resolvePayer(payerName)

    const [claim] = await sql`
      INSERT INTO claims (
        practice_id,
        encounter_note_id, appointment_id, child_id, provider_id,
        payer_name, payer_id,
        subscriber_name, subscriber_dob, subscriber_gender,
        member_id, group_number,
        service_date, place_of_service,
        diagnoses, cpt_codes, total_charge,
        rendering_provider_name, rendering_provider_npi, rendering_provider_taxonomy,
        patient_first_name, patient_last_name, patient_dob, patient_gender,
        patient_address, patient_city, patient_state, patient_zip
      ) VALUES (
        ${practiceId}::uuid,
        ${encounter_note_id}::uuid,
        ${note.appointment_id}::uuid,
        ${note.child_id ?? null}::uuid,
        ${note.provider_id ?? null}::uuid,
        ${payerName},
        ${payerId},
        ${child?.insurance_subscriber_name ?? null},
        ${child?.insurance_subscriber_dob ?? null},
        ${child?.insurance_subscriber_gender ?? null},
        ${child?.insurance_member_id ?? null},
        ${child?.insurance_group_number ?? null},
        ${appt?.scheduled_date ?? null},
        ${pos},
        ${JSON.stringify(note.diagnoses ?? [])}::jsonb,
        ${JSON.stringify(cptCodes)}::jsonb,
        ${total},
        ${provider?.name ?? null},
        ${provider?.npi ?? null},
        ${provider?.taxonomy_code ?? null},
        ${child?.first_name ?? null},
        ${child?.last_name ?? null},
        ${child?.date_of_birth ?? null},
        ${child?.gender ?? null},
        ${family?.address ?? null},
        ${family?.city ?? null},
        ${family?.state ?? null},
        ${family?.zip ?? null}
      )
      RETURNING *`
    return res.status(201).json(claim)
  }

  res.status(405).json({ error: 'Method not allowed' })
}
