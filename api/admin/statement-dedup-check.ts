import type { VercelRequest, VercelResponse } from '@vercel/node'
import { neon } from '@neondatabase/serverless'
import { createRemoteJWKSet, jwtVerify } from 'jose'

// GET /api/admin/statement-dedup-check
//
// Scans patient_statements for any existing cases where TWO OR MORE
// non-voided rows share the same claim_id — the signature of the race
// bug that let Eliza Starrs' family get two identical bills on 2026-11-21.
//
// If the scan comes back clean, the endpoint installs a partial unique
// index on patient_statements(claim_id) WHERE voided_at IS NULL. From
// that point on, the database itself rejects any second attempt to
// create an active statement for a claim — the application code catches
// the rejection and uses the existing statement instead. No more
// duplicates.
//
// If the scan finds duplicates, the index is NOT installed. Sara (or
// whoever's running it) voids the duplicates one at a time through the
// Patient Statements UI, then hits this endpoint again to verify clean
// and install the lock.
//
// Admin-only. Read-only until the clean-scan install step. Sara
// 2026-11-27.

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

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  let sub: string
  try { sub = await verifyToken(req.headers.authorization) }
  catch { return res.status(401).json({ error: 'Unauthorized' }) }

  try {
    const sql = neon(process.env.DATABASE_URL!)
    const [provider] = await sql`SELECT id, practice_id, is_admin, is_super_admin FROM providers WHERE cognito_sub = ${sub} LIMIT 1`
    if (!provider) return res.status(403).json({ error: 'Provider not found' })
    if (!provider.is_admin && !provider.is_super_admin) return res.status(403).json({ error: 'Admin only' })

    // Bootstrap voided_at — if the column was never created on this
    // environment, the partial index predicate has nothing to reference.
    try { await sql`ALTER TABLE patient_statements ADD COLUMN IF NOT EXISTS voided_at timestamptz` } catch {}

    // Find every (claim_id) group with 2+ non-voided rows in the
    // calling admin's practice.
    const dups = await sql`
      SELECT
        ps.claim_id,
        COUNT(*) AS statement_count,
        ARRAY_AGG(ps.id ORDER BY ps.created_at) AS statement_ids,
        ARRAY_AGG(ps.status ORDER BY ps.created_at) AS statuses,
        ARRAY_AGG(ps.date_of_service ORDER BY ps.created_at) AS service_dates,
        ARRAY_AGG(ps.total_amount_due ORDER BY ps.created_at) AS amounts,
        MAX(ps.patient_first_name || ' ' || ps.patient_last_name) AS patient_name
      FROM patient_statements ps
      WHERE ps.practice_id = ${provider.practice_id}::uuid
        AND ps.voided_at IS NULL
      GROUP BY ps.claim_id
      HAVING COUNT(*) > 1
      ORDER BY MAX(ps.created_at) DESC
    `

    if (dups.length > 0) {
      return res.status(200).json({
        ok: true,
        lock_installed: false,
        duplicates_found: dups.length,
        duplicates: dups,
        message: `Found ${dups.length} claim${dups.length === 1 ? '' : 's'} with multiple active statements. Void the extras in Admin → Patient Statements, then hit this URL again.`,
      })
    }

    // Clean — attempt to install the lock. CREATE UNIQUE INDEX IF NOT
    // EXISTS is idempotent; re-runs are no-ops once installed.
    let lockCreated = false
    let alreadyInstalled = false
    try {
      // Check whether it already exists. pg_indexes is the standard
      // place; the index name we use is stable so it's easy to find.
      const [existing] = await sql`
        SELECT indexname FROM pg_indexes
        WHERE schemaname = 'public'
          AND tablename = 'patient_statements'
          AND indexname = 'patient_statements_claim_active_unique'
        LIMIT 1
      `
      if (existing) {
        alreadyInstalled = true
      } else {
        await sql`
          CREATE UNIQUE INDEX patient_statements_claim_active_unique
          ON patient_statements (claim_id)
          WHERE voided_at IS NULL
        `
        lockCreated = true
      }
    } catch (e: any) {
      return res.status(500).json({
        ok: false,
        lock_installed: false,
        duplicates_found: 0,
        error: `Lock install failed: ${e?.message ?? String(e)}. No data changed — the scan just confirmed no duplicates exist. Try again later or ping Anna.`,
      })
    }

    return res.status(200).json({
      ok: true,
      lock_installed: true,
      lock_created_this_call: lockCreated,
      already_installed: alreadyInstalled,
      duplicates_found: 0,
      message: alreadyInstalled
        ? 'No duplicates found. The database-level lock is already in place — any future duplicate-statement race will be stopped at the DB layer.'
        : 'No duplicates found. The database-level lock has been installed — any future duplicate-statement race will be stopped at the DB layer.',
    })
  } catch (e: any) {
    console.error('[statement-dedup-check] error:', e)
    return res.status(500).json({ error: e?.message ?? String(e) })
  }
}
