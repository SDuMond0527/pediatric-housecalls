import type { VercelRequest, VercelResponse } from '@vercel/node'
import { neon } from '@neondatabase/serverless'

/**
 * GET /api/admin/cpr-payroll-diag?start=YYYY-MM-DD&end=YYYY-MM-DD
 * Service-token-gated. Shows every CPR-class-ish appointment on prod in
 * the window and which provider it was assigned to, so I can tell Sara
 * what the payroll report is counting vs. what Melissa actually taught.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })
  const expected = process.env.INTERNAL_SERVICE_TOKEN || ''
  const provided = String(req.headers['x-internal-service-token'] ?? '')
  if (!expected || provided !== expected) return res.status(401).json({ error: 'Unauthorized' })

  const sql = neon(process.env.DATABASE_URL!)
  const start = String(req.query.start ?? '2026-09-01')
  const end   = String(req.query.end ?? '2026-11-30')

  // Everything that looks like a CPR class in the window + the assigned
  // provider's name/role. Includes cancelled so Sara can see if the
  // discrepancy is cancellations being counted.
  const appts = await sql`
    SELECT a.id, a.scheduled_date::text AS date, a.scheduled_time, a.visit_type,
           a.status, a.provider_id, p.name AS provider_name, p.role AS provider_role,
           a.patient_first_name, a.patient_last_name, a.notes
    FROM appointments a
    LEFT JOIN providers p ON p.id = a.provider_id
    WHERE a.scheduled_date BETWEEN ${start}::date AND ${end}::date
      AND (
        a.visit_type ILIKE 'in-home cpr class%' OR a.visit_type ILIKE '%cpr class %'
        OR a.visit_type ILIKE '%cpr%'
      )
    ORDER BY a.scheduled_date, a.scheduled_time`

  // Also fetch raw CPR booking requests so we can see any that never
  // became confirmed appointments (common failure mode: the family
  // signed up, Melissa approved, but the appointment row never got
  // created or was assigned to the wrong provider).
  const bookings = await sql`
    SELECT id, reference_code, visit_type, requested_dates, status,
           created_at, charm_appointment_id,
           patient_first_name, patient_last_name
    FROM booking_requests
    WHERE created_at BETWEEN ${start}::timestamptz AND (${end}::date + INTERVAL '1 day')::timestamptz
      AND (visit_type ILIKE '%cpr%' OR visit_type ILIKE 'in-home cpr%')
    ORDER BY created_at` as any[]

  // Match to the detector the payroll report actually uses so Sara can
  // see what IS vs ISN'T being counted.
  const detector = (vt: string | null) => {
    const v = String(vt ?? '').toLowerCase()
    return v.startsWith('in-home cpr class') || v.includes('cpr class ')
  }
  const counted = (appts as any[]).map(a => ({
    ...a,
    would_be_counted_on_payroll: detector(a.visit_type) && a.status !== 'cancelled',
  }))

  const melissa = counted.filter((a: any) =>
    (a.provider_name ?? '').toLowerCase().includes('melissa'))
  const notMelissa = counted.filter((a: any) =>
    !(a.provider_name ?? '').toLowerCase().includes('melissa'))

  return res.json({
    window: { start, end },
    appointment_count: counted.length,
    melissa_count: melissa.length,
    melissa_counted_on_payroll: melissa.filter((a: any) => a.would_be_counted_on_payroll).length,
    non_melissa_count: notMelissa.length,
    appointments: counted,
    booking_requests: bookings,
  })
}
