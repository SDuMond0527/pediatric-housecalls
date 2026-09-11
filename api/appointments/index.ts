import type { VercelRequest, VercelResponse } from '@vercel/node'
import { neon } from '@neondatabase/serverless'
import { createRemoteJWKSet, jwtVerify } from 'jose'

// Inlined from api/_lib/createAppointmentCore.ts. The _lib folder is treated
// as private by Vercel and excluded from serverless function bundling, so any
// import from it fails at runtime with a 500. Keeping this local to the file
// avoids the outage.
interface CreateAppointmentInput {
  provider_id: string
  visit_type: string
  zone?: string | null
  scheduled_time: string
  scheduled_date: string
  status?: string
  notes?: string | null
  duration_minutes?: number | null
  child_id?: string | null
  state?: string | null
  second_provider_id?: string | null
}
interface CreateAppointmentResult {
  primary: any
  secondary: any
  error?: string
}
async function createAppointmentCore(
  sql: ReturnType<typeof neon>,
  practiceId: string,
  input: CreateAppointmentInput,
): Promise<CreateAppointmentResult> {
  const { provider_id, visit_type, zone, scheduled_time, scheduled_date, status, notes, duration_minutes, child_id, state: bodyState, second_provider_id } = input
  const endTime = blockEndTime(scheduled_time, visit_type, duration_minutes)
  {
    const [nh, nm] = String(scheduled_time).split(':').map(Number)
    const newStart = nh * 60 + nm
    const newDur = duration_minutes ?? VISIT_DURATIONS[visit_type] ?? 60
    const newEnd = newStart + newDur
    const existing = await sql`
      SELECT scheduled_time, COALESCE(duration_minutes, 60) AS duration_minutes
      FROM appointments
      WHERE provider_id = ${provider_id}::uuid AND practice_id = ${practiceId}::uuid
        AND scheduled_date = ${scheduled_date}::date AND status != 'cancelled'`
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
      VALUES (${practiceId}::uuid, ${provider_id}::uuid, ${scheduled_date}::date, ${scheduled_date}::date, false, ${scheduled_time}, ${endTime}, ${'appt:' + (primaryRow as any).id})`.catch(() => {})
    let secondaryRow: any = null
    let mdProviderId: string | null = null
    let mdName = ''
    if (primaryIsInHome) {
      if (second_provider_id) {
        const [md] = await sql`SELECT id, name FROM providers WHERE id = ${second_provider_id}::uuid LIMIT 1`
        if (md) { mdProviderId = (md as any).id as string; mdName = ((md as any).name ?? '') as string }
      } else if (state) {
        const onCallRows = await sql`
          SELECT oc.provider_id, p.name AS provider_name FROM on_call_schedule oc
          JOIN providers p ON p.id = oc.provider_id
          WHERE oc.practice_id = ${practiceId}::uuid AND oc.date = ${scheduled_date}::date AND oc.state = ${state}
            AND (oc.start_time IS NULL OR oc.start_time <= ${scheduled_time}::time)
            AND (oc.end_time IS NULL OR oc.end_time > ${scheduled_time}::time) LIMIT 1`
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
      // Secondary (MD/NP) side may have its OWN visit_type — different
      // duration, different price, different CPT — when configured in the
      // PAIRED_SECONDARY_VISIT_TYPE map. For CMA+tele the secondary
      // visit_type falls back to the same as primary.
      const secondaryVisitType = secondaryVisitTypeFor(visit_type)
      const secondaryDur = VISIT_DURATIONS[secondaryVisitType] ?? VISIT_DURATIONS[visit_type] ?? 60
      const secondaryEndTime = blockEndTime(scheduled_time, secondaryVisitType, null)
      const [nh2, nm2] = String(scheduled_time).split(':').map(Number)
      const newStart2 = nh2 * 60 + nm2
      const newEnd2 = newStart2 + secondaryDur
      const mdExisting = await sql`
        SELECT scheduled_time, COALESCE(duration_minutes, 60) AS duration_minutes
        FROM appointments
        WHERE provider_id = ${mdProviderId}::uuid AND practice_id = ${practiceId}::uuid
          AND scheduled_date = ${scheduled_date}::date AND status != 'cancelled'
          AND id != ${(primaryRow as any).id}::uuid`
      for (const row of mdExisting as Array<{ scheduled_time: string; duration_minutes: number }>) {
        const [eh, em] = String(row.scheduled_time).split(':').map(Number)
        const exStart = eh * 60 + em
        const exEnd = exStart + (row.duration_minutes ?? 60)
        if (newStart2 < exEnd && newEnd2 > exStart) {
          await sql`UPDATE appointments SET status = 'cancelled' WHERE id = ${(primaryRow as any).id}::uuid`
          await sql`DELETE FROM schedule_blocks WHERE reason = ${'appt:' + (primaryRow as any).id} AND practice_id = ${practiceId}::uuid`.catch(() => {})
          return { primary: null, secondary: null, error: `${mdName || 'The paired provider'} is no longer available at that time — please choose a different slot.` }
        }
      }
      const partnerRoleLabel = isCmaTelePair(visit_type) ? 'MD/NP — telemedicine' : 'MD/NP — telemedicine screening'
      const secondaryNotes = (notes ?? '') + `|PARTNER:${primaryName} (${primaryRole})`
      const primaryUpdNotes = ((primaryRow as any).notes ?? '') + `|PARTNER:${mdName} (${partnerRoleLabel})`
      ;[secondaryRow] = await sql`
        INSERT INTO appointments (practice_id, provider_id, visit_type, zone, scheduled_time, scheduled_date, status, notes, duration_minutes, child_id)
        VALUES (${practiceId}::uuid, ${mdProviderId}::uuid, ${secondaryVisitType}, ${zone ?? null}, ${scheduled_time}, ${scheduled_date}::date, 'upcoming', ${secondaryNotes}, ${secondaryDur}, ${child_id ?? null}::uuid)
        RETURNING *`
      await sql`UPDATE appointments SET notes = ${primaryUpdNotes} WHERE id = ${(primaryRow as any).id}::uuid`
      await sql`
        INSERT INTO schedule_blocks (practice_id, provider_id, start_date, end_date, all_day, start_time, end_time, reason)
        VALUES (${practiceId}::uuid, ${mdProviderId}::uuid, ${scheduled_date}::date, ${scheduled_date}::date, false, ${scheduled_time}, ${secondaryEndTime}, ${'appt:' + (secondaryRow as any).id})`.catch(() => {})
    }
    return { primary: primaryRow, secondary: secondaryRow }
  }
  const [row] = await sql`
    INSERT INTO appointments (practice_id, provider_id, visit_type, zone, scheduled_time, scheduled_date, status, notes, duration_minutes, child_id)
    VALUES (${practiceId}::uuid, ${provider_id}::uuid, ${visit_type}, ${zone ?? null}, ${scheduled_time}, ${scheduled_date}::date, ${status ?? 'upcoming'}, ${notes ?? null}, ${duration_minutes ?? null}, ${child_id ?? null}::uuid)
    RETURNING *`
  await sql`
    INSERT INTO schedule_blocks (practice_id, provider_id, start_date, end_date, all_day, start_time, end_time, reason)
    VALUES (${practiceId}::uuid, ${provider_id}::uuid, ${scheduled_date}::date, ${scheduled_date}::date, false, ${scheduled_time}, ${endTime}, ${'appt:' + (row as any).id})`.catch(e => console.error('[appointments] schedule block error:', e))
  return { primary: row, secondary: null }
}

function toMin(t: string): number {
  const s = t.trim()
  if (/[AaPp][Mm]$/.test(s)) {
    const [timePart, ampm] = s.split(' ')
    let [h, m] = timePart.split(':').map(Number)
    if (ampm.toUpperCase() === 'PM' && h !== 12) h += 12
    if (ampm.toUpperCase() === 'AM' && h === 12) h = 0
    return h * 60 + m
  }
  const [h, m] = s.split(':').map(Number)
  return h * 60 + m
}

async function validateProviderSlot(
  sql: ReturnType<typeof neon>,
  providerId: string,
  visitType: string,
  date: string,
  time: string,
): Promise<string | null> {
  const dayOfWeek = new Date(date + 'T12:00:00').getDay()
  const [availRows, overrideRows, vtRows] = await Promise.all([
    sql`SELECT is_active, start_time, end_time FROM availability WHERE provider_id = ${providerId}::uuid AND day_of_week = ${dayOfWeek} LIMIT 1`,
    sql`SELECT is_available, start_time, end_time FROM availability_overrides WHERE provider_id = ${providerId}::uuid AND date = ${date}::date LIMIT 1`,
    sql`SELECT is_active, start_time, end_time FROM visit_type_availability WHERE provider_id = ${providerId}::uuid AND visit_type = ${visitType} LIMIT 1`,
  ])
  const avail = availRows[0] as any
  const override = overrideRows[0] as any
  const vtAvail = vtRows[0] as any
  let winStart: number
  let winEnd: number
  if (override) {
    if (!override.is_available) return 'Provider is not available on this date'
    winStart = toMin(override.start_time)
    winEnd = toMin(override.end_time)
  } else if (avail) {
    if (!avail.is_active) return 'Provider is not available on this day of the week'
    winStart = toMin(avail.start_time)
    winEnd = toMin(avail.end_time)
  } else {
    return 'Provider has no availability configured for this date'
  }
  if (vtAvail?.is_active && vtAvail.start_time && vtAvail.end_time) {
    winStart = Math.max(winStart, toMin(vtAvail.start_time))
    winEnd = Math.min(winEnd, toMin(vtAvail.end_time))
  }
  if (winEnd <= winStart) return 'Provider has no availability for this visit type on this date'
  const reqMin = toMin(time)
  if (reqMin < winStart || reqMin >= winEnd) {
    const fmt = (m: number) => `${Math.floor(m / 60).toString().padStart(2, '0')}:${(m % 60).toString().padStart(2, '0')}`
    return `Requested time ${time} is outside this provider's available hours (${fmt(winStart)}–${fmt(winEnd)})`
  }
  return null
}

