import type { VercelRequest, VercelResponse } from '@vercel/node'
import { neon, type NeonQueryFunction } from '@neondatabase/serverless'
import { createRemoteJWKSet, jwtVerify } from 'jose'

// Supplies catalog — per-practice list of what providers can request.
// GET returns the active catalog (any provider on the practice).
// POST creates a new catalog item (admin only).
//
// Shape of a supply row:
//   { id, practice_id, name, unit_label, description,
//     default_quantity, associated_cpt_code, units_per_box,
//     sort_order, is_active, created_at }
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

export async function bootstrapSupplyTables(sql: NeonQueryFunction<false, false>) {
  await sql`
    CREATE TABLE IF NOT EXISTS supplies_catalog (
      id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      practice_id          uuid NOT NULL,
      name                 text NOT NULL,
      unit_label           text,
      description          text,
      default_quantity     int  NOT NULL DEFAULT 1,
      associated_cpt_code  text,
      units_per_box        int,
      sort_order           int  NOT NULL DEFAULT 100,
      is_active            boolean NOT NULL DEFAULT true,
      created_at           timestamptz NOT NULL DEFAULT NOW(),
      updated_at           timestamptz NOT NULL DEFAULT NOW()
    )`
  // Phase 2 usage-predictor signals. CPT codes are already a column;
  // sendout tags are the second signal for supplies that don't map to
  // a billable code (Luxor FedEx bags, labels, swab bundles). Added
  // 2026-11-19 after Sara noted PCR send-outs don't go through
  // GoRoam's lab-orders table — nothing to decrement off, so we need
  // a one-click tag at sign-time. See EncounterNoteModal's "Lab
  // send-outs" section.
  try { await sql`ALTER TABLE supplies_catalog ADD COLUMN IF NOT EXISTS associated_sendout_tag text` } catch {}
  await sql`CREATE INDEX IF NOT EXISTS supplies_catalog_practice_idx ON supplies_catalog(practice_id, is_active, sort_order)`

  await sql`
    CREATE TABLE IF NOT EXISTS supply_requests (
      id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      practice_id           uuid NOT NULL,
      provider_id           uuid NOT NULL,
      provider_name         text NOT NULL,
      shipping_address      text,
      notes                 text,
      status                text NOT NULL DEFAULT 'requested',
      requested_at          timestamptz NOT NULL DEFAULT NOW(),
      ordered_at            timestamptz,
      ordered_by_name       text,
      shipped_at            timestamptz,
      shipped_by_name       text,
      received_at           timestamptz,
      cancelled_at          timestamptz,
      cancelled_by_name     text,
      cancelled_reason      text
    )`
  await sql`CREATE INDEX IF NOT EXISTS supply_requests_practice_idx ON supply_requests(practice_id, status, requested_at DESC)`
  await sql`CREATE INDEX IF NOT EXISTS supply_requests_provider_idx ON supply_requests(provider_id, requested_at DESC)`

  await sql`
    CREATE TABLE IF NOT EXISTS supply_request_items (
      id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      request_id    uuid NOT NULL REFERENCES supply_requests(id) ON DELETE CASCADE,
      supply_id     uuid NOT NULL,
      supply_name   text NOT NULL,
      unit_label    text,
      quantity      int  NOT NULL DEFAULT 1,
      notes         text
    )`
  await sql`CREATE INDEX IF NOT EXISTS supply_request_items_request_idx ON supply_request_items(request_id)`
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  let sub: string
  try { sub = await verifyProviderToken(req.headers.authorization) }
  catch { return res.status(401).json({ error: 'Unauthorized' }) }

  const sql = neon(process.env.DATABASE_URL!)
  await bootstrapSupplyTables(sql)

  const [provider] = await sql`SELECT id, name, practice_id, is_admin, is_super_admin FROM providers WHERE cognito_sub = ${sub} LIMIT 1`
  if (!provider) return res.status(403).json({ error: 'Provider not found' })

  if (req.method === 'GET') {
    const includeArchived = String(req.query.include_archived ?? '') === 'true'
    const rows = includeArchived
      ? await sql`SELECT * FROM supplies_catalog WHERE practice_id = ${provider.practice_id}::uuid ORDER BY is_active DESC, sort_order, name`
      : await sql`SELECT * FROM supplies_catalog WHERE practice_id = ${provider.practice_id}::uuid AND is_active = true ORDER BY sort_order, name`
    return res.status(200).json(rows)
  }

  if (req.method === 'POST') {
    if (!provider.is_admin && !provider.is_super_admin) return res.status(403).json({ error: 'Admin only' })
    const b = req.body ?? {}
    const name = String(b.name ?? '').trim()
    if (!name) return res.status(400).json({ error: 'name required' })
    const [row] = await sql`
      INSERT INTO supplies_catalog
        (practice_id, name, unit_label, description, default_quantity, associated_cpt_code, units_per_box, sort_order, associated_sendout_tag)
      VALUES
        (${provider.practice_id}::uuid, ${name},
         ${b.unit_label ?? null}, ${b.description ?? null},
         ${Number(b.default_quantity ?? 1)},
         ${b.associated_cpt_code ?? null},
         ${b.units_per_box != null ? Number(b.units_per_box) : null},
         ${Number(b.sort_order ?? 100)},
         ${b.associated_sendout_tag ?? null})
      RETURNING *`
    return res.status(201).json(row)
  }

  return res.status(405).json({ error: 'Method not allowed' })
}
