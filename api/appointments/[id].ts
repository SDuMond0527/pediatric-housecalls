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

  if (req.method !== 'PATCH') return res.status(405).json({ error: 'Method not allowed' })

  const sql = neon(process.env.DATABASE_URL!)

  const providerRows = await sql`SELECT practice_id FROM providers WHERE cognito_sub = ${sub} LIMIT 1`
  if (!providerRows.length) return res.status(403).json({ error: 'Provider not found' })
  const practiceId = providerRows[0].practice_id as string

  const { id } = req.query as { id: string }
  const { status, after_visit_instructions } = req.body

  let row: unknown
  if (status !== undefined && after_visit_instructions !== undefined) {
    ;[row] = await sql`UPDATE appointments SET status=${status}, after_visit_instructions=${after_visit_instructions} WHERE id=${id}::uuid AND practice_id=${practiceId}::uuid RETURNING *`
  } else if (status !== undefined) {
    ;[row] = await sql`UPDATE appointments SET status=${status} WHERE id=${id}::uuid AND practice_id=${practiceId}::uuid RETURNING *`
  } else if (after_visit_instructions !== undefined) {
    ;[row] = await sql`UPDATE appointments SET after_visit_instructions=${after_visit_instructions} WHERE id=${id}::uuid AND practice_id=${practiceId}::uuid RETURNING *`
  } else {
    return res.status(400).json({ error: 'No valid fields' })
  }
  res.json(row)
}
