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

export default async function handler(req: VercelRequest, res: VercelResponse) {
  let sub: string
  try {
    sub = await verifyToken(req.headers.authorization)
  } catch {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const sql = neon(process.env.DATABASE_URL!)

  const providerRows = await sql`SELECT practice_id FROM providers WHERE cognito_sub = ${sub} LIMIT 1`
  if (!providerRows.length) return res.status(403).json({ error: 'Provider not found' })
  const practiceId = providerRows[0].practice_id as string

  // One-time in-place code swap: rapid COVID/flu test moved from 87428 to
  // 87812 (idempotent — no-op once done, no-op if 87812 already exists).
  try {
    await sql`
      UPDATE fee_schedule
      SET code = '87812'
      WHERE code = '87428'
        AND NOT EXISTS (SELECT 1 FROM fee_schedule fs2 WHERE fs2.code = '87812' AND fs2.practice_id = fee_schedule.practice_id)
    `
  } catch (e) {
    console.error('[fee-schedule] cpt swap err:', e)
  }

  // Idempotent column bootstrap for NDC (National Drug Code). Some payers
  // require an NDC attached to a service line for vaccine and drug CPTs.
  // The value stored here is the raw NDC as the biller/provider wrote it
  // (e.g., "49281-590-58"). Normalization to the 11-digit no-dash format
  // that X12 837P requires happens at Stedi payload emission time.
  try { await sql`ALTER TABLE fee_schedule ADD COLUMN IF NOT EXISTS ndc_code text` } catch {}
  // Per-dose mL amount used to populate Stedi's nationalDrugUnitCount.
  // Vaccines are typically 0.5 mL; nebulized drug solutions vary.
  try { await sql`ALTER TABLE fee_schedule ADD COLUMN IF NOT EXISTS ndc_unit_count numeric(6,3)` } catch {}

  // Seed the initial NDC mappings idempotently. Only writes when the
  // target field is currently NULL, so manual DB overrides survive.
  try {
    await sql`UPDATE fee_schedule SET ndc_code = '49281-590-58'  WHERE code = '90619' AND ndc_code IS NULL`
    await sql`UPDATE fee_schedule SET ndc_code = '49281-0400-89' WHERE code = '90715' AND ndc_code IS NULL`
    await sql`UPDATE fee_schedule SET ndc_code = '0487-9501-25'  WHERE code = 'J7613' AND ndc_code IS NULL`
    await sql`UPDATE fee_schedule SET ndc_unit_count = 0.5 WHERE code = '90619' AND ndc_unit_count IS NULL`
    await sql`UPDATE fee_schedule SET ndc_unit_count = 0.5 WHERE code = '90715' AND ndc_unit_count IS NULL`
    await sql`UPDATE fee_schedule SET ndc_unit_count = 3   WHERE code = 'J7613' AND ndc_unit_count IS NULL`
  } catch (e) { console.error('[fee-schedule] ndc seed err:', e) }

  const rows = await sql`
    SELECT code, description, category, charge_amount, place_of_service, ndc_code, ndc_unit_count
    FROM fee_schedule
    WHERE is_active = true AND practice_id = ${practiceId}::uuid
    ORDER BY category, code
  `
  return res.json(rows.map(r => ({
    ...r,
    charge_amount: parseFloat(r.charge_amount as string),
    ndc_unit_count: r.ndc_unit_count != null ? parseFloat(r.ndc_unit_count as string) : null,
  })))
}
