import type { VercelRequest, VercelResponse } from '@vercel/node'
import { neon } from '@neondatabase/serverless'

const PRACTICE_NAME = process.env.PRACTICE_NAME || 'Pediatric Housecalls'

/**
 * GET /api/agencies/by-slug?slug=<slug>
 *
 * Public endpoint. The agency-referral form hits this to resolve a URL
 * slug into the agency's display name + id (which it then stamps on the
 * referral submission). Returns 404 for inactive or unknown agencies.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  const slug = String(req.query.slug ?? '').trim().toLowerCase()
  if (!slug) return res.status(400).json({ error: 'slug required' })

  const sql = neon(process.env.DATABASE_URL!)
  const [practice] = await sql`SELECT id FROM practices WHERE LOWER(name) = LOWER(${PRACTICE_NAME}) ORDER BY created_at LIMIT 1`
  if (!practice) return res.status(500).json({ error: 'Practice not configured' })

  const [agency] = await sql`
    SELECT id, name, slug FROM agencies
    WHERE practice_id = ${practice.id}::uuid AND slug = ${slug} AND is_active = true
    LIMIT 1`
  if (!agency) return res.status(404).json({ error: 'Agency not found' })
  return res.json(agency)
}
