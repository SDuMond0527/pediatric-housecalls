// Dry-run HL7 ORU ingestion. Admin pastes a raw HL7 result message,
// we parse it, run patient matching, and preview what GoRoam would
// create — WITHOUT writing anything to the database.
//
// Used to validate the integration before LabCorp goes live, and to
// debug individual test transmissions during go-live.
//
// POST /api/admin/hl7-dry-run
//   body: { message: string }   (raw HL7 text)
//   → { parsed, match, proposed_results[] }
//
// Super-admin only. Sara 2026-11-17.

import type { VercelRequest, VercelResponse } from '@vercel/node'
import { neon } from '@neondatabase/serverless'
import { createRemoteJWKSet, jwtVerify } from 'jose'
import { parseHl7Oru, type ParsedOru } from '../hl7/parser.js'
import { matchPatient, type MatchDecision } from '../hl7/patient-match.js'

async function verifyToken(authHeader: string | undefined): Promise<string> {
  if (!authHeader?.startsWith('Bearer ')) throw new Error('Missing token')
  const token = authHeader.slice(7)
  const region = process.env.VITE_AWS_REGION || 'us-east-2'
  const poolId = process.env.VITE_AWS_USER_POOL_ID || ''
  const JWKS = createRemoteJWKSet(new URL(`https://cognito-idp.${region}.amazonaws.com/${poolId}/.well-known/jwks.json`))
  const { payload } = await jwtVerify(token, JWKS, { issuer: `https://cognito-idp.${region}.amazonaws.com/${poolId}` })
  if (!payload.sub) throw new Error('No sub')
  return payload.sub as string
}

// Shape the UI will show. Each row corresponds to a `results` row we
// would create if this were a real ingestion. The UI can render this
// as a table of "what would happen."
interface ProposedResult {
  type: 'lab'
  specimen_date: string | null
  test_code: string | null
  test_name: string | null
  source_lab: string | null
  source_provider: string | null
  observations: Array<{
    name: string
    value: string | null
    units: string | null
    reference_range: string | null
    abnormal_flag: string | null
    notes: string[]
  }>
}

function proposedResults(parsed: ParsedOru): ProposedResult[] {
  return parsed.orders.map(o => ({
    type: 'lab' as const,
    specimen_date: o.collectionDateTime ? o.collectionDateTime.slice(0, 10) : null,
    test_code: o.testCode,
    test_name: o.testName,
    source_lab: parsed.sendingApplication ?? parsed.sendingFacility,
    source_provider: [o.orderingProvider.firstName, o.orderingProvider.lastName].filter(Boolean).join(' ') || null,
    observations: o.results.map(r => ({
      name: r.identifier.name ?? r.identifier.code ?? '',
      value: r.value,
      units: r.units,
      reference_range: r.referenceRange,
      abnormal_flag: r.abnormalFlags,
      notes: r.notes,
    })),
  }))
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  let sub: string
  try { sub = await verifyToken(req.headers.authorization) }
  catch { return res.status(401).json({ error: 'Unauthorized' }) }

  const sql = neon(process.env.DATABASE_URL!)
  const [provider] = await sql`SELECT practice_id, is_super_admin FROM providers WHERE cognito_sub = ${sub} LIMIT 1`
  if (!provider) return res.status(403).json({ error: 'Provider not found' })
  if (!provider.is_super_admin) return res.status(403).json({ error: 'Super admin only' })
  const practiceId = provider.practice_id as string

  const body = (req.body ?? {}) as Record<string, any>
  const message = String(body.message ?? '')
  if (!message.trim()) return res.status(400).json({ error: 'message required' })
  if (message.length > 200_000) return res.status(413).json({ error: 'Message too large (max 200 KB)' })

  const parsed = parseHl7Oru(message)
  let match: MatchDecision | { kind: 'skipped'; reason: string }
  if (!parsed.patient) {
    match = { kind: 'skipped', reason: 'No PID segment in message' }
  } else {
    try {
      match = await matchPatient(sql, practiceId, parsed.patient)
    } catch (e: any) {
      match = { kind: 'skipped', reason: 'Patient lookup error: ' + (e?.message ?? String(e)) }
    }
  }

  return res.status(200).json({
    parsed,
    match,
    proposed_results: proposedResults(parsed),
  })
}
