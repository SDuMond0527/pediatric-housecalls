import type { VercelRequest, VercelResponse } from '@vercel/node'
import { verifyFamilyToken } from '../_lib/verifyFamilyToken'
import sql from '../_lib/db'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    await verifyFamilyToken(req.headers.authorization)
  } catch {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const { id } = req.query as { id: string }

  if (req.method === 'PATCH') {
    const b = req.body
    const [row] = await sql`
      UPDATE children SET
        insurance_provider = COALESCE(${b.insurance_provider ?? null}, insurance_provider),
        insurance_member_id = COALESCE(${b.insurance_member_id ?? null}, insurance_member_id),
        insurance_group_number = COALESCE(${b.insurance_group_number ?? null}, insurance_group_number),
        insurance_card_front_url = COALESCE(${b.insurance_card_front_url ?? null}, insurance_card_front_url),
        insurance_card_back_url = COALESCE(${b.insurance_card_back_url ?? null}, insurance_card_back_url),
        preferred_pharmacy = COALESCE(${b.preferred_pharmacy ?? null}, preferred_pharmacy),
        pcp = COALESCE(${b.pcp ?? null}, pcp),
        phi_sharing_consent = COALESCE(${b.phi_sharing_consent ?? null}, phi_sharing_consent),
        charm_patient_id = COALESCE(${b.charm_patient_id ?? null}, charm_patient_id)
      WHERE id = ${id}::uuid
      RETURNING *`
    return res.json(row)
  }

  if (req.method === 'DELETE') {
    await sql`DELETE FROM children WHERE id = ${id}::uuid`
    return res.status(204).end()
  }

  res.status(405).json({ error: 'Method not allowed' })
}
