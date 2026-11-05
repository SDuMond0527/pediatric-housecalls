// Super-admin-only endpoints for editing a practice's settings blob.
//
// GET  /api/admin/practice-settings?practice_id=<uuid>  → current settings + audit history
// PATCH /api/admin/practice-settings                    → body { practice_id, patch } applies & audits
//
// PATCH writes ONE audit row per field that actually changed. A no-op
// save (patch matches current) writes nothing.
//
// Sara 2026-11-04.

import type { VercelRequest, VercelResponse } from '@vercel/node'
import { neon } from '@neondatabase/serverless'
import { createRemoteJWKSet, jwtVerify } from 'jose'
import {
  practiceSettingsSchema,
  parsePracticeSettings,
  type PracticeSettings,
} from '../../src/lib/practiceSettings'
import { invalidatePracticeSettings } from '../../src/lib/practiceSettingsServer'

async function verifyToken(authHeader: string | undefined): Promise<string> {
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
  try { sub = await verifyToken(req.headers.authorization) }
  catch { return res.status(401).json({ error: 'Unauthorized' }) }

  const sql = neon(process.env.DATABASE_URL!)
  const [caller] = await sql`
    SELECT id, name, is_super_admin FROM providers WHERE cognito_sub = ${sub} LIMIT 1`
  if (!caller) return res.status(403).json({ error: 'Provider not found' })
  if (!caller.is_super_admin) return res.status(403).json({ error: 'Super admin access required' })

  if (req.method === 'GET') {
    const practiceId = String(req.query.practice_id ?? '')
    if (!practiceId) return res.status(400).json({ error: 'practice_id required' })

    const [practice] = await sql`
      SELECT id, name, settings FROM practices WHERE id = ${practiceId}::uuid LIMIT 1`
    if (!practice) return res.status(404).json({ error: 'Practice not found' })

    const settings = parsePracticeSettings(practice.settings)
    const audit = await sql`
      SELECT field_path, old_value, new_value, changed_by_name, changed_at
      FROM practice_settings_audit
      WHERE practice_id = ${practiceId}::uuid
      ORDER BY changed_at DESC
      LIMIT 200`

    return res.json({
      practice_id: practice.id,
      practice_name: practice.name,
      settings,
      audit,
    })
  }

  if (req.method === 'PATCH') {
    const { practice_id, patch } = (req.body ?? {}) as { practice_id?: string; patch?: unknown }
    if (!practice_id || typeof practice_id !== 'string') return res.status(400).json({ error: 'practice_id required' })
    if (!patch || typeof patch !== 'object') return res.status(400).json({ error: 'patch required' })

    const [practice] = await sql`
      SELECT id, settings FROM practices WHERE id = ${practice_id}::uuid LIMIT 1`
    if (!practice) return res.status(404).json({ error: 'Practice not found' })

    // Parse current + patch via Zod. Partial() lets the patch omit
    // fields; those fields are left alone on the merged result.
    const current = parsePracticeSettings(practice.settings)
    const partialSchema = practiceSettingsSchema.partial()
    const parsedPatch = partialSchema.safeParse(patch)
    if (!parsedPatch.success) {
      return res.status(400).json({ error: 'Invalid patch', issues: parsedPatch.error.issues })
    }

    // Compute the merged blob + the diff for audit logging.
    const merged: PracticeSettings = { ...current, ...parsedPatch.data } as PracticeSettings
    const changes: Array<{ field: string; oldValue: unknown; newValue: unknown }> = []
    for (const [field, newValue] of Object.entries(parsedPatch.data)) {
      const oldValue = (current as Record<string, unknown>)[field]
      // Deep-equal check for objects (business_hours), strict for scalars.
      if (JSON.stringify(oldValue) !== JSON.stringify(newValue)) {
        changes.push({ field, oldValue, newValue })
      }
    }

    if (changes.length === 0) {
      return res.json({ ok: true, changed: 0, settings: current })
    }

    // Write the merged blob + one audit row per changed field, in one
    // transaction. Neon HTTP driver autocommits per sql call, so without
    // transaction() a mid-batch failure could leave settings updated
    // without audit rows. sql.transaction() wraps them as a single unit.
    await sql.transaction([
      sql`
        UPDATE practices SET settings = ${JSON.stringify(merged)}::jsonb
        WHERE id = ${practice_id}::uuid`,
      ...changes.map(change => sql`
        INSERT INTO practice_settings_audit
          (practice_id, changed_by_provider_id, changed_by_name, field_path, old_value, new_value)
        VALUES
          (${practice_id}::uuid, ${caller.id}::uuid, ${caller.name},
           ${change.field},
           ${JSON.stringify(change.oldValue ?? null)}::jsonb,
           ${JSON.stringify(change.newValue ?? null)}::jsonb)`),
    ])

    invalidatePracticeSettings(practice_id)
    return res.json({ ok: true, changed: changes.length, settings: merged })
  }

  return res.status(405).json({ error: 'Method not allowed' })
}
