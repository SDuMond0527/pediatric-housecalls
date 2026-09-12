import type { neon } from '@neondatabase/serverless'
import { DUAL_VISIT_TYPES, isCmaTelePair, dualAliasMap } from './dualVisitTypes'

// Duration table — must stay in sync with api/appointments/index.ts.
const VISIT_DURATIONS: Record<string, number> = {
  'In-home sick visit': 60,
  'Sports physical': 60,
  ...dualAliasMap(30, 90),
  'Video telemedicine': 30,
  'Text visit': 15,
  'In-home CPR class (Heartsaver)': 240,
  'In-home CPR class (BLS)': 240,
  'In-home CPR class (Heartsaver Child and Infant First Aid, CPR, AED, choking, injury/environmental emergencies, opioid-associated emergencies (including how to use Narcan) with optional modules in adult CPR/AED)': 240,
  'In-home CPR class (BLS - Adult CPR/AED use, first aid basics, medical/injury/environmental emergencies, choking, opioid-associated emergencies (including how to use Narcan), recognizing mental health crisis signs in the workplace, with optional modules for child & infant CPR/AED)': 240,
}

function blockEndTime(startTime: string, visitType: string, explicitMinutes?: number | null): string {
  const minutes = explicitMinutes ?? VISIT_DURATIONS[visitType] ?? 60
  const [h, m] = startTime.split(':').map(Number)
  const total = h * 60 + m + minutes
  const eh = Math.floor(total / 60) % 24
  const em = total % 60
  return `${eh.toString().padStart(2, '0')}:${em.toString().padStart(2, '0')}`
}

async function alertNoOnCallMD(sql: ReturnType<typeof neon>, practiceId: string, visitType: string, scheduledDate: string, scheduledTime: string, state: string) {
  try {
    const RESEND_API_KEY = process.env.RESEND_API_KEY
    if (!RESEND_API_KEY) return
    const admins = await sql`SELECT email FROM providers WHERE is_admin = true AND practice_id = ${practiceId}::uuid AND email IS NOT NULL`
    if (!admins.length) return
    const body = `<p>A <strong>${visitType}</strong> appointment was booked for <strong>${scheduledDate}</strong> at <strong>${scheduledTime}</strong> in state <strong>${state}</strong>, but <strong>no on-call MD/NP was found</strong> in the on-call schedule for that date, state, and time.</p><p>The MD/NP appointment was NOT created automatically. Please add it manually.</p>`
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'Roam Platform <noreply@phc-team.com>',
        to: admins.map((a: any) => a.email),
        subject: `⚠️ No on-call MD/NP found for ${visitType} booking on ${scheduledDate}`,
        html: body,
      }),
    })
  } catch (e) {
    console.error('[createAppointmentCore] alertNoOnCallMD failed:', e)
  }
}

export interface CreateAppointmentInput {
  provider_id: string
  visit_type: string
  zone?: string | null
  scheduled_time: string  // "HH:MM"
  scheduled_date: string  // "YYYY-MM-DD"
  status?: string
  notes?: string | null
  duration_minutes?: number | null
  child_id?: string | null
  state?: string | null
  second_provider_id?: string | null
}

export interface CreateAppointmentResult {
  primary: any
  secondary: any
  error?: string
}

/**
 * Shared appointment-creation logic used by POST /api/appointments and any
 * server-side path that needs to create an appointment (e.g. slot-offer accept).
 *
 * Behavior:
 *  - Overlap-guard: rejects if the requested slot collides with any existing
 *    non-cancelled appointment for this provider.
 *  - Dual-type visits (CMA+telemedicine, In-home IV fluids): also creates the
 *    paired on-call MD/NP appointment. Uses explicit `second_provider_id` if
 *    provided; otherwise looks up the on-call MD via on_call_schedule (state
 *    derived from zone via practice_zones if not passed).
 *  - Writes schedule_blocks for both primary and (when paired) secondary.
 *  - Adds cross-linking PARTNER notes on both appointments.
 */
