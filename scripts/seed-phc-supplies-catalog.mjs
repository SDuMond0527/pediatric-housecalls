// Seeds the PHC supplies catalog with the 23 items from the current
// Google Supply Order Form. Idempotent — matches by (practice_id, name)
// and updates instead of duplicating if the item already exists.
//
// Run against production ONCE after the supplies tables ship:
//   node --env-file=/tmp/.env.prod scripts/seed-phc-supplies-catalog.mjs
//
// Or against the Neon preview branch to validate:
//   node --env-file=.env.local scripts/seed-phc-supplies-catalog.mjs
//
// Sara 2026-11-19 — items pulled from
// https://docs.google.com/forms/d/e/1FAIpQLSfDM-oCIV4klwmJI25BsDQ5XoSe8dDsjKueNl_PtvaldIUDvA/viewform

import { neon } from '@neondatabase/serverless'

// Hardcoded PHC practice id — the live practice uses this uuid.
const PHC_PRACTICE_ID = '6b5a893f-f56c-4786-9912-59148a5e9aba'

// Each entry becomes one row in supplies_catalog. CPT + units_per_box
// are seeded only for items where the Phase 2 usage-predictor can
// actually work (lab/med codes where each encounter consumes one unit).
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
  { name: 'Luxor urine collection cups',        unit_label: 'cups',                          default_quantity: 2, associated_cpt_code: '81003', sort_order: 160, associated_sendout_tags: ['luxor_urine_sendout'] },
  { name: 'Castille soap towelettes',           unit_label: 'box',                           default_quantity: 1, sort_order: 170 },
  { name: 'Rapid strep tests',                  unit_label: 'box of 25',                     default_quantity: 1, associated_cpt_code: '87880', units_per_box: 25, sort_order: 180 },
  { name: 'Rapid COVID/RSV/Flu A/B tests',      unit_label: 'box of 4',                      default_quantity: 1, associated_cpt_code: '87811', units_per_box: 4,  sort_order: 190 },
  { name: 'Luxor Lab supplies — FedEx bags',    unit_label: 'bundle',                        default_quantity: 1, description: 'Specify color variant in notes.', sort_order: 200, associated_sendout_tags: ['luxor_swab_sendout', 'luxor_urine_sendout'] },
  { name: 'Luxor Lab supplies — swabs/tubes/biohazard bundle', unit_label: 'bundle',         default_quantity: 1, sort_order: 210, associated_sendout_tags: ['luxor_swab_sendout'] },
  { name: 'Luxor Lab supplies — White labels (Mon-Wed)', unit_label: 'bundle',               default_quantity: 1, sort_order: 220, associated_sendout_tags: ['luxor_swab_sendout', 'luxor_urine_sendout'], applicable_days_of_week: ['Mon','Tue','Wed'] },
  { name: 'Luxor Lab supplies — Blue labels (Thu-Sat)',  unit_label: 'bundle',               default_quantity: 1, sort_order: 222, associated_sendout_tags: ['luxor_swab_sendout', 'luxor_urine_sendout'], applicable_days_of_week: ['Thu','Fri','Sat'] },
  { name: 'Nebulizer tubing',                   unit_label: 'tubes',                         default_quantity: 5, associated_cpt_code: '94640', sort_order: 230 },
]

const sql = neon(process.env.DATABASE_URL)

async function bootstrap() {
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
  try { await sql`ALTER TABLE supplies_catalog ADD COLUMN IF NOT EXISTS associated_sendout_tags text[]` } catch {}
  try { await sql`ALTER TABLE supplies_catalog ADD COLUMN IF NOT EXISTS applicable_days_of_week text[]` } catch {}
  // Archive legacy rows that have been split into finer-grained items.
  const DEPRECATED_NAMES = [
    'Luxor Lab supplies — FedEx labels',
  ]
  try {
    await sql`
      UPDATE supplies_catalog SET is_active = false, updated_at = NOW()
      WHERE practice_id = ${PHC_PRACTICE_ID}::uuid
        AND name = ANY(${DEPRECATED_NAMES})
        AND is_active = true`
  } catch {}
}

let inserted = 0, updated = 0
await bootstrap()
for (const it of CATALOG) {
  const [existing] = await sql`
    SELECT id FROM supplies_catalog
    WHERE practice_id = ${PHC_PRACTICE_ID}::uuid AND name = ${it.name}
    LIMIT 1`
  const tagsArr = Array.isArray(it.associated_sendout_tags)
    ? it.associated_sendout_tags
    : (it.associated_sendout_tag ? [it.associated_sendout_tag] : null)
  const legacyTag = tagsArr && tagsArr.length > 0 ? tagsArr[0] : null
  const dowArr = Array.isArray(it.applicable_days_of_week) && it.applicable_days_of_week.length > 0 ? it.applicable_days_of_week : null
  if (existing) {
    await sql`
      UPDATE supplies_catalog SET
        unit_label          = ${it.unit_label ?? null},
        description         = ${it.description ?? null},
        default_quantity    = ${it.default_quantity ?? 1},
        associated_cpt_code = ${it.associated_cpt_code ?? null},
        associated_sendout_tag = ${legacyTag},
        associated_sendout_tags = ${tagsArr},
        applicable_days_of_week = ${dowArr},
        units_per_box       = ${it.units_per_box ?? null},
        sort_order          = ${it.sort_order ?? 100},
        is_active           = true,
        updated_at          = NOW()
      WHERE id = ${existing.id}::uuid`
    updated++
  } else {
    await sql`
      INSERT INTO supplies_catalog
        (practice_id, name, unit_label, description, default_quantity, associated_cpt_code, associated_sendout_tag, associated_sendout_tags, applicable_days_of_week, units_per_box, sort_order)
      VALUES
        (${PHC_PRACTICE_ID}::uuid, ${it.name}, ${it.unit_label ?? null}, ${it.description ?? null},
         ${it.default_quantity ?? 1}, ${it.associated_cpt_code ?? null}, ${legacyTag}, ${tagsArr}, ${dowArr},
         ${it.units_per_box ?? null}, ${it.sort_order ?? 100})`
    inserted++
  }
}

console.log(`Done — ${inserted} inserted, ${updated} updated, ${CATALOG.length} total catalog items for PHC.`)
