import type { VercelRequest, VercelResponse } from '@vercel/node'
import { neon } from '@neondatabase/serverless'
import { createRemoteJWKSet, jwtVerify } from 'jose'
// Inlined from api/lib/applyClears.ts — Vercel treats every .ts file
// inside api/ as a serverless function. Files in api/lib/ that only
// export helpers (no default handler) crash the deploy with
// FUNCTION_INVOCATION_FAILED. Every consumer keeps its own copy of the
// helper. Keep in sync with peers.
const APPOINTMENTS_CLEARABLE = new Set<string>([
  'notes', 'after_visit_instructions', 'zone',
  'duration_minutes', 'second_provider_id',
])
async function applyAppointmentClears(
  sql: any,
  id: string,
  practiceId: string,
  requested: unknown,
): Promise<void> {
  const clears = Array.isArray(requested)
    ? (requested as unknown[]).filter((k): k is string => typeof k === 'string' && APPOINTMENTS_CLEARABLE.has(k))
    : []
  for (const field of clears) {
    switch (field) {
      case 'notes':                    await sql`UPDATE appointments SET notes                    = NULL WHERE id = ${id}::uuid AND practice_id = ${practiceId}::uuid`; break
      case 'after_visit_instructions': await sql`UPDATE appointments SET after_visit_instructions = NULL WHERE id = ${id}::uuid AND practice_id = ${practiceId}::uuid`; break
      case 'zone':                     await sql`UPDATE appointments SET zone                     = NULL WHERE id = ${id}::uuid AND practice_id = ${practiceId}::uuid`; break
      case 'duration_minutes':         await sql`UPDATE appointments SET duration_minutes         = NULL WHERE id = ${id}::uuid AND practice_id = ${practiceId}::uuid`; break
      case 'second_provider_id':       await sql`UPDATE appointments SET second_provider_id       = NULL WHERE id = ${id}::uuid AND practice_id = ${practiceId}::uuid`; break
    }
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

// Paired-visit aliases. Keep in sync with api/appointments/index.ts and
// src/lib/dualVisitTypes.ts.
const CMA_TELE_ALIASES = ['CMA + telemedicine', 'CMA + tele', 'CMA visit — paired with MD/NP telemedicine screening']
const IV_FLUIDS_ALIASES = ['In-home IV fluids', 'RN IV fluids', 'RN IV fluid visit — paired with MD/NP screening', 'RN in-home IV fluids administration', 'Video telemedicine screening for IV fluids']
const DUAL_VISIT_TYPES = [...CMA_TELE_ALIASES, ...IV_FLUIDS_ALIASES]

const VISIT_DURATIONS: Record<string, number> = {
  'In-home sick visit': 60,
  'Sports physical': 60,
  ...Object.fromEntries(CMA_TELE_ALIASES.map(k => [k, 30])),
  'Video telemedicine': 30,
  'Text visit': 15,
  ...Object.fromEntries(IV_FLUIDS_ALIASES.map(k => [k, 90])),
  'In-home CPR class (Heartsaver)': 240,
  'In-home CPR class (BLS)': 240,
  'In-home CPR class (Heartsaver Child and Infant First Aid, CPR, AED, choking, injury/environmental emergencies, opioid-associated emergencies (including how to use Narcan) with optional modules in adult CPR/AED)': 240,
  'In-home CPR class (BLS - Adult CPR/AED use, first aid basics, medical/injury/environmental emergencies, choking, opioid-associated emergencies (including how to use Narcan), recognizing mental health crisis signs in the workplace, with optional modules for child & infant CPR/AED)': 240,
}

function blockEndTime(startTime: string, visitType: string): string {
  const minutes = VISIT_DURATIONS[visitType] ?? 60
  const [h, m] = startTime.split(':').map(Number)
  const total = h * 60 + m + minutes
  const eh = Math.floor(total / 60) % 24
  const em = total % 60
  return `${eh.toString().padStart(2, '0')}:${em.toString().padStart(2, '0')}`
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  let sub: string
  try {
    sub = await verifyToken(req.headers.authorization)
  } catch {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  if (req.method !== 'PATCH') return res.status(405).json({ error: 'Method not allowed' })

  const sql = neon(process.env.DATABASE_URL!)

  const providerRows = await sql`SELECT practice_id FROM providers WHERE cognito_sub = ${sub} LIMIT 1`
  if (!providerRows.length) return res.status(403).json({ error: 'Provider not found' })
  const practiceId = providerRows[0].practice_id as string

  const { id } = req.query as { id: string }
  const { status, after_visit_instructions, visit_type, provider_id, scheduled_date, scheduled_time } = req.body

  let row: unknown

  // Look up the ref code from the CURRENT notes (before update). Used to find the
  // paired twin appointment for CMA+telemedicine / IV fluids visits so cancel and
  // reschedule stay in sync across both providers' schedules.
  async function findTwinId(): Promise<string | null> {
    const [existing] = await sql`SELECT visit_type, notes FROM appointments WHERE id=${id}::uuid AND practice_id=${practiceId}::uuid LIMIT 1`
    if (!existing) return null
    if (!DUAL_VISIT_TYPES.includes(existing.visit_type)) return null
    const refMatch = String(existing.notes ?? '').match(/Ref: ([A-Z0-9-]+)/)
    if (!refMatch) return null
    const twins = await sql`
      SELECT id FROM appointments
      WHERE practice_id=${practiceId}::uuid
        AND id != ${id}::uuid
        AND notes LIKE ${'%Ref: ' + refMatch[1] + '%'}
      LIMIT 1`
    return (twins[0] as any)?.id ?? null
  }

  // Full appointment edit (visit type, provider, date, time)
  if (visit_type !== undefined || provider_id !== undefined || scheduled_date !== undefined || scheduled_time !== undefined) {
    const twinId = (scheduled_date !== undefined || scheduled_time !== undefined) ? await findTwinId() : null

    ;[row] = await sql`
      UPDATE appointments SET
        visit_type      = COALESCE(${visit_type ?? null}, visit_type),
        provider_id     = COALESCE(${provider_id ?? null}::uuid, provider_id),
        scheduled_date  = COALESCE(${scheduled_date ?? null}::date, scheduled_date),
        scheduled_time  = COALESCE(${scheduled_time ?? null}, scheduled_time)
      WHERE id=${id}::uuid AND practice_id=${practiceId}::uuid RETURNING *`
    // Replace schedule block with updated appointment details
    const appt = row as Record<string, any>
    const endTime = blockEndTime(appt.scheduled_time, appt.visit_type)
    await sql`DELETE FROM schedule_blocks WHERE reason = ${'appt:' + id} AND practice_id = ${practiceId}::uuid`.catch(() => {})
    await sql`
      INSERT INTO schedule_blocks (practice_id, provider_id, start_date, end_date, all_day, start_time, end_time, reason)
      VALUES (${practiceId}::uuid, ${appt.provider_id}::uuid, ${appt.scheduled_date}::date, ${appt.scheduled_date}::date, false, ${appt.scheduled_time}, ${endTime}, ${'appt:' + id})`
      .catch(e => console.error('[appointments] block reschedule error:', e))

    // Cascade date/time change to the paired twin appointment (never change its
    // provider or visit type — those are twin-specific).
    if (twinId && (scheduled_date !== undefined || scheduled_time !== undefined)) {
      await sql`
        UPDATE appointments SET
          scheduled_date = COALESCE(${scheduled_date ?? null}::date, scheduled_date),
          scheduled_time = COALESCE(${scheduled_time ?? null}, scheduled_time)
        WHERE id=${twinId}::uuid AND practice_id=${practiceId}::uuid`
      const [twinAppt] = await sql`SELECT provider_id, scheduled_date, scheduled_time, visit_type FROM appointments WHERE id=${twinId}::uuid LIMIT 1`
      if (twinAppt) {
        const twinEnd = blockEndTime(twinAppt.scheduled_time as string, twinAppt.visit_type as string)
        await sql`DELETE FROM schedule_blocks WHERE reason = ${'appt:' + twinId} AND practice_id = ${practiceId}::uuid`.catch(() => {})
        await sql`
          INSERT INTO schedule_blocks (practice_id, provider_id, start_date, end_date, all_day, start_time, end_time, reason)
          VALUES (${practiceId}::uuid, ${twinAppt.provider_id}::uuid, ${twinAppt.scheduled_date}::date, ${twinAppt.scheduled_date}::date, false, ${twinAppt.scheduled_time}, ${twinEnd}, ${'appt:' + twinId})`
          .catch(e => console.error('[appointments] twin block reschedule error:', e))
      }
    }

    // Cascade date/time change to the matching booking_request row (linked via
    // the same "Ref: PUC-XXXXX" in notes). Without this, the appointment updates
    // but the booking_request keeps the old preferred_date/preferred_time and
    // the patient chart still displays the stale date.
    if (scheduled_date !== undefined || scheduled_time !== undefined) {
      const apptRow = row as any
      const refMatch = String(apptRow?.notes ?? '').match(/Ref: ([A-Z0-9-]+)/)
      if (refMatch) {
        await sql`
          UPDATE booking_requests SET
            preferred_date = COALESCE(${scheduled_date ?? null}::date, preferred_date),
            preferred_time = COALESCE(${scheduled_time ?? null}, preferred_time)
          WHERE reference_code = ${refMatch[1]} AND practice_id = ${practiceId}::uuid`
      }
    }
  } else if (status !== undefined && after_visit_instructions !== undefined) {
    ;[row] = await sql`UPDATE appointments SET status=${status}, after_visit_instructions=${after_visit_instructions} WHERE id=${id}::uuid AND practice_id=${practiceId}::uuid RETURNING *`
  } else if (status !== undefined) {
    const twinId = status === 'cancelled' ? await findTwinId() : null
    ;[row] = await sql`UPDATE appointments SET status=${status} WHERE id=${id}::uuid AND practice_id=${practiceId}::uuid RETURNING *`
    if (status === 'cancelled') {
      await sql`DELETE FROM schedule_blocks WHERE reason = ${'appt:' + id} AND practice_id = ${practiceId}::uuid`.catch(() => {})
      if (twinId) {
        await sql`UPDATE appointments SET status='cancelled' WHERE id=${twinId}::uuid AND practice_id=${practiceId}::uuid AND status != 'cancelled'`
        await sql`DELETE FROM schedule_blocks WHERE reason = ${'appt:' + twinId} AND practice_id = ${practiceId}::uuid`.catch(() => {})
      }
    }
  } else if (after_visit_instructions !== undefined) {
    ;[row] = await sql`UPDATE appointments SET after_visit_instructions=${after_visit_instructions} WHERE id=${id}::uuid AND practice_id=${practiceId}::uuid RETURNING *`
  } else if (Array.isArray((req.body as any)?._clear) && (req.body as any)._clear.length > 0) {
    // Pure clear-only request — no other fields to update.
    // Fall through to the clear logic below, then re-fetch.
    ;[row] = await sql`SELECT * FROM appointments WHERE id=${id}::uuid AND practice_id=${practiceId}::uuid`
  } else {
    return res.status(400).json({ error: 'No valid fields' })
  }

  // Explicit-clear support — see feedback_extract_shared_code_first_try.md.
  // Runs AFTER the COALESCE-based UPDATE above; nulls any whitelisted
  // columns the client explicitly asked to clear.
  const requestedClears = (req.body as any)?._clear
  if (Array.isArray(requestedClears) && requestedClears.length > 0) {
    await applyAppointmentClears(sql, id, practiceId, requestedClears)
    ;[row] = await sql`SELECT * FROM appointments WHERE id=${id}::uuid AND practice_id=${practiceId}::uuid`
  }
  res.json(row)
}
