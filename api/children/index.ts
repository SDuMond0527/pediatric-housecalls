import type { VercelRequest, VercelResponse } from '@vercel/node'
import { neon } from '@neondatabase/serverless'
import { createRemoteJWKSet, jwtVerify } from 'jose'

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
    const rows = await sql`SELECT id, practice_id FROM family_profiles WHERE cognito_sub = ${auth.sub} LIMIT 1`
    if (!rows.length) return res.status(403).json({ error: 'Family not found' })
    practiceId = (rows[0].practice_id || process.env.VITE_PRACTICE_ID) as string

    if (req.method === 'GET') {
      const { family_ids, ids, lookup_first, lookup_last, lookup_dob } = req.query as Record<string, string>

      // Lookup: check for an existing provider-created record matching name + DOB
      if (lookup_first && lookup_last && lookup_dob) {
        const [match] = await sql`
          SELECT id, first_name, last_name, date_of_birth, parent_phone, parent_email, parent_address
          FROM children
          WHERE practice_id = ${practiceId}::uuid
            AND family_id IS NULL
            AND first_name ILIKE ${lookup_first.trim()}
            AND last_name  ILIKE ${lookup_last.trim()}
            AND date_of_birth = ${lookup_dob}::date
          LIMIT 1`
        return res.json(match ?? null)
      }

      if (ids) {
        const idList = ids.split(',').filter(Boolean)
        if (!idList.length) return res.json([])
        const result = await sql`SELECT * FROM children WHERE id = ANY(${idList}::uuid[]) AND practice_id = ${practiceId}::uuid`
        return res.json(result)
      }
      if (!family_ids) return res.json([])
      const famIds = family_ids.split(',').filter(Boolean)
      const result = await sql`SELECT * FROM children WHERE family_id = ANY(${famIds}::uuid[]) AND practice_id = ${practiceId}::uuid`
      return res.json(result)
    }

    if (req.method === 'POST') {
      try {
        const b = req.body ?? {}
        const { display_label, first_name, last_name, date_of_birth } = b
        const familyId = rows[0].id as string

        // (1) Reject the create if there's no first name — a child chart
        //     without a name is a duplicate waiting to happen. See memory:
        //     feedback_all_patient_info_required_and_displayed.md
        const fn = String(first_name ?? '').trim()
        if (!fn) {
          return res.status(400).json({ error: "Child's first name is required." })
        }

        // Server-side guard: if the caller is providing intake fields
        // (extended signup / provider "Add sibling"), require the full
        // required set so we NEVER create a skeleton chart from an ingest
        // that promised to collect all data. Callers that don't pass any
        // intake fields still work (dedup / lookup paths above). See
        // memory: feedback_all_patient_info_required_and_displayed.md
        const REQUIRED_ALWAYS = [
          'last_name', 'date_of_birth', 'gender',
          'parent_phone', 'parent_email', 'parent_address',
          'allergies', 'current_medications', 'medical_history',
          'preferred_pharmacy', 'vaccination_status',
        ] as const
        const REQUIRED_IF_INSURED = [
          'insurance_member_id', 'insurance_group_number',
          'insurance_subscriber_name', 'insurance_subscriber_dob',
          'insurance_subscriber_gender',
          'insurance_card_front_url', 'insurance_card_back_url',
        ] as const
        const providingIntake = b.gender != null || b.allergies != null || b.preferred_pharmacy != null || b.insurance_provider != null
        const nonEmpty = (v: any) => v != null && String(v).trim() !== ''
        if (providingIntake) {
          const missing: string[] = []
          for (const k of REQUIRED_ALWAYS) if (!nonEmpty(b[k])) missing.push(k)
          const pcpOk = nonEmpty(b.pcp) || nonEmpty(b.pcp_id)
          if (!pcpOk) missing.push('pcp')
          const isSelfPay = String(b.insurance_provider || '').toLowerCase() === 'self-pay'
          if (!isSelfPay) {
            if (!nonEmpty(b.insurance_provider)) missing.push('insurance_provider')
            for (const k of REQUIRED_IF_INSURED) if (!nonEmpty(b[k])) missing.push(k)
          }
          if (missing.length) {
            return res.status(400).json({ error: `Missing required fields: ${missing.join(', ')}` })
          }
        }

        const ln = String(last_name ?? '').trim()
        const label = display_label || [fn, ln].filter(Boolean).join(' ') || 'Child'

        // (2) Race guard — if this family created ANY child row in the last
        //     10 seconds, treat this call as a double-click and return the
        //     most recent row instead of inserting a fresh duplicate. This
        //     is what produced Parker Deichmann's three identical empty
        //     rows: the parent's "Add child" fired multiple times within
        //     33 seconds.
        const [recent] = await sql`
          SELECT * FROM children
          WHERE family_id = ${familyId}::uuid
            AND practice_id = ${practiceId}::uuid
            AND created_at > NOW() - INTERVAL '10 seconds'
          ORDER BY created_at DESC
          LIMIT 1`
        if (recent) return res.json(recent)

        // (3a) Dedup within the family — if the family already has a row
        //      for a kid with this first name (matching last name and DOB
        //      when supplied), return that row instead of duplicating.
        const [sameFamilyMatch] = await sql`
          SELECT * FROM children
          WHERE family_id = ${familyId}::uuid
            AND practice_id = ${practiceId}::uuid
            AND first_name ILIKE ${fn}
            AND (${ln} = '' OR last_name ILIKE ${ln})
            AND (${date_of_birth ?? null}::date IS NULL OR date_of_birth = ${date_of_birth ?? null}::date)
          ORDER BY created_at ASC
          LIMIT 1`
        if (sameFamilyMatch) return res.json(sameFamilyMatch)

        // (3b) Link to an existing provider-added record (no family yet) if
        //      names + DOB all match — same logic as before, unchanged.
        if (ln && date_of_birth) {
          const existing = await sql`
            SELECT id FROM children
            WHERE practice_id = ${practiceId}::uuid
              AND family_id IS NULL
              AND first_name ILIKE ${fn}
              AND last_name ILIKE ${ln}
              AND date_of_birth = ${date_of_birth}
            LIMIT 1`
          if (existing.length) {
            const [linked] = await sql`
              UPDATE children SET family_id = ${familyId}::uuid, display_label = ${label}
              WHERE id = ${existing[0].id}::uuid
              RETURNING *`
            return res.json(linked)
          }
        }

        // Family-wide inheritance — a new sibling inherits every family-
        // wide field from any existing sibling in the family, so the parent
        // doesn't have to re-type pharmacy / PCP / insurance / address etc.
        // for each kid. See memory: feedback_all_patient_info_required_and_displayed.md
        const [inherit] = await sql`
          SELECT
            MAX(NULLIF(parent_phone,''))                          AS parent_phone,
            MAX(NULLIF(parent_email,''))                          AS parent_email,
            MAX(NULLIF(parent_address,''))                        AS parent_address,
            MAX(NULLIF(parent_city,''))                           AS parent_city,
            MAX(NULLIF(parent_state,''))                          AS parent_state,
            MAX(NULLIF(parent_zip,''))                            AS parent_zip,
            MAX(NULLIF(insurance_provider,''))                    AS insurance_provider,
            MAX(NULLIF(insurance_member_id,''))                   AS insurance_member_id,
            MAX(NULLIF(insurance_group_number,''))                AS insurance_group_number,
            MAX(NULLIF(insurance_subscriber_name,''))             AS insurance_subscriber_name,
            MAX(insurance_subscriber_dob)                         AS insurance_subscriber_dob,
            MAX(NULLIF(insurance_subscriber_gender,''))           AS insurance_subscriber_gender,
            MAX(NULLIF(insurance_subscriber_relationship,''))     AS insurance_subscriber_relationship,
            MAX(insurance_card_front_url)                         AS insurance_card_front_url,
            MAX(insurance_card_back_url)                          AS insurance_card_back_url,
            MAX(NULLIF(preferred_pharmacy,''))                    AS preferred_pharmacy,
            MAX(NULLIF(pcp,''))                                   AS pcp,
            MAX(pcp_id)                                           AS pcp_id
          FROM children
          WHERE family_id = ${familyId}::uuid
            AND practice_id = ${practiceId}::uuid
            AND (is_archived IS NULL OR is_archived = false)
        `
        const inh = (inherit as any) ?? {}

        // Prefer explicit body values (from intake), then family-wide
        // inherited values, then null. Same rule for every field.
        const pick = (k: string) => {
          const v = b[k]
          if (v != null && String(v).trim() !== '') return v
          return inh[k] ?? null
        }

        const [row] = await sql`
          INSERT INTO children (
            practice_id, display_label, first_name, last_name, family_id, date_of_birth,
            gender,
            parent_phone, parent_email, parent_address, parent_city, parent_state, parent_zip,
            allergies, current_medications, medical_history, vaccination_status,
            insurance_provider, insurance_member_id, insurance_group_number,
            insurance_subscriber_name, insurance_subscriber_dob, insurance_subscriber_gender, insurance_subscriber_relationship,
            insurance_card_front_url, insurance_card_back_url,
            preferred_pharmacy, pcp, pcp_id
          )
          VALUES (
            ${practiceId}::uuid, ${label}, ${fn}, ${ln || null}, ${familyId}::uuid, ${date_of_birth || null},
            ${pick('gender')},
            ${pick('parent_phone')}, ${pick('parent_email')}, ${pick('parent_address')},
            ${pick('parent_city')},  ${pick('parent_state')},  ${pick('parent_zip')},
            ${pick('allergies')}, ${pick('current_medications')}, ${pick('medical_history')}, ${pick('vaccination_status')},
            ${pick('insurance_provider')}, ${pick('insurance_member_id')}, ${pick('insurance_group_number')},
            ${pick('insurance_subscriber_name')}, ${pick('insurance_subscriber_dob') || null}::date,
            ${pick('insurance_subscriber_gender')}, ${pick('insurance_subscriber_relationship')},
            ${pick('insurance_card_front_url')}, ${pick('insurance_card_back_url')},
            ${pick('preferred_pharmacy')}, ${pick('pcp')}, ${pick('pcp_id') || null}::uuid
          )
          RETURNING *`
        return res.json(row)
      } catch (e: any) {
        return res.status(500).json({ error: e.message ?? String(e) })
      }
    }

    return res.status(405).json({ error: 'Method not allowed' })
  }

  // Provider path
  const providerRows = await sql`SELECT practice_id FROM providers WHERE cognito_sub = ${auth.sub} LIMIT 1`
  if (!providerRows.length) return res.status(403).json({ error: 'Provider not found' })
  practiceId = providerRows[0].practice_id as string

  if (req.method === 'GET') {
    const { family_ids, ids, search, include_archived } = req.query as Record<string, string>
    const showArchived = include_archived === '1'

    if (search?.trim()) {
      const q = `%${search.trim()}%`
      const rows = showArchived
        ? await sql`
            SELECT c.*,
                   fp.display_name  AS family_display_name,
                   fp.email         AS family_email,
                   fp.phone         AS family_phone,
                   fp.address_line1 AS family_address_line1,
                   fp.city          AS family_city,
                   fp.state         AS family_state,
                   fp.zip           AS family_zip
            FROM children c
            LEFT JOIN family_profiles fp ON fp.id = c.family_id
            WHERE c.practice_id = ${practiceId}::uuid
              AND c.is_archived = true
              AND (
                c.first_name ILIKE ${q}
                OR c.last_name  ILIKE ${q}
                OR (c.first_name || ' ' || c.last_name) ILIKE ${q}
                OR c.display_label ILIKE ${q}
              )
            ORDER BY c.first_name, c.last_name
            LIMIT 20`
        : await sql`
            SELECT c.*,
                   fp.display_name  AS family_display_name,
                   fp.email         AS family_email,
                   fp.phone         AS family_phone,
                   fp.address_line1 AS family_address_line1,
                   fp.city          AS family_city,
                   fp.state         AS family_state,
                   fp.zip           AS family_zip
            FROM children c
            LEFT JOIN family_profiles fp ON fp.id = c.family_id
            WHERE c.practice_id = ${practiceId}::uuid
              AND (c.is_archived IS NULL OR c.is_archived = false)
              AND (
                c.first_name ILIKE ${q}
                OR c.last_name  ILIKE ${q}
                OR (c.first_name || ' ' || c.last_name) ILIKE ${q}
                OR c.display_label ILIKE ${q}
              )
            ORDER BY c.first_name, c.last_name
            LIMIT 20`
      return res.json(rows)
    }

    if (ids) {
      const idList = ids.split(',').filter(Boolean)
      if (!idList.length) return res.json([])
      const rows = await sql`
        SELECT c.*,
               fp.display_name  AS family_display_name,
               fp.email         AS family_email,
               fp.phone         AS family_phone,
               fp.address_line1 AS family_address_line1,
               fp.city          AS family_city,
               fp.state         AS family_state,
               fp.zip           AS family_zip
        FROM children c
        LEFT JOIN family_profiles fp ON fp.id = c.family_id
        WHERE c.id = ANY(${idList}::uuid[]) AND c.practice_id = ${practiceId}::uuid`
      return res.json(rows)
    }
    if (family_ids) {
      const famIds = family_ids.split(',').filter(Boolean)
      const rows = await sql`SELECT * FROM children WHERE family_id = ANY(${famIds}::uuid[]) AND practice_id = ${practiceId}::uuid`
      return res.json(rows)
    }
    // No filters — return active or archived depending on flag
    const rows = showArchived
      ? await sql`
          SELECT c.*,
                 fp.display_name AS family_display_name,
                 fp.email        AS family_email,
                 fp.phone        AS family_phone
          FROM children c
          LEFT JOIN family_profiles fp ON fp.id = c.family_id
          WHERE c.practice_id = ${practiceId}::uuid
            AND c.is_archived = true
          ORDER BY c.archived_at DESC, c.first_name, c.last_name
          LIMIT 200`
      : await sql`
          SELECT c.*,
                 fp.display_name AS family_display_name,
                 fp.email        AS family_email,
                 fp.phone        AS family_phone
          FROM children c
          LEFT JOIN family_profiles fp ON fp.id = c.family_id
          WHERE c.practice_id = ${practiceId}::uuid
            AND (c.is_archived IS NULL OR c.is_archived = false)
          ORDER BY c.first_name, c.last_name, c.display_label
          LIMIT 200`
    return res.json(rows)
  }

  if (req.method === 'POST') {
    const {
      first_name, last_name, date_of_birth, gender,
      family_id,
      parent_name, parent_phone, parent_email,
      parent_address, parent_city, parent_state, parent_zip,
      pcp, preferred_pharmacy,
      insurance_provider, insurance_member_id, insurance_group_number,
      insurance_subscriber_name, insurance_subscriber_dob, insurance_subscriber_gender,
      insurance_subscriber_relationship,
      insurance_card_front_url, insurance_card_back_url,
      nickname,
      allergies, current_medications, medical_history, vaccination_status,
    } = req.body
    // Provider-path dedup — same three rules as the family-portal path:
    //   (1) Reject if first_name is missing. No more empty rows.
    //   (2) Race guard — if the same practice created ANY child row for
    //       this family (or, when family_id isn't provided, matching
    //       first_name in the practice) in the last 10 seconds, return
    //       that row rather than inserting a duplicate.
    //   (3) Same-family / same-name dedup — return the existing row
    //       when a match already exists.
    const fn = String(first_name ?? '').trim()
    const ln = String(last_name ?? '').trim()
    if (!fn) return res.status(400).json({ error: "Child's first name is required." })

    if (family_id) {
      const [recent] = await sql`
        SELECT * FROM children
        WHERE family_id = ${family_id}::uuid
          AND practice_id = ${practiceId}::uuid
          AND created_at > NOW() - INTERVAL '10 seconds'
        ORDER BY created_at DESC
        LIMIT 1`
      if (recent) return res.json(recent)
    } else {
      const [recent] = await sql`
        SELECT * FROM children
        WHERE practice_id = ${practiceId}::uuid
          AND family_id IS NULL
          AND first_name ILIKE ${fn}
          AND created_at > NOW() - INTERVAL '10 seconds'
        ORDER BY created_at DESC
        LIMIT 1`
      if (recent) return res.json(recent)
    }

    if (family_id) {
      const [sameFamilyMatch] = await sql`
        SELECT * FROM children
        WHERE family_id = ${family_id}::uuid
          AND practice_id = ${practiceId}::uuid
          AND first_name ILIKE ${fn}
          AND (${ln} = '' OR last_name ILIKE ${ln})
          AND (${date_of_birth ?? null}::date IS NULL OR date_of_birth = ${date_of_birth ?? null}::date)
        ORDER BY created_at ASC
        LIMIT 1`
      if (sameFamilyMatch) return res.json(sameFamilyMatch)
    } else if (ln && date_of_birth) {
      const [prevMatch] = await sql`
        SELECT * FROM children
        WHERE practice_id = ${practiceId}::uuid
          AND family_id IS NULL
          AND first_name ILIKE ${fn}
          AND last_name ILIKE ${ln}
          AND date_of_birth = ${date_of_birth}::date
        LIMIT 1`
      if (prevMatch) return res.json(prevMatch)
    }

    const label = [fn, ln].filter(Boolean).join(' ')
    const [row] = await sql`
      INSERT INTO children (
        practice_id, display_label, first_name, last_name, date_of_birth, gender,
        family_id,
        parent_name, parent_phone, parent_email,
        parent_address, parent_city, parent_state, parent_zip,
        pcp, preferred_pharmacy,
        insurance_provider, insurance_member_id, insurance_group_number,
        insurance_subscriber_name, insurance_subscriber_dob, insurance_subscriber_gender,
        insurance_subscriber_relationship,
        insurance_card_front_url, insurance_card_back_url,
        nickname,
        allergies, current_medications, medical_history, vaccination_status
      )
      VALUES (
        ${practiceId}::uuid,
        ${label},
        ${fn},
        ${ln || null},
        ${date_of_birth || null},
        ${gender || null},
        ${family_id || null},
        ${parent_name || null},
        ${parent_phone || null},
        ${parent_email || null},
        ${parent_address || null},
        ${parent_city || null},
        ${parent_state || null},
        ${parent_zip || null},
        ${pcp || null},
        ${preferred_pharmacy || null},
        ${insurance_provider || null},
        ${insurance_member_id || null},
        ${insurance_group_number || null},
        ${insurance_subscriber_name || null},
        ${insurance_subscriber_dob || null},
        ${insurance_subscriber_gender || null},
        ${insurance_subscriber_relationship || null},
        ${insurance_card_front_url || null},
        ${insurance_card_back_url || null},
        ${nickname || null},
        ${allergies || null},
        ${current_medications || null},
        ${medical_history || null},
        ${vaccination_status || null}
      )
      RETURNING *`
    return res.json(row)
  }

  res.status(405).json({ error: 'Method not allowed' })
}
