import type { VercelRequest, VercelResponse } from '@vercel/node'
import { neon } from '@neondatabase/serverless'
import { createRemoteJWKSet, jwtVerify } from 'jose'
import { bootstrapSupplyTables } from '../supplies/index.js'

// GET /api/supply-requests — provider sees own history, admin sees all.
//   Query:
//     scope=mine   → just this provider's requests (default for non-admin)
//     scope=all    → entire practice (admin only; default for admin)
//     status=open  → requested/ordered/shipped (not received or cancelled)
//     status=<explicit>
//
// POST /api/supply-requests — any provider can create a request for themselves.
//   Body: { items: [{ supply_id, quantity, notes? }], shipping_address?, notes? }
//   If shipping_address missing → falls back to provider.home_address.
//
// Sara 2026-11-19.

async function verifyProviderToken(authHeader: string | undefined): Promise<string> {
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
  let sub: string
  try { sub = await verifyProviderToken(req.headers.authorization) }
  catch { return res.status(401).json({ error: 'Unauthorized' }) }

  const sql = neon(process.env.DATABASE_URL!)
  await bootstrapSupplyTables(sql)

  const [provider] = await sql`SELECT id, name, practice_id, is_admin, is_super_admin, home_address FROM providers WHERE cognito_sub = ${sub} LIMIT 1`
  if (!provider) return res.status(403).json({ error: 'Provider not found' })
  const isAdmin = !!(provider.is_admin || provider.is_super_admin)

  if (req.method === 'GET') {
    const requestedScope = String(req.query.scope ?? '')
    const scope: 'mine' | 'all' =
      requestedScope === 'mine' ? 'mine'
      : requestedScope === 'all' && isAdmin ? 'all'
      : isAdmin ? 'all'
      : 'mine'
    const status = String(req.query.status ?? '').trim()

    // Base rows — filter by practice always, by provider if scope=mine.
    const baseRows = scope === 'mine'
      ? await sql`
          SELECT * FROM supply_requests
          WHERE practice_id = ${provider.practice_id}::uuid
            AND provider_id = ${provider.id}::uuid
          ORDER BY requested_at DESC`
      : await sql`
          SELECT * FROM supply_requests
          WHERE practice_id = ${provider.practice_id}::uuid
          ORDER BY requested_at DESC`

    // Filter by status in JS so the same base SELECT works for both branches.
    const rows = status
      ? status === 'open'
        ? baseRows.filter((r: any) => !['received', 'cancelled'].includes(r.status))
        : baseRows.filter((r: any) => r.status === status)
      : baseRows

    if (rows.length === 0) return res.status(200).json([])

    // Pull all items for the returned requests in one query.
    const ids = rows.map((r: any) => r.id)
    const items = await sql`
      SELECT * FROM supply_request_items WHERE request_id = ANY(${ids}::uuid[])
      ORDER BY id`
    const itemsByRequest = new Map<string, any[]>()
    for (const it of items) {
      const k = String((it as any).request_id)
      if (!itemsByRequest.has(k)) itemsByRequest.set(k, [])
      itemsByRequest.get(k)!.push(it)
    }
    const result = rows.map((r: any) => ({ ...r, items: itemsByRequest.get(String(r.id)) ?? [] }))
    return res.status(200).json(result)
  }

  if (req.method === 'POST') {
    const b = req.body ?? {}
    const items = Array.isArray(b.items) ? b.items : []
    if (items.length === 0) return res.status(400).json({ error: 'At least one supply required' })

    const shippingAddress = String(b.shipping_address ?? '').trim() || provider.home_address || null
    if (!shippingAddress) return res.status(400).json({ error: 'Shipping address required — none on your profile and none provided' })

    const notes = typeof b.notes === 'string' ? b.notes.trim() || null : null

    // Validate supplies belong to the same practice.
    const supplyIds = items.map((it: any) => String(it.supply_id)).filter(Boolean)
    if (supplyIds.length !== items.length) return res.status(400).json({ error: 'Every item needs a supply_id' })

    const supplies = await sql`
      SELECT id, name, unit_label FROM supplies_catalog
      WHERE id = ANY(${supplyIds}::uuid[]) AND practice_id = ${provider.practice_id}::uuid AND is_active = true`
    if (supplies.length !== supplyIds.length) {
      return res.status(400).json({ error: 'One or more supplies are not active in your practice catalog' })
    }
    const suppliesById = new Map(supplies.map((s: any) => [String(s.id), s]))

    const [reqRow] = await sql`
      INSERT INTO supply_requests
        (id, practice_id, provider_id, provider_name, shipping_address, notes)
      VALUES
        (gen_random_uuid(), ${provider.practice_id}::uuid, ${provider.id}::uuid,
         ${provider.name ?? 'Provider'}, ${shippingAddress}, ${notes})
      RETURNING *`

    const itemRows: any[] = []
    for (const it of items) {
      const sup = suppliesById.get(String(it.supply_id))!
      const qty = Math.max(1, Number(it.quantity ?? 1) | 0)
      const itemNotes = typeof it.notes === 'string' ? it.notes.trim() || null : null
      const [r] = await sql`
        INSERT INTO supply_request_items
          (id, request_id, supply_id, supply_name, unit_label, quantity, notes)
        VALUES
          (gen_random_uuid(), ${reqRow.id}::uuid, ${sup.id}::uuid,
           ${sup.name}, ${sup.unit_label ?? null}, ${qty}, ${itemNotes})
        RETURNING *`
      itemRows.push(r)
    }

    return res.status(201).json({ ...reqRow, items: itemRows })
  }

  return res.status(405).json({ error: 'Method not allowed' })
}
