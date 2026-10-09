import type { VercelRequest, VercelResponse } from '@vercel/node'
import { neon } from '@neondatabase/serverless'
import { createRemoteJWKSet, jwtVerify } from 'jose'

async function verifyFamilyToken(authHeader: string | undefined): Promise<string> {
  if (!authHeader?.startsWith('Bearer ')) throw new Error('Missing token')
  const token = authHeader.slice(7)
  const region = process.env.VITE_AWS_REGION || 'us-east-2'
  const poolId = process.env.VITE_FAMILY_USER_POOL_ID || ''
  const JWKS = createRemoteJWKSet(new URL(`https://cognito-idp.${region}.amazonaws.com/${poolId}/.well-known/jwks.json`))
  const { payload } = await jwtVerify(token, JWKS, { issuer: `https://cognito-idp.${region}.amazonaws.com/${poolId}` })
  if (!payload.sub) throw new Error('No sub')
  return payload.sub as string
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  let sub: string
  try { sub = await verifyFamilyToken(req.headers.authorization) }
  catch { return res.status(401).json({ error: 'Unauthorized' }) }

  const sql = neon(process.env.DATABASE_URL!)

  const [fam] = await sql`
    SELECT id, practice_id FROM family_profiles WHERE cognito_sub = ${sub} LIMIT 1
  `
  if (!fam) return res.json([])

  const children = await sql`
    SELECT id, first_name, last_name FROM children WHERE family_id = ${fam.id}::uuid
  `
  if (!children.length) return res.json([])
  const childIds = children.map((c: any) => c.id as string)
  const childMap: Record<string, string> = {}
  children.forEach((c: any) => { childMap[c.id] = `${c.first_name} ${c.last_name}`.trim() })

  // Bootstrap on every read path (feedback_bootstrap_columns rule).
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS school_notes (
        id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        practice_id            uuid NOT NULL REFERENCES practices(id),
        child_id               uuid NOT NULL REFERENCES children(id) ON DELETE CASCADE,
        appointment_id         uuid REFERENCES appointments(id),
        requested_by_family_id uuid REFERENCES family_profiles(id),
        requested_by_name      text,
        excuse_dates_text      text NOT NULL,
        parent_additional_notes text,
        rendering_provider_id  uuid REFERENCES providers(id),
        rendering_provider_name text,
        rendering_provider_npi text,
        blob_url               text NOT NULL,
        filename               text NOT NULL,
        sent_to_email          text,
        sent_at                timestamptz,
        status                 text NOT NULL DEFAULT 'generated',
        created_at             timestamptz NOT NULL DEFAULT NOW()
      )`
    await sql`ALTER TABLE school_notes ADD COLUMN IF NOT EXISTS requested_by_provider_id uuid REFERENCES providers(id)`
    await sql`ALTER TABLE school_notes ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'family'`
  } catch (e: any) { console.error('school_notes bootstrap failed:', e?.message) }

  const rows = await sql`
    SELECT
      sn.id,
      sn.child_id,
      sn.excuse_dates_text,
      sn.rendering_provider_name,
      sn.blob_url,
      sn.filename,
      sn.sent_at,
      sn.status,
      sn.created_at,
      a.scheduled_date AS visit_date,
      a.visit_type
    FROM school_notes sn
    LEFT JOIN appointments a ON a.id = sn.appointment_id
    WHERE sn.practice_id = ${fam.practice_id}::uuid
      AND sn.child_id = ANY(${childIds}::uuid[])
    ORDER BY sn.created_at DESC
    LIMIT 200
  `

  const result = rows.map((r: any) => ({
    id: r.id,
    child_id: r.child_id,
    child_name: childMap[r.child_id] ?? 'Unknown',
    excuse_dates_text: r.excuse_dates_text,
    provider_name: r.rendering_provider_name,
    blob_url: r.blob_url,
    filename: r.filename,
    sent_at: r.sent_at,
    status: r.status,
    created_at: r.created_at,
    visit_date: r.visit_date,
    visit_type: r.visit_type,
  }))

  return res.json(result)
}
