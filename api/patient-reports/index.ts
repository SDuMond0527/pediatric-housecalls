import type { VercelRequest, VercelResponse } from '@vercel/node'
import { neon } from '@neondatabase/serverless'
import { del as deleteBlob } from '@vercel/blob'
import { createRemoteJWKSet, jwtVerify } from 'jose'

type Role = 'provider' | 'family'
interface Caller {
  role: Role
  sub: string
  // Provider: provider_id + practice_id. Family: family_id + practice_id.
  provider_id?: string
  family_id?: string
  practice_id: string
  provider_name?: string
  family_name?: string
  is_admin?: boolean
}

async function verifyProvider(token: string): Promise<string | null> {
  const region = process.env.VITE_AWS_REGION || 'us-east-2'
  const poolId = process.env.VITE_AWS_USER_POOL_ID || ''
  if (!poolId) return null
  try {
    const JWKS = createRemoteJWKSet(new URL(`https://cognito-idp.${region}.amazonaws.com/${poolId}/.well-known/jwks.json`))
    const { payload } = await jwtVerify(token, JWKS, { issuer: `https://cognito-idp.${region}.amazonaws.com/${poolId}` })
    return (payload.sub as string) || null
  } catch { return null }
}

async function verifyFamily(token: string): Promise<string | null> {
  const region = process.env.VITE_AWS_REGION || 'us-east-2'
  const poolId = process.env.VITE_FAMILY_USER_POOL_ID || ''
  if (!poolId) return null
  try {
    const JWKS = createRemoteJWKSet(new URL(`https://cognito-idp.${region}.amazonaws.com/${poolId}/.well-known/jwks.json`))
    const { payload } = await jwtVerify(token, JWKS, { issuer: `https://cognito-idp.${region}.amazonaws.com/${poolId}` })
    return (payload.sub as string) || null
  } catch { return null }
}

async function resolveCaller(authHeader: string | undefined, sql: any): Promise<Caller | null> {
  if (!authHeader?.startsWith('Bearer ')) return null
  const token = authHeader.slice(7)

  const providerSub = await verifyProvider(token)
  if (providerSub) {
    const [prov] = await sql`
      SELECT id, practice_id, name, is_admin
      FROM providers WHERE cognito_sub = ${providerSub} LIMIT 1
    `
    if (!prov) return null
    return {
      role: 'provider',
      sub: providerSub,
      provider_id: prov.id,
      practice_id: prov.practice_id,
      provider_name: prov.name,
      is_admin: !!prov.is_admin,
    }
  }

  const familySub = await verifyFamily(token)
  if (familySub) {
    const [fam] = await sql`
      SELECT id, practice_id, parent_name, email
      FROM family_profiles WHERE cognito_sub = ${familySub} LIMIT 1
    `
    if (!fam) return null
    return {
      role: 'family',
      sub: familySub,
      family_id: fam.id,
      practice_id: fam.practice_id,
      family_name: fam.parent_name || fam.email || 'Family',
    }
  }

  return null
}

async function assertCanAccessChild(sql: any, caller: Caller, childId: string): Promise<boolean> {
  if (caller.role === 'provider') {
    const [c] = await sql`
      SELECT 1 AS ok FROM children
      WHERE id = ${childId}::uuid AND practice_id = ${caller.practice_id}::uuid
      LIMIT 1
    `
    return !!c
  }
  const [c] = await sql`
    SELECT 1 AS ok FROM children
    WHERE id = ${childId}::uuid AND family_id = ${caller.family_id}::uuid
    LIMIT 1
  `
  return !!c
}

