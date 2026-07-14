import type { NeonQueryFunction } from '@neondatabase/serverless'

const PAYER_IDS: Record<string, string> = {
  'bcbs': 'UPICO', 'bcbs of nc': 'UPICO', 'bcbs nc': 'UPICO',
  'blue cross': 'UPICO', 'blue cross nc': 'UPICO',
  'blue cross blue shield': 'UPICO', 'blue cross blue shield of nc': 'UPICO',
  'blue cross blue shield nc': 'UPICO',
  'aetna': '60054', 'cigna': '62308',
  'united healthcare': '87726', 'united health care': '87726', 'uhc': '87726',
  'umr': '39026', 'humana': '61101',
  'phcs': '52133', 'multiplan': '52133',
  'coventry': '38217', 'select health': '53589',
  'medcost': '56196', 'healthgram': '56162',
  'bright health': '98798', 'bright healthcare': '98798',
}

function resolvePayer(name: string | null): string | null {
  if (!name) return null
  return PAYER_IDS[name.toLowerCase().trim()] ?? null
}

export async function generateClaimForNote(
  sql: NeonQueryFunction<false, false>,
  encounterNoteId: string,
  practiceId: string
): Promise<{ claim?: any; skipped?: string; error?: string }> {
  // Skip if claim already exists
  const [existing] = await sql`
    SELECT id FROM claims WHERE encounter_note_id = ${encounterNoteId}::uuid AND practice_id = ${practiceId}::uuid
  `
  if (existing) return { skipped: 'Claim already exists' }

  const [note] = await sql`SELECT * FROM encounter_notes WHERE id = ${encounterNoteId}::uuid AND practice_id = ${practiceId}::uuid`
  if (!note) return { error: 'Note not found' }
  if (!note.is_signed) return { error: 'Note must be signed' }

  const [appt] = note.appointment_id
    ? await sql`SELECT * FROM appointments WHERE id = ${note.appointment_id}::uuid AND practice_id = ${practiceId}::uuid`
    : [null]
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
  const total = cptCodes.reduce((s: number, c: any) => s + (parseFloat(c.charge_amount) || 0), 0)
  const pos = cptCodes[0]?.place_of_service ?? (appt?.visit_type?.toLowerCase().includes('tele') ? '10' : '12')
  const payerName = child?.insurance_provider ?? null
  const payerId = resolvePayer(payerName)

  const [claim] = await sql`
    INSERT INTO claims (
      practice_id, encounter_note_id, appointment_id, child_id, provider_id,
      payer_name, payer_id,
      subscriber_name, subscriber_dob, subscriber_gender, member_id, group_number,
      service_date, place_of_service,
      diagnoses, cpt_codes, total_charge,
      rendering_provider_name, rendering_provider_npi, rendering_provider_taxonomy,
      patient_first_name, patient_last_name, patient_dob, patient_gender,
      patient_address, patient_city, patient_state, patient_zip
    ) VALUES (
      ${practiceId}::uuid, ${encounterNoteId}::uuid,
      ${note.appointment_id ?? null}::uuid, ${note.child_id ?? null}::uuid, ${note.provider_id ?? null}::uuid,
      ${payerName}, ${payerId},
      ${child?.insurance_subscriber_name ?? null}, ${child?.insurance_subscriber_dob ?? null},
      ${child?.insurance_subscriber_gender ?? null}, ${child?.insurance_member_id ?? null},
      ${child?.insurance_group_number ?? null},
      ${appt?.scheduled_date ?? null}, ${pos},
      ${JSON.stringify(note.diagnoses ?? [])}::jsonb, ${JSON.stringify(cptCodes)}::jsonb, ${total},
      ${provider?.name ?? null}, ${provider?.npi ?? null}, ${provider?.taxonomy_code ?? null},
      ${child?.first_name ?? null}, ${child?.last_name ?? null},
      ${child?.date_of_birth ?? null}, ${child?.gender ?? null},
      ${family?.address ?? null}, ${family?.city ?? null}, ${family?.state ?? null}, ${family?.zip ?? null}
    )
    RETURNING *`

  return { claim }
}
