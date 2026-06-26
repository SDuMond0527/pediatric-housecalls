import type { VercelRequest, VercelResponse } from '@vercel/node'
import sql from '../_lib/db'
import { getProviderContext } from '../_lib/auth'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  let practiceId: string
  try {
    const ctx = await getProviderContext(req.headers.authorization)
    practiceId = ctx.practiceId
  } catch {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const { id } = req.query as { id: string }

  if (req.method === 'PATCH') {
    try {
      const b = req.body
      const dob = b.date_of_birth || null
      const [row] = await sql`
        UPDATE children SET
          first_name           = COALESCE(${b.first_name           || null}, first_name),
          last_name            = COALESCE(${b.last_name            || null}, last_name),
          date_of_birth        = COALESCE(${dob}::date,                      date_of_birth),
          insurance_provider   = COALESCE(${b.insurance_provider   || null}, insurance_provider),
          insurance_member_id  = COALESCE(${b.insurance_member_id  || null}, insurance_member_id),
          insurance_group_number = COALESCE(${b.insurance_group_number || null}, insurance_group_number),
          insurance_card_front_url     = COALESCE(${b.insurance_card_front_url     || null}, insurance_card_front_url),
          insurance_card_back_url      = COALESCE(${b.insurance_card_back_url      || null}, insurance_card_back_url),
          gender                       = COALESCE(${b.gender                       || null}, gender),
          insurance_subscriber_name    = COALESCE(${b.insurance_subscriber_name    || null}, insurance_subscriber_name),
          insurance_subscriber_dob     = COALESCE(${b.insurance_subscriber_dob     || null}::date, insurance_subscriber_dob),
          insurance_subscriber_gender  = COALESCE(${b.insurance_subscriber_gender  || null}, insurance_subscriber_gender),
          allergies            = COALESCE(${b.allergies            || null}, allergies),
          current_medications  = COALESCE(${b.current_medications  || null}, current_medications),
          medical_history      = COALESCE(${b.medical_history      || null}, medical_history),
          preferred_pharmacy   = COALESCE(${b.preferred_pharmacy   || null}, preferred_pharmacy),
          pcp                  = COALESCE(${b.pcp                  || null}, pcp),
          phi_sharing_consent  = COALESCE(${b.phi_sharing_consent  ?? null}, phi_sharing_consent),
          charm_patient_id     = COALESCE(${b.charm_patient_id     || null}, charm_patient_id)
        WHERE id = ${id}::uuid AND practice_id = ${practiceId}::uuid
        RETURNING *`
      return res.json(row)
    } catch (err: any) {
      return res.status(500).json({ error: err.message ?? String(err) })
    }
  }

  if (req.method === 'DELETE') {
    await sql`DELETE FROM children WHERE id = ${id}::uuid AND practice_id = ${practiceId}::uuid`
    return res.status(204).end()
  }

  res.status(405).json({ error: 'Method not allowed' })
}
