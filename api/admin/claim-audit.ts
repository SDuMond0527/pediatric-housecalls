import type { VercelRequest, VercelResponse } from '@vercel/node'
import { neon } from '@neondatabase/serverless'
import { createRemoteJWKSet, jwtVerify } from 'jose'

async function verifyToken(authHeader: string | undefined): Promise<string> {
  if (!authHeader?.startsWith('Bearer ')) throw new Error('Missing token')
  const token = authHeader.slice(7)
  const region = process.env.VITE_AWS_REGION || 'us-east-2'
  const poolId = process.env.VITE_AWS_USER_POOL_ID || ''
  const JWKS = createRemoteJWKSet(new URL(`https://cognito-idp.${region}.amazonaws.com/${poolId}/.well-known/jwks.json`))
  const { payload } = await jwtVerify(token, JWKS, { issuer: `https://cognito-idp.${region}.amazonaws.com/${poolId}` })
  if (!payload.sub) throw new Error('No sub in token')
  return payload.sub as string
}

/**
 * GET /api/admin/claim-audit
 *   ?limit=100 (default 100, max 500)
 *   ?search=<string> (patient name / chart number / PCN substring, case-insensitive)
 *
 * Returns one row per claim with a chronological event timeline covering
 * every lifecycle step the system tracks:
 *   - Claim created / submitted / resubmitted
 *   - ERA received (with payment)
 *   - 277 rejection (with code + text)
 *   - Patient statement created / sent / paid / written off
 *   - Fix+Resubmit entries from claims.resubmission_log
 *   - Any claim_activity_log rows (attachments, provider replies, etc.)
 *
 * Replaces the old PHI-access audit log at /admin/audit-log per Sara
 * 2026-10-06. The underlying phi_audit_log table is unchanged and still
 * populated — just not surfaced in the admin UI anymore.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  let sub: string
  try { sub = await verifyToken(req.headers.authorization) }
  catch { return res.status(401).json({ error: 'Unauthorized' }) }

  const sql = neon(process.env.DATABASE_URL!)
  const [caller] = await sql`SELECT id, is_admin, practice_id FROM providers WHERE cognito_sub = ${sub} LIMIT 1`
  if (!caller) return res.status(403).json({ error: 'Provider not found' })
  if (!caller.is_admin) return res.status(403).json({ error: 'Admin access required' })

  const practiceId = caller.practice_id as string
  const limit  = Math.max(1, Math.min(500, parseInt(String((req.query.limit ?? '100')), 10) || 100))
  const search = String(req.query.search ?? '').trim()

  // Pull one row per claim with everything we need to construct a
  // timeline. LEFT JOINs so partial-data claims still show.
  const claims = await sql`
    SELECT
      cl.id                           AS claim_id,
      cl.created_at,
      cl.submitted_at,
      cl.era_received_at,
      cl.era_seen_at,
      cl.claim_rejection_at,
      cl.claim_rejection_reasons,
      cl.reopened_at,
      cl.reopen_reason,
      cl.reopen_note,
      cl.rework_resolved_at,
      cl.written_off_at,
      cl.write_off_reason,
      cl.resubmission_log,
      cl.status,
      cl.service_date,
      cl.payer_name,
      cl.payer_id,
      cl.total_charge,
      cl.insurance_payment_era,
      cl.patient_first_name,
      cl.patient_last_name,
      c.first_name AS child_first_name,
      c.last_name  AS child_last_name,
      c.chart_number,
      COALESCE(cl.payer_control_number, SUBSTRING(REPLACE(cl.id::text, '-', ''), 1, 20)) AS pcn,
      ps.id              AS statement_id,
      ps.status          AS statement_status,
      ps.created_at      AS statement_created_at,
      ps.sent_at         AS statement_sent_at,
      ps.paid_at         AS statement_paid_at,
      ps.voided_at       AS statement_voided_at,
      ps.void_reason     AS statement_void_reason,
      ps.total_amount_due AS statement_total,
      ps.paid_amount_cents AS statement_paid_cents,
      (
        SELECT json_agg(json_build_object(
          'at',   al.created_at,
          'kind', al.kind,
          'body', al.body,
          'by',   al.created_by_name
        ) ORDER BY al.created_at)
        FROM claim_activity_log al
        WHERE al.claim_id = cl.id
      ) AS activity
    FROM claims cl
    LEFT JOIN children c              ON c.id = cl.child_id
    LEFT JOIN patient_statements ps   ON ps.claim_id = cl.id
    WHERE cl.practice_id = ${practiceId}::uuid
      AND (
        ${search} = ''
        OR LOWER(COALESCE(cl.patient_first_name,'')) LIKE '%' || LOWER(${search}) || '%'
        OR LOWER(COALESCE(cl.patient_last_name,'')) LIKE '%' || LOWER(${search}) || '%'
        OR LOWER(COALESCE(c.first_name,'')) LIKE '%' || LOWER(${search}) || '%'
        OR LOWER(COALESCE(c.last_name,'')) LIKE '%' || LOWER(${search}) || '%'
        OR LOWER(COALESCE(c.chart_number,'')) LIKE '%' || LOWER(${search}) || '%'
        OR LOWER(cl.id::text) LIKE '%' || LOWER(${search}) || '%'
      )
    ORDER BY COALESCE(
      ps.paid_at, ps.sent_at,
      cl.era_received_at, cl.claim_rejection_at, cl.submitted_at, cl.created_at
    ) DESC NULLS LAST
    LIMIT ${limit}
  `

  type EventType =
    'created' | 'submitted' | 'rejection' | 'era_received' |
    'resubmit' | 'reopened' | 'rework_resolved' | 'written_off' |
    'statement_created' | 'statement_sent' | 'statement_paid' | 'statement_written_off' |
    'activity'

  type Event = {
    at: string
    type: EventType
    label: string
    detail: string | null
    by?: string | null
  }

  const result = claims.map((row: any) => {
    const events: Event[] = []

    if (row.created_at)
      events.push({ at: row.created_at, type: 'created', label: 'Claim created', detail: `Charge ${row.total_charge != null ? '$' + Number(row.total_charge).toFixed(2) : '—'}` })

    if (row.submitted_at)
      events.push({ at: row.submitted_at, type: 'submitted', label: 'Submitted to insurance', detail: row.payer_name ?? null })

    if (row.claim_rejection_at) {
      const reasons: any[] = Array.isArray(row.claim_rejection_reasons) ? row.claim_rejection_reasons : []
      const headline = reasons[0]
        ? `${reasons[0].category}/${reasons[0].code}${reasons[0].message ? ' — ' + String(reasons[0].message).slice(0, 180) : ''}`
        : 'Rejection received'
      events.push({ at: row.claim_rejection_at, type: 'rejection', label: 'Rejection returned', detail: headline })
    }

    if (row.era_received_at) {
      const paid = row.insurance_payment_era != null ? '$' + Number(row.insurance_payment_era).toFixed(2) : '—'
      events.push({ at: row.era_received_at, type: 'era_received', label: 'ERA returned', detail: `Insurance paid ${paid}` })
    }

    if (row.reopened_at)
      events.push({ at: row.reopened_at, type: 'reopened', label: 'Reopened for correction', detail: row.reopen_reason ?? null })

    if (Array.isArray(row.resubmission_log)) {
      for (const entry of row.resubmission_log) {
        if (!entry?.at) continue
        events.push({
          at: entry.at,
          type: 'resubmit',
          label: 'Fix + resubmit prepared',
          detail: entry.note ?? null,
          by: entry.by_name ?? null,
        })
      }
    }

    if (row.rework_resolved_at)
      events.push({ at: row.rework_resolved_at, type: 'rework_resolved', label: 'Rework marked complete', detail: null })

    if (row.written_off_at)
      events.push({ at: row.written_off_at, type: 'written_off', label: 'Claim written off', detail: row.write_off_reason ?? null })

    if (row.statement_created_at)
      events.push({ at: row.statement_created_at, type: 'statement_created', label: 'Patient statement generated', detail: row.statement_total != null ? '$' + Number(row.statement_total).toFixed(2) : null })

    if (row.statement_sent_at)
      events.push({ at: row.statement_sent_at, type: 'statement_sent', label: 'Patient statement sent', detail: null })

    if (row.statement_paid_at) {
      const paidDollars = row.statement_paid_cents != null ? '$' + (Number(row.statement_paid_cents) / 100).toFixed(2) : null
      events.push({ at: row.statement_paid_at, type: 'statement_paid', label: 'Patient statement paid', detail: paidDollars })
    }

    if (row.statement_voided_at)
      events.push({
        at: row.statement_voided_at,
        type: 'statement_written_off',
        label: 'Patient statement voided / written off',
        detail: row.statement_void_reason ?? null,
      })

    // Catch-all activity_log entries that aren't already represented.
    // Skip kinds we already surface explicitly to avoid duplication.
    const EXPLICIT_KINDS = new Set(['fix_resubmit', 'rework_resolved_with_statement'])
    if (Array.isArray(row.activity)) {
      for (const a of row.activity) {
        if (!a?.at || EXPLICIT_KINDS.has(a.kind)) continue
        events.push({
          at: a.at,
          type: 'activity',
          label: a.kind ? String(a.kind).replace(/_/g, ' ') : 'Activity',
          detail: a.body ?? null,
          by: a.by ?? null,
        })
      }
    }

    events.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime())

    const patient = [row.child_first_name ?? row.patient_first_name, row.child_last_name ?? row.patient_last_name]
      .filter(Boolean).join(' ') || 'Unknown patient'

    return {
      claim_id:      row.claim_id,
      patient_name:  patient,
      chart_number:  row.chart_number ?? null,
      pcn:           row.pcn ?? null,
      service_date:  row.service_date,
      payer_name:    row.payer_name,
      payer_id:      row.payer_id,
      total_charge:  row.total_charge,
      status:        row.status,
      events,
    }
  })

  return res.status(200).json(result)
}
