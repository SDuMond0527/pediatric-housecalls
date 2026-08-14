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

  // Full appointment edit (visit type, provider, date, time)
  if (visit_type !== undefined || provider_id !== undefined || scheduled_date !== undefined || scheduled_time !== undefined) {
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
  } else if (status !== undefined && after_visit_instructions !== undefined) {
    ;[row] = await sql`UPDATE appointments SET status=${status}, after_visit_instructions=${after_visit_instructions} WHERE id=${id}::uuid AND practice_id=${practiceId}::uuid RETURNING *`
  } else if (status !== undefined) {
    ;[row] = await sql`UPDATE appointments SET status=${status} WHERE id=${id}::uuid AND practice_id=${practiceId}::uuid RETURNING *`
    if (status === 'cancelled') {
      await sql`DELETE FROM schedule_blocks WHERE reason = ${'appt:' + id} AND practice_id = ${practiceId}::uuid`.catch(() => {})
    }
  } else if (after_visit_instructions !== undefined) {
    ;[row] = await sql`UPDATE appointments SET after_visit_instructions=${after_visit_instructions} WHERE id=${id}::uuid AND practice_id=${practiceId}::uuid RETURNING *`
  } else {
    return res.status(400).json({ error: 'No valid fields' })
  }
  res.json(row)
}