async function bootstrap(sql: any) {
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS patient_reports (
        id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        child_id          uuid NOT NULL REFERENCES children(id) ON DELETE CASCADE,
        practice_id       uuid NOT NULL REFERENCES practices(id),
        kind              text NOT NULL CHECK (kind IN ('lab','radiology')),
        title             text NOT NULL,
        blob_url          text NOT NULL,
        filename          text NOT NULL,
        mime_type         text,
        size_bytes        bigint,
        uploaded_by_type  text NOT NULL CHECK (uploaded_by_type IN ('provider','family')),
        uploaded_by_id    uuid,
        uploaded_by_name  text NOT NULL,
        uploaded_at       timestamptz NOT NULL DEFAULT NOW()
      )`
    await sql`CREATE INDEX IF NOT EXISTS patient_reports_child_kind_idx ON patient_reports(child_id, kind, uploaded_at DESC)`
  } catch (e: any) {
    console.error('patient_reports bootstrap failed:', e?.message)
  }
}

/**
 * /api/patient-reports — unified read/write/delete for lab + radiology
 * report uploads attached to a child.
 *
 * Dual-auth: accepts either a provider or family Cognito access token.
 * Family callers can only see / write rows for children in their own
 * family. Provider callers can only see / write rows for children in
 * their practice. Deletes are provider-only (family users 403).
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const sql = neon(process.env.DATABASE_URL!)
  await bootstrap(sql)

  const caller = await resolveCaller(req.headers.authorization, sql)
  if (!caller) return res.status(401).json({ error: 'Unauthorized' })

  if (req.method === 'GET') {
    const childId = String(req.query.child_id ?? '')
    const kindRaw = String(req.query.kind ?? '')
    const kind = kindRaw === 'lab' || kindRaw === 'radiology' ? kindRaw : null
    if (!childId) return res.status(400).json({ error: 'child_id required' })
    if (!kind)    return res.status(400).json({ error: 'kind must be "lab" or "radiology"' })

    const ok = await assertCanAccessChild(sql, caller, childId)
    if (!ok) return res.status(403).json({ error: 'Child not accessible' })

    const rows = await sql`
      SELECT id, child_id, kind, title, blob_url, filename, mime_type, size_bytes,
             uploaded_by_type, uploaded_by_name, uploaded_at
      FROM patient_reports
      WHERE child_id = ${childId}::uuid AND kind = ${kind} AND practice_id = ${caller.practice_id}::uuid
      ORDER BY uploaded_at DESC
    `
    return res.status(200).json(rows)
  }

  if (req.method === 'POST') {
    const { child_id, kind, title, blob_url, filename, mime_type, size_bytes } = req.body ?? {}
    if (!child_id) return res.status(400).json({ error: 'child_id required' })
    if (kind !== 'lab' && kind !== 'radiology') return res.status(400).json({ error: 'kind must be "lab" or "radiology"' })
    if (!title?.trim()) return res.status(400).json({ error: 'title required' })
    if (!blob_url)      return res.status(400).json({ error: 'blob_url required (upload first)' })
    if (!filename)      return res.status(400).json({ error: 'filename required' })

    const ok = await assertCanAccessChild(sql, caller, child_id)
    if (!ok) return res.status(403).json({ error: 'Child not accessible' })

    const uploaderName = caller.role === 'provider' ? (caller.provider_name ?? 'Provider') : (caller.family_name ?? 'Family')
    const uploaderId   = caller.role === 'provider' ? caller.provider_id : caller.family_id

    const [row] = await sql`
      INSERT INTO patient_reports (
        child_id, practice_id, kind, title, blob_url, filename,
        mime_type, size_bytes, uploaded_by_type, uploaded_by_id, uploaded_by_name
      )
      VALUES (
        ${child_id}::uuid, ${caller.practice_id}::uuid, ${kind}, ${title.trim()}, ${blob_url}, ${filename},
        ${mime_type ?? null}, ${size_bytes ?? null},
        ${caller.role}, ${uploaderId ?? null}::uuid, ${uploaderName}
      )
      RETURNING id, child_id, kind, title, blob_url, filename, mime_type, size_bytes,
                uploaded_by_type, uploaded_by_name, uploaded_at
    `
    return res.status(201).json(row)
  }

  if (req.method === 'DELETE') {
    // Delete is provider-only per Sara 2026-10-02 — families cannot
    // remove reports from the chart even if they uploaded them.
    if (caller.role !== 'provider') return res.status(403).json({ error: 'Delete not allowed for family users' })

    const id = String(req.query.id ?? '')
    if (!id) return res.status(400).json({ error: 'id required' })

    const rows = await sql`
      DELETE FROM patient_reports
      WHERE id = ${id}::uuid AND practice_id = ${caller.practice_id}::uuid
      RETURNING blob_url
    `
    if (!rows.length) return res.status(404).json({ error: 'Report not found' })

    try { await deleteBlob(rows[0].blob_url as string) }
    catch (e: any) { console.error('patient_reports blob delete failed (row already gone):', e?.message) }

    return res.status(200).json({ ok: true })
  }

  return res.status(405).json({ error: 'Method not allowed' })
}