export async function createAppointmentCore(
  sql: ReturnType<typeof neon>,
  practiceId: string,
  input: CreateAppointmentInput,
): Promise<CreateAppointmentResult> {
  const { provider_id, visit_type, zone, scheduled_time, scheduled_date, status, notes, duration_minutes, child_id, state: bodyState, second_provider_id } = input
  const endTime = blockEndTime(scheduled_time, visit_type, duration_minutes)

  // Overlap guard.
  {
    const [nh, nm] = String(scheduled_time).split(':').map(Number)
    const newStart = nh * 60 + nm
    const newDur = duration_minutes ?? VISIT_DURATIONS[visit_type] ?? 60
    const newEnd = newStart + newDur
    const existing = await sql`
      SELECT scheduled_time, COALESCE(duration_minutes, 60) AS duration_minutes
      FROM appointments
      WHERE provider_id = ${provider_id}::uuid
        AND practice_id = ${practiceId}::uuid
        AND scheduled_date = ${scheduled_date}::date
        AND status != 'cancelled'`
    for (const row of existing as Array<{ scheduled_time: string; duration_minutes: number }>) {
      const [eh, em] = String(row.scheduled_time).split(':').map(Number)
      const exStart = eh * 60 + em
      const exEnd = exStart + (row.duration_minutes ?? 60)
      if (newStart < exEnd && newEnd > exStart) {
        return { primary: null, secondary: null, error: 'That time overlaps another appointment on this provider\'s schedule. Please choose a different time.' }
      }
    }
  }

  if (DUAL_VISIT_TYPES.includes(visit_type)) {
    let state = bodyState
    if (!state && zone) {
      const [zoneRow] = await sql`SELECT state FROM practice_zones WHERE zone_name = ${zone} AND practice_id = ${practiceId}::uuid LIMIT 1`
      state = (zoneRow as any)?.state ?? null
    }

    const [primaryProvRow] = await sql`SELECT role, name FROM providers WHERE id = ${provider_id}::uuid LIMIT 1`
    const primaryRole = ((primaryProvRow as any)?.role ?? '') as string
    const primaryName = ((primaryProvRow as any)?.name ?? '') as string
    const primaryIsInHome = primaryRole === 'CMA' || primaryRole === 'RN'

    const [primaryRow] = await sql`
      INSERT INTO appointments (practice_id, provider_id, visit_type, zone, scheduled_time, scheduled_date, status, notes, duration_minutes, child_id)
      VALUES (${practiceId}::uuid, ${provider_id}::uuid, ${visit_type}, ${zone ?? null}, ${scheduled_time}, ${scheduled_date}::date, ${status ?? 'upcoming'}, ${notes ?? null}, ${duration_minutes ?? null}, ${child_id ?? null}::uuid)
      RETURNING *`
    await sql`
      INSERT INTO schedule_blocks (practice_id, provider_id, start_date, end_date, all_day, start_time, end_time, reason)
      VALUES (${practiceId}::uuid, ${provider_id}::uuid, ${scheduled_date}::date, ${scheduled_date}::date, false, ${scheduled_time}, ${endTime}, ${'appt:' + (primaryRow as any).id})`
      .catch(() => {})

    let secondaryRow: any = null
    let mdProviderId: string | null = null
    let mdName = ''

    if (primaryIsInHome) {
      if (second_provider_id) {
        const [md] = await sql`SELECT id, name FROM providers WHERE id = ${second_provider_id}::uuid LIMIT 1`
        if (md) {
          mdProviderId = (md as any).id as string
          mdName = ((md as any).name ?? '') as string
        }
      } else if (state) {
        const onCallRows = await sql`
          SELECT oc.provider_id, p.name AS provider_name FROM on_call_schedule oc
          JOIN providers p ON p.id = oc.provider_id
          WHERE oc.practice_id = ${practiceId}::uuid AND oc.date = ${scheduled_date}::date AND oc.state = ${state}
            AND (oc.start_time IS NULL OR oc.start_time <= ${scheduled_time}::time)
            AND (oc.end_time IS NULL OR oc.end_time > ${scheduled_time}::time)
          LIMIT 1`
        if (onCallRows.length) {
          mdProviderId = (onCallRows[0] as any).provider_id as string
          mdName = ((onCallRows[0] as any).provider_name ?? '') as string
        }
      }

      if (!mdProviderId && state) {
        alertNoOnCallMD(sql, practiceId, visit_type, scheduled_date, scheduled_time, state).catch(() => {})
      }
    }

    if (mdProviderId) {
      // Overlap guard for the paired provider — same as the primary. If the
      // MD/NP is already booked at this time, roll back the primary insert and
      // return an error so the caller (e.g. broadcast claim) can surface it.
      const [nh2, nm2] = String(scheduled_time).split(':').map(Number)
      const newStart2 = nh2 * 60 + nm2
      const newDur2 = duration_minutes ?? VISIT_DURATIONS[visit_type] ?? 60
      const newEnd2 = newStart2 + newDur2
      const mdExisting = await sql`
        SELECT scheduled_time, COALESCE(duration_minutes, 60) AS duration_minutes
        FROM appointments
        WHERE provider_id = ${mdProviderId}::uuid
          AND practice_id = ${practiceId}::uuid
          AND scheduled_date = ${scheduled_date}::date
          AND status != 'cancelled'
          AND id != ${(primaryRow as any).id}::uuid`
      for (const row of mdExisting as Array<{ scheduled_time: string; duration_minutes: number }>) {
        const [eh, em] = String(row.scheduled_time).split(':').map(Number)
        const exStart = eh * 60 + em
        const exEnd = exStart + (row.duration_minutes ?? 60)
        if (newStart2 < exEnd && newEnd2 > exStart) {
          // Roll back — cancel the primary and delete its schedule block.
          await sql`UPDATE appointments SET status = 'cancelled' WHERE id = ${(primaryRow as any).id}::uuid`
          await sql`DELETE FROM schedule_blocks WHERE reason = ${'appt:' + (primaryRow as any).id} AND practice_id = ${practiceId}::uuid`.catch(() => {})
          return { primary: null, secondary: null, error: `${mdName || 'The paired provider'} is no longer available at that time — please choose a different slot.` }
        }
      }

      const partnerRoleLabel = isCmaTelePair(visit_type)
        ? 'MD/NP — telemedicine'
        : 'MD/NP — telemedicine screening'
      const secondaryNotes = (notes ?? '') + `|PARTNER:${primaryName} (${primaryRole})`
      const primaryUpdNotes = ((primaryRow as any).notes ?? '') + `|PARTNER:${mdName} (${partnerRoleLabel})`
      ;[secondaryRow] = await sql`
        INSERT INTO appointments (practice_id, provider_id, visit_type, zone, scheduled_time, scheduled_date, status, notes, duration_minutes, child_id)
        VALUES (${practiceId}::uuid, ${mdProviderId}::uuid, ${visit_type}, ${zone ?? null}, ${scheduled_time}, ${scheduled_date}::date, 'upcoming', ${secondaryNotes}, ${duration_minutes ?? null}, ${child_id ?? null}::uuid)
        RETURNING *`
      await sql`UPDATE appointments SET notes = ${primaryUpdNotes} WHERE id = ${(primaryRow as any).id}::uuid`
      await sql`
        INSERT INTO schedule_blocks (practice_id, provider_id, start_date, end_date, all_day, start_time, end_time, reason)
        VALUES (${practiceId}::uuid, ${mdProviderId}::uuid, ${scheduled_date}::date, ${scheduled_date}::date, false, ${scheduled_time}, ${endTime}, ${'appt:' + (secondaryRow as any).id})`
        .catch(() => {})
    }

    return { primary: primaryRow, secondary: secondaryRow }
  }

  const [row] = await sql`
    INSERT INTO appointments (practice_id, provider_id, visit_type, zone, scheduled_time, scheduled_date, status, notes, duration_minutes, child_id)
    VALUES (${practiceId}::uuid, ${provider_id}::uuid, ${visit_type}, ${zone ?? null}, ${scheduled_time}, ${scheduled_date}::date, ${status ?? 'upcoming'}, ${notes ?? null}, ${duration_minutes ?? null}, ${child_id ?? null}::uuid)
    RETURNING *`
  await sql`
    INSERT INTO schedule_blocks (practice_id, provider_id, start_date, end_date, all_day, start_time, end_time, reason)
    VALUES (${practiceId}::uuid, ${provider_id}::uuid, ${scheduled_date}::date, ${scheduled_date}::date, false, ${scheduled_time}, ${endTime}, ${'appt:' + (row as any).id})`
    .catch(e => console.error('[createAppointmentCore] schedule block error:', e))
  return { primary: row, secondary: null }
}
