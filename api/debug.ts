import type { VercelRequest, VercelResponse } from '@vercel/node'
import { neon } from '@neondatabase/serverless'
import { createRemoteJWKSet } from 'jose'

export default async function handler(_req: VercelRequest, res: VercelResponse) {
  void createRemoteJWKSet
  const checks: Record<string, unknown> = {
    DATABASE_URL: process.env.DATABASE_URL ? 'set ✓' : 'MISSING ✗',
    VITE_AWS_REGION: process.env.VITE_AWS_REGION || 'MISSING ✗',
    VITE_AWS_USER_POOL_ID: process.env.VITE_AWS_USER_POOL_ID || 'MISSING ✗',
    VITE_AWS_CLIENT_ID: process.env.VITE_AWS_CLIENT_ID ? 'set ✓' : 'MISSING ✗',
  }

  if (!process.env.DATABASE_URL) {
    return res.json(checks)
  }

  try {
    const sql = neon(process.env.DATABASE_URL)
    const rows = await sql`SELECT id, cognito_sub, name, role FROM providers LIMIT 5`
    checks.db = 'connected ✓'
    checks.providers = rows
  } catch (e: unknown) {
    checks.db = 'ERROR: ' + (e instanceof Error ? e.message : String(e))
  }

  res.json(checks)
}