async function alertNoOnCallMD(sql: ReturnType<typeof neon>, practiceId: string, visitType: string, scheduledDate: string, scheduledTime: string, state: string) {
  try {
    const RESEND_API_KEY = process.env.RESEND_API_KEY
    if (!RESEND_API_KEY) return
    const admins = await sql`SELECT email FROM providers WHERE is_admin = true AND practice_id = ${practiceId}::uuid AND email IS NOT NULL`
    if (!admins.length) return
    const body = `<p>A <strong>${visitType}</strong> appointment was booked for <strong>${scheduledDate}</strong> at <strong>${scheduledTime}</strong> in state <strong>${state}</strong>, but <strong>no on-call MD/NP was found</strong> in the on-call schedule for that date, state, and time.</p><p>The MD/NP appointment was NOT created automatically. Please add it manually.</p><p><em>Debug info — practice_id queried: ${practiceId} | date: ${scheduledDate} | state: ${state} | time: ${scheduledTime}</em></p>`
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
  } catch {}
}


async function verifyAnyToken(authHeader: string | undefined): Promise<{ sub: string; type: 'family' | 'provider' }> {
  if (!authHeader?.startsWith('Bearer ')) throw new Error('Missing token')
  const token = authHeader.slice(7)
  const region = process.env.VITE_AWS_REGION || 'us-east-2'
  const familyPoolId = process.env.VITE_FAMILY_USER_POOL_ID || ''
  if (familyPoolId) {
    try {
      const JWKS = createRemoteJWKSet(new URL(`https://cognito-idp.${region}.amazonaws.com/${familyPoolId}/.well-known/jwks.json`))
      const { payload } = await jwtVerify(token, JWKS, { issuer: `https://cognito-idp.${region}.amazonaws.com/${familyPoolId}` })
      if (payload.sub) return { sub: payload.sub, type: 'family' }
    } catch {}
  }
  const providerPoolId = process.env.VITE_AWS_USER_POOL_ID || ''
  const JWKS = createRemoteJWKSet(new URL(`https://cognito-idp.${region}.amazonaws.com/${providerPoolId}/.well-known/jwks.json`))
  const { payload } = await jwtVerify(token, JWKS, { issuer: `https://cognito-idp.${region}.amazonaws.com/${providerPoolId}` })
  if (!payload.sub) throw new Error('No sub in token')
  return { sub: payload.sub, type: 'provider' }
}

