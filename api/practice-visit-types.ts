import type { VercelRequest, VercelResponse } from '@vercel/node'
import { neon } from '@neondatabase/serverless'
import { createRemoteJWKSet, jwtVerify } from 'jose'

// Returns the caller's practice_id. Supports either the provider
// pool (admin + clinical) or the family pool. Returns null if no
// token or no practice resolved. Sara 2026-11-15.
async function resolveCallerPracticeId(sql: any, authHeader: string | undefined): Promise<string | null> {
  if (!authHeader?.startsWith('Bearer ')) return null
  const token = authHeader.slice(7)
  const region = process.env.VITE_AWS_REGION || 'us-east-2'
  const familyPoolId = process.env.VITE_FAMILY_USER_POOL_ID || ''
  if (familyPoolId) {
    try {
      const JWKS = createRemoteJWKSet(new URL(`https://cognito-idp.${region}.amazonaws.com/${familyPoolId}/.well-known/jwks.json`))
      const { payload } = await jwtVerify(token, JWKS, { issuer: `https://cognito-idp.${region}.amazonaws.com/${familyPoolId}` })
      if (payload.sub) {
        const [row] = await sql`SELECT practice_id FROM family_profiles WHERE cognito_sub = ${payload.sub} LIMIT 1`
        return (row?.practice_id as string) ?? null
      }
    } catch {}
  }
  const userPoolId = process.env.VITE_AWS_USER_POOL_ID || ''
  if (userPoolId) {
    try {
      const JWKS = createRemoteJWKSet(new URL(`https://cognito-idp.${region}.amazonaws.com/${userPoolId}/.well-known/jwks.json`))
      const { payload } = await jwtVerify(token, JWKS, { issuer: `https://cognito-idp.${region}.amazonaws.com/${userPoolId}` })
      if (payload.sub) {
        const [row] = await sql`SELECT practice_id FROM providers WHERE cognito_sub = ${payload.sub} LIMIT 1`
        return (row?.practice_id as string) ?? null
      }
    } catch {}
  }
  return null
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  const sql = neon(process.env.DATABASE_URL!)

  // Multi-tenant seam: visit types MUST come from the caller's own
  // practice. Before 2026-11-15 this endpoint hard-wired
  // VITE_PRACTICE_ID (PHC) and served PHC's visit types to every
  // caller — so Direct Dermatology's Analytics page showed "In-home
  // CPR class" / "Sports physical" / etc. as columns.
  //
  // Also added token verification — previously this was an
  // unauthenticated endpoint leaking visit-type labels to anyone.
  const practiceId = await resolveCallerPracticeId(sql, req.headers.authorization)
  if (!practiceId) return res.status(401).json({ error: 'Unauthorized' })

  // No visit-type renames on read — the descriptive names already in the
  // DB (`CMA + telemedicine`, `RN in-home IV fluids administration`,
  // `Video telemedicine screening for IV fluids`) are the source of truth.
  // An earlier version of this endpoint tried to rename them based on the
  // shorter badge_labels, but that matched nothing and confused everyone.

  // Self-heal: if the practice has uses_ear_piercing on but no
  // "In-home ear piercing" row (because a prior settings-save side
  // effect silently failed), create it on the next GET + flip Becca
  // Jones + Megan Heilemann's availability on. All idempotent. Sara
  // 2026-11-22 — settings toggle was flipping the flag but the row
  // wasn't getting created, which hid the per-provider toggle.
  try {
    const [p] = await sql`SELECT settings FROM practices WHERE id = ${practiceId}::uuid LIMIT 1`
    const settings = (p?.settings ?? {}) as Record<string, unknown>
    if (settings.uses_ear_piercing === true) {
      const EAR_PIERCING = 'In-home ear piercing'
      const [existing] = await sql`
        SELECT id, is_active FROM practice_visit_types
        WHERE practice_id = ${practiceId}::uuid AND visit_type = ${EAR_PIERCING}
        LIMIT 1`
      if (!existing) {
        await sql`
          INSERT INTO practice_visit_types
            (practice_id, visit_type, base_price, badge_label, badge_color, badge_text_color,
             duration_minutes, lead_minutes, has_convenience_fee, per_child_extra_minutes,
             is_in_home, is_cpr, is_active, sort_order)
          VALUES
            (${practiceId}::uuid, ${EAR_PIERCING}, 100, 'Piercing', '#F1EFE8', '#1A1A2E',
             60, 60, true, 0, true, false, true, 50)`
      } else if (existing.is_active === false) {
        await sql`
          UPDATE practice_visit_types SET is_active = true, base_price = 100
          WHERE id = ${existing.id}::uuid`
      }
      // Upsert fee-schedule rows + Becca/Megan availability on the same
      // self-heal pass so the whole feature lights up together.
      // Two-tier pricing (Sara 2026-11-24): EarPierce $100 for regular,
      // EarPierceUpg $160 for upgraded-studs piercings. One line per tier
      // keeps the self-pay statement clean.
      for (const [code, desc, amt] of [
        ['EarPierce',    'In-home ear piercing (includes medical-grade titanium starter studs)', 100.00],
        ['EarPierceUpg', 'In-home ear piercing with upgraded studs',                              160.00],
      ] as const) {
        const [feeExisting] = await sql`
          SELECT code FROM fee_schedule WHERE practice_id = ${practiceId}::uuid AND code = ${code} LIMIT 1`
        if (!feeExisting) {
          await sql`
            INSERT INTO fee_schedule (practice_id, code, description, charge_amount, category)
            VALUES (${practiceId}::uuid, ${code}, ${desc}, ${amt}, 'Non-Covered Services')`
        }
      }
      const providers = await sql`
        SELECT id FROM providers
        WHERE practice_id = ${practiceId}::uuid
          AND name IN ('Becca Jones','Megan Heilemann')
          AND is_active = true` as any[]
      for (const pr of providers) {
        const [av] = await sql`
          SELECT id FROM visit_type_availability
          WHERE provider_id = ${pr.id}::uuid AND visit_type = ${EAR_PIERCING}
          LIMIT 1`
        if (!av) {
          await sql`
            INSERT INTO visit_type_availability (provider_id, visit_type, is_active, start_time, end_time)
            VALUES (${pr.id}::uuid, ${EAR_PIERCING}, true, '08:00', '17:00')`
        }
      }
    }
  } catch (e: any) {
    console.error('[practice-visit-types] ear-piercing self-heal failed:', e?.message)
  }

  const rows = await sql`
    SELECT * FROM practice_visit_types
    WHERE practice_id = ${practiceId}::uuid AND is_active = true
    ORDER BY sort_order, visit_type`
  res.json(rows)
}
