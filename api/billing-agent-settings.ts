import type { VercelRequest, VercelResponse } from '@vercel/node'
import { neon } from '@neondatabase/serverless'
import { createRemoteJWKSet, jwtVerify } from 'jose'

// Per-work-category auto-mode toggle. Sara 2026-11-09:
//   "Each type of work (claim submission, rejections, denials) has its
//    own on/off setting for automatic handling. All of them start OFF,
//    and only I can turn them on."
// The toggle is read by the agent-logic jobs (future commit): when true,
// the job commits directly; when false, it queues for review.

const WORK_CATEGORIES = ['claim_submission', 'rejections', 'denials'] as const

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
  // Co-located bootstrap — same rule as /api/review-queue.
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS billing_agent_settings (
        practice_id     uuid NOT NULL,
        work_category   text NOT NULL,
        auto_enabled    boolean NOT NULL DEFAULT false,
        updated_at      timestamptz NOT NULL DEFAULT NOW(),
        updated_by      uuid,
        updated_by_name text,
        PRIMARY KEY (practice_id, work_category)
      )`
  } catch {}

  const [provider] = await sql`SELECT id, name, practice_id, is_admin FROM providers WHERE cognito_sub = ${sub} LIMIT 1`
  if (!provider) return res.status(403).json({ error: 'Provider not found' })
  if (!provider.is_admin) return res.status(403).json({ error: 'Admin only' })
  const practiceId = provider.practice_id as string

  if (req.method === 'GET') {
    const rows = await sql`
      SELECT work_category, auto_enabled, updated_at, updated_by_name
      FROM billing_agent_settings
      WHERE practice_id = ${practiceId}::uuid`
    // Return every category, defaulting to off if the row doesn't exist yet
    // (fresh practice, never configured).
    const settings = WORK_CATEGORIES.map(cat => {
      const row = rows.find((r: any) => r.work_category === cat)
      return {
        work_category: cat,
        auto_enabled: !!row?.auto_enabled,
        updated_at: row?.updated_at ?? null,
        updated_by_name: row?.updated_by_name ?? null,
      }
    })
    return res.status(200).json({ settings })
  }

  if (req.method === 'PATCH') {
    const body = req.body as { work_category?: string; auto_enabled?: boolean }
    const cat = String(body?.work_category ?? '')
    if (!WORK_CATEGORIES.includes(cat as any)) {
      return res.status(400).json({ error: `work_category must be one of ${WORK_CATEGORIES.join(', ')}` })
    }
    const enabled = !!body?.auto_enabled
    await sql`
      INSERT INTO billing_agent_settings (practice_id, work_category, auto_enabled, updated_by, updated_by_name)
      VALUES (${practiceId}::uuid, ${cat}, ${enabled}, ${provider.id}::uuid, ${provider.name ?? 'Admin'})
      ON CONFLICT (practice_id, work_category) DO UPDATE SET
        auto_enabled = EXCLUDED.auto_enabled,
        updated_at   = NOW(),
        updated_by   = EXCLUDED.updated_by,
        updated_by_name = EXCLUDED.updated_by_name`
    return res.status(200).json({ ok: true })
  }

  return res.status(405).json({ error: 'Method not allowed' })
}
