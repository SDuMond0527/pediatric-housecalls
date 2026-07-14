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
  try {
    sub = await verifyFamilyToken(req.headers.authorization)
  } catch {
    return res.status(401).json({ error: 'Unauthorized' })
  }

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

  const notes = await sql`
    SELECT
      en.id,
      en.child_id,
      en.appointment_id,
      en.chief_complaint,
      en.assessment,
      en.plan,
      en.diagnoses,
      en.signed_at,
      a.visit_type,
      a.scheduled_date,
      a.scheduled_time,
      a.after_visit_instructions,
      p.name AS provider_name
    FROM encounter_notes en
    LEFT JOIN appointments a ON a.id = en.appointment_id
    LEFT JOIN providers p ON p.id = a.provider_id
    WHERE en.child_id = ANY(${childIds}::uuid[])
      AND en.practice_id = ${fam.practice_id}::uuid
      AND en.is_signed = true
    ORDER BY a.scheduled_date DESC NULLS LAST
    LIMIT 50
  `

  const result = notes.map((n: any) => ({
    id: n.id,
    child_id: n.child_id,
    child_name: childMap[n.child_id] ?? 'Unknown',
    appointment_id: n.appointment_id,
    chief_complaint: n.chief_complaint,
    assessment: n.assessment,
    plan: n.plan,
    after_visit_instructions: n.after_visit_instructions,
    // Send only diagnosis names, not billing codes
    diagnoses: (n.diagnoses ?? []).map((dx: any) => dx.name).filter(Boolean),
    signed_at: n.signed_at,
    visit_type: n.visit_type,
    scheduled_date: n.scheduled_date,
    scheduled_time: n.scheduled_time,
    provider_name: n.provider_name,
  }))

  return res.json(result)
}
