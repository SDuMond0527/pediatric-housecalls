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

  if (req.method !== 'PATCH') return res.status(405).json({ error: 'Method not allowed' })

  const sql = neon(process.env.DATABASE_URL!)

  const { id } = req.query as { id: string }
  const b = req.body

  const updates: string[] = []
  if (b.phone !== undefined)               updates.push('phone')
  if (b.secure_text_number !== undefined)  updates.push('secure_text_number')
  if (b.home_address !== undefined)        updates.push('home_address')
  if (b.email !== undefined)               updates.push('email')
  if (b.zones !== undefined)               updates.push('zones')
  if (b.states !== undefined)              updates.push('states')

  if (!updates.length) return res.status(400).json({ error: 'No valid fields' })

  const zones  = b.zones  !== undefined ? JSON.stringify(b.zones)  : null
  const states = b.states !== undefined ? JSON.stringify(b.states) : null

  const [row] = await sql`
    UPDATE providers SET
      phone              = CASE WHEN ${b.phone !== undefined} THEN ${b.phone ?? null}              ELSE phone              END,
      secure_text_number = CASE WHEN ${b.secure_text_number !== undefined} THEN ${b.secure_text_number ?? null} ELSE secure_text_number END,
      home_address       = CASE WHEN ${b.home_address !== undefined} THEN ${b.home_address ?? null} ELSE home_address       END,
      email              = CASE WHEN ${b.email !== undefined} THEN ${b.email ?? null}              ELSE email              END,
      zones              = CASE WHEN ${b.zones !== undefined} THEN ${zones}::jsonb               ELSE zones              END,
      states             = CASE WHEN ${b.states !== undefined} THEN ${states}::jsonb              ELSE states             END
    WHERE id = ${id}::uuid
    RETURNING *`
  res.json(row)
}
