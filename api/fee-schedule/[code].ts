// PATCH /api/fee-schedule/[code]
//   body: { description?, category?, charge_amount?, place_of_service?, is_active? }
// DELETE /api/fee-schedule/[code]  → sets is_active = false (soft archive)
//
// Scoped by practice_id — admins can only touch their own practice's
// fee schedule. Sara 2026-11-16, built so Dr. Cash can self-manage
// her derm procedure prices.

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
  if (!payload.sub) throw new Error('No sub')
  return payload.sub as string
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  let sub: string
  try { sub = await verifyToken(req.headers.authorization) }
  catch { return res.status(401).json({ error: 'Unauthorized' }) }

  const code = String(req.query.code ?? '').trim()
  if (!code) return res.status(400).json({ error: 'code required' })

  const sql = neon(process.env.DATABASE_URL!)
  const [provider] = await sql`SELECT id, practice_id, is_admin FROM providers WHERE cognito_sub = ${sub} LIMIT 1`
  if (!provider) return res.status(403).json({ error: 'Provider not found' })
  if (!provider.is_admin) return res.status(403).json({ error: 'Admin only' })
  const practiceId = provider.practice_id as string

  if (req.method === 'PATCH') {
    const body = (req.body ?? {}) as Record<string, any>
    const description   = typeof body.description      === 'string' ? body.description.trim() : undefined
    const category      = typeof body.category         === 'string' ? body.category.trim() || null : undefined
    const chargeAmount  = body.charge_amount != null ? Number(body.charge_amount) : undefined
    const placeOfService = typeof body.place_of_service === 'string' ? (body.place_of_service.trim() || null) : undefined
    const isActive      = typeof body.is_active        === 'boolean' ? body.is_active : undefined

    if (chargeAmount != null && (!Number.isFinite(chargeAmount) || chargeAmount < 0)) {
      return res.status(400).json({ error: 'charge_amount must be a non-negative number' })
    }

    const [row] = await sql`
      UPDATE fee_schedule SET
        description      = COALESCE(${description ?? null}, description),
        category         = COALESCE(${category ?? null}, category),
        charge_amount    = COALESCE(${chargeAmount ?? null}, charge_amount),
        place_of_service = CASE WHEN ${placeOfService === undefined}::boolean THEN place_of_service ELSE ${placeOfService ?? null} END,
        is_active        = COALESCE(${isActive ?? null}::boolean, is_active)
      WHERE practice_id = ${practiceId}::uuid AND code = ${code}
      RETURNING code, description, category, charge_amount, place_of_service, is_active`
    if (!row) return res.status(404).json({ error: 'Not found' })
    return res.status(200).json({
      ...row,
      charge_amount: parseFloat(row.charge_amount as any),
    })
  }

  if (req.method === 'DELETE') {
    const [row] = await sql`
      UPDATE fee_schedule SET is_active = false
      WHERE practice_id = ${practiceId}::uuid AND code = ${code}
      RETURNING code`
    if (!row) return res.status(404).json({ error: 'Not found' })
    return res.status(200).json({ ok: true })
  }

  return res.status(405).json({ error: 'Method not allowed' })
}
