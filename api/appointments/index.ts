import type { VercelRequest, VercelResponse } from '@vercel/node'
import { neon } from '@neondatabase/serverless'
import { createRemoteJWKSet, jwtVerify } from 'jose'
import { validateProviderSlot } from '../_lib/validateProviderSlot'

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

const VISIT_DURATIONS: Record<string, number> = {
  'In-home sick visit': 60,
  'Sports physical': 60,
  'CMA + telemedicine': 60,
  'Video telemedicine': 30,
  'Text visit': 15,
  'In-home IV fluids': 90,
  'In-home CPR class (Heartsaver)': 180,
  'In-home CPR class (BLS)': 180,
  'In-home CPR class (Heartsaver Child and Infant First Aid, CPR, AED, choking, injury/environmental emergencies, opioid-associated emergencies (including how to use Narcan) with optional modules in adult CPR/AED)': 180,
  'In-home CPR class (BLS - Adult CPR/AED use, first aid basics, medical/injury/environmental emergencies, choking, opioid-associated emergencies (including how to use Narcan), recognizing mental health crisis signs in the workplace, with optional modules for child & infant CPR/AED)': 180,
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
    const { provider_id, second_provider_id, visit_type, zone, scheduled_time, scheduled_date, status, notes, duration_minutes, child_id, state } = req.body
    const endTime = blockEndTime(scheduled_time, visit_type, duration_minutes)

    // Server-side availability guard for family-originated bookings.
    // Providers/admins may schedule outside normal hours intentionally.
    if (auth.type === 'family' && provider_id && scheduled_time && scheduled_date) {
      const slotError = await validateProviderSlot(
        sql, provider_id, visit_type, scheduled_date, scheduled_time
      )
      if (slotError) return res.status(409).json({ error: slotError })
    }

    // CMA + telemedicine family bookings: create CMA appointment + auto-assign on-call MD/NP
    if (visit_type === 'CMA + telemedicine' && auth.type === 'family') {
      const [cmaProvider] = await sql`SELECT name FROM providers WHERE id = ${provider_id}::uuid LIMIT 1`
      const cmaName = (cmaProvider?.name ?? '') as string

      const [cmaRow] = await sql`
        INSERT INTO appointments (practice_id, provider_id, visit_type, zone, scheduled_time, scheduled_date, status, notes, duration_minutes, child_id)
        VALUES (${practiceId}::uuid, ${provider_id}::uuid, ${visit_type}, ${zone}, ${scheduled_time}, ${scheduled_date}::date, 'upcoming', ${notes ?? null}, ${duration_minutes ?? null}, ${child_id ?? null}::uuid)
        RETURNING *`
      await sql`
        INSERT INTO schedule_blocks (practice_id, provider_id, start_date, end_date, all_day, start_time, end_time, reason)
        VALUES (${practiceId}::uuid, ${provider_id}::uuid, ${scheduled_date}::date, ${scheduled_date}::date, false, ${scheduled_time}, ${endTime}, ${'appt:' + (cmaRow as any).id})`
        .catch(() => {})

      let mdRow: unknown = null
      if (state) {
        const onCallRows = await sql`
          SELECT oc.provider_id, p.name AS provider_name FROM on_call_schedule oc
          JOIN providers p ON p.id = oc.provider_id
          WHERE oc.practice_id = ${practiceId}::uuid AND oc.date = ${scheduled_date}::date AND oc.state = ${state}
            AND (oc.start_time IS NULL OR oc.start_time <= ${scheduled_time}::time)
            AND (oc.end_time IS NULL OR oc.end_time > ${scheduled_time}::time)
          LIMIT 1`
        if (!onCallRows.length) {
          alertNoOnCallMD(sql, practiceId, visit_type, scheduled_date, scheduled_time, state).catch(() => {})
        } else {
          const mdProviderId = onCallRows[0].provider_id as string
          const mdName = (onCallRows[0].provider_name ?? '') as string
          const mdNotes = (notes ?? '') + (mdName ? `|PARTNER:${cmaName} (CMA)` : '')
          const cmaNotes = ((cmaRow as any).notes ?? '') + (cmaName ? `|PARTNER:${mdName} (MD/NP — telemedicine)` : '')
          ;[mdRow] = await sql`
            INSERT INTO appointments (practice_id, provider_id, visit_type, zone, scheduled_time, scheduled_date, status, notes, duration_minutes, child_id)
            VALUES (${practiceId}::uuid, ${mdProviderId}::uuid, ${visit_type}, ${zone}, ${scheduled_time}, ${scheduled_date}::date, 'upcoming', ${mdNotes}, ${duration_minutes ?? null}, ${child_id ?? null}::uuid)
            RETURNING *`
          await sql`UPDATE appointments SET notes = ${cmaNotes} WHERE id = ${(cmaRow as any).id}::uuid`
          await sql`
            INSERT INTO schedule_blocks (practice_id, provider_id, start_date, end_date, all_day, start_time, end_time, reason)
            VALUES (${practiceId}::uuid, ${mdProviderId}::uuid, ${scheduled_date}::date, ${scheduled_date}::date, false, ${scheduled_time}, ${endTime}, ${'appt:' + (mdRow as any).id})`
            .catch(() => {})
        }
      }
      return res.json({ cma: cmaRow, md: mdRow })
    }

    // In-home IV fluids family bookings: create RN appointment + auto-assign on-call MD/NP
    if (visit_type === 'In-home IV fluids' && auth.type === 'family') {
      const [rnProvider] = await sql`SELECT name FROM providers WHERE id = ${provider_id}::uuid LIMIT 1`
      const rnName = (rnProvider?.name ?? '') as string

      const [rnRow] = await sql`
        INSERT INTO appointments (practice_id, provider_id, visit_type, zone, scheduled_time, scheduled_date, status, notes, duration_minutes, child_id)
        VALUES (${practiceId}::uuid, ${provider_id}::uuid, ${visit_type}, ${zone}, ${scheduled_time}, ${scheduled_date}::date, 'upcoming', ${notes ?? null}, ${duration_minutes ?? null}, ${child_id ?? null}::uuid)
        RETURNING *`
      await sql`
        INSERT INTO schedule_blocks (practice_id, provider_id, start_date, end_date, all_day, start_time, end_time, reason)
        VALUES (${practiceId}::uuid, ${provider_id}::uuid, ${scheduled_date}::date, ${scheduled_date}::date, false, ${scheduled_time}, ${endTime}, ${'appt:' + (rnRow as any).id})`
        .catch(() => {})

      let mdRow: unknown = null
      if (state) {
        const onCallRows = await sql`
          SELECT oc.provider_id, p.name AS provider_name FROM on_call_schedule oc
          JOIN providers p ON p.id = oc.provider_id
          WHERE oc.practice_id = ${practiceId}::uuid AND oc.date = ${scheduled_date}::date AND oc.state = ${state}
            AND (oc.start_time IS NULL OR oc.start_time <= ${scheduled_time}::time)
            AND (oc.end_time IS NULL OR oc.end_time > ${scheduled_time}::time)
          LIMIT 1`
        if (!onCallRows.length) {
          alertNoOnCallMD(sql, practiceId, visit_type, scheduled_date, scheduled_time, state).catch(() => {})
        } else {
          const mdProviderId = onCallRows[0].provider_id as string
          const mdName = (onCallRows[0].provider_name ?? '') as string
          const mdNotes = (notes ?? '') + (mdName ? `|PARTNER:${rnName} (RN — in-home)` : '')
          const rnNotes = ((rnRow as any).notes ?? '') + (rnName ? `|PARTNER:${mdName} (MD/NP — telemedicine screening)` : '')
          ;[mdRow] = await sql`
            INSERT INTO appointments (practice_id, provider_id, visit_type, zone, scheduled_time, scheduled_date, status, notes, duration_minutes, child_id)
            VALUES (${practiceId}::uuid, ${mdProviderId}::uuid, ${visit_type}, ${zone}, ${scheduled_time}, ${scheduled_date}::date, 'upcoming', ${mdNotes}, ${duration_minutes ?? null}, ${child_id ?? null}::uuid)
            RETURNING *`
          await sql`UPDATE appointments SET notes = ${rnNotes} WHERE id = ${(rnRow as any).id}::uuid`
          await sql`
            INSERT INTO schedule_blocks (practice_id, provider_id, start_date, end_date, all_day, start_time, end_time, reason)
            VALUES (${practiceId}::uuid, ${mdProviderId}::uuid, ${scheduled_date}::date, ${scheduled_date}::date, false, ${scheduled_time}, ${endTime}, ${'appt:' + (mdRow as any).id})`
            .catch(() => {})
        }
      }
      return res.json({ rn: rnRow, md: mdRow })
    }

    // Admin/provider dual-provider bookings (CMA+tele or IV fluids with explicit second_provider_id)
    if (auth.type === 'provider' && second_provider_id &&
        (visit_type === 'CMA + telemedicine' || visit_type === 'In-home IV fluids')) {
      const isCma = visit_type === 'CMA + telemedicine'
      const [p1Row] = await sql`SELECT name FROM providers WHERE id = ${provider_id}::uuid LIMIT 1`
      const [p2Row] = await sql`SELECT name FROM providers WHERE id = ${second_provider_id}::uuid LIMIT 1`
      const p1Name = (p1Row?.name ?? '') as string
      const p2Name = (p2Row?.name ?? '') as string
      const p1Role = isCma ? 'CMA' : 'RN — in-home'
      const p2Role = 'MD/NP — telemedicine'
      const p1Notes = (notes ?? '') + (p2Name ? `|PARTNER:${p2Name} (${p2Role})` : '')
      const p2Notes = (notes ?? '') + (p1Name ? `|PARTNER:${p1Name} (${p1Role})` : '')

      const [primaryRow] = await sql`
        INSERT INTO appointments (practice_id, provider_id, visit_type, zone, scheduled_time, scheduled_date, status, notes, duration_minutes, child_id)
        VALUES (${practiceId}::uuid, ${provider_id}::uuid, ${visit_type}, ${zone}, ${scheduled_time}, ${scheduled_date}::date, ${status ?? 'upcoming'}, ${p1Notes}, ${duration_minutes ?? null}, ${child_id ?? null}::uuid)
        RETURNING *`
      await sql`
        INSERT INTO schedule_blocks (practice_id, provider_id, start_date, end_date, all_day, start_time, end_time, reason)
        VALUES (${practiceId}::uuid, ${provider_id}::uuid, ${scheduled_date}::date, ${scheduled_date}::date, false, ${scheduled_time}, ${endTime}, ${'appt:' + (primaryRow as any).id})`
        .catch(() => {})

      const [secondaryRow] = await sql`
        INSERT INTO appointments (practice_id, provider_id, visit_type, zone, scheduled_time, scheduled_date, status, notes, duration_minutes, child_id)
        VALUES (${practiceId}::uuid, ${second_provider_id}::uuid, ${visit_type}, ${zone}, ${scheduled_time}, ${scheduled_date}::date, ${status ?? 'upcoming'}, ${p2Notes}, ${duration_minutes ?? null}, ${child_id ?? null}::uuid)
        RETURNING *`
      await sql`
        INSERT INTO schedule_blocks (practice_id, provider_id, start_date, end_date, all_day, start_time, end_time, reason)
        VALUES (${practiceId}::uuid, ${second_provider_id}::uuid, ${scheduled_date}::date, ${scheduled_date}::date, false, ${scheduled_time}, ${endTime}, ${'appt:' + (secondaryRow as any).id})`
        .catch(() => {})

      return res.json({ primary: primaryRow, secondary: secondaryRow })
    }

    const [row] = await sql`
      INSERT INTO appointments (practice_id, provider_id, visit_type, zone, scheduled_time, scheduled_date, status, notes, duration_minutes, child_id)
      VALUES (${practiceId}::uuid, ${provider_id}::uuid, ${visit_type}, ${zone}, ${scheduled_time}, ${scheduled_date}::date, ${status ?? 'upcoming'}, ${notes ?? null}, ${duration_minutes ?? null}, ${child_id ?? null}::uuid)
      RETURNING *`
    // Auto-block the provider's schedule for the duration of this appointment
    await sql`
      INSERT INTO schedule_blocks (practice_id, provider_id, start_date, end_date, all_day, start_time, end_time, reason)
      VALUES (${practiceId}::uuid, ${provider_id}::uuid, ${scheduled_date}::date, ${scheduled_date}::date, false, ${scheduled_time}, ${endTime}, ${'appt:' + (row as any).id})`
      .catch(e => console.error('[appointments] schedule block error:', e))
    return res.json(row)
  }

  res.status(405).json({ error: 'Method not allowed' })
}
