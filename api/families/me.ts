import type { VercelRequest, VercelResponse } from '@vercel/node'
import { verifyFamilyToken } from '../_lib/verifyFamilyToken'
import sql from '../_lib/db'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    var sub = await verifyFamilyToken(req.headers.authorization)
  } catch {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  if (req.method === 'GET') {
    const [profiles, kids] = await Promise.all([
      sql`SELECT * FROM family_profiles WHERE cognito_sub = ${sub} LIMIT 1`,
      sql`SELECT * FROM children WHERE family_id = (SELECT id FROM family_profiles WHERE cognito_sub = ${sub}) ORDER BY created_at`,
    ])
    if (profiles.length === 0) return res.status(404).json({ error: 'Family not found' })
    return res.json({ family: profiles[0], children: kids })
  }

  if (req.method === 'PATCH') {
    const { display_name, phone, address_line1, city, state, zip, referral_source, agreements_accepted_at, payment_policy_accepted_at } = req.body
    const [row] = await sql`
      INSERT INTO family_profiles (cognito_sub, display_name, phone, address_line1, city, state, zip, referral_source, agreements_accepted_at, payment_policy_accepted_at)
      VALUES (
        ${sub},
        ${display_name ?? null},
        ${phone ?? null},
        ${address_line1 ?? null},
        ${city ?? null},
        ${state ?? null},
        ${zip ?? null},
        ${referral_source ?? null},
        ${agreements_accepted_at ?? null}::timestamptz,
        ${payment_policy_accepted_at ?? null}::timestamptz
      )
      ON CONFLICT (cognito_sub) DO UPDATE SET
        display_name = COALESCE(EXCLUDED.display_name, family_profiles.display_name),
        phone = COALESCE(EXCLUDED.phone, family_profiles.phone),
        address_line1 = COALESCE(EXCLUDED.address_line1, family_profiles.address_line1),
        city = COALESCE(EXCLUDED.city, family_profiles.city),
        state = COALESCE(EXCLUDED.state, family_profiles.state),
        zip = COALESCE(EXCLUDED.zip, family_profiles.zip),
        referral_source = COALESCE(EXCLUDED.referral_source, family_profiles.referral_source),
        agreements_accepted_at = COALESCE(EXCLUDED.agreements_accepted_at, family_profiles.agreements_accepted_at),
        payment_policy_accepted_at = COALESCE(EXCLUDED.payment_policy_accepted_at, family_profiles.payment_policy_accepted_at)
      RETURNING *`
    return res.json(row)
  }

  res.status(405).json({ error: 'Method not allowed' })
}
