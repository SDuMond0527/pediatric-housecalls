import type { VercelRequest, VercelResponse } from '@vercel/node'
import { neon } from '@neondatabase/serverless'
import { createRemoteJWKSet, jwtVerify } from 'jose'

// POST /api/agent/authorize/[proposalId]
//
// The clinician clicked Authorize (or Cancel) in the agent confirmation
// modal. This endpoint decides the proposal's fate: it either fires the
// underlying write (e.g., sends the prescription to DoseSpot) or marks
// it cancelled. Either way it writes an audit log row and returns the
// updated proposal shape to the UI.
//
// Body: { action: 'authorize' | 'cancel' }
//
// NOTE — Commit 2 scope: the authorize path accepts the request, flips
// status to 'authorized_pending_execution', and returns a
// pending-execution response. Actual DoseSpot wiring (drug search →
// prescription create → sign + send) lands in Commit 3 without
// changing this endpoint's shape. Keeping that gap narrow + visible
// so Sara can see the staging surface works before any real
// prescription could fire.

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

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  let sub: string
  try { sub = await verifyToken(req.headers.authorization) }
  catch { return res.status(401).json({ error: 'Unauthorized' }) }

  const proposalId = String(req.query.proposalId ?? '')
  if (!proposalId) return res.status(400).json({ error: 'proposalId required' })

  const body = (req.body ?? {}) as { action?: string }
  const action = String(body.action ?? '').trim()
  if (action !== 'authorize' && action !== 'cancel') {
    return res.status(400).json({ error: "action must be 'authorize' or 'cancel'" })
  }

  const sql = neon(process.env.DATABASE_URL!)

  const [provider] = await sql`SELECT id, name, practice_id FROM providers WHERE cognito_sub = ${sub} LIMIT 1`
  if (!provider) return res.status(403).json({ error: 'Provider not found' })

  // Load + authorize scope-check in one SELECT. Proposal must belong to
  // this provider — a different clinician cannot authorize a prescription
  // staged by someone else, even inside the same practice.
  const [proposal] = await sql`
    SELECT id, conversation_id, practice_id, provider_id, kind, payload, status
    FROM agent_proposals
    WHERE id = ${proposalId}::uuid
      AND practice_id = ${provider.practice_id}::uuid
      AND provider_id = ${provider.id}::uuid
    LIMIT 1`
  if (!proposal) return res.status(404).json({ error: 'Proposal not found or not yours to authorize' })

  if (proposal.status !== 'pending') {
    return res.status(409).json({ error: `Proposal is already ${proposal.status} — nothing to do.`, proposal })
  }

  if (action === 'cancel') {
    const [updated] = await sql`
      UPDATE agent_proposals
      SET status = 'cancelled', decided_at = NOW()
      WHERE id = ${proposalId}::uuid
      RETURNING id, kind, status, payload, decided_at`
    try {
      await sql`
        INSERT INTO phi_audit_log (provider_id, action, resource_type, resource_id)
        VALUES (${provider.id}::uuid, 'agent_proposal_cancelled', 'agent_proposal', ${proposalId})`
    } catch {}
    return res.status(200).json({
      ok: true,
      proposal: updated,
      message: 'Proposal cancelled. Nothing was sent.',
    })
  }

  // action === 'authorize'. Commit 2 stops here (staging only). Commit
  // 3 will replace this block with:
  //   case 'prescription': await fireDoseSpotPrescription(proposal.payload)
  //   case 'lab_order':    await fireLabOrder(proposal.payload)
  //   etc.
  const [updated] = await sql`
    UPDATE agent_proposals
    SET status = 'authorized_pending_execution', decided_at = NOW()
    WHERE id = ${proposalId}::uuid
    RETURNING id, kind, status, payload, decided_at`
  try {
    await sql`
      INSERT INTO phi_audit_log (provider_id, action, resource_type, resource_id)
      VALUES (${provider.id}::uuid, 'agent_proposal_authorized', 'agent_proposal', ${proposalId})`
  } catch {}

  return res.status(200).json({
    ok: true,
    proposal: updated,
    pending_execution: true,
    message: `Authorized. DoseSpot send-off is wired in the next commit; for now the prescription is staged safely and nothing has been transmitted to the pharmacy.`,
  })
}
