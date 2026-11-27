import type { VercelRequest, VercelResponse } from '@vercel/node'
import { neon } from '@neondatabase/serverless'
import { createRemoteJWKSet, jwtVerify } from 'jose'

// GET /api/admin/writeoff-detail?start=YYYY-MM-DD&end=YYYY-MM-DD[&include=billing_error]
//
// Per-row drill-down for the "Statement write-offs" MoneyCard on the
// Financial Reports page. Default excludes billing_error voids (matches
// the top-line total on the card). Pass include=billing_error to see
// everything including the system-correction voids.
//
// Sara 2026-11-27.

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
    const [provider] = await sql`SELECT practice_id, is_admin, is_super_admin FROM providers WHERE cognito_sub = ${sub} LIMIT 1`
    if (!provider) return res.status(403).json({ error: 'Provider not found' })
    if (!provider.is_admin && !provider.is_super_admin) return res.status(403).json({ error: 'Admin only' })

    const start = String(req.query.start ?? '').trim()
    const end   = String(req.query.end   ?? '').trim()
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
      return res.status(400).json({ error: 'start and end must be YYYY-MM-DD' })
    }
    const includeBillingError = String(req.query.include ?? '') === 'billing_error'

    // Bootstrap just in case.
    try { await sql`ALTER TABLE patient_statements ADD COLUMN IF NOT EXISTS voided_at timestamptz` } catch {}
    try { await sql`ALTER TABLE patient_statements ADD COLUMN IF NOT EXISTS void_reason text` } catch {}
    try { await sql`ALTER TABLE patient_statements ADD COLUMN IF NOT EXISTS voided_by uuid` } catch {}
    try { await sql`ALTER TABLE patient_statements ADD COLUMN IF NOT EXISTS void_note text` } catch {}

    const rows = includeBillingError
      ? await sql`
          SELECT
            ps.id,
            ps.patient_first_name,
            ps.patient_last_name,
            ps.date_of_service,
            ps.total_amount_due,
            ps.void_reason,
            ps.void_note,
            ps.voided_at,
            p.name AS voided_by_name
          FROM patient_statements ps
          LEFT JOIN providers p ON p.id = ps.voided_by
          WHERE ps.practice_id = ${provider.practice_id}::uuid
            AND ps.status = 'void'
            AND ps.voided_at IS NOT NULL
            AND ps.voided_at::date BETWEEN ${start}::date AND ${end}::date
          ORDER BY ps.voided_at DESC`
      : await sql`
          SELECT
            ps.id,
            ps.patient_first_name,
            ps.patient_last_name,
            ps.date_of_service,
            ps.total_amount_due,
            ps.void_reason,
            ps.void_note,
            ps.voided_at,
            p.name AS voided_by_name
          FROM patient_statements ps
          LEFT JOIN providers p ON p.id = ps.voided_by
          WHERE ps.practice_id = ${provider.practice_id}::uuid
            AND ps.status = 'void'
            AND ps.voided_at IS NOT NULL
            AND ps.voided_at::date BETWEEN ${start}::date AND ${end}::date
            AND COALESCE(NULLIF(TRIM(ps.void_reason), ''), '') <> 'billing_error'
          ORDER BY ps.voided_at DESC`

    return res.status(200).json({ rows })
  } catch (e: any) {
    console.error('[writeoff-detail] error:', e)
    return res.status(500).json({ error: e?.message ?? String(e) })
  }
}
