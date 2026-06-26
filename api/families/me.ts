import type { VercelRequest, VercelResponse } from '@vercel/node'
import sql from '../_lib/db'
import { getFamilyContext } from '../_lib/auth'
import { verifyFamilyToken } from '../_lib/verifyFamilyToken'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  let sub: string
  try {
    sub = await verifyFamilyToken(req.headers.authorization)
  } catch {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  if (req.method === 'GET') {
    // Use getFamilyContext which also validates the family exists
    let ctx: { sub: string; practiceId: string; familyId: string }
    try {
      ctx = await getFamilyContext(req.headers.authorization)
    } catch {
      return res.status(404).json({ error: 'Family not found' })
    }
    const [profiles, kids] = await Promise.all([
      sql`SELECT * FROM family_profiles WHERE cognito_sub = ${sub} AND practice_id = ${ctx.practiceId}::uuid LIMIT 1`,
      sql`SELECT * FROM children WHERE family_id = ${ctx.familyId}::uuid AND practice_id = ${ctx.practiceId}::uuid ORDER BY created_at`,
    ])
    if (profiles.length === 0) return res.status(404).json({ error: 'Family not found' })
    return res.json({ family: profiles[0], children: kids })
  }

  if (req.method === 'PATCH') {
    try {
      // Try to get practiceId from existing family record
      let practiceId: string
      const [existing] = await sql`SELECT id, practice_id FROM family_profiles WHERE cognito_sub = ${sub} LIMIT 1`
      if (existing?.practice_id) {
        practiceId = existing.practice_id
      } else {
        // First upsert — look up the default practice
        const [practice] = await sql`SELECT id FROM practices WHERE slug = 'pediatric-house-calls' LIMIT 1`
        if (!practice) throw new Error('Default practice not found')
        practiceId = practice.id
      }

      const { email, display_name, phone, address_line1, city, state, zip, referral_source, agreements_accepted_at, payment_policy_accepted_at } = req.body
      const [row] = await sql`
        INSERT INTO family_profiles (id, cognito_sub, email, display_name, phone, address_line1, city, state, zip, referral_source, agreements_accepted_at, payment_policy_accepted_at, practice_id)
        VALUES (
          gen_random_uuid(),
          ${sub},
          ${email ?? ''},
          ${display_name ?? null},
          ${phone ?? null},
          ${address_line1 ?? null},
          ${city ?? null},
          ${state ?? null},
          ${zip ?? null},
          ${referral_source ?? null},
          ${agreements_accepted_at ?? null}::timestamptz,
          ${payment_policy_accepted_at ?? null}::timestamptz,
          ${practiceId}::uuid
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
          payment_policy_accepted_at = COALESCE(EXCLUDED.payment_policy_accepted_at, family_profiles.payment_policy_accepted_at),
          practice_id = COALESCE(family_profiles.practice_id, EXCLUDED.practice_id)
        RETURNING *`
      return res.json(row)
    } catch (e: any) {
      return res.status(500).json({ error: e.message ?? String(e) })
    }
  }

  res.status(405).json({ error: 'Method not allowed' })
}
