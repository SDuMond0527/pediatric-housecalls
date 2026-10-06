import type { VercelRequest, VercelResponse } from '@vercel/node'
import { neon } from '@neondatabase/serverless'
import { createRemoteJWKSet, jwtVerify } from 'jose'

// GET /api/family/paired-md-availability?date=YYYY-MM-DD&state=NC
//
// Family-safe lookup for the on-call MD/NP that would be auto-paired to a
// CMA+tele or IV fluids booking on a given date + state, plus that NP's
// booked time blocks. The family-side slot grid in BookVisit.tsx intersects
// these with the primary (CMA/RN) booked times so parents don't see slots
// that would always fail at submit (the on-call NP is already in another
// visit at that time). Mackenzie Twigg on 2026-10-06 made 9 cancelled
// attempts fighting Megan Heilemann's hidden calendar before finding noon.
// Sara 2026-10-06.
//
// Returns { provider_name, bookedSlots: [{ time: "HH:MM", duration: N }] }
// or { provider_name: null, bookedSlots: [] } if no on-call NP exists for
// that date+state (slot grid falls back to RN-only computation).

async function verifyFamilyToken(authHeader: string | undefined): Promise<string> {
  if (!authHeader?.startsWith('Bearer ')) throw new Error('Missing token')
  const token = authHeader.slice(7)
  const region = process.env.VITE_AWS_REGION || 'us-east-2'
  const userPoolId = process.env.VITE_FAMILY_USER_POOL_ID || ''
  const JWKS = createRemoteJWKSet(new URL(`https://cognito-idp.${region}.amazonaws.com/${userPoolId}/.well-known/jwks.json`))
  const { payload } = await jwtVerify(token, JWKS, { issuer: `https://cognito-idp.${region}.amazonaws.com/${userPoolId}` })
  if (!payload.sub) throw new Error('No sub')
  return payload.sub as string
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })
  try { await verifyFamilyToken(req.headers.authorization) }
  catch (e: any) { return res.status(401).json({ error: e?.message || 'Unauthorized' }) }

  const { date, state } = req.query as Record<string, string>
  if (!date || !state) return res.status(400).json({ error: 'date and state are required' })

  const sql = neon(process.env.DATABASE_URL!)

  // Find the practice for this state (small practice, one row expected).
  // on_call_schedule is per-practice, per-date, per-state. We take any
  // on-call row matching date + state and return that provider's booked
  // times. If multiple shifts cover the day we union all of their appts.
  const onCallRows = await sql`
    SELECT DISTINCT oc.provider_id, p.name, oc.practice_id
    FROM on_call_schedule oc
    JOIN providers p ON p.id = oc.provider_id
    WHERE oc.date = ${date}::date AND oc.state = ${state}
  `
  if (onCallRows.length === 0) {
    return res.json({ provider_name: null, bookedSlots: [] })
  }

  // Collect booked time blocks across every on-call NP for the date.
  // The server-side pairing logic in api/appointments/index.ts picks
  // ONE of them at submit time, but we don't know which — so we treat
  // ANY on-call NP's bookings as potentially blocking.
  const providerIds = onCallRows.map(r => r.provider_id)
  const names = onCallRows.map(r => r.name).join(' / ')
  const practiceId = (onCallRows[0] as any).practice_id

  const appts = await sql`
    SELECT scheduled_time, COALESCE(duration_minutes, 60) AS duration_minutes
    FROM appointments
    WHERE provider_id = ANY(${providerIds}::uuid[])
      AND practice_id = ${practiceId}::uuid
      AND scheduled_date = ${date}::date
      AND status != 'cancelled'
  `
  const bookedSlots = appts.map((a: any) => ({
    time: String(a.scheduled_time).slice(0, 5),
    duration: Number(a.duration_minutes) || 60,
  }))

  return res.json({ provider_name: names, bookedSlots })
}
