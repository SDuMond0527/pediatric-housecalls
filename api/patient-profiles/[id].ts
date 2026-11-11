// Adult patient profile detail — GET + PATCH.
//
// Phase 4A. Provider-authed only. Practice-scoped: a provider can
// only see / edit patients in their own practice (practice_id match
// enforced on every query). All helpers inlined per Vercel's bundling
// behavior — api/_lib / src/lib imports are not packaged into sibling
// serverless functions. Sara 2026-11-06.
//
//   GET   /api/patient-profiles/[id]
//   PATCH /api/patient-profiles/[id]  body = partial update
//
// No DELETE — archive via PATCH { archived: true, archived_reason: '...' }.

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

const WRITABLE_FIELDS = new Set([
  'first_name', 'last_name', 'date_of_birth', 'gender',
  'email', 'phone',
  'address_line1', 'address_line2', 'city', 'state', 'zip',
  'allergies', 'medications', 'medical_history', 'primary_care_provider',
  'preferred_pharmacy', 'dosespot_pharmacy_id', 'dosespot_pharmacy_source_text',
  'self_pay',
  'insurance_provider', 'insurance_member_id', 'insurance_group_number',
  'insurance_dependent_code',
  'insurance_subscriber_name', 'insurance_subscriber_dob',
  'insurance_subscriber_gender', 'insurance_subscriber_relationship',
  'insurance_card_front_url', 'insurance_card_back_url',
  'chart_number', 'archived', 'archived_reason',
  // Provider-only sticky notes. Server derives the updated_at + actor
  // name on write; client-supplied values for those fields are ignored
  // for integrity. Sara 2026-11-11.
  'provider_sticky_notes',
])

