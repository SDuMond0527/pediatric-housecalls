import type { VercelRequest, VercelResponse } from '@vercel/node'
import { neon } from '@neondatabase/serverless'
import { createRemoteJWKSet, jwtVerify } from 'jose'
import {
  getDoseSpotToken,
  ensureDoseSpotPatient,
  createCodedPrescription,
  sendPrescriptions,
} from '../dosespot'

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

  // action === 'authorize' — dispatch by proposal kind.
  if (proposal.kind !== 'prescription') {
    // Other kinds (lab_order, follow_up, etc.) will land in later
    // commits. Explicit refusal so we never silently flip a non-Rx
    // proposal through a path it isn't wired for yet.
    return res.status(501).json({ error: `Authorize is not implemented for proposal kind '${proposal.kind}' yet.` })
  }

  const payload = proposal.payload as any
  const rx = payload?.prescription ?? {}
  const ds = payload?.dosespot ?? {}
  const pharmacy = payload?.pharmacy ?? {}
  const patient = payload?.patient ?? {}
  const prescriber = payload?.prescriber ?? {}

  // Hard-check everything the DoseSpot calls need before we touch the
  // vendor. Each missing piece would be caught by DoseSpot anyway, but
  // failing early gives Sara a clean actionable error instead of a
  // vendor stack trace in the modal.
  const miss: string[] = []
  if (!patient.child_id) miss.push('child_id')
  if (!pharmacy.dosespot_pharmacy_id) miss.push('pharmacy_id')
  if (!ds.dispensable_drug_id) miss.push('dispensable_drug_id')
  if (!ds.dispense_unit_id) miss.push('dispense_unit_id')
  if (typeof ds.parsed_quantity !== 'number') miss.push('parsed_quantity')
  if (typeof rx.refills !== 'number') miss.push('refills')
  if (typeof rx.days_supply !== 'number') miss.push('days_supply')
  if (!rx.sig) miss.push('sig')
  if (!prescriber.dosespot_clinician_id) miss.push('dosespot_clinician_id')
  if (miss.length) {
    return res.status(422).json({ error: `Proposal is missing fields needed to transmit: ${miss.join(', ')}. The proposal was not sent.` })
  }

  let executionResult: any
  try {
    // Use the PRESCRIBER's clinician ID for the token so DoseSpot
    // attributes the Rx to the right provider, not the admin fallback.
    const token = await getDoseSpotToken(prescriber.dosespot_clinician_id)

    // Ensure the patient exists in DoseSpot. Reuses the same create
    // shape as the SSO flow, so a patient already launched via the
    // DoseSpot button carries over without re-create.
    const dsPatientId = await ensureDoseSpotPatient(patient.child_id, provider.practice_id, token, sql)

    // Create the prescription.
    const created = await createCodedPrescription({
      patientId:         dsPatientId,
      pharmacyId:        pharmacy.dosespot_pharmacy_id,
      dispensableDrugId: ds.dispensable_drug_id,
      dispenseUnitId:    ds.dispense_unit_id,
      quantity:          ds.parsed_quantity,
      refills:           rx.refills,
      daysSupply:        rx.days_supply,
      directions:        rx.sig,
      pharmacyNotes:     rx.notes_to_pharmacist ?? null,
    }, token)

    // Transmit to the pharmacy. If send fails, the Rx is still in
    // DoseSpot in draft form — Sara can finish it in DoseSpot's UI.
    // We surface that distinction in the response so she knows
    // whether CVS has it or whether she needs to intervene.
    let sent: any
    let sendError: string | null = null
    try {
      sent = await sendPrescriptions(dsPatientId, [created.PrescriptionId], token)
    } catch (e: any) {
      sendError = e?.message ?? String(e)
    }

    executionResult = {
      dosespot_patient_id: dsPatientId,
      dosespot_prescription_id: created.PrescriptionId,
      sent: !sendError,
      send_error: sendError,
      send_response: sent ?? null,
    }
  } catch (e: any) {
    // Mark the proposal as failed (not cancelled) and surface the
    // vendor error verbatim. Status 'execution_failed' is distinct
    // from 'cancelled' so audit can distinguish "clinician said no"
    // from "DoseSpot refused".
    await sql`
      UPDATE agent_proposals
      SET status = 'execution_failed', decided_at = NOW(),
          execution_result = ${JSON.stringify({ error: e?.message ?? String(e) })}::jsonb
      WHERE id = ${proposalId}::uuid`
    try {
      await sql`
        INSERT INTO phi_audit_log (provider_id, action, resource_type, resource_id)
        VALUES (${provider.id}::uuid, 'agent_proposal_execution_failed', 'agent_proposal', ${proposalId})`
    } catch {}
    return res.status(502).json({
      error: `DoseSpot refused the prescription: ${e?.message ?? 'unknown error'}. The clinician should prescribe directly in DoseSpot.`,
      proposalId,
    })
  }

  const finalStatus = executionResult.sent ? 'executed' : 'authorized_pending_send'
  const [updated] = await sql`
    UPDATE agent_proposals
    SET status = ${finalStatus}, decided_at = NOW(),
        execution_result = ${JSON.stringify(executionResult)}::jsonb
    WHERE id = ${proposalId}::uuid
    RETURNING id, kind, status, payload, decided_at, execution_result`
  try {
    await sql`
      INSERT INTO phi_audit_log (provider_id, action, resource_type, resource_id)
      VALUES (${provider.id}::uuid, ${executionResult.sent ? 'agent_proposal_executed' : 'agent_proposal_sent_failed'}, 'agent_proposal', ${proposalId})`
  } catch {}

  return res.status(200).json({
    ok: true,
    proposal: updated,
    pending_execution: !executionResult.sent,
    message: executionResult.sent
      ? `Sent to pharmacy. DoseSpot prescription ID ${executionResult.dosespot_prescription_id}.`
      : `Prescription created in DoseSpot (ID ${executionResult.dosespot_prescription_id}) but the transmission to the pharmacy failed: ${executionResult.send_error}. Open DoseSpot to transmit manually.`,
  })
}
