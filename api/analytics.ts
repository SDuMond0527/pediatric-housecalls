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
  try {
    await verifyToken(req.headers.authorization)
  } catch {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  const sql = neon(process.env.DATABASE_URL!)

  const [appointments, bookingRequests, waitlistEntries, familyProfiles, providers, broadcasts] = await Promise.all([
    sql`SELECT id, status, visit_type, scheduled_date, provider_id, notes, zone FROM appointments`,
    sql`SELECT id, status, visit_type, state, created_at, family_id FROM booking_requests`,
    sql`SELECT id, status, state, family_id, converted_provider_id FROM waitlist_entries`,
    sql`SELECT id FROM family_profiles`,
    sql`SELECT id, name, role FROM providers`,
    sql`SELECT id, status, created_at, is_urgent FROM broadcasts`,
  ])

  res.json({ appointments, bookingRequests, waitlistEntries, familyProfiles, providers, broadcasts })
}