// Paired-visit aliases. All three names for each pair map to the same
// duration so historical names, current DB names, and the explicit renamed
// versions all resolve correctly. Keep in sync with api/_lib/dualVisitTypes.ts
// and src/lib/dualVisitTypes.ts.
const CMA_TELE_ALIASES = ['CMA + telemedicine', 'CMA + tele', 'CMA visit — paired with MD/NP telemedicine screening']
const IV_FLUIDS_ALIASES = ['In-home IV fluids', 'RN IV fluids', 'RN IV fluid visit — paired with MD/NP screening', 'RN in-home IV fluids administration', 'Video telemedicine screening for IV fluids']
const DUAL_VISIT_TYPES = [...CMA_TELE_ALIASES, ...IV_FLUIDS_ALIASES]
const isCmaTelePair  = (v?: string | null) => !!v && CMA_TELE_ALIASES.includes(v)
const isIvFluidsPair = (v?: string | null) => !!v && IV_FLUIDS_ALIASES.includes(v)

// Split-type pair map: some paired visits have DIFFERENT visit_type strings
// on each twin so each side can have its own duration, price, allowed_roles,
// and billable claim. When missing from this map, both twins share the same
// visit_type (existing CMA+tele behavior).
const PAIRED_SECONDARY_VISIT_TYPE: Record<string, string> = {
  // IV fluids pair — RN in-home + MD/NP telemedicine screening
  'RN in-home IV fluids administration':        'Video telemedicine screening for IV fluids',
  'Video telemedicine screening for IV fluids': 'RN in-home IV fluids administration',
  'In-home IV fluids':                          'Video telemedicine screening for IV fluids',
  'RN IV fluids':                               'Video telemedicine screening for IV fluids',
  'RN IV fluid visit — paired with MD/NP screening': 'Video telemedicine screening for IV fluids',
}
const secondaryVisitTypeFor = (primary: string): string =>
  PAIRED_SECONDARY_VISIT_TYPE[primary] || primary

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

