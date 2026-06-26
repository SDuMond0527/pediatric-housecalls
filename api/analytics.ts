import type { VercelRequest, VercelResponse } from '@vercel/node'
import { neon } from '@neondatabase/serverless'
import { createRemoteJWKSet, jwtVerify } from 'jose'

async function verifyToken(authHeader: string | undefined): Promise<string> {
  if (!authHeader?.startsWith('Bearer ')) throw new Error('Missing token')
  const token = authHeader.slice(7)
  const region = process.env.VITE_AWS_REGION || 'us-east-2'
  const userPoolId = process.env.VITE_AWS_USER_POOL_ID || ''
  const JWKS = createRemoteJWKSet(new URL(`https://cognito-idp.${region}.amazonaws.com/${userPoolId}/.well-known/jwks.json`))
  const { payload } = await jwtVerify(token, JWKS, { issuer: `https://cognito-idp.${region}.amazonaws.com/${userPoolId}` })
  if (!payload.sub) throw new Error('No sub in token')
  return payload.sub
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  let sub: string
  try {
    sub = await verifyToken(req.headers.authorization)
  } catch {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  const sql = neon(process.env.DATABASE_URL!)

  const providerRows = await sql`SELECT practice_id FROM providers WHERE cognito_sub = ${sub} LIMIT 1`
  if (!providerRows.length) return res.status(403).json({ error: 'Provider not found' })
  const practiceId = providerRows[0].practice_id as string

  const [appointments, bookingRequests, waitlistEntries, familyProfiles, providers, broadcasts] = await Promise.all([
    sql`SELECT id, status, visit_type, scheduled_date, provider_id, notes, zone FROM appointments WHERE practice_id = ${practiceId}::uuid`,
    sql`SELECT id, status, visit_type, state, created_at, family_id FROM booking_requests WHERE practice_id = ${practiceId}::uuid`,
    sql`SELECT id, status, state, family_id, converted_provider_id FROM waitlist_entries WHERE practice_id = ${practiceId}::uuid`,
    sql`SELECT id FROM family_profiles WHERE practice_id = ${practiceId}::uuid`,
    sql`SELECT id, name, role FROM providers WHERE practice_id = ${practiceId}::uuid`,
    sql`SELECT id, status, created_at, is_urgent FROM broadcasts WHERE practice_id = ${practiceId}::uuid`,
  ])

  res.json({ appointments, bookingRequests, waitlistEntries, familyProfiles, providers, broadcasts })
}
