// Audit BCBS NC member IDs and dep codes for drift / silent failures.
// Prints: children with insurance_provider ~ BCBS, their member_id length +
// dep code, and recent claims' stored member_id + dep code so we can see
// where the suffix is or isn't going.

import { neon } from '@neondatabase/serverless'
const sql = neon(process.env.DATABASE_URL)

const kids = await sql`
  SELECT id, first_name, last_name,
         insurance_provider, insurance_member_id, insurance_dependent_code,
         LENGTH(insurance_member_id) AS mid_len
  FROM children
  WHERE insurance_provider ILIKE '%blue%' OR insurance_provider ILIKE '%bcbs%' OR insurance_provider ILIKE '%anthem%'
  ORDER BY last_name, first_name`
console.log(`BCBS-ish children (${kids.length}):`)
for (const k of kids) {
  console.log(` ${k.first_name} ${k.last_name}  ${k.insurance_provider}  mid_len=${k.mid_len}  dep='${k.insurance_dependent_code ?? ''}'  id='${k.insurance_member_id ?? ''}'`)
}

const claims = await sql`
  SELECT id, payer_id, member_id, insurance_dependent_code, patient_first_name, patient_last_name,
         status, submitted_at, LENGTH(member_id) AS mid_len
  FROM claims
  WHERE payer_id IN ('UPICO', 'BCSNC', 'NCBCBS', 'NCBLS', 'NCPNHP')
  ORDER BY created_at DESC
  LIMIT 20`
console.log(`\nRecent BCBS claims (${claims.length}):`)
for (const c of claims) {
  console.log(` ${c.patient_first_name} ${c.patient_last_name}  status=${c.status}  payer=${c.payer_id}  mid_len=${c.mid_len}  dep='${c.insurance_dependent_code ?? ''}'  id='${c.member_id ?? ''}'  submitted=${c.submitted_at?.toISOString?.() ?? 'no'}`)
}

// Spot the pattern: what % of children have no dep code? what % of
// stored claims have no dep code? the submit transforms require it.
const kidsMissingDep = kids.filter(k => !k.insurance_dependent_code).length
const claimsMissingDep = claims.filter(c => !c.insurance_dependent_code).length
console.log(`\nmissing dep codes — kids: ${kidsMissingDep}/${kids.length}, claims: ${claimsMissingDep}/${claims.length}`)
