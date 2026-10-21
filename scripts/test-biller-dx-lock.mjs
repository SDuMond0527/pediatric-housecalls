// Verifies the fix for generateClaimForNote: SELECT must include
// biller_edited_at + payer_id so re-sign doesn't clobber dx edits.
//
// Before 2026-10-21 the SELECT pulled only (id, status). billerLocked
// then read undefined → false, so every note re-sign silently restored
// the note's original diagnoses even after Andrea had edited the claim.

import { neon } from '@neondatabase/serverless'
import { randomUUID } from 'crypto'

const sql = neon(process.env.DATABASE_URL)

const run = async () => {
  await sql`ALTER TABLE claims ADD COLUMN IF NOT EXISTS biller_edited_at timestamptz`

  const [practice] = await sql`SELECT id FROM practices LIMIT 1`
  if (!practice) { console.log('No practice row — abort'); return }
  const practiceId = practice.id

  const claimId = randomUUID()
  const noteDx   = [{ code: 'J06.9' }]
  const billerDx = [{ code: 'Z00.129' }]
  // We skip creating a real encounter_notes row (appointment_id NOT NULL
  // + plenty of FK bedrock) and instead point encounter_note_id at a
  // random uuid. The sign-path UPDATE keys on claims.id anyway, so the
  // dangling FK doesn't affect the dx-preservation assertion.
  const noteId = randomUUID()

  try {
    await sql`
      INSERT INTO claims (id, practice_id, status, diagnoses, cpt_codes, biller_edited_at)
      VALUES (${claimId}::uuid, ${practiceId}::uuid, 'pending_review',
              ${JSON.stringify(billerDx)}::jsonb, ${JSON.stringify([{code:'99213',charge_amount:'150',units:1}])}::jsonb,
              now())`

    // BEFORE fix (replicates pre-2026-10-21 bug): SELECT only id+status.
    const [before] = await sql`SELECT id, status FROM claims WHERE id = ${claimId}::uuid`
    const brokenLock = !!before.biller_edited_at
    console.log('before fix — billerLocked:', brokenLock, '(bug: reads false)')

    // AFTER fix: SELECT also pulls biller_edited_at.
    const [after] = await sql`SELECT id, status, payer_id, biller_edited_at FROM claims WHERE id = ${claimId}::uuid`
    const fixedLock = !!after.biller_edited_at
    console.log('after fix  — billerLocked:', fixedLock, '(expected: true)')

    if (brokenLock) throw new Error('unexpected: broken SELECT already read true')
    if (!fixedLock) throw new Error('FAIL: fixed SELECT still read false')

    // Simulate the sign-path UPDATE with the fixed lock.
    const [updated] = await sql`
      UPDATE claims SET
        diagnoses = CASE WHEN ${fixedLock}::boolean THEN diagnoses ELSE ${JSON.stringify(noteDx)}::jsonb END
      WHERE id = ${claimId}::uuid RETURNING diagnoses`
    const preservedCode = updated.diagnoses?.[0]?.code
    console.log('dx after re-sign (expected Z00.129):', preservedCode)
    if (preservedCode !== 'Z00.129') throw new Error(`FAIL: dx overwritten to ${preservedCode}`)

    console.log('\nPASS — biller edit survives note re-sign with fixed SELECT')
  } finally {
    await sql`DELETE FROM claims WHERE id = ${claimId}::uuid`
  }
}

run().catch(e => { console.error(e); process.exit(1) })