function blockEndTime(startTime: string, visitType: string, explicitMinutes?: number | null): string {
  const minutes = explicitMinutes ?? VISIT_DURATIONS[visitType] ?? 60
  const [h, m] = startTime.split(':').map(Number)
  const total = h * 60 + m + minutes
  const eh = Math.floor(total / 60) % 24
  const em = total % 60
  return `${eh.toString().padStart(2, '0')}:${em.toString().padStart(2, '0')}`
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  let auth: { sub: string; type: 'family' | 'provider' }
  try {
    auth = await verifyAnyToken(req.headers.authorization)
  } catch {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const sql = neon(process.env.DATABASE_URL!)

  let practiceId: string
  if (auth.type === 'provider') {
    const rows = await sql`SELECT practice_id FROM providers WHERE cognito_sub = ${auth.sub} LIMIT 1`
    if (!rows.length) return res.status(403).json({ error: 'Provider not found' })
    practiceId = rows[0].practice_id as string
  } else {
    const rows = await sql`SELECT practice_id FROM family_profiles WHERE cognito_sub = ${auth.sub} LIMIT 1`
    if (!rows.length) return res.status(403).json({ error: 'Family not found' })
    practiceId = rows[0].practice_id as string
  }

  if (req.method === 'GET') {
    const { provider_id, date: _date, scheduled_date, date_gte, date_lte, child_id } = req.query as Record<string, string>
    const date = _date || scheduled_date
    let rows: unknown[]
    if (child_id) {
      rows = await sql`SELECT a.*, p.name as provider_name FROM appointments a LEFT JOIN providers p ON p.id = a.provider_id WHERE a.child_id = ${child_id}::uuid AND a.practice_id = ${practiceId}::uuid ORDER BY a.scheduled_date DESC, a.scheduled_time DESC`
    } else if (provider_id && date) {
      rows = await sql`SELECT * FROM appointments WHERE provider_id = ${provider_id}::uuid AND scheduled_date = ${date}::date AND practice_id = ${practiceId}::uuid ORDER BY scheduled_time`
    } else if (provider_id && date_gte && date_lte) {
      rows = await sql`SELECT * FROM appointments WHERE provider_id = ${provider_id}::uuid AND scheduled_date >= ${date_gte}::date AND scheduled_date <= ${date_lte}::date AND practice_id = ${practiceId}::uuid`
    } else if (date) {
      rows = await sql`SELECT * FROM appointments WHERE scheduled_date = ${date}::date AND practice_id = ${practiceId}::uuid ORDER BY scheduled_time`
    } else if (provider_id) {
      rows = await sql`SELECT * FROM appointments WHERE provider_id = ${provider_id}::uuid AND practice_id = ${practiceId}::uuid ORDER BY scheduled_date, scheduled_time`
    } else {
      rows = await sql`SELECT id, status, visit_type, scheduled_date, provider_id, notes FROM appointments WHERE practice_id = ${practiceId}::uuid`
    }
    return res.json(rows)
  }

  if (req.method === 'POST') {
    const { provider_id, visit_type, zone, scheduled_time, scheduled_date, status, notes, duration_minutes, child_id, state: bodyState, second_provider_id } = req.body

    // Server-side availability guard for family-originated bookings.
    // Providers/admins may schedule outside normal hours intentionally.
    if (auth.type === 'family' && provider_id && scheduled_time && scheduled_date) {
      const slotError = await validateProviderSlot(
        sql, provider_id, visit_type, scheduled_date, scheduled_time
      )
      if (slotError) return res.status(409).json({ error: slotError })
    }

    const result = await createAppointmentCore(sql, practiceId, {
      provider_id, visit_type, zone, scheduled_time, scheduled_date,
      status, notes, duration_minutes, child_id,
      state: bodyState, second_provider_id,
    })
    if (result.error) return res.status(409).json({ error: result.error })

    if (DUAL_VISIT_TYPES.includes(visit_type)) {
      // Legacy response shape — some callers read .cma / .rn / .md; some read .primary / .secondary.
      const primaryKey = isCmaTelePair(visit_type) ? 'cma' : 'rn'
      return res.json({
        primary: result.primary,
        secondary: result.secondary,
        [primaryKey]: result.primary,
        md: result.secondary,
      })
    }
    return res.json(result.primary)
  }

  res.status(405).json({ error: 'Method not allowed' })
}
