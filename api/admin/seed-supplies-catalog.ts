import type { VercelRequest, VercelResponse } from '@vercel/node'
import { neon } from '@neondatabase/serverless'
import { createRemoteJWKSet, jwtVerify } from 'jose'

// POST /api/admin/seed-supplies-catalog
//
// One-shot endpoint that upserts the 23 items from the PHC Google
// Supply Order Form into the authenticated super-admin's practice
// supplies_catalog. Idempotent — matches by (practice_id, name) and
// updates existing rows instead of duplicating.
//
// Super-admin only. Separate from the catalog CRUD endpoints so it
// doesn't need to be exposed in the UI editor. Sara 2026-11-19
// explicitly hits it once per practice they want seeded; I'll show
// her a one-line command or a button in the catalog editor.

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

const CATALOG = [
  { name: 'Gloves',                             unit_label: 'box (ship 2 at a time)',       default_quantity: 2, description: 'Specify size (S/M/L) in notes.', sort_order: 10 },
  { name: 'Surgical masks',                     unit_label: 'box',                           default_quantity: 1, sort_order: 20 },
  { name: 'N95 masks',                          unit_label: 'box',                           default_quantity: 1, sort_order: 30 },
  { name: 'Thermometer probe covers',           unit_label: 'box of 250',                    default_quantity: 1, description: 'Specify thermometer type in notes.', sort_order: 40 },
  { name: 'Tongue depressors',                  unit_label: 'box of 100',                    default_quantity: 1, sort_order: 50 },
  { name: 'Dexamethasone IV/IM 10 mg/mL',       unit_label: 'box of 25 single-dose vials',   default_quantity: 1, associated_cpt_code: 'J1100', sort_order: 60 },
  { name: 'Zofran 4 mg ODT',                    unit_label: 'package of 30 tablets',         default_quantity: 1, associated_cpt_code: 'J2405', units_per_box: 30, sort_order: 70 },
  { name: 'Epinephrine 1:1000',                 unit_label: 'single-dose vial',              default_quantity: 1, associated_cpt_code: 'J0171', sort_order: 80 },
  { name: 'Albuterol for nebulizer',            unit_label: 'package of 5 vials',            default_quantity: 1, associated_cpt_code: 'J7613', units_per_box: 5,  sort_order: 90 },
  { name: 'Bandaids',                           unit_label: 'box',                           default_quantity: 1, sort_order: 100 },
  { name: 'Ear wax curettes',                   unit_label: 'box of 50',                     default_quantity: 1, units_per_box: 50, sort_order: 110 },
  { name: 'AccuCheck strips',                   unit_label: 'box',                           default_quantity: 1, description: 'Include a photo of your machine in notes.', sort_order: 120 },
  { name: 'Otoscope speculums',                 unit_label: 'bag',                           default_quantity: 1, description: 'Specify pediatric or adult size in notes.', sort_order: 130 },
  { name: 'Pediatric urine collection bags',    unit_label: 'bags',                          default_quantity: 5, sort_order: 140 },
  { name: 'Urine dipsticks',                    unit_label: 'box',                           default_quantity: 1, associated_cpt_code: '81003', sort_order: 150 },
  { name: 'Luxor urine collection cups',        unit_label: 'cups',                          default_quantity: 2, associated_cpt_code: '81003', sort_order: 160 },
  { name: 'Castille soap towelettes',           unit_label: 'box',                           default_quantity: 1, sort_order: 170 },
  { name: 'Rapid strep tests',                  unit_label: 'box of 25',                     default_quantity: 1, associated_cpt_code: '87880', units_per_box: 25, sort_order: 180 },
  { name: 'Rapid COVID/RSV/Flu A/B tests',      unit_label: 'box of 4',                      default_quantity: 1, associated_cpt_code: '87811', units_per_box: 4,  sort_order: 190 },
  { name: 'Luxor Lab supplies — FedEx bags',    unit_label: 'bundle',                        default_quantity: 1, description: 'Specify color variant in notes.', sort_order: 200, associated_sendout_tag: 'luxor_sendout' },
  { name: 'Luxor Lab supplies — swabs/tubes/biohazard bundle', unit_label: 'bundle',         default_quantity: 1, sort_order: 210, associated_sendout_tag: 'luxor_sendout' },
  { name: 'Luxor Lab supplies — FedEx labels', unit_label: 'bundle',                         default_quantity: 1, sort_order: 220, associated_sendout_tag: 'luxor_sendout' },
  { name: 'Nebulizer tubing',                   unit_label: 'tubes',                         default_quantity: 5, associated_cpt_code: '94640', sort_order: 230 },
]

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  let sub: string
  try { sub = await verifyProviderToken(req.headers.authorization) }
  catch { return res.status(401).json({ error: 'Unauthorized' }) }

  const sql = neon(process.env.DATABASE_URL!)
  const [provider] = await sql`SELECT id, name, practice_id, is_super_admin FROM providers WHERE cognito_sub = ${sub} LIMIT 1`
  if (!provider) return res.status(403).json({ error: 'Provider not found' })
  if (!provider.is_super_admin) return res.status(403).json({ error: 'Super-admin only' })

  // Bootstrap the table just in case the admin hits this before any
  // list GET on /api/supplies (which also bootstraps).
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
  try { await sql`ALTER TABLE supplies_catalog ADD COLUMN IF NOT EXISTS associated_sendout_tag text` } catch {}

  let inserted = 0, updated = 0
  for (const it of CATALOG) {
    const [existing] = await sql`
      SELECT id FROM supplies_catalog
      WHERE practice_id = ${provider.practice_id}::uuid AND name = ${it.name}
      LIMIT 1`
    if (existing) {
      await sql`
        UPDATE supplies_catalog SET
          unit_label          = ${it.unit_label ?? null},
          description         = ${(it as any).description ?? null},
          default_quantity    = ${it.default_quantity ?? 1},
          associated_cpt_code = ${(it as any).associated_cpt_code ?? null},
          associated_sendout_tag = ${(it as any).associated_sendout_tag ?? null},
          units_per_box       = ${(it as any).units_per_box ?? null},
          sort_order          = ${it.sort_order ?? 100},
          is_active           = true,
          updated_at          = NOW()
        WHERE id = ${existing.id}::uuid`
      updated++
    } else {
      await sql`
        INSERT INTO supplies_catalog
          (practice_id, name, unit_label, description, default_quantity, associated_cpt_code, associated_sendout_tag, units_per_box, sort_order)
        VALUES
          (${provider.practice_id}::uuid, ${it.name}, ${it.unit_label ?? null}, ${(it as any).description ?? null},
           ${it.default_quantity ?? 1}, ${(it as any).associated_cpt_code ?? null}, ${(it as any).associated_sendout_tag ?? null},
           ${(it as any).units_per_box ?? null}, ${it.sort_order ?? 100})`
      inserted++
    }
  }
  return res.status(200).json({ ok: true, inserted, updated, total: CATALOG.length })
}
