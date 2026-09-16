import type { VercelRequest, VercelResponse } from '@vercel/node'
import { neon } from '@neondatabase/serverless'
import { createRemoteJWKSet, jwtVerify } from 'jose'

async function verifyProviderToken(authHeader: string | undefined): Promise<string> {
  if (!authHeader?.startsWith('Bearer ')) throw new Error('Missing token')
  const token = authHeader.slice(7)
  const region = process.env.VITE_AWS_REGION || 'us-east-2'
  const poolId = process.env.VITE_AWS_USER_POOL_ID || ''
  const JWKS = createRemoteJWKSet(new URL(`https://cognito-idp.${region}.amazonaws.com/${poolId}/.well-known/jwks.json`))
  const { payload } = await jwtVerify(token, JWKS, { issuer: `https://cognito-idp.${region}.amazonaws.com/${poolId}` })
  if (!payload.sub) throw new Error('No sub in token')
  return payload.sub as string
}

/**
 * GET /api/admin/family-portal-view?family_id=xxx
 *
 * Returns everything the family portal renders (dashboard, visits,
 * vaccines, profile, billing) for the specified family — in one
 * round-trip. Admin-only so a biller / owner can "View as parent"
 * on any family without needing family credentials.
 *
 * The response shape mirrors what the four family-portal pages
 * (FamilyDashboard, FamilyVisitHistory, FamilyVaccines, FamilyProfile)
 * consume, so the admin view page can render them as read-only mirrors
 * of the parent experience.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  let sub: string
  try {
    sub = await verifyProviderToken(req.headers.authorization)
  } catch {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const { family_id } = req.query as { family_id?: string }
  if (!family_id) return res.status(400).json({ error: 'family_id required' })

  try {
    const sql = neon(process.env.DATABASE_URL!)

    const [provider] = await sql`
      SELECT id, is_admin, practice_id FROM providers WHERE cognito_sub = ${sub} LIMIT 1
    `
    if (!provider) return res.status(403).json({ error: 'Provider not found' })
    if (!provider.is_admin) return res.status(403).json({ error: 'Admin access required' })

    const [family] = await sql`
      SELECT * FROM family_profiles
      WHERE id = ${family_id}::uuid AND practice_id = ${provider.practice_id}::uuid
      LIMIT 1
    `
    if (!family) return res.status(404).json({ error: 'Family not found' })

    const children = await sql`
      SELECT * FROM children
      WHERE family_id = ${family_id}::uuid
        AND practice_id = ${provider.practice_id}::uuid
        AND (is_archived IS NULL OR is_archived = false)
      ORDER BY date_of_birth DESC NULLS LAST
    `

    const bookings = await sql`
      SELECT * FROM booking_requests
      WHERE family_id = ${family_id}::uuid
        AND practice_id = ${provider.practice_id}::uuid
      ORDER BY preferred_date DESC
      LIMIT 50
    `

    const waitlist = await sql`
      SELECT * FROM waitlist_entries
      WHERE family_id = ${family_id}::uuid
        AND practice_id = ${provider.practice_id}::uuid
        AND status = 'waiting'
      ORDER BY created_at DESC
    `

    const waitlistIds = waitlist.map((w: any) => w.id as string)
    const offers = waitlistIds.length
      ? await sql`
          SELECT * FROM slot_offers
          WHERE waitlist_entry_id = ANY(${waitlistIds}::uuid[])
            AND status = 'pending'
          ORDER BY created_at DESC
        `
      : []

    const childIds = children.map((c: any) => c.id as string)
    const childMap: Record<string, string> = {}
    for (const c of children) childMap[c.id as string] = [c.first_name, c.last_name].filter(Boolean).join(' ')

    const encounterNotes = childIds.length
      ? await sql`
          SELECT
            en.id,
            en.child_id,
            en.appointment_id,
            en.note_type,
            en.chief_complaint,
            en.assessment,
            en.plan,
            en.diagnoses,
            en.vaccine_administrations,
            en.signed_at,
            a.visit_type,
            a.scheduled_date,
            a.scheduled_time,
            a.after_visit_instructions,
            p.name AS provider_name
          FROM encounter_notes en
          LEFT JOIN appointments a ON a.id = en.appointment_id
          LEFT JOIN providers p ON p.id = a.provider_id
          WHERE en.child_id = ANY(${childIds}::uuid[])
            AND en.practice_id = ${provider.practice_id}::uuid
            AND en.is_signed = true
          ORDER BY a.scheduled_date DESC NULLS LAST
          LIMIT 100
        `
      : []

    // Billing statements — same shape as /api/family/patient-statements
    // so the shared PatientBillingList component can render it unchanged.
    const statements = childIds.length
      ? await sql`
          SELECT
            ps.id,
            ps.status,
            ps.visit_type,
            ps.provider_name,
            ps.cpt_codes,
            COALESCE(NULLIF(ps.total_amount_due_text, ''), ps.total_amount_due::text) AS total_amount_due,
            ps.amount_billed,
            ps.insurance_payment,
            ps.contractual_adjustment,
            ps.patient_copay,
            ps.patient_deductible,
            ps.patient_coinsurance,
            ps.patient_non_covered,
            ps.remaining_balance,
            ps.prior_balance,
            ps.square_payment_link_url AS square_payment_url,
            ps.sent_at,
            ps.paid_at,
            ps.paid_amount_cents,
            ps.created_at,
            c.payer_name,
            COALESCE(ps.patient_first_name, c.patient_first_name, ch.first_name) AS patient_first_name,
            COALESCE(ps.patient_last_name,  c.patient_last_name,  ch.last_name)  AS patient_last_name,
            COALESCE(ps.patient_dob::text,  c.patient_dob::text,  ch.date_of_birth::text) AS patient_dob,
            COALESCE(ps.date_of_service::text, c.service_date::text) AS service_date
          FROM patient_statements ps
          LEFT JOIN claims c ON c.id = ps.claim_id
          JOIN children ch ON ch.id = COALESCE(
            c.child_id,
            (SELECT child_id FROM appointments WHERE id = c.appointment_id LIMIT 1)
          )
          WHERE ps.practice_id = ${provider.practice_id}::uuid
            AND ch.family_id  = ${family_id}::uuid
            AND ps.status IN ('sent', 'paid')
          ORDER BY ps.created_at DESC
        `
      : []

    const notes = encounterNotes.map((n: any) => ({
      id: n.id,
      child_id: n.child_id,
      child_name: childMap[n.child_id] ?? 'Unknown',
      appointment_id: n.appointment_id,
      note_type: n.note_type,
      chief_complaint: n.chief_complaint,
      assessment: n.assessment,
      plan: n.plan,
      after_visit_instructions: n.after_visit_instructions,
      diagnoses: (n.diagnoses ?? []).map((dx: any) => dx.name).filter(Boolean),
      vaccine_administrations: n.note_type === 'In-home vaccine administration' ? (n.vaccine_administrations ?? []) : undefined,
      signed_at: n.signed_at,
      visit_type: n.visit_type,
      scheduled_date: n.scheduled_date,
      scheduled_time: n.scheduled_time,
      provider_name: n.provider_name,
    }))

    return res.status(200).json({
      family,
      children,
      bookings,
      waitlist,
      offers,
      encounter_notes: notes,
      statements,
    })
  } catch (e: any) {
    console.error('admin/family-portal-view error:', e)
    return res.status(500).json({ error: e.message ?? 'Internal server error' })
  }
}
