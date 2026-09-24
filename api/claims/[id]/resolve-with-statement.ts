import type { VercelRequest, VercelResponse } from '@vercel/node'
import { neon } from '@neondatabase/serverless'
import { createRemoteJWKSet, jwtVerify } from 'jose'

async function verifyToken(authHeader: string | undefined): Promise<string> {
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
 * POST /api/claims/[id]/resolve-with-statement
 *
 * Two-in-one action for the Rework tab: biller signals she's done
 * working the claim AND wants a draft patient statement created so
 * she can bill the patient for any remaining balance.
 *
 * 1. Stamps rework_resolved_at (moves claim Rework → Completed via filter)
 * 2. Creates a draft patient_statements row if one doesn't already exist
 *    - Uses whatever CAS/ERA data is on the claim (may be empty for 277
 *      rejection cases where no ERA was received)
 *    - Andrea edits + sends from the Statements page later
 * 3. Auto-logs to claim_activity_log
 *
 * Idempotent — safe to click twice. If a statement already exists,
 * returns the existing one.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  let sub: string
  try { sub = await verifyToken(req.headers.authorization) }
  catch { return res.status(401).json({ error: 'Unauthorized' }) }

  try {
    const sql = neon(process.env.DATABASE_URL!)
    const [provider] = await sql`SELECT id, name, practice_id FROM providers WHERE cognito_sub = ${sub} LIMIT 1`
    if (!provider) return res.status(403).json({ error: 'Provider not found' })

    const claimId = req.query.id as string
    if (!claimId) return res.status(400).json({ error: 'id required' })

    // Column + table bootstraps.
    try { await sql`ALTER TABLE claims ADD COLUMN IF NOT EXISTS rework_resolved_at timestamptz` } catch {}
    try { await sql`ALTER TABLE claims ADD COLUMN IF NOT EXISTS rework_resolved_by uuid` } catch {}
    try { await sql`ALTER TABLE claims ADD COLUMN IF NOT EXISTS rework_resolved_by_name text` } catch {}
    try { await sql`ALTER TABLE claims ADD COLUMN IF NOT EXISTS rework_resolved_note text` } catch {}
    try {
      await sql`
        CREATE TABLE IF NOT EXISTS claim_activity_log (
          id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          claim_id        uuid NOT NULL,
          created_at      timestamptz NOT NULL DEFAULT NOW(),
          created_by      uuid,
          created_by_name text,
          kind            text NOT NULL DEFAULT 'note',
          body            text NOT NULL
        )`
    } catch {}

    const [claim] = await sql`
      SELECT
        cl.id, cl.practice_id, cl.child_id, cl.appointment_id, cl.service_date,
        cl.cpt_codes, cl.total_charge,
        cl.patient_first_name, cl.patient_last_name, cl.patient_dob,
        cl.amount_billed_era, cl.insurance_payment_era, cl.contractual_adjustment_era,
        cl.patient_copay_era, cl.patient_deductible_era,
        cl.patient_coinsurance_era, cl.patient_non_covered_era,
        ch.parent_email, ch.parent_phone,
        fp.email AS family_email, fp.phone AS family_phone
      FROM claims cl
      LEFT JOIN children ch ON ch.id = COALESCE(cl.child_id, (SELECT child_id FROM appointments WHERE id = cl.appointment_id LIMIT 1))
      LEFT JOIN family_profiles fp ON fp.id = ch.family_id
      WHERE cl.id = ${claimId}::uuid AND cl.practice_id = ${provider.practice_id}::uuid
      LIMIT 1
    `
    if (!claim) return res.status(404).json({ error: 'Claim not found' })

    // 1. Mark rework resolved.
    await sql`
      UPDATE claims SET
        rework_resolved_at      = COALESCE(rework_resolved_at, NOW()),
        rework_resolved_by      = COALESCE(rework_resolved_by, ${provider.id}::uuid),
        rework_resolved_by_name = COALESCE(rework_resolved_by_name, ${provider.name ?? 'Biller'}),
        updated_at              = NOW()
      WHERE id = ${claimId}::uuid AND practice_id = ${provider.practice_id}::uuid
    `

    // 2. Ensure draft statement — use whatever CAS/ERA numbers exist on
    // the claim. For 277-rejection cases with no ERA, everything is 0
    // and Andrea fills in the amounts in the statement modal.
    const [existingStmt] = await sql`SELECT id, status FROM patient_statements WHERE claim_id = ${claimId}::uuid LIMIT 1`
    let statementId: string | undefined = existingStmt?.id
    let statementCreated = false

    if (!existingStmt) {
      const casCopay      = parseFloat(String(claim.patient_copay_era        ?? 0)) || 0
      const casDeductible = parseFloat(String(claim.patient_deductible_era   ?? 0)) || 0
      const casCoins      = parseFloat(String(claim.patient_coinsurance_era  ?? 0)) || 0
      const casNonCov     = parseFloat(String(claim.patient_non_covered_era  ?? 0)) || 0
      const casContract   = parseFloat(String(claim.contractual_adjustment_era ?? 0)) || 0
      const amountBilled  = parseFloat(String(claim.amount_billed_era        ?? claim.total_charge ?? 0)) || 0
      const insurancePay  = parseFloat(String(claim.insurance_payment_era    ?? 0)) || 0
      const patientResp   = +(casCopay + casDeductible + casCoins + casNonCov).toFixed(2)
      const remaining     = +(amountBilled - insurancePay - casContract).toFixed(2)
      const email = claim.parent_email ?? claim.family_email ?? null
      const phone = claim.parent_phone ?? claim.family_phone ?? null

      const [row] = await sql`
        INSERT INTO patient_statements (
          practice_id, claim_id,
          patient_first_name, patient_last_name, patient_dob,
          date_of_service, cpt_codes,
          patient_email, patient_phone,
          amount_billed, insurance_payment, contractual_adjustment,
          patient_copay, patient_deductible, patient_coinsurance, patient_non_covered,
          remaining_balance, prior_balance, total_amount_due, total_amount_due_text,
          status, created_at, updated_at
        ) VALUES (
          ${claim.practice_id}::uuid, ${claim.id},
          ${claim.patient_first_name}, ${claim.patient_last_name}, ${claim.patient_dob},
          ${claim.service_date}, ${JSON.stringify(claim.cpt_codes ?? [])}::jsonb,
          ${email}, ${phone},
          ${amountBilled}, ${insurancePay}, ${casContract},
          ${casCopay}, ${casDeductible}, ${casCoins}, ${casNonCov},
          ${remaining}, 0, ${patientResp}, ${String(patientResp)},
          'draft', NOW(), NOW()
        )
        RETURNING id
      `
      statementId = row?.id
      statementCreated = true
    }

    // 3. Activity log entry.
    const activityBody = statementCreated
      ? 'Marked rework complete — moved to Completed and generated a draft patient statement.'
      : 'Marked rework complete — moved to Completed. (Draft statement already existed.)'
    try {
      await sql`
        INSERT INTO claim_activity_log (claim_id, created_by, created_by_name, kind, body)
        VALUES (${claimId}::uuid, ${provider.id}::uuid, ${provider.name ?? 'Biller'}, 'rework_resolved_with_statement', ${activityBody})`
    } catch (logErr: any) {
      console.error('resolve-with-statement activity log insert failed (non-fatal):', logErr?.message)
    }

    return res.status(200).json({
      ok: true,
      claim_id: claimId,
      statement_id: statementId,
      statement_created: statementCreated,
    })
  } catch (e: any) {
    console.error('claims/[id]/resolve-with-statement error:', e)
    return res.status(500).json({ error: e.message ?? 'Internal server error' })
  }
}
