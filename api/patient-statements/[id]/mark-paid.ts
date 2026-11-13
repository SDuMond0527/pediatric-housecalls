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
 * POST /api/patient-statements/[id]/mark-paid
 *
 * Manual "record a payment" for billers running cards in Square outside
 * of the portal. Body:
 *   {
 *     amount_paid: number | string,   // dollars (server converts to cents)
 *     paid_at:     string,            // ISO date/datetime, defaults to now
 *     payment_method?: string,        // free label — 'Card on file', 'Check', etc.
 *     payment_note?:   string         // Pam's reference — Square receipt id, check #, etc.
 *   }
 *
 * Sets status='paid', paid_at, paid_amount_cents, and appends the
 * payment_method / payment_note into a payment_note column. Rejects if
 * the statement is already paid so double-clicks or accidental
 * re-submits don't destroy paid_at/paid_amount_cents.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  let sub: string
  try {
    sub = await verifyToken(req.headers.authorization)
  } catch {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  try {
    const sql = neon(process.env.DATABASE_URL!)

    const [provider] = await sql`SELECT practice_id FROM providers WHERE cognito_sub = ${sub} LIMIT 1`
    if (!provider) return res.status(403).json({ error: 'Provider not found' })
    const practiceId = provider.practice_id as string

    const statementId = req.query.id as string
    if (!statementId) return res.status(400).json({ error: 'id required' })

    // Idempotent — biller needs a place to note "Square receipt #xxx" or
    // "Check #1042" when they record the payment outside the portal.
    try {
      await sql`ALTER TABLE patient_statements ADD COLUMN IF NOT EXISTS payment_note text`
    } catch {}

    const { amount_paid, paid_at, payment_method, payment_note } = req.body ?? {}

    const dollars = parseFloat(String(amount_paid ?? ''))
    // $0 is legal — used by the "No patient responsibility" flow when
    // ERA fully covers the claim or the whole thing is a contractual
    // adjustment. Negative amounts are not.
    if (!isFinite(dollars) || dollars < 0) {
      return res.status(400).json({ error: 'amount_paid must be a non-negative number.' })
    }
    const cents = Math.round(dollars * 100)

    const paidAtIso = paid_at && String(paid_at).trim() !== ''
      ? new Date(String(paid_at)).toISOString()
      : new Date().toISOString()

    const [existing] = await sql`
      SELECT id, status FROM patient_statements
      WHERE id = ${statementId} AND practice_id = ${practiceId}::uuid
      LIMIT 1
    `
    if (!existing) return res.status(404).json({ error: 'Statement not found' })
    if (existing.status === 'paid') {
      return res.status(409).json({ error: 'Statement is already marked paid. Refresh the page to see the latest state.' })
    }

    const noteParts: string[] = []
    if (payment_method && String(payment_method).trim()) noteParts.push(String(payment_method).trim())
    if (payment_note   && String(payment_note).trim())   noteParts.push(String(payment_note).trim())
    const combinedNote = noteParts.length ? noteParts.join(' — ') : null

    const [updated] = await sql`
      UPDATE patient_statements SET
        status            = 'paid',
        paid_at           = ${paidAtIso}::timestamptz,
        paid_amount_cents = ${cents},
        payment_note      = ${combinedNote},
        updated_at        = NOW()
      WHERE id = ${statementId} AND practice_id = ${practiceId}::uuid
      RETURNING *
    `

    return res.status(200).json(updated)
  } catch (e: any) {
    console.error('patient-statements/[id]/mark-paid error:', e)
    return res.status(500).json({ error: e.message ?? 'Internal server error' })
  }
}
