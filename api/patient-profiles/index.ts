// Adult patient profiles — list + create.
//
// Phase 4A. Provider-authed only. Practice-scoped via the caller's
// providers.practice_id (NOT env var). Zero cross-imports: Cognito
// verify is inlined per the Vercel bundling lesson (api/_lib and
// src/lib files do not get bundled into sibling serverless
// functions). Sara 2026-11-06.
//
//   GET  /api/patient-profiles?search=<string>&include_archived=1
//   POST /api/patient-profiles  body = { first_name, last_name, date_of_birth, ... }

import type { VercelRequest, VercelResponse } from '@vercel/node'
import { neon } from '@neondatabase/serverless'
import { createRemoteJWKSet, jwtVerify } from 'jose'

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
  const [provider] = await sql`
    SELECT id, practice_id, is_admin, is_super_admin
    FROM providers WHERE cognito_sub = ${sub} LIMIT 1`
  if (!provider) return res.status(403).json({ error: 'Provider not found' })
  const practiceId = provider.practice_id as string

  // ── GET: list / search ─────────────────────────────────────────────────
  if (req.method === 'GET') {
    const search = String(req.query.search ?? '').trim()
    const includeArchived = String(req.query.include_archived ?? '') === '1'

    const rows = await sql`
      SELECT *
      FROM patient_profiles
      WHERE practice_id = ${practiceId}::uuid
        AND (${includeArchived}::boolean OR archived = false)
        AND (
          ${search} = ''
          OR LOWER(first_name)   LIKE '%' || LOWER(${search}) || '%'
          OR LOWER(last_name)    LIKE '%' || LOWER(${search}) || '%'
          OR LOWER(chart_number) LIKE '%' || LOWER(${search}) || '%'
          OR LOWER(email)        LIKE '%' || LOWER(${search}) || '%'
        )
      ORDER BY last_name, first_name
      LIMIT 500`
    return res.json(rows)
  }

  // ── POST: create a new adult patient ───────────────────────────────────
  if (req.method === 'POST') {
    const body = (req.body ?? {}) as Record<string, unknown>

    // Required
    const first_name = String(body.first_name ?? '').trim()
    const last_name  = String(body.last_name  ?? '').trim()
    const dob        = String(body.date_of_birth ?? '').trim()
    if (!first_name)        return res.status(400).json({ error: 'first_name required' })
    if (!last_name)         return res.status(400).json({ error: 'last_name required' })
    if (!dob)               return res.status(400).json({ error: 'date_of_birth required' })
    // Date format sanity — YYYY-MM-DD
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dob)) {
      return res.status(400).json({ error: 'date_of_birth must be YYYY-MM-DD' })
    }

    // Normalize gender to M/F (null allowed)
    const genderRaw = String(body.gender ?? '').trim().toUpperCase()
    const gender = genderRaw === 'M' || genderRaw === 'MALE'   ? 'M'
                 : genderRaw === 'F' || genderRaw === 'FEMALE' ? 'F'
                 : null

    // Insurance defaults
    const selfPay = body.self_pay === undefined ? true : !!body.self_pay

    // Build value strings for optional fields; sanitize empty strings
    // to null for numeric inputs per feedback_api_numeric_sanitization.md
    const dsPharmId = body.dosespot_pharmacy_id === '' || body.dosespot_pharmacy_id == null
      ? null : Number(body.dosespot_pharmacy_id)
    const subscriberDob = body.insurance_subscriber_dob
      ? String(body.insurance_subscriber_dob) : null
    if (subscriberDob && !/^\d{4}-\d{2}-\d{2}$/.test(subscriberDob)) {
      return res.status(400).json({ error: 'insurance_subscriber_dob must be YYYY-MM-DD' })
    }

    // Enforce chart_number uniqueness per practice if provided
    const chartNumber = body.chart_number ? String(body.chart_number).trim() : null
    if (chartNumber) {
      const [dup] = await sql`
        SELECT id FROM patient_profiles
        WHERE practice_id = ${practiceId}::uuid AND chart_number = ${chartNumber}
        LIMIT 1`
      if (dup) return res.status(409).json({ error: `chart_number "${chartNumber}" is already in use for this practice` })
    }

    try {
      const [row] = await sql`
        INSERT INTO patient_profiles (
          practice_id,
          first_name, last_name, date_of_birth, gender,
          email, phone,
          address_line1, address_line2, city, state, zip,
          allergies, medications, medical_history, primary_care_provider,
          preferred_pharmacy, dosespot_pharmacy_id, dosespot_pharmacy_source_text,
          self_pay,
          insurance_provider, insurance_member_id, insurance_group_number,
          insurance_dependent_code,
          insurance_subscriber_name, insurance_subscriber_dob,
          insurance_subscriber_gender, insurance_subscriber_relationship,
          insurance_card_front_url, insurance_card_back_url,
          chart_number
        ) VALUES (
          ${practiceId}::uuid,
          ${first_name}, ${last_name}, ${dob}::date, ${gender},
          ${(body.email as string) ?? null}, ${(body.phone as string) ?? null},
          ${(body.address_line1 as string) ?? null}, ${(body.address_line2 as string) ?? null},
          ${(body.city as string) ?? null}, ${(body.state as string) ?? null}, ${(body.zip as string) ?? null},
          ${(body.allergies as string) ?? ''}, ${(body.medications as string) ?? ''},
          ${(body.medical_history as string) ?? ''}, ${(body.primary_care_provider as string) ?? null},
          ${(body.preferred_pharmacy as string) ?? null}, ${dsPharmId}, ${(body.dosespot_pharmacy_source_text as string) ?? null},
          ${selfPay},
          ${(body.insurance_provider as string) ?? null}, ${(body.insurance_member_id as string) ?? null},
          ${(body.insurance_group_number as string) ?? null},
          ${(body.insurance_dependent_code as string) ?? null},
          ${(body.insurance_subscriber_name as string) ?? null},
          ${subscriberDob ? subscriberDob : null}::date,
          ${(body.insurance_subscriber_gender as string) ?? null},
          ${(body.insurance_subscriber_relationship as string) ?? null},
          ${(body.insurance_card_front_url as string) ?? null},
          ${(body.insurance_card_back_url as string) ?? null},
          ${chartNumber}
        )
        RETURNING *`
      return res.status(201).json(row)
    } catch (e: any) {
      return res.status(500).json({ error: e?.message ?? 'Failed to create patient' })
    }
  }

  return res.status(405).json({ error: 'Method not allowed' })
}
