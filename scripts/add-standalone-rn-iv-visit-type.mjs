// Add a new visit type: RN IV fluids (outside referral) that does NOT
// auto-pair with telemed screening. Used when an outside physician's
// referral comes in — the patient has already been evaluated, so no
// telemed screening is needed.
//
// Mirrors the existing "RN in-home IV fluids administration" row's
// pricing, duration, roles, convenience fee. The ONLY difference is
// the visit_type string, which is deliberately absent from the
// PAIRED_SECONDARY_VISIT_TYPE map in api/appointments/index.ts — so
// booking creates ONLY the RN side, no auto-pair.
//
// Idempotent: skips if already present.
//
// Sara 2026-11-05.

import { neon } from '@neondatabase/serverless'
const sql = neon(process.env.DATABASE_URL)
const PHC_ID = '6b5a893f-f56c-4786-9912-59148a5e9aba'

const NEW_TYPE = 'RN IV fluids (outside referral)'

const [existing] = await sql`
  SELECT id FROM practice_visit_types
  WHERE practice_id = ${PHC_ID}::uuid AND visit_type = ${NEW_TYPE}
  LIMIT 1`

if (existing) {
  console.log(`✓ "${NEW_TYPE}" already exists (${existing.id}) — nothing to do`)
  process.exit(0)
}

const [inserted] = await sql`
  INSERT INTO practice_visit_types (
    practice_id, visit_type, base_price, badge_label, badge_color,
    duration_minutes, lead_minutes, has_convenience_fee, per_child_extra_minutes,
    is_in_home, is_cpr, is_active, sort_order, allowed_roles
  )
  VALUES (
    ${PHC_ID}::uuid,
    ${NEW_TYPE},
    250.00,
    'RN IV (outside)',
    '#E1F5EE',
    90,
    60,
    true,
    0,
    true,
    false,
    true,
    10,
    ARRAY['RN']
  )
  RETURNING id, visit_type, badge_label, duration_minutes, allowed_roles`

console.log(`✓ Inserted ${inserted.id}:`)
console.log(JSON.stringify(inserted, null, 2))
