// Import CMS's NCCI PTP (Procedure-to-Procedure) edits CSV into the
// ncci_edits table. Runs the scrubber that catches CPT-pair bundling
// problems at submit time. Sara 2026-11-10.
//
// HOW TO USE:
// 1. Go to https://www.cms.gov/medicare/coding-billing/national-correct-coding-initiative-ncci-edits
// 2. Download the latest quarterly ZIP under "Medicare NCCI PTP Edits"
// 3. Unzip it. You'll see a big CSV named something like
//      "medicare-ncci-ptp-edits-practitioner-services-q4-2026.csv"
//    (hospital/ASC files are also in the ZIP; we only want practitioner)
// 4. Run:
//      node --env-file=.env scripts/import-ncci-ptp.mjs /path/to/file.csv
//
// Idempotent: UPSERT by primary key (column_1, column_2, effective_date,
// file_type). Safe to re-run — latest effective_date wins.
//
// Format expected (CMS columns, as of 2024):
//   Column 1, Column 2, * (pre-1996 flag), Effective Date (MM/DD/YYYY),
//   Deletion Date (MM/DD/YYYY or blank), Modifier (0/1/9), PTP Rationale
import { neon } from '@neondatabase/serverless'
import { readFileSync } from 'node:fs'

const sql = neon(process.env.DATABASE_URL)

const csvPath = process.argv[2]
if (!csvPath) {
  console.error('Usage: node --env-file=.env scripts/import-ncci-ptp.mjs <path-to-csv>')
  process.exit(1)
}

console.log('Reading', csvPath)
const raw = readFileSync(csvPath, 'utf8')
const lines = raw.split(/\r?\n/).filter(l => l.trim())
console.log(`${lines.length} lines in file.`)

// Ensure table + index exist (mirrors the bootstrap in
// api/claims/[id].ts so this script can run against a fresh DB).
await sql`
  CREATE TABLE IF NOT EXISTS ncci_edits (
    column_1            text NOT NULL,
    column_2            text NOT NULL,
    modifier_indicator  int NOT NULL,
    effective_date      date NOT NULL,
    deletion_date       date,
    rationale           text,
    file_type           text NOT NULL DEFAULT 'practitioner',
    imported_at         timestamptz NOT NULL DEFAULT NOW(),
    PRIMARY KEY (column_1, column_2, effective_date, file_type)
  )`
await sql`CREATE INDEX IF NOT EXISTS idx_ncci_edits_lookup ON ncci_edits(column_1, column_2) WHERE deletion_date IS NULL`

function parseCsvLine(line) {
  // Simple CSV parser — handles quoted fields with embedded commas.
  const out = []
  let cur = ''
  let inQ = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (c === '"') { inQ = !inQ; continue }
    if (c === ',' && !inQ) { out.push(cur); cur = ''; continue }
    cur += c
  }
  out.push(cur)
  return out
}

function parseDate(s) {
  if (!s || !s.trim()) return null
  // MM/DD/YYYY → YYYY-MM-DD
  const m = s.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
  if (!m) return null
  return `${m[3]}-${String(m[1]).padStart(2, '0')}-${String(m[2]).padStart(2, '0')}`
}

// Find the header row — CMS usually has 1-2 preamble rows + the column
// headers. Detect by looking for "Column 1" in the line.
let dataStart = -1
let headerCols = []
for (let i = 0; i < Math.min(lines.length, 10); i++) {
  const cols = parseCsvLine(lines[i])
  if (cols.some(c => /column\s*1/i.test(c))) {
    headerCols = cols.map(c => c.trim().toLowerCase())
    dataStart = i + 1
    break
  }
}
if (dataStart < 0) {
  console.error('Could not find CMS "Column 1" header row. Format may have changed; inspect the CSV manually.')
  process.exit(1)
}
console.log('Headers:', headerCols)

// Expected column positions (CMS format, mid-2020s):
const idx = {
  c1:   headerCols.findIndex(h => /column\s*1/.test(h)),
  c2:   headerCols.findIndex(h => /column\s*2/.test(h)),
  eff:  headerCols.findIndex(h => /effective/.test(h)),
  del:  headerCols.findIndex(h => /deletion/.test(h)),
  mod:  headerCols.findIndex(h => /modifier/.test(h)),
  rat:  headerCols.findIndex(h => /rationale/.test(h)),
}
if (idx.c1 < 0 || idx.c2 < 0 || idx.eff < 0 || idx.mod < 0) {
  console.error('Missing required columns. Found positions:', idx)
  process.exit(1)
}

const BATCH = 500
let inserted = 0
let skipped = 0
let batch = []

async function flushBatch() {
  if (batch.length === 0) return
  // Use parameterized placeholders — one row at a time to keep the
  // SQL safe. Neon serverless autocommits each statement.
  for (const row of batch) {
    try {
      await sql`
        INSERT INTO ncci_edits (column_1, column_2, modifier_indicator,
                                effective_date, deletion_date, rationale, file_type)
        VALUES (${row.c1}, ${row.c2}, ${row.mi}, ${row.eff}::date,
                ${row.del}::date, ${row.rat}, 'practitioner')
        ON CONFLICT (column_1, column_2, effective_date, file_type) DO UPDATE SET
          modifier_indicator = EXCLUDED.modifier_indicator,
          deletion_date      = EXCLUDED.deletion_date,
          rationale          = EXCLUDED.rationale,
          imported_at        = NOW()`
      inserted++
    } catch (e) {
      skipped++
      if (skipped < 10) console.error('  skip:', row.c1, row.c2, '-', e.message?.slice(0, 80))
    }
  }
  batch = []
}

console.log(`Importing rows starting at line ${dataStart + 1}…`)
let lineNo = 0
for (let i = dataStart; i < lines.length; i++) {
  lineNo++
  const cols = parseCsvLine(lines[i])
  if (cols.length < Math.max(idx.c1, idx.c2, idx.eff, idx.mod) + 1) { skipped++; continue }
  const c1  = String(cols[idx.c1]).trim().replace(/[^A-Z0-9]/gi, '')
  const c2  = String(cols[idx.c2]).trim().replace(/[^A-Z0-9]/gi, '')
  const eff = parseDate(cols[idx.eff])
  const del = idx.del >= 0 ? parseDate(cols[idx.del]) : null
  const mi  = parseInt(String(cols[idx.mod]).trim(), 10)
  const rat = idx.rat >= 0 ? String(cols[idx.rat]).trim().slice(0, 500) : null
  if (!c1 || !c2 || !eff || Number.isNaN(mi)) { skipped++; continue }

  batch.push({ c1, c2, mi, eff, del, rat })
  if (batch.length >= BATCH) {
    await flushBatch()
    if (lineNo % 5000 === 0) console.log(`  …${lineNo} rows processed, ${inserted} inserted, ${skipped} skipped`)
  }
}
await flushBatch()

console.log(`\n✓ Import complete: ${inserted} rows upserted, ${skipped} skipped.`)
const [stats] = await sql`SELECT COUNT(*)::int AS total FROM ncci_edits WHERE file_type='practitioner'`
console.log(`Total practitioner rows in table: ${stats.total}`)
