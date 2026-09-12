import type { VercelRequest, VercelResponse } from '@vercel/node'
import { neon } from '@neondatabase/serverless'
import { createRemoteJWKSet, jwtVerify } from 'jose'

// See feedback_utc_date_bug.md. Vercel runs UTC; new Date().toISOString()
// after 8 PM ET returns tomorrow's date. Use for practice-local dates.
function easternDateStr(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
}

async function verifyAnyToken(authHeader: string | undefined): Promise<{ sub: string; isFamily: boolean }> {
  if (!authHeader?.startsWith('Bearer ')) throw new Error('Missing token')
  const token = authHeader.slice(7)
  const region = process.env.VITE_AWS_REGION || 'us-east-2'
  const familyPoolId = process.env.VITE_FAMILY_USER_POOL_ID || ''
  if (familyPoolId) {
    try {
      const JWKS = createRemoteJWKSet(new URL(`https://cognito-idp.${region}.amazonaws.com/${familyPoolId}/.well-known/jwks.json`))
      const { payload } = await jwtVerify(token, JWKS, { issuer: `https://cognito-idp.${region}.amazonaws.com/${familyPoolId}` })
      if (payload.sub) return { sub: payload.sub, isFamily: true }
    } catch {}
  }
  const providerPoolId = process.env.VITE_AWS_USER_POOL_ID || ''
  const JWKS = createRemoteJWKSet(new URL(`https://cognito-idp.${region}.amazonaws.com/${providerPoolId}/.well-known/jwks.json`))
  const { payload } = await jwtVerify(token, JWKS, { issuer: `https://cognito-idp.${region}.amazonaws.com/${providerPoolId}` })
  if (!payload.sub) throw new Error('No sub in token')
  return { sub: payload.sub, isFamily: false }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  let auth: { sub: string; isFamily: boolean }
  try {
    auth = await verifyAnyToken(req.headers.authorization)
  } catch {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const sql = neon(process.env.DATABASE_URL!)

  let practiceId: string
  if (auth.isFamily) {
    const familyRows = await sql`SELECT practice_id FROM family_profiles WHERE cognito_sub = ${auth.sub} LIMIT 1`
    if (!familyRows.length) return res.status(403).json({ error: 'Family not found' })
    practiceId = (familyRows[0].practice_id || process.env.VITE_PRACTICE_ID) as string
  } else {
    const providerRows = await sql`SELECT practice_id FROM providers WHERE cognito_sub = ${auth.sub} LIMIT 1`
    if (!providerRows.length) return res.status(403).json({ error: 'Provider not found' })
    practiceId = providerRows[0].practice_id as string
  }

  const { id } = req.query as { id: string }

  if (req.method === 'PATCH') {
    try {
      const b = req.body

      // Subscriber name must include both first + last if provided.
      // Empty is fine (self-pay / not-yet-collected). Single-word is
      // rejected downstream by Blue Cross — catch it here so bad data
      // never lands in children.insurance_subscriber_name.
      if (b?.insurance_subscriber_name && String(b.insurance_subscriber_name).trim()) {
        const parts = String(b.insurance_subscriber_name).trim().split(/\s+/).filter(Boolean)
        if (parts.length < 2) {
          return res.status(400).json({ error: 'Subscriber name must include both first and last name (e.g., "Sarah Rodgers").' })
        }
      }

      // ── Archive / unarchive patient ──────────────────────────────────────────
      if (b._action === 'archive') {
        const [row] = await sql`
          UPDATE children SET is_archived = true, archived_at = NOW()
          WHERE id = ${id}::uuid AND practice_id = ${practiceId}::uuid
          RETURNING *`
        if (!row) return res.status(404).json({ error: 'Not found' })
        return res.json(row)
      }

      if (b._action === 'unarchive') {
        const [row] = await sql`
          UPDATE children SET is_archived = false, archived_at = NULL
          WHERE id = ${id}::uuid AND practice_id = ${practiceId}::uuid
          RETURNING *`
        if (!row) return res.status(404).json({ error: 'Not found' })
        return res.json(row)
      }

      // ── Archive current insurance and clear it ────────────────────────────────
      if (b._action === 'archive_insurance') {
        const [current] = await sql`SELECT * FROM children WHERE id = ${id}::uuid AND practice_id = ${practiceId}::uuid`
        if (!current) return res.status(404).json({ error: 'Not found' })

        const entry = {
          insurance_provider:        current.insurance_provider        ?? null,
          insurance_member_id:       current.insurance_member_id       ?? null,
          insurance_group_number:    current.insurance_group_number    ?? null,
          insurance_subscriber_name: current.insurance_subscriber_name ?? null,
          insurance_subscriber_dob:  current.insurance_subscriber_dob  ?? null,
          insurance_subscriber_gender: current.insurance_subscriber_gender ?? null,
          insurance_card_front_url:  current.insurance_card_front_url  ?? null,
          insurance_card_back_url:   current.insurance_card_back_url   ?? null,
          deactivated_at: easternDateStr(),
        }
        const hasData = entry.insurance_provider || entry.insurance_member_id || entry.insurance_group_number
        const history = [
          ...(Array.isArray(current.previous_insurance) ? current.previous_insurance : []),
          ...(hasData ? [entry] : []),
        ]

        const [row] = await sql`
          UPDATE children SET
            previous_insurance           = ${JSON.stringify(history)}::jsonb,
            insurance_provider           = NULL,
            insurance_member_id          = NULL,
            insurance_group_number       = NULL,
            insurance_subscriber_name    = NULL,
            insurance_subscriber_dob     = NULL,
            insurance_subscriber_gender  = NULL,
            insurance_card_front_url     = NULL,
            insurance_card_back_url      = NULL
          WHERE id = ${id}::uuid AND practice_id = ${practiceId}::uuid
          RETURNING *`
        return res.json(row)
      }

      const dob = b.date_of_birth || null
      const newFirst = b.first_name || null
      const newLast  = b.last_name  || null

      // Family-wide fields — cascade to every sibling in the same family.
      // Parents typing these into any child's chart / intake should NOT
      // have to repeat themselves for their other kids. See memory:
      // feedback_all_patient_info_required_and_displayed.md
      //
      // Runs BEFORE the target-child UPDATE so the target row always ends
      // up with the newest values too (the target's own UPDATE re-applies
      // them via COALESCE with the same value — no conflict).
      const FAMILY_WIDE_KEYS = [
        'parent_phone', 'parent_email', 'parent_address',
        'parent_city',  'parent_state', 'parent_zip',
        'insurance_provider', 'insurance_member_id', 'insurance_group_number',
        'insurance_subscriber_name', 'insurance_subscriber_dob',
        'insurance_subscriber_gender', 'insurance_subscriber_relationship',
        'insurance_card_front_url', 'insurance_card_back_url',
        'preferred_pharmacy', 'pcp', 'pcp_id',
      ] as const
      const familyWideUpdate: Record<string, any> = {}
      for (const k of FAMILY_WIDE_KEYS) {
        const v = b[k]
        if (v != null && String(v).trim() !== '') familyWideUpdate[k] = v
      }
      if (Object.keys(familyWideUpdate).length > 0) {
        const [tgt] = await sql`SELECT family_id FROM children WHERE id = ${id}::uuid AND practice_id = ${practiceId}::uuid LIMIT 1`
        const familyId = (tgt as any)?.family_id
        if (familyId) {
          // Overwrite family-wide fields on ALL siblings (including target).
          // These fields are the same for every kid in the family — new
          // input wins. Per-child fields (name, DOB, allergies, meds, PMH,
          // vaccination_status) are handled by the per-target UPDATE below.
          await sql`
            UPDATE children SET
              parent_phone   = COALESCE(${familyWideUpdate.parent_phone   ?? null}, parent_phone),
              parent_email   = COALESCE(${familyWideUpdate.parent_email   ?? null}, parent_email),
              parent_address = COALESCE(${familyWideUpdate.parent_address ?? null}, parent_address),
              parent_city    = COALESCE(${familyWideUpdate.parent_city    ?? null}, parent_city),
              parent_state   = COALESCE(${familyWideUpdate.parent_state   ?? null}, parent_state),
              parent_zip     = COALESCE(${familyWideUpdate.parent_zip     ?? null}, parent_zip),
              insurance_provider           = COALESCE(${familyWideUpdate.insurance_provider           ?? null}, insurance_provider),
              insurance_member_id          = COALESCE(${familyWideUpdate.insurance_member_id          ?? null}, insurance_member_id),
              insurance_group_number       = COALESCE(${familyWideUpdate.insurance_group_number       ?? null}, insurance_group_number),
              insurance_subscriber_name    = COALESCE(${familyWideUpdate.insurance_subscriber_name    ?? null}, insurance_subscriber_name),
              insurance_subscriber_dob     = COALESCE(${familyWideUpdate.insurance_subscriber_dob     ?? null}::date, insurance_subscriber_dob),
              insurance_subscriber_gender  = COALESCE(${familyWideUpdate.insurance_subscriber_gender  ?? null}, insurance_subscriber_gender),
              insurance_subscriber_relationship = COALESCE(${familyWideUpdate.insurance_subscriber_relationship ?? null}, insurance_subscriber_relationship),
              insurance_card_front_url     = COALESCE(${familyWideUpdate.insurance_card_front_url     ?? null}, insurance_card_front_url),
              insurance_card_back_url      = COALESCE(${familyWideUpdate.insurance_card_back_url      ?? null}, insurance_card_back_url),
              preferred_pharmacy           = COALESCE(${familyWideUpdate.preferred_pharmacy           ?? null}, preferred_pharmacy),
              pcp                          = COALESCE(${familyWideUpdate.pcp                          ?? null}, pcp),
              pcp_id                       = COALESCE(${familyWideUpdate.pcp_id                       ?? null}::uuid, pcp_id)
            WHERE family_id = ${familyId}::uuid
              AND practice_id = ${practiceId}::uuid
              AND (is_archived IS NULL OR is_archived = false)
          `
        }
      }

      const [row] = await sql`
        UPDATE children SET
          first_name           = COALESCE(${newFirst}, first_name),
          last_name            = COALESCE(${newLast},  last_name),
          display_label        = CASE
            WHEN ${newFirst}::text IS NOT NULL OR ${newLast}::text IS NOT NULL
            THEN TRIM(COALESCE(${newFirst}::text, first_name) || ' ' || COALESCE(${newLast}::text, last_name))
            ELSE display_label
          END,
          date_of_birth        = COALESCE(${dob}::date,                      date_of_birth),
          insurance_provider   = COALESCE(${b.insurance_provider   || null}, insurance_provider),
          insurance_member_id  = COALESCE(${b.insurance_member_id  || null}, insurance_member_id),
          insurance_group_number = COALESCE(${b.insurance_group_number || null}, insurance_group_number),
          insurance_card_front_url     = COALESCE(${b.insurance_card_front_url     || null}, insurance_card_front_url),
          insurance_card_back_url      = COALESCE(${b.insurance_card_back_url      || null}, insurance_card_back_url),
          gender                       = COALESCE(${b.gender                       || null}, gender),
          insurance_subscriber_name    = COALESCE(${b.insurance_subscriber_name    || null}, insurance_subscriber_name),
          insurance_subscriber_dob     = COALESCE(${b.insurance_subscriber_dob     || null}::date, insurance_subscriber_dob),
          insurance_subscriber_gender  = COALESCE(${b.insurance_subscriber_gender  || null}, insurance_subscriber_gender),
          insurance_subscriber_relationship = COALESCE(${b.insurance_subscriber_relationship || null}, insurance_subscriber_relationship),
          allergies            = COALESCE(${b.allergies            || null}, allergies),
          current_medications  = COALESCE(${b.current_medications  || null}, current_medications),
          medical_history      = COALESCE(${b.medical_history      || null}, medical_history),
          preferred_pharmacy   = COALESCE(${b.preferred_pharmacy   || null}, preferred_pharmacy),
          pcp                  = COALESCE(${b.pcp                  || null}, pcp),
          pcp_id               = COALESCE(${b.pcp_id               || null}::uuid, pcp_id),
          phi_sharing_consent  = COALESCE(${b.phi_sharing_consent  ?? null}, phi_sharing_consent),
          charm_patient_id     = COALESCE(${b.charm_patient_id     || null}, charm_patient_id),
          parent_name          = COALESCE(${b.parent_name          ?? null}, parent_name),
          parent_phone         = COALESCE(${b.parent_phone         ?? null}, parent_phone),
          parent_email         = COALESCE(${b.parent_email         ?? null}, parent_email),
          parent_address       = COALESCE(${b.parent_address       ?? null}, parent_address),
          parent_city          = COALESCE(${b.parent_city          ?? null}, parent_city),
          parent_state         = COALESCE(${b.parent_state         ?? null}, parent_state),
          parent_zip           = COALESCE(${b.parent_zip           ?? null}, parent_zip),
          nickname             = COALESCE(${b.nickname             ?? null}, nickname),
          vaccination_status   = COALESCE(${b.vaccination_status   ?? null}, vaccination_status)
        WHERE id = ${id}::uuid AND practice_id = ${practiceId}::uuid
        RETURNING *`

      // Explicit-clear support. Every field in b._clear (if it's on the
      // whitelist) is set to NULL after the COALESCE-based update above.
      // This lets a user actually wipe a stale allergy list or remove
      // an old PCP entry — previously impossible because the client's
      // `field || null` pattern converted empty strings to null, and
      // COALESCE preserved the old value on null input. See memory:
      // feedback_extract_shared_code_first_try.md.
      const CLEARABLE = new Set([
        'nickname',
        'allergies', 'current_medications', 'medical_history',
        'preferred_pharmacy', 'pcp', 'pcp_id', 'vaccination_status',
        'insurance_provider', 'insurance_member_id', 'insurance_group_number',
        'insurance_subscriber_name', 'insurance_subscriber_dob',
        'insurance_subscriber_gender', 'insurance_subscriber_relationship',
        'insurance_card_front_url', 'insurance_card_back_url',
        // Contact fields — not typically cleared but allowed for editors.
        'parent_phone', 'parent_email',
        'parent_address', 'parent_city', 'parent_state', 'parent_zip',
      ])
      const requestedClears: unknown = (b as any)?._clear
      const clears = Array.isArray(requestedClears)
        ? (requestedClears as unknown[]).filter((k): k is string => typeof k === 'string' && CLEARABLE.has(k))
        : []
      if (clears.length > 0) {
        // Build one UPDATE that nulls every requested clearable field.
        // Neon serverless doesn't allow tagged-template column list
        // interpolation, so we branch by field name.
        for (const field of clears) {
          switch (field) {
            case 'nickname':                            await sql`UPDATE children SET nickname = NULL                            WHERE id = ${id}::uuid AND practice_id = ${practiceId}::uuid`; break
            case 'allergies':                           await sql`UPDATE children SET allergies = NULL                           WHERE id = ${id}::uuid AND practice_id = ${practiceId}::uuid`; break
            case 'current_medications':                 await sql`UPDATE children SET current_medications = NULL                 WHERE id = ${id}::uuid AND practice_id = ${practiceId}::uuid`; break
            case 'medical_history':                     await sql`UPDATE children SET medical_history = NULL                     WHERE id = ${id}::uuid AND practice_id = ${practiceId}::uuid`; break
            case 'preferred_pharmacy':                  await sql`UPDATE children SET preferred_pharmacy = NULL                  WHERE id = ${id}::uuid AND practice_id = ${practiceId}::uuid`; break
            case 'pcp':                                 await sql`UPDATE children SET pcp = NULL                                 WHERE id = ${id}::uuid AND practice_id = ${practiceId}::uuid`; break
            case 'pcp_id':                              await sql`UPDATE children SET pcp_id = NULL                              WHERE id = ${id}::uuid AND practice_id = ${practiceId}::uuid`; break
            case 'vaccination_status':                  await sql`UPDATE children SET vaccination_status = NULL                  WHERE id = ${id}::uuid AND practice_id = ${practiceId}::uuid`; break
            case 'insurance_provider':                  await sql`UPDATE children SET insurance_provider = NULL                  WHERE id = ${id}::uuid AND practice_id = ${practiceId}::uuid`; break
            case 'insurance_member_id':                 await sql`UPDATE children SET insurance_member_id = NULL                 WHERE id = ${id}::uuid AND practice_id = ${practiceId}::uuid`; break
            case 'insurance_group_number':              await sql`UPDATE children SET insurance_group_number = NULL              WHERE id = ${id}::uuid AND practice_id = ${practiceId}::uuid`; break
            case 'insurance_subscriber_name':           await sql`UPDATE children SET insurance_subscriber_name = NULL           WHERE id = ${id}::uuid AND practice_id = ${practiceId}::uuid`; break
            case 'insurance_subscriber_dob':            await sql`UPDATE children SET insurance_subscriber_dob = NULL            WHERE id = ${id}::uuid AND practice_id = ${practiceId}::uuid`; break
            case 'insurance_subscriber_gender':         await sql`UPDATE children SET insurance_subscriber_gender = NULL         WHERE id = ${id}::uuid AND practice_id = ${practiceId}::uuid`; break
            case 'insurance_subscriber_relationship':   await sql`UPDATE children SET insurance_subscriber_relationship = NULL   WHERE id = ${id}::uuid AND practice_id = ${practiceId}::uuid`; break
            case 'insurance_card_front_url':            await sql`UPDATE children SET insurance_card_front_url = NULL            WHERE id = ${id}::uuid AND practice_id = ${practiceId}::uuid`; break
            case 'insurance_card_back_url':             await sql`UPDATE children SET insurance_card_back_url = NULL             WHERE id = ${id}::uuid AND practice_id = ${practiceId}::uuid`; break
            case 'parent_phone':                        await sql`UPDATE children SET parent_phone = NULL                        WHERE id = ${id}::uuid AND practice_id = ${practiceId}::uuid`; break
            case 'parent_email':                        await sql`UPDATE children SET parent_email = NULL                        WHERE id = ${id}::uuid AND practice_id = ${practiceId}::uuid`; break
            case 'parent_address':                      await sql`UPDATE children SET parent_address = NULL                      WHERE id = ${id}::uuid AND practice_id = ${practiceId}::uuid`; break
            case 'parent_city':                         await sql`UPDATE children SET parent_city = NULL                         WHERE id = ${id}::uuid AND practice_id = ${practiceId}::uuid`; break
            case 'parent_state':                        await sql`UPDATE children SET parent_state = NULL                        WHERE id = ${id}::uuid AND practice_id = ${practiceId}::uuid`; break
            case 'parent_zip':                          await sql`UPDATE children SET parent_zip = NULL                          WHERE id = ${id}::uuid AND practice_id = ${practiceId}::uuid`; break
          }
        }
        // Re-fetch after nulls so the response reflects the cleared state.
        const [refreshed] = await sql`SELECT * FROM children WHERE id = ${id}::uuid AND practice_id = ${practiceId}::uuid`
        return res.json(refreshed)
      }

      return res.json(row)
    } catch (err: any) {
      return res.status(500).json({ error: err.message ?? String(err) })
    }
  }

  if (req.method === 'DELETE') {
    await sql`DELETE FROM children WHERE id = ${id}::uuid AND practice_id = ${practiceId}::uuid`
    return res.status(204).end()
  }

  res.status(405).json({ error: 'Method not allowed' })
}