export default async function handler(req: VercelRequest, res: VercelResponse) {
  let sub: string
  try { sub = await verifyProviderToken(req.headers.authorization) }
  catch { return res.status(401).json({ error: 'Unauthorized' }) }

  const sql = neon(process.env.DATABASE_URL!)
  // Provider-only sticky notes — mirrors the field on `children`.
  // Sara 2026-11-11.
  try { await sql`ALTER TABLE patient_profiles ADD COLUMN IF NOT EXISTS provider_sticky_notes text` } catch {}
  try { await sql`ALTER TABLE patient_profiles ADD COLUMN IF NOT EXISTS provider_sticky_notes_updated_at timestamptz` } catch {}
  try { await sql`ALTER TABLE patient_profiles ADD COLUMN IF NOT EXISTS provider_sticky_notes_updated_by_name text` } catch {}

  const [provider] = await sql`
    SELECT id, name, practice_id
    FROM providers WHERE cognito_sub = ${sub} LIMIT 1`
  if (!provider) return res.status(403).json({ error: 'Provider not found' })
  const practiceId = provider.practice_id as string

  const id = String(req.query.id ?? '')
  if (!id) return res.status(400).json({ error: 'id required' })

  // ── GET: fetch one ─────────────────────────────────────────────────────
  if (req.method === 'GET') {
    const [row] = await sql`
      SELECT * FROM patient_profiles
      WHERE id = ${id}::uuid AND practice_id = ${practiceId}::uuid
      LIMIT 1`
    if (!row) return res.status(404).json({ error: 'Patient not found' })
    return res.json(row)
  }

  // ── PATCH: update one ──────────────────────────────────────────────────
  if (req.method === 'PATCH') {
    const body = (req.body ?? {}) as Record<string, unknown>

    // Confirm the patient exists in this practice BEFORE building the
    // update — avoids scoping bugs where an id from another practice
    // sneaks through.
    const [existing] = await sql`
      SELECT id, chart_number, archived
      FROM patient_profiles
      WHERE id = ${id}::uuid AND practice_id = ${practiceId}::uuid
      LIMIT 1`
    if (!existing) return res.status(404).json({ error: 'Patient not found' })

    // Whitelist incoming keys — anything not in WRITABLE_FIELDS silently
    // dropped. Matches feedback_verify_field_in_server_allowlist.md.
    const patch: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(body)) {
      if (WRITABLE_FIELDS.has(k)) patch[k] = v
    }
    if (Object.keys(patch).length === 0) {
      return res.json(existing)
    }

    // Normalize gender and subscriber_gender if provided
    if ('gender' in patch) {
      const g = String(patch.gender ?? '').trim().toUpperCase()
      patch.gender = g === 'M' || g === 'MALE' ? 'M' : g === 'F' || g === 'FEMALE' ? 'F' : null
    }
    if ('insurance_subscriber_gender' in patch) {
      const g = String(patch.insurance_subscriber_gender ?? '').trim().toUpperCase()
      patch.insurance_subscriber_gender = g === 'M' || g === 'MALE' ? 'M' : g === 'F' || g === 'FEMALE' ? 'F' : null
    }
    // Numeric sanitization
    if ('dosespot_pharmacy_id' in patch) {
      const v = patch.dosespot_pharmacy_id
      patch.dosespot_pharmacy_id = v === '' || v == null ? null : Number(v)
    }
    // Date format sanity
    for (const dateField of ['date_of_birth', 'insurance_subscriber_dob'] as const) {
      if (dateField in patch && patch[dateField]) {
        const v = String(patch[dateField])
        if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) {
          return res.status(400).json({ error: `${dateField} must be YYYY-MM-DD` })
        }
      }
    }

    // Enforce chart_number uniqueness per practice when changing it
    if ('chart_number' in patch && patch.chart_number != null && patch.chart_number !== existing.chart_number) {
      const nextCn = String(patch.chart_number).trim()
      if (nextCn) {
        const [dup] = await sql`
          SELECT id FROM patient_profiles
          WHERE practice_id = ${practiceId}::uuid
            AND chart_number = ${nextCn}
            AND id != ${id}::uuid
          LIMIT 1`
        if (dup) return res.status(409).json({ error: `chart_number "${nextCn}" is already in use for this practice` })
      }
    }

    // Archive timestamping — set archived_at when toggling true, clear
    // when toggling false. Lets the UI filter by archived_at IS NOT NULL
    // for a clean deleted-patient view.
    if ('archived' in patch) {
      if (patch.archived === true && !existing.archived) {
        patch.archived_at = new Date().toISOString() as any
      } else if (patch.archived === false && existing.archived) {
        patch.archived_at = null
        patch.archived_reason = null
      }
    }

    // Build the UPDATE. Because Neon's tagged-template interpolation
    // doesn't support dynamic column sets, we build each column
    // conditionally with COALESCE — the pattern used throughout this
    // codebase (see api/claims/[id].ts). Kept verbose on purpose.
    const [row] = await sql`
      UPDATE patient_profiles SET
        first_name                        = COALESCE(${('first_name'                        in patch ? patch.first_name                        : null) as any}, first_name),
        last_name                         = COALESCE(${('last_name'                         in patch ? patch.last_name                         : null) as any}, last_name),
        date_of_birth                     = COALESCE(${('date_of_birth'                     in patch ? patch.date_of_birth                     : null) as any}::date, date_of_birth),
        gender                            = CASE WHEN ${'gender' in patch}::boolean THEN ${(patch.gender ?? null) as any} ELSE gender END,
        email                             = CASE WHEN ${'email' in patch}::boolean THEN ${(patch.email ?? null) as any} ELSE email END,
        phone                             = CASE WHEN ${'phone' in patch}::boolean THEN ${(patch.phone ?? null) as any} ELSE phone END,
        address_line1                     = CASE WHEN ${'address_line1' in patch}::boolean THEN ${(patch.address_line1 ?? null) as any} ELSE address_line1 END,
        address_line2                     = CASE WHEN ${'address_line2' in patch}::boolean THEN ${(patch.address_line2 ?? null) as any} ELSE address_line2 END,
        city                              = CASE WHEN ${'city' in patch}::boolean THEN ${(patch.city ?? null) as any} ELSE city END,
        state                             = CASE WHEN ${'state' in patch}::boolean THEN ${(patch.state ?? null) as any} ELSE state END,
        zip                               = CASE WHEN ${'zip' in patch}::boolean THEN ${(patch.zip ?? null) as any} ELSE zip END,
        allergies                         = COALESCE(${('allergies'                         in patch ? patch.allergies                         : null) as any}, allergies),
        medications                       = COALESCE(${('medications'                       in patch ? patch.medications                       : null) as any}, medications),
        medical_history                   = COALESCE(${('medical_history'                   in patch ? patch.medical_history                   : null) as any}, medical_history),
        primary_care_provider             = CASE WHEN ${'primary_care_provider' in patch}::boolean THEN ${(patch.primary_care_provider ?? null) as any} ELSE primary_care_provider END,
        preferred_pharmacy                = CASE WHEN ${'preferred_pharmacy' in patch}::boolean THEN ${(patch.preferred_pharmacy ?? null) as any} ELSE preferred_pharmacy END,
        dosespot_pharmacy_id              = CASE WHEN ${'dosespot_pharmacy_id' in patch}::boolean THEN ${(patch.dosespot_pharmacy_id ?? null) as any}::integer ELSE dosespot_pharmacy_id END,
        dosespot_pharmacy_source_text     = CASE WHEN ${'dosespot_pharmacy_source_text' in patch}::boolean THEN ${(patch.dosespot_pharmacy_source_text ?? null) as any} ELSE dosespot_pharmacy_source_text END,
        self_pay                          = COALESCE(${('self_pay'                          in patch ? patch.self_pay                          : null) as any}::boolean, self_pay),
        insurance_provider                = CASE WHEN ${'insurance_provider' in patch}::boolean THEN ${(patch.insurance_provider ?? null) as any} ELSE insurance_provider END,
        insurance_member_id               = CASE WHEN ${'insurance_member_id' in patch}::boolean THEN ${(patch.insurance_member_id ?? null) as any} ELSE insurance_member_id END,
        insurance_group_number            = CASE WHEN ${'insurance_group_number' in patch}::boolean THEN ${(patch.insurance_group_number ?? null) as any} ELSE insurance_group_number END,
        insurance_dependent_code          = CASE WHEN ${'insurance_dependent_code' in patch}::boolean THEN ${(patch.insurance_dependent_code ?? null) as any} ELSE insurance_dependent_code END,
        insurance_subscriber_name         = CASE WHEN ${'insurance_subscriber_name' in patch}::boolean THEN ${(patch.insurance_subscriber_name ?? null) as any} ELSE insurance_subscriber_name END,
        insurance_subscriber_dob          = CASE WHEN ${'insurance_subscriber_dob' in patch}::boolean THEN ${(patch.insurance_subscriber_dob ?? null) as any}::date ELSE insurance_subscriber_dob END,
        insurance_subscriber_gender       = CASE WHEN ${'insurance_subscriber_gender' in patch}::boolean THEN ${(patch.insurance_subscriber_gender ?? null) as any} ELSE insurance_subscriber_gender END,
        insurance_subscriber_relationship = CASE WHEN ${'insurance_subscriber_relationship' in patch}::boolean THEN ${(patch.insurance_subscriber_relationship ?? null) as any} ELSE insurance_subscriber_relationship END,
        insurance_card_front_url          = CASE WHEN ${'insurance_card_front_url' in patch}::boolean THEN ${(patch.insurance_card_front_url ?? null) as any} ELSE insurance_card_front_url END,
        insurance_card_back_url           = CASE WHEN ${'insurance_card_back_url' in patch}::boolean THEN ${(patch.insurance_card_back_url ?? null) as any} ELSE insurance_card_back_url END,
        chart_number                      = CASE WHEN ${'chart_number' in patch}::boolean THEN ${(patch.chart_number ?? null) as any} ELSE chart_number END,
        archived                          = COALESCE(${('archived'                          in patch ? patch.archived                          : null) as any}::boolean, archived),
        archived_at                       = CASE WHEN ${'archived_at' in patch}::boolean THEN ${(patch.archived_at ?? null) as any}::timestamptz ELSE archived_at END,
        archived_reason                   = CASE WHEN ${'archived_reason' in patch}::boolean THEN ${(patch.archived_reason ?? null) as any} ELSE archived_reason END,
        provider_sticky_notes             = CASE WHEN ${'provider_sticky_notes' in patch}::boolean THEN ${(patch.provider_sticky_notes ?? null) as any} ELSE provider_sticky_notes END,
        provider_sticky_notes_updated_at  = CASE WHEN ${'provider_sticky_notes' in patch}::boolean THEN NOW() ELSE provider_sticky_notes_updated_at END,
        provider_sticky_notes_updated_by_name = CASE WHEN ${'provider_sticky_notes' in patch}::boolean THEN ${provider.name as any} ELSE provider_sticky_notes_updated_by_name END,
        updated_at                        = NOW()
      WHERE id = ${id}::uuid AND practice_id = ${practiceId}::uuid
      RETURNING *`

    // Sticky-note edits log to phi_audit_log — just the fact of the
    // edit, never the content. Sara 2026-11-11.
    if ('provider_sticky_notes' in patch) {
      try {
        await sql`
          INSERT INTO phi_audit_log (provider_id, action, resource_type, resource_id)
          VALUES (${provider.id}::uuid, 'edit_sticky_notes', 'patient_profile', ${id})`
      } catch (e: any) {
        console.error('sticky-note audit log insert failed (non-fatal):', e?.message)
      }
    }

    return res.json(row)
  }

  return res.status(405).json({ error: 'Method not allowed' })
}
